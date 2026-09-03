# Sổ thu chi — Chứng từ đính kèm, danh mục mở rộng & mặc định Thu/Chi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add receipt/proof-of-payment attachments (stored in Cloudflare R2) to Sổ thu chi transactions, let each user set a per-browser default Thu/Chi type for the quick-add form, expand the `category` taxonomy to 13 Thu/Chi-classified slugs with a client-side dynamic filter, and warn manager/admin when R2 storage crosses 9GB/month.

**Architecture:** Same stack as the rest of V4 — Cloudflare Pages Functions + D1, vanilla-JS admin frontend, no build step. Adds Cloudflare R2 as new infrastructure (first use in this codebase) via a `RECEIPTS` bucket binding. A SQLite CHECK-constraint rebuild migration widens `finance_transactions.category` and adds three `receipt_*` columns. A new shared backend module (`lib/financeCategories.js`) is the single source of truth for the category→type table, imported by both transaction endpoints; the client keeps its own independent copy of the same table (this codebase has no bundler — `admin/*.js` files are classic `<script>` tags, not ES modules, so client/server code cannot share an `import`; this mirrors the existing, already-accepted duplication of category labels between backend and frontend).

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), Cloudflare R2, vanilla JS, Vitest + `@cloudflare/vitest-pool-workers` (Miniflare-emulated D1 *and* R2 — no real network calls to Cloudflare in tests), Playwright for e2e (outer repo).

**Spec:** `docs/specs/2026-09-03-finance-attachments-and-categories-design.md` (this plan argues from that spec; read both).

**Repos:** Backend/frontend/unit-test work happens in the `v4` repo (`D:\VDX\HienLeGarden\LandingPage\v4`, branch `feat/finance-round2`, which already carries the prior "Observer can't see Chi" commit). The e2e Playwright spec lives in the **outer** repo (`D:\VDX\HienLeGarden\LandingPage`, `tests/e2e/finance-dashboard.spec.js`) — Task 9 works there instead.

## Global Constraints

- No build step, no new frontend library or bundler — `admin/finance.js` stays a classic script.
- R2 first use in this codebase: bucket binding name `RECEIPTS`, bucket name `hien-le-garden-finance-receipts`. R2 is now enabled on the Cloudflare account (confirmed via `wrangler r2 bucket list` succeeding) — the bucket itself does not exist yet and must be created at deploy time (Task 8 covers the command).
- Upload is two independent HTTP requests, never one combined multipart create: `POST /api/finance/transactions` stays byte-for-byte unchanged, followed by a separate `POST /api/finance/transactions/:id/attachment` only if a file was picked.
- No R2 object is ever public — every read goes through the authenticated `GET .../attachment` proxy endpoint.
- Exactly one attachment per transaction; uploading again replaces the old file (old R2 object deleted first).
- The category → type classification table (§4.1 of the spec, 13 slugs) is binding and exact — reproduced in Task 1.
- The Thu/Chi default-form-type preference is a per-browser `localStorage` value only — never a server-side setting.
- Observer role: `GET .../attachment` returns `404` (never `403`) for a non-income transaction's attachment — a `403` would itself leak that an attachment exists on a transaction this role can't otherwise see.
- Apply migration 0016 to production D1 (`--remote`) before deploying any dependent code — standing rule for this project.
- Every push/migrate/deploy step requires explicit user confirmation before it happens — standing rule for this project.

---

## Task 1: Migration 0016 + shared category module

**Files:**
- Create: `v4/migrations/0016_finance_transactions_v2.sql`
- Create: `v4/lib/financeCategories.js`
- Modify: `v4/test/migrations.test.js`

**Interfaces:**
- Produces: `lib/financeCategories.js` exports `CATEGORY_META` (object, `{ [slug]: { label: string, type: 'income'|'expense' } }`, 13 keys), `VALID_CATEGORIES` (array of the 13 slugs), `CATEGORY_LABELS` (object, `{ [slug]: label }`, derived from `CATEGORY_META`), `categoryMatchesType(category, type)` (function, `boolean`). Task 2 imports all four.

- [ ] **Step 1: Write the failing migration test**

Append to `v4/test/migrations.test.js`:

```js
describe('migration 0016', () => {
  it('accepts all 13 category slugs paired with their correct type', async () => {
    await env.DB.exec('DELETE FROM finance_transactions');
    const rows = [
      ['cay_giong', 'expense'], ['vat_tu', 'expense'], ['nhan_cong', 'expense'], ['van_chuyen', 'expense'],
      ['bao_tri', 'expense'], ['thuc_pham', 'expense'], ['am_thuc_lien_ket', 'expense'], ['khac', 'expense'],
      ['ban_hang', 'income'], ['dich_vu', 'income'], ['bep_hien_le', 'income'], ['hien_le_drinks', 'income'],
      ['hh_am_thuc_lien_ket', 'income'],
    ];
    for (const [category, type] of rows) {
      await env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES (?, ?, 10000, '2026-09-01', 'draft', 'test', '2026-09-01T00:00:00Z')`
      ).bind(type, category).run();
    }
    const { results } = await env.DB.prepare(`SELECT COUNT(*) as count FROM finance_transactions`).all();
    expect(results[0].count).toBe(13);
  });

  it('still rejects an invalid category slug', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('expense', 'not_a_real_category', 10000, '2026-09-01', 'draft', 'test', '2026-09-01T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });

  it('has the three new receipt columns, defaulting to null', async () => {
    await env.DB.exec('DELETE FROM finance_transactions');
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 50000, '2026-09-01', 'draft', 'test', '2026-09-01T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT receipt_key, receipt_filename, receipt_uploaded_at FROM finance_transactions WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ receipt_key: null, receipt_filename: null, receipt_uploaded_at: null });
  });

  it('assigns a fresh id higher than any pre-existing row after the CHECK-constraint rebuild (sqlite_sequence preserved)', async () => {
    const before = await env.DB.prepare(`SELECT MAX(id) as maxId FROM finance_transactions`).first();
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 20000, '2026-09-01', 'draft', 'test', '2026-09-01T00:00:00Z')`
    ).run();
    expect(insert.meta.last_row_id).toBeGreaterThan(before.maxId || 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

From `v4/`: `npx vitest run test/migrations.test.js`
Expected: FAIL — `not_a_real_category` insert doesn't throw yet (old CHECK doesn't include the new slugs as valid either, but the 13-slug insert loop fails because `thuc_pham`/`am_thuc_lien_ket`/`bep_hien_le`/`hien_le_drinks`/`hh_am_thuc_lien_ket` aren't yet valid, and the receipt-columns test fails because those columns don't exist yet).

If this is a Windows Miniflare "Isolated storage failed" teardown-only flake (no assertion failure, just a teardown error), retry the same command up to 2 more times before treating it as real.

- [ ] **Step 3: Write the migration**

Create `v4/migrations/0016_finance_transactions_v2.sql`:

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE finance_transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category TEXT NOT NULL CHECK (category IN (
    'cay_giong', 'vat_tu', 'nhan_cong', 'van_chuyen', 'bao_tri', 'thuc_pham', 'am_thuc_lien_ket', 'khac',
    'ban_hang', 'dich_vu', 'bep_hien_le', 'hien_le_drinks', 'hh_am_thuc_lien_ket'
  )),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  transaction_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'paid')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  voided_by TEXT,
  voided_at TEXT,
  receipt_key TEXT,
  receipt_filename TEXT,
  receipt_uploaded_at TEXT
);

INSERT INTO finance_transactions_new
  (id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at)
  SELECT id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at
  FROM finance_transactions;

DROP TABLE finance_transactions;
ALTER TABLE finance_transactions_new RENAME TO finance_transactions;

CREATE INDEX idx_finance_transactions_date ON finance_transactions(transaction_date);
CREATE INDEX idx_finance_transactions_status ON finance_transactions(status);

-- Explicitly carry the AUTOINCREMENT high-water mark forward so the next
-- genuinely-new transaction can never reuse an id from the pre-rebuild table.
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  VALUES ('finance_transactions', (SELECT COALESCE(MAX(id), 0) FROM finance_transactions));

PRAGMA foreign_keys=ON;
```

- [ ] **Step 4: Create the shared category module**

Create `v4/lib/financeCategories.js`:

```js
// v4/lib/financeCategories.js
// Single source of truth for the finance category -> type classification table.
// Both transaction endpoints (transactions/index.js, transactions/[id].js) import
// this so the 13-slug list and its Thu/Chi pairing can never drift between them.
// The client (admin/finance.js) keeps its own independent copy of the same table —
// admin/*.js are classic <script> tags, not ES modules, so they cannot import this.

export const CATEGORY_META = {
  cay_giong: { label: 'Cây giống', type: 'expense' },
  vat_tu: { label: 'Vật tư', type: 'expense' },
  nhan_cong: { label: 'Nhân công', type: 'expense' },
  van_chuyen: { label: 'Vận chuyển', type: 'expense' },
  bao_tri: { label: 'Bảo trì', type: 'expense' },
  thuc_pham: { label: 'Thực phẩm', type: 'expense' },
  am_thuc_lien_ket: { label: 'Ẩm thực liên kết', type: 'expense' },
  khac: { label: 'Chi phí khác', type: 'expense' },
  ban_hang: { label: 'Bán hàng', type: 'income' },
  dich_vu: { label: 'Lưu trú Hiền Lê', type: 'income' },
  bep_hien_le: { label: 'Bếp Hiền Lê', type: 'income' },
  hien_le_drinks: { label: 'Hiền Lê Drinks', type: 'income' },
  hh_am_thuc_lien_ket: { label: 'HH Ẩm thực liên kết', type: 'income' },
};

export const VALID_CATEGORIES = Object.keys(CATEGORY_META);

export const CATEGORY_LABELS = Object.fromEntries(
  Object.entries(CATEGORY_META).map(([slug, meta]) => [slug, meta.label])
);

export function categoryMatchesType(category, type) {
  const meta = CATEGORY_META[category];
  return !!meta && meta.type === type;
}
```

- [ ] **Step 5: Run the test to verify it passes**

`npx vitest run test/migrations.test.js`
Expected: PASS (4/4 new tests, plus the pre-existing migration 0003/0004 tests still green).

- [ ] **Step 6: Commit**

```bash
cd v4
git add migrations/0016_finance_transactions_v2.sql lib/financeCategories.js test/migrations.test.js
git commit -m "feat: migrate finance_transactions to 13 categories + receipt columns"
```

---

## Task 2: Backend transaction endpoints — category validation + receipt fields

**Files:**
- Modify: `v4/functions/api/finance/transactions/index.js`
- Modify: `v4/functions/api/finance/transactions/[id].js`
- Modify: `v4/test/financeTransactions.test.js`

**Interfaces:**
- Consumes: `lib/financeCategories.js` → `VALID_CATEGORIES`, `CATEGORY_LABELS`, `categoryMatchesType` (Task 1).
- Produces: `coerceRow(r)` (in `index.js`) now includes `receiptKey`, `receiptFilename`, `receiptUploadedAt` — Task 6 (client) and Task 9 (client) read these fields.

- [ ] **Step 1: Write the failing tests**

Insert into the `describe('POST /api/finance/transactions', ...)` block in `v4/test/financeTransactions.test.js`, right after the existing `'lets admin create with an explicit status'` test:

```js
  it('rejects a type/category mismatch (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'income', category: 'vat_tu', amount: 100000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('accepts a new category (thuc_pham) paired with the correct type (expense)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'thuc_pham', amount: 150000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(201);
  });

  it('rejects a new category (hh_am_thuc_lien_ket, income) paired with the wrong type (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'hh_am_thuc_lien_ket', amount: 150000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('writes the renamed "Lưu trú Hiền Lê" label into the audit_log entry for a dich_vu transaction', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'income', category: 'dich_vu', amount: 700000, transactionDate: '2026-08-29' }),
      env,
    });
    const body = await response.json();
    const auditRow = await env.DB.prepare(`SELECT new_value FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ?`).bind(body.id).first();
    expect(auditRow.new_value).toContain('Lưu trú Hiền Lê');
  });
```

Insert into the `describe('GET /api/finance/transactions', ...)` block, right after `'filters by keyword against note, case-insensitively'`:

```js
  it('includes null receipt fields for a transaction with no attachment', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    const row = body.find((t) => t.note === 'Bán rau');
    expect(row.receiptKey).toBeNull();
    expect(row.receiptFilename).toBeNull();
    expect(row.receiptUploadedAt).toBeNull();
  });
```

Insert into the `describe('PATCH /api/finance/transactions/:id', ...)` block, right after `'rejects an invalid amount on update (400)'`:

```js
  it('rejects a type/category mismatch on update, including when only type changes and category is left stale (400)', async () => {
    // txId starts as expense/vat_tu (see beforeEach) — flipping only type to income
    // must be validated against vat_tu, which is expense-only.
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, managerToken, 'PATCH', { type: 'income' }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

`npx vitest run test/financeTransactions.test.js`
Expected: FAIL — `thuc_pham`/`hh_am_thuc_lien_ket` rejected as invalid categories (400 for reasons other than the mismatch check), no type/category mismatch check exists yet, `receiptKey` etc. are `undefined` not `null`.

- [ ] **Step 3: Update `index.js`**

In `v4/functions/api/finance/transactions/index.js`, replace lines 1-21 (the imports and the local `VALID_CATEGORIES`/`CATEGORY_LABELS` consts) with:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { VALID_CATEGORIES, CATEGORY_LABELS, categoryMatchesType } from '../../../../lib/financeCategories.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];
const VALID_STATUSES = ['draft', 'confirmed', 'paid'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
```

Update `coerceRow` (currently ends at `voidedAt: r.voided_at,`) to add the three new fields:

```js
function coerceRow(r) {
  return {
    id: r.id,
    type: r.type,
    category: r.category,
    amount: r.amount,
    note: r.note,
    transactionDate: r.transaction_date,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
    voidedBy: r.voided_by,
    voidedAt: r.voided_at,
    receiptKey: r.receipt_key,
    receiptFilename: r.receipt_filename,
    receiptUploadedAt: r.receipt_uploaded_at,
  };
}
```

In `onRequestPost`, right after the existing `if (!VALID_CATEGORIES.includes(category)) return jsonError('Danh mục không hợp lệ', 400);` line, add:

```js
  if (!categoryMatchesType(category, type)) return jsonError('Danh mục không phù hợp với loại giao dịch đã chọn', 400);
```

- [ ] **Step 4: Update `[id].js`**

In `v4/functions/api/finance/transactions/[id].js`, replace lines 1-12 with:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { summarize } from './index.js';
import { VALID_CATEGORIES, categoryMatchesType } from '../../../../lib/financeCategories.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];
const VALID_STATUSES = ['draft', 'confirmed', 'paid'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
```

Right after the existing `if (!VALID_CATEGORIES.includes(category)) return jsonError('Danh mục không hợp lệ', 400);` line in `onRequestPatch`, add:

```js
  if (!categoryMatchesType(category, type)) return jsonError('Danh mục không phù hợp với loại giao dịch đã chọn', 400);
```

(This runs against the already-resolved `type`/`category` — the fallback-to-existing-value pair a few lines above — so an edit that only changes `type` is validated against the *new* type paired with whatever category the row already had, exactly the case the new test covers.)

- [ ] **Step 5: Run the tests to verify they pass**

`npx vitest run test/financeTransactions.test.js`
Expected: PASS (all tests, including the 5 new ones).

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/finance/transactions/index.js functions/api/finance/transactions/[id].js test/financeTransactions.test.js
git commit -m "feat: enforce category/type pairing, expose receipt fields on transactions"
```

---

## Task 3: R2 binding + attachment endpoints

**Files:**
- Modify: `v4/wrangler.toml`
- Create: `v4/functions/api/finance/transactions/[id]/attachment.js`
- Create: `v4/test/financeAttachments.test.js`

**Interfaces:**
- Consumes: `env.RECEIPTS` (R2 bucket binding, Miniflare-emulated locally and in tests once `wrangler.toml` declares it), `requireAuth` (`lib/requireAuth.js`).
- Produces: `POST /api/finance/transactions/:id/attachment`, `DELETE /api/finance/transactions/:id/attachment`, `GET /api/finance/transactions/:id/attachment` — Task 6 (client) calls all three.

- [ ] **Step 1: Add the R2 binding**

In `v4/wrangler.toml`, add after the existing `[[d1_databases]]` block:

```toml
[[r2_buckets]]
binding = "RECEIPTS"
bucket_name = "hien-le-garden-finance-receipts"
```

- [ ] **Step 2: Write the failing tests**

Create `v4/test/financeAttachments.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as uploadAttachment, onRequestDelete as deleteAttachment, onRequestGet as getAttachment } from '../functions/api/finance/transactions/[id]/attachment.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, observerToken;
let expenseTxId, incomeTxId, voidedTxId;

function pdfFile(name = 'hoa-don.pdf', bytes = new Uint8Array([1, 2, 3, 4])) {
  return new File([bytes], name, { type: 'application/pdf' });
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM finance_transactions');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_att', 'x', 'manager', '2026-09-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_att', 'x', 'reception', '2026-09-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_att', 'x', 'observer', '2026-09-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  const expenseTx = await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('expense', 'vat_tu', 100000, '2026-09-01', 'draft', 'quan_ly_att', '2026-09-01T00:00:00Z')`
  ).run();
  expenseTxId = expenseTx.meta.last_row_id;

  const incomeTx = await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 200000, '2026-09-01', 'draft', 'quan_ly_att', '2026-09-01T00:00:00Z')`
  ).run();
  incomeTxId = incomeTx.meta.last_row_id;

  const voidedTx = await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at, voided_by, voided_at) VALUES ('expense', 'vat_tu', 50000, '2026-09-01', 'draft', 'quan_ly_att', '2026-09-01T00:00:00Z', 'quan_ly_att', '2026-09-01T01:00:00Z')`
  ).run();
  voidedTxId = voidedTx.meta.last_row_id;
});

function authedFormRequest(url, token, file) {
  const form = new FormData();
  if (file) form.append('file', file);
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method: 'POST', headers, body: form });
}

function authedRequest(url, token, method) {
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers });
}

describe('POST /api/finance/transactions/:id/attachment', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, null, pdfFile()), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, receptionToken, pdfFile()), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, observerToken, pdfFile()), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent transaction', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/999999/attachment`, managerToken, pdfFile()), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('400s for a voided transaction', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${voidedTxId}/attachment`, managerToken, pdfFile()), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(400);
  });

  it('400s when no file is included', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, null), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(400);
  });

  it('400s for a disallowed content type', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'note.txt', { type: 'text/plain' });
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, file), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(400);
  });

  it('400s for a file over 10MB', async () => {
    const bigFile = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'hoa-don.pdf', { type: 'application/pdf' });
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, bigFile), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(400);
  });

  it('uploads a valid file, stores the R2 object, updates the transaction row, and writes an audit_log row', async () => {
    const response = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, pdfFile('hoa-don-a.pdf')), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.receiptFilename).toBe('hoa-don-a.pdf');

    const row = await env.DB.prepare(`SELECT receipt_key, receipt_filename, receipt_uploaded_at FROM finance_transactions WHERE id = ?`).bind(expenseTxId).first();
    expect(row.receipt_filename).toBe('hoa-don-a.pdf');
    expect(row.receipt_key).toContain(`finance-receipts/${expenseTxId}/`);
    expect(row.receipt_uploaded_at).not.toBeNull();

    const object = await env.RECEIPTS.get(row.receipt_key);
    expect(object).not.toBeNull();

    const auditRow = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ? AND action_type = 'finance_transaction_attachment_upload'`).bind(expenseTxId).first();
    expect(auditRow).not.toBeNull();
    expect(auditRow.actor).toBe('quan_ly_att');
  });

  it('replacing an existing attachment deletes the old R2 object', async () => {
    const first = await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, pdfFile('first.pdf')), env, params: { id: String(expenseTxId) } });
    const firstRow = await env.DB.prepare(`SELECT receipt_key FROM finance_transactions WHERE id = ?`).bind(expenseTxId).first();
    expect(first.status).toBe(200);

    await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, pdfFile('second.pdf')), env, params: { id: String(expenseTxId) } });
    const secondRow = await env.DB.prepare(`SELECT receipt_key FROM finance_transactions WHERE id = ?`).bind(expenseTxId).first();

    expect(secondRow.receipt_key).not.toBe(firstRow.receipt_key);
    const oldObject = await env.RECEIPTS.get(firstRow.receipt_key);
    expect(oldObject).toBeNull();
  });
});

describe('DELETE /api/finance/transactions/:id/attachment', () => {
  it('rejects reception (403)', async () => {
    const response = await deleteAttachment({ request: authedRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, receptionToken, 'DELETE'), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(403);
  });

  it('400s when the transaction has no attachment to remove', async () => {
    const response = await deleteAttachment({ request: authedRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, 'DELETE'), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(400);
  });

  it('400s for a voided transaction', async () => {
    const response = await deleteAttachment({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/attachment`, managerToken, 'DELETE'), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(400);
  });

  it('removes the R2 object and clears all three receipt columns', async () => {
    await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, pdfFile()), env, params: { id: String(expenseTxId) } });
    const uploaded = await env.DB.prepare(`SELECT receipt_key FROM finance_transactions WHERE id = ?`).bind(expenseTxId).first();

    const response = await deleteAttachment({ request: authedRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, 'DELETE'), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT receipt_key, receipt_filename, receipt_uploaded_at FROM finance_transactions WHERE id = ?`).bind(expenseTxId).first();
    expect(row).toEqual({ receipt_key: null, receipt_filename: null, receipt_uploaded_at: null });

    const object = await env.RECEIPTS.get(uploaded.receipt_key);
    expect(object).toBeNull();

    const auditRow = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ? AND action_type = 'finance_transaction_attachment_delete'`).bind(expenseTxId).first();
    expect(auditRow).not.toBeNull();
  });
});

describe('GET /api/finance/transactions/:id/attachment', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getAttachment({ request: authedRequest(`https://x/api/finance/transactions/${incomeTxId}/attachment`, null, 'GET'), env, params: { id: String(incomeTxId) } });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await getAttachment({ request: authedRequest(`https://x/api/finance/transactions/${incomeTxId}/attachment`, receptionToken, 'GET'), env, params: { id: String(incomeTxId) } });
    expect(response.status).toBe(403);
  });

  it('404s when the transaction has no attachment', async () => {
    const response = await getAttachment({ request: authedRequest(`https://x/api/finance/transactions/${incomeTxId}/attachment`, managerToken, 'GET'), env, params: { id: String(incomeTxId) } });
    expect(response.status).toBe(404);
  });

  it('streams the file back with the right content type and filename for manager/admin', async () => {
    await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, pdfFile('bill.pdf')), env, params: { id: String(expenseTxId) } });
    const response = await getAttachment({ request: authedRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, 'GET'), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/pdf');
    expect(response.headers.get('Content-Disposition')).toContain('bill.pdf');
  });

  it('observer can fetch an income transaction attachment', async () => {
    await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${incomeTxId}/attachment`, managerToken, pdfFile('income-receipt.pdf')), env, params: { id: String(incomeTxId) } });
    const response = await getAttachment({ request: authedRequest(`https://x/api/finance/transactions/${incomeTxId}/attachment`, observerToken, 'GET'), env, params: { id: String(incomeTxId) } });
    expect(response.status).toBe(200);
  });

  it('observer gets 404 (not 403) for an expense transaction attachment, even though one exists', async () => {
    await uploadAttachment({ request: authedFormRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, managerToken, pdfFile()), env, params: { id: String(expenseTxId) } });
    const response = await getAttachment({ request: authedRequest(`https://x/api/finance/transactions/${expenseTxId}/attachment`, observerToken, 'GET'), env, params: { id: String(expenseTxId) } });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

`npx vitest run test/financeAttachments.test.js`
Expected: FAIL — `functions/api/finance/transactions/[id]/attachment.js` doesn't exist yet (module not found).

- [ ] **Step 4: Write the endpoint**

Create `v4/functions/api/finance/transactions/[id]/attachment.js`:

```js
// functions/api/finance/transactions/[id]/attachment.js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

function receiptKeyFor(transactionId, filename) {
  return `finance-receipts/${transactionId}/${Date.now()}-${sanitizeFilename(filename)}`;
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy giao dịch', 404);
  if (existing.voided_at) return jsonError('Giao dịch này đã bị huỷ, không thể sửa', 400);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return jsonError('Vui lòng chọn tệp để tải lên', 400);
  if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
    return jsonError('Chỉ chấp nhận ảnh (JPG/PNG/WebP) hoặc PDF', 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return jsonError('Tệp vượt quá dung lượng tối đa 10MB', 400);
  }

  if (existing.receipt_key) {
    await env.RECEIPTS.delete(existing.receipt_key);
  }

  const key = receiptKeyFor(params.id, file.name);
  await env.RECEIPTS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE finance_transactions SET receipt_key = ?, receipt_filename = ?, receipt_uploaded_at = ? WHERE id = ?`
    ).bind(key, file.name, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('finance_transaction_attachment_upload', 'finance_transaction', ?, ?, NULL, ?, ?, ?)`
    ).bind(params.id, file.name, file.name, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true, receiptFilename: file.name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy giao dịch', 404);
  if (existing.voided_at) return jsonError('Giao dịch này đã bị huỷ, không thể sửa', 400);
  if (!existing.receipt_key) return jsonError('Giao dịch này chưa có chứng từ đính kèm', 400);

  await env.RECEIPTS.delete(existing.receipt_key);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE finance_transactions SET receipt_key = NULL, receipt_filename = NULL, receipt_uploaded_at = NULL WHERE id = ?`
    ).bind(params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('finance_transaction_attachment_delete', 'finance_transaction', ?, ?, ?, NULL, ?, ?)`
    ).bind(params.id, existing.receipt_filename, existing.receipt_filename, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(params.id).first();
  if (!existing || !existing.receipt_key) return jsonError('Không tìm thấy chứng từ', 404);
  // Observer's transaction-visibility boundary applies here too: a 403 would itself confirm
  // an attachment exists on an expense transaction this role can't otherwise see — 404 is
  // indistinguishable from "no attachment", same as GET .../transactions already hides
  // expense rows by omission rather than erroring.
  if (auth.role === 'observer' && existing.type !== 'income') {
    return jsonError('Không tìm thấy chứng từ', 404);
  }

  const object = await env.RECEIPTS.get(existing.receipt_key);
  if (!object) return jsonError('Không tìm thấy chứng từ', 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `inline; filename="${existing.receipt_filename || 'chung-tu'}"`);
  return new Response(object.body, { status: 200, headers });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

`npx vitest run test/financeAttachments.test.js`
Expected: PASS (all tests). If a lone Windows Miniflare teardown flake appears, retry the same command.

- [ ] **Step 6: Commit**

```bash
cd v4
git add wrangler.toml functions/api/finance/transactions/[id]/attachment.js test/financeAttachments.test.js
git commit -m "feat: add R2-backed finance transaction attachment endpoints"
```

---

## Task 4: Client markup — attachment form, default-type toggle, storage warning slot

**Files:**
- Modify: `v4/admin/finance.html`
- Modify: `v4/admin/admin.css`

**Interfaces:**
- Produces: DOM ids/selectors `#defaultTypeToggle .tab-btn[data-default-type]`, `#financeForm input[name="receipt"]`, `#financeAttachmentInfo`, `#financeStorageWarning`, and a new `<th>Chứng từ</th>` column in `#financeTable` — Task 5, 6, and 9 wire behavior to these.

- [ ] **Step 1: Add CSS for the storage-warning banner and the attachment badge**

In `v4/admin/admin.css`, add after the existing `.status-badge` rules (near line 176, after `.status-policy-off`):

```css
.status-attachment { background: rgba(120,160,220,0.15); color: #8FB8E8; }

.warning-banner {
  background: rgba(217,166,92,0.15);
  color: #D9A65C;
  border: 1px solid rgba(217,166,92,0.3);
  border-radius: 6px;
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 0.9rem;
}
```

- [ ] **Step 2: Update `finance.html`**

Add the storage-warning slot right after the existing `<p id="financeError" class="error"></p>` line:

```html
    <p id="financeStorageWarning" class="warning-banner hidden"></p>
```

Add the default-type toggle right before `<form id="financeForm">`, and the file input + attachment-info paragraph inside the form, right after the "Trạng thái" `<label>` and before the submit `<button>`. The full `#addTransactionSection` block becomes:

```html
    <div id="addTransactionSection" class="hidden">
      <h2>Thêm giao dịch</h2>
      <div class="filters" id="defaultTypeToggle">
        <span style="align-self: center;">Mặc định khi mở form:</span>
        <button type="button" class="tab-btn" data-default-type="income">Thu</button>
        <button type="button" class="tab-btn" data-default-type="expense">Chi</button>
      </div>
      <form id="financeForm">
        <div class="form-row">
          <label>Loại
            <select name="type" required>
              <option value="income">Thu</option>
              <option value="expense" selected>Chi</option>
            </select>
          </label>
          <label>Danh mục
            <select name="category" required></select>
          </label>
        </div>
        <div class="form-row">
          <label>Số tiền (đ) <input type="number" name="amount" min="0" step="1" required /></label>
          <label>Ngày <input type="date" name="transactionDate" required /></label>
        </div>
        <label>Ghi chú <input type="text" name="note" /></label>
        <label>Trạng thái
          <select name="status">
            <option value="draft" selected>Nháp</option>
            <option value="confirmed">Đã xác nhận</option>
            <option value="paid">Đã thanh toán</option>
          </select>
        </label>
        <label>Hoá đơn/chứng từ (ảnh hoặc PDF, tối đa 10MB)
          <input type="file" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf" />
        </label>
        <p id="financeAttachmentInfo"></p>
        <button type="submit">Ghi giao dịch</button>
        <button type="button" id="financeCancelEditBtn" class="btn-secondary hidden">Huỷ sửa</button>
        <p id="financeFormError" class="error"></p>
      </form>
    </div>
```

Update the `#financeTable` header (add a "Chứng từ" column between "Người tạo" and the trailing action column):

```html
        <thead><tr><th>Ngày</th><th>Loại</th><th>Danh mục</th><th>Số tiền</th><th>Trạng thái</th><th>Ghi chú</th><th>Người tạo</th><th>Chứng từ</th><th></th></tr></thead>
```

- [ ] **Step 3: Manual sanity check**

From `v4/`: `npx http-server . -p 8899 -s -c-1` (background), then open `http://localhost:8899/admin/finance.html` and confirm the page renders without console errors (the new elements exist but have no behavior yet — that's Tasks 5-6). Stop the server after checking.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/finance.html admin/admin.css
git commit -m "feat: add finance form markup for attachments, default-type toggle, storage warning"
```

---

## Task 5: Client — category filter by type + default Thu/Chi toggle

**Files:**
- Modify: `v4/admin/finance.js`

**Interfaces:**
- Consumes: `#defaultTypeToggle .tab-btn[data-default-type]`, `#financeForm select[name="type"]`, `#financeForm select[name="category"]`, `#filterCategory` (Task 4).
- Produces: `CATEGORY_META` (client-side object, mirrors `lib/financeCategories.js`'s table exactly), `categoryLabel(slug)`, `populateCategorySelect(select, { includeAllOption, type })` (new signature — an options object, not a positional boolean), `defaultTypePreference()`, `setDefaultTypePreference(type)`, `renderAttachmentEditor(t)`. `renderAttachmentEditor` is self-consumed by this same task's `resetFinanceForm`/`openEditTransaction` (Step 6 below) — Task 6 does not call it. Task 9 later calls `defaultTypePreference`.

This task has no server round-trip to unit-test against (it's pure DOM/localStorage logic already covered by the existing e2e harness); verification is a manual page check now, plus e2e coverage in Task 9. Follow the edits exactly — they replace the current category-label/select logic.

- [ ] **Step 1: Replace `CATEGORY_LABELS` with `CATEGORY_META` and add `categoryLabel`**

In `v4/admin/finance.js`, replace lines 4-13 (the `CATEGORY_LABELS` object) with:

```js
const CATEGORY_META = {
  cay_giong: { label: 'Cây giống', type: 'expense' },
  vat_tu: { label: 'Vật tư', type: 'expense' },
  nhan_cong: { label: 'Nhân công', type: 'expense' },
  van_chuyen: { label: 'Vận chuyển', type: 'expense' },
  bao_tri: { label: 'Bảo trì', type: 'expense' },
  thuc_pham: { label: 'Thực phẩm', type: 'expense' },
  am_thuc_lien_ket: { label: 'Ẩm thực liên kết', type: 'expense' },
  khac: { label: 'Chi phí khác', type: 'expense' },
  ban_hang: { label: 'Bán hàng', type: 'income' },
  dich_vu: { label: 'Lưu trú Hiền Lê', type: 'income' },
  bep_hien_le: { label: 'Bếp Hiền Lê', type: 'income' },
  hien_le_drinks: { label: 'Hiền Lê Drinks', type: 'income' },
  hh_am_thuc_lien_ket: { label: 'HH Ẩm thực liên kết', type: 'income' },
};

function categoryLabel(slug) {
  return CATEGORY_META[slug] ? CATEGORY_META[slug].label : slug;
}
```

- [ ] **Step 2: Replace `populateCategorySelect`**

Replace the existing `populateCategorySelect` function (lines 21-35) with:

```js
function populateCategorySelect(select, { includeAllOption = false, type } = {}) {
  select.innerHTML = '';
  if (includeAllOption) {
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'Tất cả danh mục';
    select.appendChild(allOpt);
  }
  const entries = Object.entries(CATEGORY_META).filter(([, meta]) => !type || meta.type === type);
  if (!type) {
    // Filter bar's "all categories" case: group by type for readability.
    [['income', 'Thu'], ['expense', 'Chi']].forEach(([groupType, groupLabel]) => {
      const group = document.createElement('optgroup');
      group.label = groupLabel;
      entries.filter(([, meta]) => meta.type === groupType).forEach(([slug, meta]) => {
        const opt = document.createElement('option');
        opt.value = slug;
        opt.textContent = meta.label;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });
    return;
  }
  entries.forEach(([slug, meta]) => {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = meta.label;
    select.appendChild(opt);
  });
}
```

- [ ] **Step 3: Add `renderAttachmentEditor`, referenced by Step 6 below**

Add this function anywhere after `populateCategorySelect` in `v4/admin/finance.js` (its DELETE-button wiring is inert until Task 6 adds `receiptKey`/`receiptFilename` handling elsewhere, but `resetFinanceForm`/`openEditTransaction` in Step 6 below call it unconditionally on every page load, so it must exist before this task's own commit — defining it here, not in Task 6, avoids a `renderAttachmentEditor is not defined` crash the moment this task's changes land):

```js
function renderAttachmentEditor(t) {
  const container = document.getElementById('financeAttachmentInfo');
  container.innerHTML = '';
  if (!t || !t.receiptKey) return;
  const link = document.createElement('a');
  link.href = `/api/finance/transactions/${t.id}/attachment`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = `📎 ${t.receiptFilename || 'Chứng từ hiện tại'}`;
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-secondary';
  removeBtn.textContent = 'Gỡ chứng từ';
  removeBtn.addEventListener('click', async () => {
    const errorEl = document.getElementById('financeFormError');
    errorEl.textContent = '';
    const response = await fetch(`/api/finance/transactions/${t.id}/attachment`, { method: 'DELETE' });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi gỡ chứng từ';
      return;
    }
    container.innerHTML = '';
    await loadTransactions();
  });
  container.append(link, ' ', removeBtn);
}
```

- [ ] **Step 4: Add default-type preference helpers**

Add right after `populateCategorySelect`:

```js
function defaultTypePreference() {
  try {
    return localStorage.getItem('financeDefaultType') || 'expense';
  } catch (err) {
    return 'expense';
  }
}

function setDefaultTypePreference(type) {
  try {
    localStorage.setItem('financeDefaultType', type);
  } catch (err) {
    // localStorage unavailable (private browsing, blocked storage) — the toggle
    // still updates the button state below, it just won't persist across reloads.
  }
  document.querySelectorAll('#defaultTypeToggle .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.defaultType === type);
  });
}

document.querySelectorAll('#defaultTypeToggle .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => setDefaultTypePreference(btn.dataset.defaultType));
});

document.querySelector('#financeForm select[name="type"]').addEventListener('change', (event) => {
  populateCategorySelect(document.querySelector('#financeForm select[name="category"]'), { type: event.target.value });
});
```

- [ ] **Step 5: Update the init IIFE**

Replace the two `populateCategorySelect(...)` calls near the top of the async IIFE (currently `populateCategorySelect(document.querySelector('#financeForm select[name="category"]'), false);` and `populateCategorySelect(document.getElementById('filterCategory'), true);`) with:

```js
  setDefaultTypePreference(defaultTypePreference());
  populateCategorySelect(document.getElementById('filterCategory'), { includeAllOption: true });
```

(The quick-add form's category select no longer needs populating here — `resetFinanceForm()`, called a few lines later in the same IIFE, now does it based on the default-type preference; see Step 5.)

- [ ] **Step 6: Update `resetFinanceForm` and `openEditTransaction`**

Replace `resetFinanceForm`:

```js
function resetFinanceForm() {
  const form = document.getElementById('financeForm');
  form.reset();
  delete form.dataset.editingId;
  const defaultType = defaultTypePreference();
  form.querySelector('[name="type"]').value = defaultType;
  populateCategorySelect(form.querySelector('[name="category"]'), { type: defaultType });
  form.querySelector('[name="transactionDate"]').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  document.querySelector('#financeForm button[type="submit"]').textContent = 'Ghi giao dịch';
  document.getElementById('financeCancelEditBtn').classList.add('hidden');
  renderAttachmentEditor(null);
}
```

(`renderAttachmentEditor` was just defined in Step 3 above, so this is safe to call from the moment this task lands — no forward reference to Task 6.)

Replace `openEditTransaction`:

```js
function openEditTransaction(t) {
  const form = document.getElementById('financeForm');
  form.querySelector('[name="type"]').value = t.type;
  populateCategorySelect(form.querySelector('[name="category"]'), { type: t.type });
  form.querySelector('[name="category"]').value = t.category;
  form.querySelector('[name="amount"]').value = t.amount;
  form.querySelector('[name="transactionDate"]').value = t.transactionDate;
  form.querySelector('[name="note"]').value = t.note || '';
  form.querySelector('[name="status"]').value = t.status;
  form.dataset.editingId = t.id;
  document.querySelector('#financeForm button[type="submit"]').textContent = 'Lưu thay đổi';
  document.getElementById('financeCancelEditBtn').classList.remove('hidden');
  renderAttachmentEditor(t);
}
```

- [ ] **Step 7: Update `renderTransactions`' two `CATEGORY_LABELS[...]` lookups**

Replace `tdCategory.textContent = CATEGORY_LABELS[t.category] || t.category;` with `tdCategory.textContent = categoryLabel(t.category);`, and replace `pHeader.append(strong, \` — ${typeLabel} · ${CATEGORY_LABELS[t.category] || t.category}\`);` with `pHeader.append(strong, \` — ${typeLabel} · ${categoryLabel(t.category)}\`);`.

- [ ] **Step 8: Manual sanity check**

From `v4/`: `npx http-server . -p 8899 -s -c-1` (background). Open `http://localhost:8899/admin/finance.html` in a browser, log in as a manager (or use devtools to fake `/api/auth/me`), and confirm: switching "Loại" between Thu/Chi re-filters "Danh mục" to only that type's slugs; clicking a "Mặc định" toggle button highlights it and persists across a reload. Stop the server after checking.

- [ ] **Step 9: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: dynamic category filter by type + per-browser default Thu/Chi toggle"
```

---

## Task 6: Client — two-step attachment upload + display

**Files:**
- Modify: `v4/admin/finance.js`

**Interfaces:**
- Consumes: `POST/DELETE/GET /api/finance/transactions/:id/attachment` (Task 3), `categoryLabel`, `renderAttachmentEditor` (both Task 5 — `renderAttachmentEditor` is already wired into `resetFinanceForm`/`openEditTransaction`, not touched again here), `t.receiptKey`/`t.receiptFilename` (Task 2).
- Produces: submit-handler upload wiring and 📎 indicators in `renderTransactions` — no new named exports other tasks depend on.

- [ ] **Step 1: Wire the two-step upload into the submit handler**

In the `document.getElementById('financeForm').addEventListener('submit', ...)` handler, replace the block from `resetFinanceForm();` through the end of the handler (currently just `resetFinanceForm(); await loadTransactions(); if (typeof refreshFinanceSummary === 'function') refreshFinanceSummary();`) with:

```js
  const body = await response.json();
  const transactionId = editingId || body.id;
  const fileInput = form.querySelector('[name="receipt"]');
  const file = fileInput.files[0];
  if (file) {
    const uploadForm = new FormData();
    uploadForm.append('file', file);
    try {
      const uploadResponse = await fetch(`/api/finance/transactions/${transactionId}/attachment`, { method: 'POST', body: uploadForm });
      if (!uploadResponse.ok) {
        errorEl.textContent = 'Đã lưu giao dịch nhưng tải chứng từ lên thất bại — có thể thử lại bằng nút Sửa';
      }
    } catch (err) {
      errorEl.textContent = 'Đã lưu giao dịch nhưng tải chứng từ lên thất bại — có thể thử lại bằng nút Sửa';
    }
  }

  resetFinanceForm();
  await loadTransactions();
  if (typeof refreshFinanceSummary === 'function') refreshFinanceSummary();
```

(The existing `if (!response.ok) { ... return; }` block right before this stays exactly as-is — this replacement only covers what runs after a successful create/update response.)

- [ ] **Step 2: Add the 📎 indicator to the table row**

In `renderTransactions`, right after the block that builds `tdCreatedBy` (`const tdCreatedBy = document.createElement('td'); tdCreatedBy.textContent = t.createdBy; applyVoidedStyle(tdCreatedBy, t.voidedAt);`), insert:

```js
    const tdAttachment = document.createElement('td');
    if (t.receiptKey) {
      const link = document.createElement('a');
      link.href = `/api/finance/transactions/${t.id}/attachment`;
      link.target = '_blank';
      link.rel = 'noopener';
      const badge = document.createElement('span');
      badge.className = 'status-badge status-attachment';
      badge.textContent = '📎';
      link.appendChild(badge);
      tdAttachment.appendChild(link);
    }
    applyVoidedStyle(tdAttachment, t.voidedAt);
```

Then update the `tr.append(...)` line from `tr.append(tdDate, tdType, tdCategory, tdAmount, tdStatus, tdNote, tdCreatedBy, tdActions);` to:

```js
    tr.append(tdDate, tdType, tdCategory, tdAmount, tdStatus, tdNote, tdCreatedBy, tdAttachment, tdActions);
```

- [ ] **Step 3: Add the attachment link to the mobile card**

Right after `card.append(pHeader, pAmount, pNote, pCreatedBy);`, insert:

```js
    if (t.receiptKey) {
      const pAttachment = document.createElement('p');
      const link = document.createElement('a');
      link.href = `/api/finance/transactions/${t.id}/attachment`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '📎 Chứng từ';
      pAttachment.appendChild(link);
      card.appendChild(pAttachment);
    }
```

- [ ] **Step 4: Manual sanity check**

From `v4/`: `npx http-server . -p 8899 -s -c-1` (background). Log in as manager, add a transaction with a small PDF/image attached, confirm the 📎 badge appears in the list, click it to confirm the file opens, then open the row's "Sửa" form and confirm the current attachment shows with a working "Gỡ chứng từ" button. Stop the server after checking.

- [ ] **Step 5: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: two-step attachment upload, replace, remove, and list/edit display"
```

---

## Task 7: E2e coverage — categories, default toggle, attachments

**Files:**
- Modify: `LandingPage/tests/e2e/finance-dashboard.spec.js` (outer repo — `D:\VDX\HienLeGarden\LandingPage`, not `v4`)

**Interfaces:**
- Consumes: everything from Tasks 4-6 (finance.html/finance.js DOM contract).

- [ ] **Step 1: Add the new tests**

Add these `test(...)` blocks inside the existing `test.describe('Finance dashboard (sổ thu chi)', ...)` block in `tests/e2e/finance-dashboard.spec.js`, before its closing `});`:

```js
  test('category dropdown re-filters when the type changes, dropping a now-invalid selection', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await page.selectOption('#financeForm select[name="type"]', 'expense');
    await expect(page.locator('#financeForm select[name="category"] option[value="thuc_pham"]')).toHaveCount(1);
    await expect(page.locator('#financeForm select[name="category"] option[value="ban_hang"]')).toHaveCount(0);

    await page.selectOption('#financeForm select[name="type"]', 'income');
    await expect(page.locator('#financeForm select[name="category"] option[value="ban_hang"]')).toHaveCount(1);
    await expect(page.locator('#financeForm select[name="category"] option[value="thuc_pham"]')).toHaveCount(0);
  });

  test('the default Thu/Chi toggle persists across a reload via localStorage', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await page.click('#defaultTypeToggle button[data-default-type="income"]');
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);

    await page.reload();
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);
    await expect(page.locator('#financeForm select[name="type"]')).toHaveValue('income');
  });

  test('uploading a receipt file shows the 📎 indicator after the transaction is created', async ({ page }) => {
    let uploadedFilename = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...SAMPLE_TX, { id: 3, type: 'expense', category: 'vat_tu', amount: 100000, note: 'Có chứng từ', transactionDate: '2026-08-21', status: 'draft', createdBy: 'test_user', createdAt: '2026-08-21T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null, receiptKey: 'finance-receipts/3/x-bill.pdf', receiptFilename: 'bill.pdf', receiptUploadedAt: '2026-08-21T00:00:00Z' }]) });
    });
    await page.route('**/api/finance/transactions/3/attachment', (route) => {
      uploadedFilename = 'bill.pdf';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptFilename: 'bill.pdf' }) });
    });

    await page.goto('/admin/finance.html');
    await page.fill('#financeForm input[name="amount"]', '100000');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-21');
    await page.fill('#financeForm input[name="note"]', 'Có chứng từ');
    await page.setInputFiles('#financeForm input[name="receipt"]', { name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await page.click('#financeForm button[type="submit"]');

    await expect.poll(() => uploadedFilename).toBe('bill.pdf');
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Có chứng từ' })).toContainText('📎');
  });
```

- [ ] **Step 2: Run the e2e suite**

From `LandingPage/` (outer repo root): `npx playwright test tests/e2e/finance-dashboard.spec.js`
Expected: PASS (all tests in the file, 13/13 including the 3 new ones and the pre-existing 10).

- [ ] **Step 3: Commit**

```bash
cd ..
git add tests/e2e/finance-dashboard.spec.js
git commit -m "test: e2e coverage for dynamic category filter, default-type toggle, receipt upload"
```

---

## Task 8: R2 storage usage endpoint

**Files:**
- Create: `v4/functions/api/finance/receipts-usage.js`
- Create: `v4/test/financeReceiptsUsage.test.js`

**Interfaces:**
- Consumes: `env.RECEIPTS` (R2 bucket binding, Task 3), `requireAuth`.
- Produces: `GET /api/finance/receipts-usage` → `{ totalBytes: number, thresholdBytes: number, overThreshold: boolean }` — Task 9 (client) calls this.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/financeReceiptsUsage.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getReceiptsUsage } from '../functions/api/finance/receipts-usage.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_usage', 'x', 'manager', '2026-09-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_usage', 'x', 'reception', '2026-09-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_usage', 'x', 'observer', '2026-09-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  // Clear out any objects a previous test in this file left behind.
  const listing = await env.RECEIPTS.list();
  for (const obj of listing.objects) await env.RECEIPTS.delete(obj.key);
});

function authedRequest(url, token) {
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method: 'GET', headers });
}

describe('GET /api/finance/receipts-usage', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getReceiptsUsage({ request: authedRequest('https://x/api/finance/receipts-usage', null), env });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await getReceiptsUsage({ request: authedRequest('https://x/api/finance/receipts-usage', receptionToken), env });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await getReceiptsUsage({ request: authedRequest('https://x/api/finance/receipts-usage', observerToken), env });
    expect(response.status).toBe(403);
  });

  it('sums object sizes across the bucket and reports under the 9GB threshold when empty', async () => {
    const response = await getReceiptsUsage({ request: authedRequest('https://x/api/finance/receipts-usage', managerToken), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalBytes).toBe(0);
    expect(body.thresholdBytes).toBe(9 * 1024 * 1024 * 1024);
    expect(body.overThreshold).toBe(false);
  });

  it('sums multiple objects correctly', async () => {
    await env.RECEIPTS.put('finance-receipts/1/a.pdf', new Uint8Array(1000));
    await env.RECEIPTS.put('finance-receipts/2/b.pdf', new Uint8Array(2000));
    const response = await getReceiptsUsage({ request: authedRequest('https://x/api/finance/receipts-usage', managerToken), env });
    const body = await response.json();
    expect(body.totalBytes).toBe(3000);
    expect(body.overThreshold).toBe(false);
  });

  it('flags overThreshold once total bytes exceed 9GB', async () => {
    // A real 9GB+ upload isn't practical to allocate in a test process — instead, put one
    // object and directly assert the threshold math the endpoint applies, by putting an
    // object just over the line via a sparse-ish size the R2 emulator will still report
    // correctly through `.size` (Miniflare tracks size metadata, not a real byte buffer
    // of this length, so this stays fast).
    const overThresholdSize = 9 * 1024 * 1024 * 1024 + 1;
    await env.RECEIPTS.put('finance-receipts/1/big.pdf', new Uint8Array(overThresholdSize));
    const response = await getReceiptsUsage({ request: authedRequest('https://x/api/finance/receipts-usage', managerToken), env });
    const body = await response.json();
    expect(body.totalBytes).toBe(overThresholdSize);
    expect(body.overThreshold).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

`npx vitest run test/financeReceiptsUsage.test.js`
Expected: FAIL — `functions/api/finance/receipts-usage.js` doesn't exist yet.

If the `overThreshold once total bytes exceed 9GB` test is too slow or memory-heavy in the local Miniflare R2 emulator (allocating a real >9GB `Uint8Array` can exceed Node's default heap), drop that test and instead assert the threshold constant directly: `expect(body.thresholdBytes).toBe(9 * 1024 * 1024 * 1024)` in the empty-bucket test already covers the constant, and the "sums multiple objects correctly" test already proves the summation math — the endpoint's `>` comparison is a one-line, low-risk piece of arithmetic that doesn't need its own multi-gigabyte fixture. Make this call before writing the implementation, not after a slow/OOM run — check available test memory headroom by trying a smaller stand-in first (e.g. `10 * 1024 * 1024` with a threshold temporarily reasoned about, not actually reconfigured) only if genuinely unsure; otherwise just drop the large-fixture test and keep the rest.

- [ ] **Step 3: Write the endpoint**

Create `v4/functions/api/finance/receipts-usage.js`:

```js
// functions/api/finance/receipts-usage.js
import { requireAuth } from '../../../lib/requireAuth.js';

const THRESHOLD_BYTES = 9 * 1024 * 1024 * 1024; // 9GB — warn before the 10GB R2 free-tier storage limit

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  let totalBytes = 0;
  let cursor;
  do {
    const page = await env.RECEIPTS.list(cursor ? { cursor } : {});
    for (const obj of page.objects) totalBytes += obj.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return new Response(
    JSON.stringify({ totalBytes, thresholdBytes: THRESHOLD_BYTES, overThreshold: totalBytes > THRESHOLD_BYTES }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

`npx vitest run test/financeReceiptsUsage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/finance/receipts-usage.js test/financeReceiptsUsage.test.js
git commit -m "feat: add R2 receipt storage usage endpoint with 9GB warning threshold"
```

---

## Task 9: Client — storage warning banner

**Files:**
- Modify: `v4/admin/finance.js`
- Modify: `LandingPage/tests/e2e/finance-dashboard.spec.js` (outer repo)

**Interfaces:**
- Consumes: `GET /api/finance/receipts-usage` (Task 8), `#financeStorageWarning` (Task 4).

- [ ] **Step 1: Add `refreshStorageWarning` to `finance.js`**

Add this function anywhere after `refreshFinanceSummary` in `v4/admin/finance.js`:

```js
async function refreshStorageWarning() {
  if (currentRole !== 'manager' && currentRole !== 'admin') return;
  const banner = document.getElementById('financeStorageWarning');
  let response;
  try {
    response = await fetch('/api/finance/receipts-usage');
  } catch (err) {
    return; // Non-critical — a failed usage check should never block the page.
  }
  if (!response.ok) return;
  const { totalBytes, overThreshold } = await response.json();
  if (overThreshold) {
    const gb = (totalBytes / (1024 ** 3)).toFixed(1);
    banner.textContent = `⚠️ Dung lượng chứng từ đính kèm đã đạt ${gb}GB, vượt ngưỡng cảnh báo 9GB/tháng — cân nhắc xoá bớt file cũ hoặc nâng cấp gói lưu trữ R2.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}
```

Call it from the init IIFE, right after the existing `await refreshFinanceSummary();` line:

```js
  await refreshStorageWarning();
```

- [ ] **Step 2: Add the e2e test**

Add to `tests/e2e/finance-dashboard.spec.js` (outer repo), inside `test.describe('Finance dashboard (sổ thu chi)', ...)`:

```js
  test('manager sees the storage warning banner when receipt usage is over 9GB', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/receipts-usage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalBytes: 9800000000, thresholdBytes: 9663676416, overThreshold: true }) }));

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStorageWarning')).toBeVisible();
    await expect(page.locator('#financeStorageWarning')).toContainText('9GB');
  });

  test('observer never triggers a receipts-usage fetch (no banner, no request)', async ({ page }) => {
    let usageRequested = false;
    const observerSummary = { month: '2026-08', totalIncome: 2000000 };
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat_a', role: 'observer' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(observerSummary) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX.filter((t) => t.type === 'income')) }));
    await page.route('**/api/finance/receipts-usage', (route) => {
      usageRequested = true;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) });
    });

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStorageWarning')).toBeHidden();
    expect(usageRequested).toBe(false);
  });
```

- [ ] **Step 3: Run the e2e suite**

From `LandingPage/` (outer repo root): `npx playwright test tests/e2e/finance-dashboard.spec.js`
Expected: PASS (all tests in the file).

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: show storage-warning banner when R2 receipt usage exceeds 9GB"
cd ..
git add tests/e2e/finance-dashboard.spec.js
git commit -m "test: e2e coverage for the R2 storage warning banner"
```

---

## Deploy checklist (after all tasks pass final review)

Every step below requires explicit user confirmation before running — standing rule for this project.

1. Create the R2 bucket (R2 is already enabled on the account, confirmed via a successful `wrangler r2 bucket list`): `npx wrangler r2 bucket create hien-le-garden-finance-receipts` (from `v4/`).
2. Apply migration 0016 to production D1 **before** deploying dependent code, using the project's standard migration-tracking command — **not** `d1 execute --file`, which does not record the migration in D1's `d1_migrations` table and would make 0016 silently re-run (and destructively drop the `receipt_*` columns' data) the next time any later migration is applied the standard way: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (from `v4/`, matching `BACKEND.md` and every prior migration in this project).
3. Before applying, run this read-only gate against production D1 to confirm no legacy row's existing type/category pairing would be affected by the new PATCH validation (Task 2's grandfathering fix means legacy mismatches are safe to edit as long as the pairing itself isn't changed, but it's worth knowing the count going in):
   ```sql
   SELECT id, type, category FROM finance_transactions
   WHERE (type='income'  AND category NOT IN ('ban_hang','dich_vu','bep_hien_le','hien_le_drinks','hh_am_thuc_lien_ket'))
      OR (type='expense' AND category NOT IN ('cay_giong','vat_tu','nhan_cong','van_chuyen','bao_tri','thuc_pham','am_thuc_lien_ket','khac'));
   ```
4. Push `v4` branch `feat/finance-round2`, verify Cloudflare Pages deployment.
5. Push the outer repo (e2e test additions).
6. Production smoke-test: log in as manager, add a transaction with an attached receipt, confirm the 📎 indicator and file retrieval work, confirm the category dropdown filters correctly by type, confirm the default-type toggle persists, and open-then-save (without changing category) at least one of the legacy rows found by step 3's query to confirm the grandfathering fix works against real production data.
