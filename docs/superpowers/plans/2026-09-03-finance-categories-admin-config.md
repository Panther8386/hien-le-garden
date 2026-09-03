# Sổ thu chi — Danh mục cấu hình được bởi Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the finance-ledger category taxonomy from a hardcoded JS module into an Admin-manageable, D1-backed table with a CRUD admin UI, while applying two content changes (add "Giờ xanh Hiền Lê" income category, rename "Bán hàng" → "Dịch vụ khác") as part of the same migration's seed data.

**Architecture:** A new `finance_categories` D1 table replaces `lib/financeCategories.js`'s hardcoded `CATEGORY_META`; the two existing transaction endpoints load it from D1 instead of a static import. A new admin-only page (`admin/finance-categories.html`/`.js`) provides add/edit-label/hide CRUD, following the existing `admin/catalog.html` precedent exactly (role split, `is_active` soft-delete, `{ ok: true }` PATCH responses). `admin/finance.js`'s category dropdown becomes a runtime fetch instead of a hardcoded object. `finance_transactions.category`'s hardcoded CHECK-constraint enum is dropped (a second migration, same rebuild procedure as before) so newly admin-added categories are never rejected at the DB layer.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS, Vitest + `@cloudflare/vitest-pool-workers`, Playwright for e2e (outer repo).

**Spec:** `docs/superpowers/specs/2026-09-03-finance-categories-admin-config-design.md` (this plan argues from that spec; read both).

**Repos:** Backend/frontend/unit-test work happens in the `v4` repo (`D:\VDX\HienLeGarden\LandingPage\v4`, branch `main`). Task 5 and Task 6 also touch the outer repo (`D:\VDX\HienLeGarden\LandingPage`, branch `main`) for e2e coverage.

## Global Constraints

- No build step, no new frontend library — `admin/*.js` stay classic `<script>` tags.
- A category's `slug` and `type` are immutable after creation — only `label` and `isActive` can change via `PATCH`.
- "Xoá" a category means `is_active = 0` — never a hard `DELETE` row removal. No `DELETE` endpoint exists for `finance_categories`.
- Manager keeps full edit access to a transaction's `category` field — this work does not touch `PATCH /api/finance/transactions/:id`'s role list or its existing type/category-pairing "grandfathering" logic, only where that logic's category data comes from.
- `GET /api/finance/categories` — roles `manager`, `admin`, `observer`. `POST`/`PATCH` — role `admin` only.
- Every push/migrate/deploy step requires explicit user confirmation before it happens — standing rule for this project.

---

## Task 1: Migrations — `finance_categories` table + drop the transactions category CHECK

**Files:**
- Create: `v4/migrations/0018_finance_categories.sql`
- Create: `v4/migrations/0019_finance_transactions_drop_category_check.sql`
- Modify: `v4/test/migrations.test.js`

**Interfaces:**
- Produces: `finance_categories` table (`id, slug, label, type, is_active, created_by, created_at, updated_by, updated_at`), 14 seeded rows. `finance_transactions.category` becomes a plain `TEXT NOT NULL` (no enum CHECK) — Task 2 and Task 3 both rely on this.

- [ ] **Step 1: Write the failing tests**

Read `v4/test/migrations.test.js` first — it currently ends with a `describe('migration 0016', ...)` block containing a test `'still rejects an invalid category slug'` that asserts `INSERT ... category = 'not_a_real_category'` throws. That assertion is about to become **false** once migration 0019 drops the CHECK — replace that one test (delete it from the 0016 block) and add the two new `describe` blocks below, which together supersede it: 0018 proves the new table's seed is correct, 0019 proves the CHECK is gone and any category string is now accepted (validation moves entirely to the application layer, tested in Task 2).

In `v4/test/migrations.test.js`, remove this test from the `describe('migration 0016', ...)` block:

```js
  it('still rejects an invalid category slug', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('expense', 'not_a_real_category', 10000, '2026-09-01', 'draft', 'test', '2026-09-01T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });
```

Then append these two new `describe` blocks at the end of the file:

```js
describe('migration 0018', () => {
  it('seeds exactly 14 categories with the correct labels and types, including the two requested edits', async () => {
    const { results } = await env.DB.prepare(`SELECT slug, label, type, is_active FROM finance_categories ORDER BY id`).all();
    expect(results).toEqual([
      { slug: 'cay_giong', label: 'Cây giống', type: 'expense', is_active: 1 },
      { slug: 'vat_tu', label: 'Vật tư', type: 'expense', is_active: 1 },
      { slug: 'nhan_cong', label: 'Nhân công', type: 'expense', is_active: 1 },
      { slug: 'van_chuyen', label: 'Vận chuyển', type: 'expense', is_active: 1 },
      { slug: 'bao_tri', label: 'Bảo trì', type: 'expense', is_active: 1 },
      { slug: 'thuc_pham', label: 'Thực phẩm', type: 'expense', is_active: 1 },
      { slug: 'am_thuc_lien_ket', label: 'Ẩm thực liên kết', type: 'expense', is_active: 1 },
      { slug: 'khac', label: 'Chi phí khác', type: 'expense', is_active: 1 },
      { slug: 'ban_hang', label: 'Dịch vụ khác', type: 'income', is_active: 1 },
      { slug: 'dich_vu', label: 'Lưu trú Hiền Lê', type: 'income', is_active: 1 },
      { slug: 'bep_hien_le', label: 'Bếp Hiền Lê', type: 'income', is_active: 1 },
      { slug: 'hien_le_drinks', label: 'Hiền Lê Drinks', type: 'income', is_active: 1 },
      { slug: 'hh_am_thuc_lien_ket', label: 'HH Ẩm thực liên kết', type: 'income', is_active: 1 },
      { slug: 'gio_xanh_hien_le', label: 'Giờ xanh Hiền Lê', type: 'income', is_active: 1 },
    ]);
  });

  it('rejects a duplicate slug at the DB layer', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at) VALUES ('khac', 'Trùng slug', 'expense', 1, 'test', '2026-09-03T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });

  it('rejects an invalid type at the DB layer', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at) VALUES ('test_slug', 'Test', 'neither', 1, 'test', '2026-09-03T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });
});

describe('migration 0019', () => {
  it('no longer rejects an arbitrary category string at the DB layer (CHECK constraint removed)', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'a_brand_new_admin_added_category', 10000, '2026-09-03', 'draft', 'test', '2026-09-03T00:00:00Z')`
    ).run();
    expect(insert.meta.last_row_id).toBeGreaterThan(0);
  });

  it('still rejects an invalid type (unrelated CHECK, untouched by this migration)', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('neither', 'khac', 10000, '2026-09-03', 'draft', 'test', '2026-09-03T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });

  it('preserves the receipt columns and existing indexes', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 50000, '2026-09-03', 'draft', 'test', '2026-09-03T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT receipt_key, receipt_filename, receipt_uploaded_at FROM finance_transactions WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ receipt_key: null, receipt_filename: null, receipt_uploaded_at: null });
  });

  it('assigns a fresh id higher than any pre-existing row after the rebuild (sqlite_sequence preserved)', async () => {
    const before = await env.DB.prepare(`SELECT MAX(id) as maxId FROM finance_transactions`).first();
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 20000, '2026-09-03', 'draft', 'test', '2026-09-03T00:00:00Z')`
    ).run();
    expect(insert.meta.last_row_id).toBeGreaterThan(before.maxId || 0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

From `v4/`: `npx vitest run test/migrations.test.js`
Expected: FAIL — `finance_categories` table doesn't exist yet, and the CHECK-removal tests fail because the CHECK is still present.

If this is a Windows Miniflare "Isolated storage failed" teardown-only flake (no assertion failure, just a teardown error), retry the same command up to 2-3 times before treating it as real.

- [ ] **Step 3: Write migration 0018**

Create `v4/migrations/0018_finance_categories.sql`:

```sql
CREATE TABLE finance_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

CREATE INDEX idx_finance_categories_type ON finance_categories(type);

INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at) VALUES
  ('cay_giong', 'Cây giống', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('vat_tu', 'Vật tư', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('nhan_cong', 'Nhân công', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('van_chuyen', 'Vận chuyển', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('bao_tri', 'Bảo trì', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('thuc_pham', 'Thực phẩm', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('am_thuc_lien_ket', 'Ẩm thực liên kết', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('khac', 'Chi phí khác', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('ban_hang', 'Dịch vụ khác', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('dich_vu', 'Lưu trú Hiền Lê', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('bep_hien_le', 'Bếp Hiền Lê', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('hien_le_drinks', 'Hiền Lê Drinks', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('hh_am_thuc_lien_ket', 'HH Ẩm thực liên kết', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('gio_xanh_hien_le', 'Giờ xanh Hiền Lê', 'income', 1, 'system', '2026-09-03T00:00:00Z');
```

- [ ] **Step 4: Write migration 0019**

Create `v4/migrations/0019_finance_transactions_drop_category_check.sql`:

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE finance_transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category TEXT NOT NULL,
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
  (id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at, receipt_key, receipt_filename, receipt_uploaded_at)
  SELECT id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at, receipt_key, receipt_filename, receipt_uploaded_at
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

- [ ] **Step 5: Run the tests to verify they pass**

`npx vitest run test/migrations.test.js`
Expected: PASS — all tests, including the 4 new migration-0018 tests and 4 new migration-0019 tests, plus every pre-existing migration test (0016's "rejects invalid category" test is gone, its neighbors unaffected).

- [ ] **Step 6: Commit**

```bash
cd v4
git add migrations/0018_finance_categories.sql migrations/0019_finance_transactions_drop_category_check.sql test/migrations.test.js
git commit -m "feat: add finance_categories table, drop hardcoded category CHECK on finance_transactions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Backend — transaction endpoints read categories from D1

**Files:**
- Modify: `v4/lib/financeCategories.js`
- Modify: `v4/functions/api/finance/transactions/index.js`
- Modify: `v4/functions/api/finance/transactions/[id].js`
- Modify: `v4/functions/api/finance/transactions/[id]/void.js`
- Modify: `v4/test/financeTransactions.test.js`

**Interfaces:**
- Consumes: `finance_categories` table (Task 1).
- Produces: `lib/financeCategories.js` exports `loadCategoryMeta(env)` (async, returns `{ [slug]: { label, type, isActive } }`), `categoryMatchesType(categoryMeta, category, type)` (sync, pure — signature changed from the old `categoryMatchesType(category, type)`), `slugify(label)` (sync) — Task 3 imports `slugify`.

- [ ] **Step 1: Write the failing tests**

Insert into the `describe('POST /api/finance/transactions', ...)` block in `v4/test/financeTransactions.test.js`, right after the existing `'writes the renamed "Lưu trú Hiền Lê" label into the audit_log entry for a dich_vu transaction'` test:

```js
  it('writes the renamed "Dịch vụ khác" label into the audit_log entry for a ban_hang transaction', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'income', category: 'ban_hang', amount: 100000, transactionDate: '2026-09-03' }),
      env,
    });
    const body = await response.json();
    const auditRow = await env.DB.prepare(`SELECT new_value FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ?`).bind(body.id).first();
    expect(auditRow.new_value).toContain('Dịch vụ khác');
  });

  it('rejects create with an inactive category, even though the category itself is otherwise valid (400)', async () => {
    await env.DB.prepare(`UPDATE finance_categories SET is_active = 0 WHERE slug = 'khac'`).run();
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'khac', amount: 100000, transactionDate: '2026-09-03' }),
      env,
    });
    expect(response.status).toBe(400);
  });
```

Insert into the `describe('PATCH /api/finance/transactions/:id', ...)` block, right after the existing `'rejects a type/category mismatch on update, including when only type changes and category is left stale (400)'` test:

```js
  it('lets an edit succeed on a transaction whose category has since been deactivated, as long as the pairing itself is unchanged', async () => {
    // txId (from this block's beforeEach) starts as expense/vat_tu.
    await env.DB.prepare(`UPDATE finance_categories SET is_active = 0 WHERE slug = 'vat_tu'`).run();
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, managerToken, 'PATCH', { amount: 999000 }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(200);
  });

  it('rejects changing to a now-inactive category, even one of the same type (400)', async () => {
    await env.DB.prepare(`UPDATE finance_categories SET is_active = 0 WHERE slug = 'nhan_cong'`).run();
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, managerToken, 'PATCH', { category: 'nhan_cong' }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

`npx vitest run test/financeTransactions.test.js`
Expected: FAIL — the endpoints still validate against the hardcoded `lib/financeCategories.js` module (which has no `isActive` concept and no `ban_hang` → "Dịch vụ khác" rename), so the new assertions don't hold yet.

- [ ] **Step 3: Rewrite `lib/financeCategories.js`**

Replace the entire file with:

```js
// v4/lib/financeCategories.js
// Finance category metadata now lives in the `finance_categories` D1 table
// (admin-configurable via /api/finance/categories) rather than hardcoded here.
// This module is the single place the transaction endpoints (transactions/index.js,
// [id].js, [id]/void.js) load that table from. The client (admin/finance.js) fetches
// the same table over HTTP and keeps its own independent copy in memory — admin/*.js
// are classic <script> tags, not ES modules, so they cannot import this file.

export async function loadCategoryMeta(env) {
  const { results } = await env.DB.prepare(`SELECT slug, label, type, is_active FROM finance_categories`).all();
  return Object.fromEntries(results.map((r) => [r.slug, { label: r.label, type: r.type, isActive: !!r.is_active }]));
}

export function categoryMatchesType(categoryMeta, category, type) {
  const meta = categoryMeta[category];
  return !!meta && meta.type === type;
}

export function slugify(label) {
  return label
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')   // strip combining diacritics after NFD decomposition (à, ê, ộ, ...)
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')  // đ/Đ don't decompose via NFD, handled separately
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
```

- [ ] **Step 4: Update `functions/api/finance/transactions/index.js`**

Replace the import line and the `summarize`/`coerceRow` section (lines 1-36 in the current file) with:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { loadCategoryMeta, categoryMatchesType } from '../../../../lib/financeCategories.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];
const VALID_STATUSES = ['draft', 'confirmed', 'paid'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export function summarize(row, categoryMeta) {
  const typeLabel = row.type === 'income' ? 'Thu' : 'Chi';
  const label = (categoryMeta && categoryMeta[row.category] && categoryMeta[row.category].label) || row.category;
  return `${typeLabel} · ${label} · ${Number(row.amount).toLocaleString('vi-VN')}đ`;
}

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

Leave `onRequestGet` completely unchanged (it never touched categories directly). Replace `onRequestPost`'s body (everything after `const { type, category, amount, note, transactionDate, status } = body || {};`) with:

```js
  const categoryMeta = await loadCategoryMeta(env);

  if (!VALID_TYPES.includes(type)) return jsonError('Loại giao dịch không hợp lệ', 400);
  if (!categoryMeta[category]) return jsonError('Danh mục không hợp lệ', 400);
  if (!categoryMeta[category].isActive) return jsonError('Danh mục không hợp lệ', 400);
  if (!categoryMatchesType(categoryMeta, category, type)) return jsonError('Danh mục không phù hợp với loại giao dịch đã chọn', 400);
  if (!Number.isInteger(amount) || amount <= 0) return jsonError('Số tiền phải là số nguyên dương', 400);
  if (typeof transactionDate !== 'string' || !DATE_FORMAT.test(transactionDate)) return jsonError('Ngày không hợp lệ', 400);
  const resolvedStatus = status !== undefined ? status : 'draft';
  if (!VALID_STATUSES.includes(resolvedStatus)) return jsonError('Trạng thái không hợp lệ', 400);

  const now = new Date().toISOString();
  const summary = summarize({ type, category, amount }, categoryMeta);

  const insert = env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(type, category, amount, note || null, transactionDate, resolvedStatus, auth.username, now);

  const result = await insert.run();
  const newId = result.meta.last_row_id;

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('finance_transaction_create', 'finance_transaction', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, summary, summary, auth.username, now).run();

  return new Response(JSON.stringify({ id: newId, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Update `functions/api/finance/transactions/[id].js`**

Replace the import lines (lines 1-11 in the current file) with:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { summarize } from './index.js';
import { loadCategoryMeta, categoryMatchesType } from '../../../../lib/financeCategories.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];
const VALID_STATUSES = ['draft', 'confirmed', 'paid'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
```

In `onRequestPatch`, replace the block from `if (!VALID_TYPES.includes(type)) ...` through `const newSummary = summarize({ type, category, amount });` with:

```js
  const categoryMeta = await loadCategoryMeta(env);

  if (!VALID_TYPES.includes(type)) return jsonError('Loại giao dịch không hợp lệ', 400);
  if (!categoryMeta[category]) return jsonError('Danh mục không hợp lệ', 400);
  // Legacy rows, or rows whose category has since been deactivated, may already carry
  // a category the checks below would otherwise reject. Per spec, existing rows keep
  // whatever pairing/state they were saved with — only enforce isActive and the
  // type/category pairing when the resolved pair is actually a NEW choice (type
  // and/or category changed in this request), not when an edit to some other field
  // resolves back to the row's own existing pair.
  const pairingChanged = type !== existing.type || category !== existing.category;
  if (pairingChanged) {
    if (!categoryMeta[category].isActive) return jsonError('Danh mục không hợp lệ', 400);
    if (!categoryMatchesType(categoryMeta, category, type)) {
      return jsonError('Danh mục không phù hợp với loại giao dịch đã chọn', 400);
    }
  }
  if (!Number.isInteger(amount) || amount <= 0) return jsonError('Số tiền phải là số nguyên dương', 400);
  if (typeof transactionDate !== 'string' || !DATE_FORMAT.test(transactionDate)) return jsonError('Ngày không hợp lệ', 400);
  if (!VALID_STATUSES.includes(status)) return jsonError('Trạng thái không hợp lệ', 400);

  const now = new Date().toISOString();
  const oldSummary = summarize(existing, categoryMeta);
  const newSummary = summarize({ type, category, amount }, categoryMeta);
```

Everything else in the file (the `env.DB.batch([...])` call and the return statement) stays exactly as-is.

- [ ] **Step 6: Update `functions/api/finance/transactions/[id]/void.js`**

Replace the import line and add `categoryMeta` loading:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';
import { summarize } from '../index.js';
import { loadCategoryMeta } from '../../../../../lib/financeCategories.js';
```

Replace `const summary = summarize(existing);` with:

```js
  const categoryMeta = await loadCategoryMeta(env);
  const summary = summarize(existing, categoryMeta);
```

- [ ] **Step 7: Run the tests to verify they pass**

`npx vitest run test/financeTransactions.test.js`
Expected: PASS — all tests, including the 4 new ones. If you hit the known Windows Miniflare teardown flake, retry the same command a few times.

- [ ] **Step 8: Commit**

```bash
cd v4
git add lib/financeCategories.js functions/api/finance/transactions/index.js functions/api/finance/transactions/[id].js functions/api/finance/transactions/[id]/void.js test/financeTransactions.test.js
git commit -m "feat: load finance category metadata from D1 instead of a hardcoded module

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: New endpoints — category CRUD

**Files:**
- Create: `v4/functions/api/finance/categories/index.js`
- Create: `v4/functions/api/finance/categories/[id].js`
- Create: `v4/test/financeCategories.test.js`

**Interfaces:**
- Consumes: `slugify` (Task 2, `lib/financeCategories.js`).
- Produces: `GET/POST /api/finance/categories`, `PATCH /api/finance/categories/:id` — Task 4 (admin page) and Task 5 (`admin/finance.js`) both call these.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/financeCategories.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listCategories, onRequestPost as createCategory } from '../functions/api/finance/categories/index.js';
import { onRequestPatch as patchCategory } from '../functions/api/finance/categories/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_cat', 'x', 'manager', '2026-09-03T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_cat', 'x', 'reception', '2026-09-03T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_cat', 'x', 'admin', '2026-09-03T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_cat', 'x', 'observer', '2026-09-03T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/finance/categories', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listCategories({ request: new Request('https://x/api/finance/categories'), env });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await listCategories({ request: authedRequest('https://x/api/finance/categories', receptionToken, 'GET'), env });
    expect(response.status).toBe(403);
  });

  it('lets manager, admin, and observer list, including inactive rows', async () => {
    await env.DB.prepare(`UPDATE finance_categories SET is_active = 0 WHERE slug = 'khac'`).run();
    for (const token of [managerToken, adminToken, observerToken]) {
      const response = await listCategories({ request: authedRequest('https://x/api/finance/categories', token, 'GET'), env });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(14);
      const khac = body.find((c) => c.slug === 'khac');
      expect(khac.isActive).toBe(false);
    }
  });

  it('returns the exact field shape expected by clients', async () => {
    const response = await listCategories({ request: authedRequest('https://x/api/finance/categories', managerToken, 'GET'), env });
    const body = await response.json();
    const dichVu = body.find((c) => c.slug === 'dich_vu');
    expect(dichVu).toMatchObject({ slug: 'dich_vu', label: 'Lưu trú Hiền Lê', type: 'income', isActive: true });
    expect(typeof dichVu.id).toBe('number');
  });
});

describe('POST /api/finance/categories', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', null, 'POST', { label: 'Test', type: 'income' }), env });
    expect(response.status).toBe(401);
  });

  it('rejects manager (403) — creating a category is admin-only', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', managerToken, 'POST', { label: 'Test', type: 'income' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects reception (403)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', receptionToken, 'POST', { label: 'Test', type: 'income' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', observerToken, 'POST', { label: 'Test', type: 'income' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects an empty label (400)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', adminToken, 'POST', { label: '   ', type: 'income' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid type (400)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', adminToken, 'POST', { label: 'Test', type: 'neither' }), env });
    expect(response.status).toBe(400);
  });

  it('generates a Vietnamese-diacritics-stripped slug and creates the category active by default', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', adminToken, 'POST', { label: 'Sự kiện đặc biệt', type: 'income' }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.slug).toBe('su_kien_dac_biet');
    expect(body.label).toBe('Sự kiện đặc biệt');
    expect(body.type).toBe('income');
    expect(body.isActive).toBe(true);

    const row = await env.DB.prepare(`SELECT * FROM finance_categories WHERE slug = 'su_kien_dac_biet'`).first();
    expect(row.created_by).toBe('admin_cat');
    const auditRow = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'finance_category' AND action_type = 'finance_category_create'`).first();
    expect(auditRow).not.toBeNull();
  });

  it('rejects a label that generates a slug already in use, active or not (400)', async () => {
    await env.DB.prepare(`UPDATE finance_categories SET is_active = 0 WHERE slug = 'khac'`).run();
    const response = await createCategory({ request: authedRequest('https://x/api/finance/categories', adminToken, 'POST', { label: 'Chi phí khác', type: 'expense' }), env });
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/finance/categories/:id', () => {
  let categoryId;
  beforeEach(async () => {
    const row = await env.DB.prepare(`SELECT id FROM finance_categories WHERE slug = 'khac'`).first();
    categoryId = row.id;
  });

  it('rejects manager (403)', async () => {
    const response = await patchCategory({ request: authedRequest(`https://x/api/finance/categories/${categoryId}`, managerToken, 'PATCH', { label: 'Đổi tên' }), env, params: { id: String(categoryId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await patchCategory({ request: authedRequest('https://x/api/finance/categories/999999', adminToken, 'PATCH', { label: 'Đổi tên' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('edits the label only', async () => {
    const response = await patchCategory({ request: authedRequest(`https://x/api/finance/categories/${categoryId}`, adminToken, 'PATCH', { label: 'Chi phí khác (đã sửa)' }), env, params: { id: String(categoryId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT label, slug, type FROM finance_categories WHERE id = ?`).bind(categoryId).first();
    expect(row.label).toBe('Chi phí khác (đã sửa)');
    expect(row.slug).toBe('khac');   // slug never changes
    expect(row.type).toBe('expense'); // type never changes
  });

  it('toggles isActive off then back on', async () => {
    const off = await patchCategory({ request: authedRequest(`https://x/api/finance/categories/${categoryId}`, adminToken, 'PATCH', { isActive: false }), env, params: { id: String(categoryId) } });
    expect(off.status).toBe(200);
    let row = await env.DB.prepare(`SELECT is_active FROM finance_categories WHERE id = ?`).bind(categoryId).first();
    expect(row.is_active).toBe(0);

    const on = await patchCategory({ request: authedRequest(`https://x/api/finance/categories/${categoryId}`, adminToken, 'PATCH', { isActive: true }), env, params: { id: String(categoryId) } });
    expect(on.status).toBe(200);
    row = await env.DB.prepare(`SELECT is_active FROM finance_categories WHERE id = ?`).bind(categoryId).first();
    expect(row.is_active).toBe(1);
  });

  it('silently ignores type and slug in the body rather than erroring', async () => {
    const response = await patchCategory({
      request: authedRequest(`https://x/api/finance/categories/${categoryId}`, adminToken, 'PATCH', { label: 'Vẫn hợp lệ', type: 'income', slug: 'hacked_slug' }),
      env,
      params: { id: String(categoryId) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT label, slug, type FROM finance_categories WHERE id = ?`).bind(categoryId).first();
    expect(row.label).toBe('Vẫn hợp lệ');
    expect(row.slug).toBe('khac');
    expect(row.type).toBe('expense');
  });

  it('rejects an empty label (400)', async () => {
    const response = await patchCategory({ request: authedRequest(`https://x/api/finance/categories/${categoryId}`, adminToken, 'PATCH', { label: '  ' }), env, params: { id: String(categoryId) } });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

`npx vitest run test/financeCategories.test.js`
Expected: FAIL — `functions/api/finance/categories/index.js` and `[id].js` don't exist yet.

- [ ] **Step 3: Write `functions/api/finance/categories/index.js`**

```js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { slugify } from '../../../../lib/financeCategories.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];

function coerceRow(r) {
  return {
    id: r.id,
    slug: r.slug,
    label: r.label,
    type: r.type,
    isActive: !!r.is_active,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(`SELECT * FROM finance_categories ORDER BY type, id`).all();
  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { label, type } = body || {};

  if (typeof label !== 'string' || label.trim() === '') return jsonError('Tên danh mục không được để trống', 400);
  if (!VALID_TYPES.includes(type)) return jsonError('Loại danh mục không hợp lệ', 400);

  const trimmedLabel = label.trim();
  const slug = slugify(trimmedLabel);
  if (!slug) return jsonError('Tên danh mục không hợp lệ', 400);

  const existing = await env.DB.prepare(`SELECT id FROM finance_categories WHERE slug = ?`).bind(slug).first();
  if (existing) return jsonError('Danh mục với tên tương tự đã tồn tại', 400);

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at) VALUES (?, ?, ?, 1, ?, ?)`
  ).bind(slug, trimmedLabel, type, auth.username, now).run();
  const newId = insert.meta.last_row_id;

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('finance_category_create', 'finance_category', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, trimmedLabel, trimmedLabel, auth.username, now).run();

  return new Response(JSON.stringify({ id: newId, slug, label: trimmedLabel, type, isActive: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Write `functions/api/finance/categories/[id].js`**

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_categories WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy danh mục', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }

  const label = body.label !== undefined ? body.label : existing.label;
  const isActive = body.isActive !== undefined ? body.isActive : !!existing.is_active;
  // `type` and `slug` are intentionally never read from the request body — a
  // category's type and slug are immutable after creation. Silently ignoring rather
  // than erroring keeps a stray extra field in an otherwise-valid request from failing.

  if (typeof label !== 'string' || label.trim() === '') return jsonError('Tên danh mục không được để trống', 400);
  const trimmedLabel = label.trim();

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE finance_categories SET label = ?, is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(trimmedLabel, isActive ? 1 : 0, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('finance_category_update', 'finance_category', ?, ?, ?, ?, ?, ?)`
    ).bind(
      params.id,
      trimmedLabel,
      `${existing.label} (${existing.is_active ? 'active' : 'inactive'})`,
      `${trimmedLabel} (${isActive ? 'active' : 'inactive'})`,
      auth.username,
      now
    ),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

`npx vitest run test/financeCategories.test.js`
Expected: PASS — all tests.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/finance/categories/index.js functions/api/finance/categories/[id].js test/financeCategories.test.js
git commit -m "feat: add finance category CRUD endpoints (admin-only write, wider read)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: New admin page — `admin/finance-categories.html` + `.js`

**Files:**
- Create: `v4/admin/finance-categories.html`
- Create: `v4/admin/finance-categories.js`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`

**Interfaces:**
- Consumes: `GET/POST /api/finance/categories`, `PATCH /api/finance/categories/:id` (Task 3).

- [ ] **Step 1: Create `admin/finance-categories.html`**

```html
<!-- v4/admin/finance-categories.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Danh mục Sổ thu chi — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Danh mục Sổ thu chi</h1>
    <p id="pageError" class="error"></p>

    <h2>Thu</h2>
    <div class="table-scroll">
      <table id="incomeTable">
        <thead><tr><th>Tên danh mục</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <form id="incomeAddForm" class="hidden">
      <label>Tên danh mục Thu mới <input type="text" name="label" required /></label>
      <button type="submit">+ Thêm danh mục</button>
      <p id="incomeAddError" class="error"></p>
    </form>

    <h2>Chi</h2>
    <div class="table-scroll">
      <table id="expenseTable">
        <thead><tr><th>Tên danh mục</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <form id="expenseAddForm" class="hidden">
      <label>Tên danh mục Chi mới <input type="text" name="label" required /></label>
      <button type="submit">+ Thêm danh mục</button>
      <p id="expenseAddError" class="error"></p>
    </form>
  </div>

  <script src="/admin/finance-categories.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `admin/finance-categories.js`**

```js
// v4/admin/finance-categories.js
let currentRole = null;
let categories = [];

(async () => {
  let res;
  try {
    res = await fetch('/api/auth/me');
  } catch (err) {
    window.location.href = '/admin';
    return;
  }
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;

  if (currentRole === 'admin') {
    document.getElementById('incomeAddForm').classList.remove('hidden');
    document.getElementById('expenseAddForm').classList.remove('hidden');
  }

  await loadCategories();
})();

async function loadCategories() {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch('/api/finance/categories');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải danh mục';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải danh mục';
    return;
  }
  categories = await response.json();
  renderTable('income', document.querySelector('#incomeTable tbody'));
  renderTable('expense', document.querySelector('#expenseTable tbody'));
}

function renderTable(type, tbody) {
  tbody.innerHTML = '';
  categories.filter((c) => c.type === type).forEach((c) => {
    const tr = document.createElement('tr');
    if (!c.isActive) tr.style.opacity = '0.5';

    const tdLabel = document.createElement('td');
    tdLabel.textContent = c.label;

    const tdStatus = document.createElement('td');
    tdStatus.textContent = c.isActive ? 'Đang dùng' : 'Đã ẩn';

    const tdActions = document.createElement('td');
    if (currentRole === 'admin') {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Sửa tên';
      editBtn.addEventListener('click', () => editLabel(c));
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-secondary';
      toggleBtn.textContent = c.isActive ? 'Ẩn' : 'Hiện lại';
      toggleBtn.addEventListener('click', () => toggleActive(c));
      tdActions.append(editBtn, toggleBtn);
    }

    tr.append(tdLabel, tdStatus, tdActions);
    tbody.appendChild(tr);
  });
}

async function editLabel(category) {
  const newLabel = window.prompt('Tên danh mục mới:', category.label);
  if (newLabel === null) return;
  const trimmed = newLabel.trim();
  if (!trimmed || trimmed === category.label) return;

  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/finance/categories/${category.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: trimmed }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi sửa tên danh mục';
    return;
  }
  await loadCategories();
}

async function toggleActive(category) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/finance/categories/${category.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !category.isActive }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi cập nhật danh mục';
    return;
  }
  await loadCategories();
}

function wireAddForm(formId, errorId, type) {
  const form = document.getElementById(formId);
  const errorEl = document.getElementById(errorId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const label = form.querySelector('[name="label"]').value.trim();
    if (!label) {
      errorEl.textContent = 'Vui lòng nhập tên danh mục';
      return;
    }
    const response = await fetch('/api/finance/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, type }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi thêm danh mục';
      return;
    }
    form.reset();
    await loadCategories();
  });
}

wireAddForm('incomeAddForm', 'incomeAddError', 'income');
wireAddForm('expenseAddForm', 'expenseAddError', 'expense');
```

- [ ] **Step 3: Register the page in the nav drawer**

In `v4/admin/nav-drawer.js`, add a new item to the `'Cấu hình & Quản trị'` group's `items` array, right after the `catalog.html` entry:

```js
      { page: 'catalog.html', label: 'Bảng giá dịch vụ', icon: '💰', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'finance-categories.html', label: 'Danh mục Sổ thu chi', icon: '🏷️', roles: ['admin'] },
```

Add `'finance-categories.html': 'finance-categories'` to the `pageSlug` map (same line as the other entries):

```js
  const pageSlug = { 'dashboard.html': 'dashboard', 'finance.html': 'finance', 'finance-categories.html': 'finance-categories', 'customers.html': 'customers', 'templates.html': 'templates', 'manager.html': 'config', 'catalog.html': 'catalog', 'audit-log.html': 'audit-log', 'cancellation-policy.html': 'cancellation-policy', 'users.html': 'users', 'change-password.html': 'change-password' };
```

- [ ] **Step 4: Add the clean-URL redirect**

In `v4/_redirects`, add a new line right after the `/manager/finance` line:

```
/manager/finance               /admin/finance          200
/manager/finance-categories     /admin/finance-categories   200
```

- [ ] **Step 5: Manual sanity check**

From `v4/`: `npx http-server . -p 8899 -s -c-1` (background). Open `http://localhost:8899/admin/finance-categories.html`, confirm the page loads without console errors (it will redirect to `/admin` since there's no real session in a static-server context — that confirms the auth-check code path runs without throwing). Stop the server after checking.

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/finance-categories.html admin/finance-categories.js admin/nav-drawer.js _redirects
git commit -m "feat: add admin-only finance category management page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `admin/finance.js` reads categories from D1 + keep the existing e2e suite green

**Files:**
- Modify: `v4/admin/finance.js`
- Modify: `LandingPage/tests/e2e/finance-dashboard.spec.js` (outer repo — `D:\VDX\HienLeGarden\LandingPage`, not `v4`)

**Interfaces:**
- Consumes: `GET /api/finance/categories` (Task 3).
- Produces: `categoryMeta` (module-level object, replaces the old hardcoded `CATEGORY_META` constant — same `{ [slug]: { label, type } }` shape plus a new `isActive` field on each entry), `loadCategoryMeta()` (client-side async function — distinct from, and unrelated to, the same-named server-side function in `lib/financeCategories.js`; this one does a `fetch`, that one does a DB query).

**Why this task also touches the outer repo:** `admin/finance.js`'s init flow will unconditionally fetch `/api/finance/categories` on every page load. The outer repo's existing `finance-dashboard.spec.js` mocks every endpoint `finance.js` calls — without a mock for this new endpoint, every one of its ~13 pre-existing tests would see an unmocked request resolve to a real 404 from the static test server, leaving `categoryMeta` empty and breaking every assertion that depends on the category dropdown being populated. This task must land both halves together so neither repo is left with a broken test suite between commits.

- [ ] **Step 1: Update `admin/finance.js`**

Replace the hardcoded `CATEGORY_META` object (the first `const CATEGORY_META = {...};` block, lines 4-18 of the current file) with:

```js
let categoryMeta = {};

async function loadCategoryMeta() {
  try {
    const response = await fetch('/api/finance/categories');
    if (!response.ok) return;
    const rows = await response.json();
    categoryMeta = Object.fromEntries(rows.map((c) => [c.slug, { label: c.label, type: c.type, isActive: c.isActive }]));
  } catch (err) {
    // Leave categoryMeta empty on failure — category selects render empty rather
    // than throw, and categoryLabel() falls back to the raw slug for any row.
  }
}
```

Update `categoryLabel` (currently reads `CATEGORY_META`) to read the new variable:

```js
function categoryLabel(slug) {
  return categoryMeta[slug] ? categoryMeta[slug].label : slug;
}
```

Update `populateCategorySelect` so the type-filtered branch (used by the quick-add form and the edit form — never the unfiltered "all categories" filter-bar branch, which must keep showing inactive categories so users can still filter the transaction list by a category that's since been hidden) only offers active categories:

```js
function populateCategorySelect(select, { includeAllOption = false, type } = {}) {
  select.innerHTML = '';
  if (includeAllOption) {
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'Tất cả danh mục';
    select.appendChild(allOpt);
  }
  const entries = Object.entries(categoryMeta).filter(([, meta]) => !type || meta.type === type);
  if (!type) {
    // Filter bar's "all categories" case: group by type for readability. Includes
    // inactive categories on purpose — filtering the transaction list by a since-hidden
    // category (to find its old rows) must keep working.
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
  entries.filter(([, meta]) => meta.isActive).forEach(([slug, meta]) => {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = meta.label;
    select.appendChild(opt);
  });
}
```

Update `openEditTransaction`'s legacy-mismatch fallback (currently `const isLegacyMismatch = !CATEGORY_META[t.category] || CATEGORY_META[t.category].type !== t.type;`) to also fall back for a since-deactivated category, not just a type mismatch:

```js
function openEditTransaction(t) {
  const form = document.getElementById('financeForm');
  form.querySelector('[name="type"]').value = t.type;
  const select = form.querySelector('[name="category"]');
  // Legacy rows may hold a category that doesn't belong to their own type, or whose
  // category has since been deactivated by an admin — either way, a type-filtered
  // (active-only) select would silently drop such a value, leaving the select
  // unselected and blocking submit. Fall back to the unfiltered, grouped-by-type
  // option list (which includes inactive categories) so the value stays selectable.
  const meta = categoryMeta[t.category];
  const isLegacyMismatch = !meta || meta.type !== t.type || !meta.isActive;
  populateCategorySelect(select, isLegacyMismatch ? {} : { type: t.type });
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

In the page-init IIFE, add `await loadCategoryMeta();` right after `currentRole = role;` and before the first `populateCategorySelect`/`setDefaultTypePreference` call:

```js
  const { role } = await res.json();
  currentRole = role;

  await loadCategoryMeta();

  setDefaultTypePreference(defaultTypePreference());
  populateCategorySelect(document.getElementById('filterCategory'), { includeAllOption: true });
```

- [ ] **Step 2: Update the outer repo's e2e mocks**

In `tests/e2e/finance-dashboard.spec.js` (outer repo), add a `DEFAULT_CATEGORIES` fixture right after the existing `SAMPLE_TX` constant:

```js
const DEFAULT_CATEGORIES = [
  { id: 1, slug: 'cay_giong', label: 'Cây giống', type: 'expense', isActive: true },
  { id: 2, slug: 'vat_tu', label: 'Vật tư', type: 'expense', isActive: true },
  { id: 3, slug: 'nhan_cong', label: 'Nhân công', type: 'expense', isActive: true },
  { id: 4, slug: 'van_chuyen', label: 'Vận chuyển', type: 'expense', isActive: true },
  { id: 5, slug: 'bao_tri', label: 'Bảo trì', type: 'expense', isActive: true },
  { id: 6, slug: 'thuc_pham', label: 'Thực phẩm', type: 'expense', isActive: true },
  { id: 7, slug: 'am_thuc_lien_ket', label: 'Ẩm thực liên kết', type: 'expense', isActive: true },
  { id: 8, slug: 'khac', label: 'Chi phí khác', type: 'expense', isActive: true },
  { id: 9, slug: 'ban_hang', label: 'Dịch vụ khác', type: 'income', isActive: true },
  { id: 10, slug: 'dich_vu', label: 'Lưu trú Hiền Lê', type: 'income', isActive: true },
  { id: 11, slug: 'bep_hien_le', label: 'Bếp Hiền Lê', type: 'income', isActive: true },
  { id: 12, slug: 'hien_le_drinks', label: 'Hiền Lê Drinks', type: 'income', isActive: true },
  { id: 13, slug: 'hh_am_thuc_lien_ket', label: 'HH Ẩm thực liên kết', type: 'income', isActive: true },
  { id: 14, slug: 'gio_xanh_hien_le', label: 'Giờ xanh Hiền Lê', type: 'income', isActive: true },
];
```

Add a mock for the new endpoint inside `mockCommonRoutes`'s `Promise.all([...])` array (this single addition covers the ~12 tests that call `mockCommonRoutes`):

```js
    page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CATEGORIES) })),
```

Three tests build their route set manually instead of via `mockCommonRoutes` — add a matching categories mock to each:

In `'observer sees only income: ..._'` (around line 55-58), add right after the existing `page.route('**/api/finance/transactions**', ...)` line:
```js
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CATEGORIES) }));
```

In `'reception stays on the page ...'` (around line 76-79), add right after the existing `page.route('**/api/finance/transactions**', ...)` line, matching that test's all-403 pattern:
```js
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
```

In `'observer never triggers a receipts-usage fetch ...'` (around line 254-256), add right after the existing `page.route('**/api/finance/transactions**', ...)` line:
```js
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CATEGORIES) }));
```

- [ ] **Step 3: Run the full e2e suite to verify nothing broke**

From `LandingPage/` (outer repo root): `npx playwright test tests/e2e/finance-dashboard.spec.js --project=v4`
Expected: PASS — all 15 pre-existing tests still pass (now correctly mocked for the new fetch), with zero test-code changes needed to any assertion, only the new `page.route` additions.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: fetch finance categories from D1 instead of a hardcoded object

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
cd ..
git add tests/e2e/finance-dashboard.spec.js
git commit -m "test: mock the new /api/finance/categories endpoint in existing finance e2e specs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: E2e coverage for the new category admin page

**Files:**
- Create: `LandingPage/tests/e2e/finance-categories.spec.js` (outer repo)

**Interfaces:**
- Consumes: everything from Task 4 (admin page DOM contract) and Task 5 (`DEFAULT_CATEGORIES` fixture shape, though this is a new file so it defines its own local fixture rather than importing across spec files, matching this test suite's existing convention of each spec file being self-contained).

- [ ] **Step 1: Write the e2e tests**

Create `tests/e2e/finance-categories.spec.js` (outer repo):

```js
// tests/e2e/finance-categories.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_CATEGORIES = [
  { id: 1, slug: 'vat_tu', label: 'Vật tư', type: 'expense', isActive: true },
  { id: 2, slug: 'ban_hang', label: 'Dịch vụ khác', type: 'income', isActive: true },
  { id: 3, slug: 'khac', label: 'Chi phí khác', type: 'expense', isActive: false },
];

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

test.describe('Finance category management page', () => {
  test('admin sees the add forms and both grouped tables, including an inactive row shown dimmed', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));

    await page.goto('/admin/finance-categories.html');

    await expect(page.locator('#incomeAddForm')).toBeVisible();
    await expect(page.locator('#expenseAddForm')).toBeVisible();
    await expect(page.locator('#incomeTable tbody')).toContainText('Dịch vụ khác');
    await expect(page.locator('#expenseTable tbody')).toContainText('Vật tư');
    await expect(page.locator('#expenseTable tbody')).toContainText('Chi phí khác');
    await expect(page.locator('#expenseTable tbody tr', { hasText: 'Chi phí khác' })).toHaveCSS('opacity', '0.5');
  });

  test('manager (read-only) sees the tables but not the add forms or edit/toggle buttons', async ({ page }) => {
    await mockAuth(page, 'manager');
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));

    await page.goto('/admin/finance-categories.html');

    await expect(page.locator('#incomeAddForm')).toBeHidden();
    await expect(page.locator('#expenseAddForm')).toBeHidden();
    await expect(page.locator('#expenseTable tbody')).toContainText('Vật tư');
    await expect(page.locator('#expenseTable tbody button')).toHaveCount(0);
  });

  test('adding a category posts the correct payload and refreshes the list', async ({ page }) => {
    await mockAuth(page, 'admin');
    let posted = null;
    await page.route('**/api/finance/categories', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 4, slug: 'gio_xanh_hien_le', label: 'Giờ xanh Hiền Lê', type: 'income', isActive: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
    });

    await page.goto('/admin/finance-categories.html');
    await page.fill('#incomeAddForm input[name="label"]', 'Giờ xanh Hiền Lê');
    await page.click('#incomeAddForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ label: 'Giờ xanh Hiền Lê', type: 'income' });
  });

  test('toggling a category off sends isActive:false for that id', async ({ page }) => {
    await mockAuth(page, 'admin');
    let patched = null;
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));
    await page.route('**/api/finance/categories/1', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/finance-categories.html');
    await page.locator('#expenseTable tbody tr', { hasText: 'Vật tư' }).locator('button', { hasText: 'Ẩn' }).click();

    await expect.poll(() => patched).toMatchObject({ isActive: false });
  });

  test('editing a label prompts and PATCHes the new value', async ({ page }) => {
    await mockAuth(page, 'admin');
    let patched = null;
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));
    await page.route('**/api/finance/categories/1', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    page.once('dialog', (dialog) => dialog.accept('Vật tư nông nghiệp'));

    await page.goto('/admin/finance-categories.html');
    await page.locator('#expenseTable tbody tr', { hasText: 'Vật tư' }).locator('button', { hasText: 'Sửa tên' }).click();

    await expect.poll(() => patched).toMatchObject({ label: 'Vật tư nông nghiệp' });
  });

  test('reception gets a 403 error surfaced, empty tables, no add forms', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance-categories.html');

    await expect(page.locator('#pageError')).toContainText('Không đủ quyền');
    await expect(page.locator('#incomeAddForm')).toBeHidden();
    await expect(page.locator('#incomeTable tbody tr')).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the new spec**

From `LandingPage/` (outer repo root): `npx playwright test tests/e2e/finance-categories.spec.js --project=v4`
Expected: PASS — 6/6.

- [ ] **Step 3: Run the full v4 e2e project once more as a final sanity check**

`npx playwright test --project=v4`
Expected: PASS — every test in the v4 project, including `finance-dashboard.spec.js` (Task 5) and the new `finance-categories.spec.js`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/finance-categories.spec.js
git commit -m "test: e2e coverage for the finance category admin page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (after all tasks pass final review)

Every step below requires explicit user confirmation before running — standing rule for this project.

1. Apply migrations 0018 and 0019 to production D1, in order, using the standard tracked-migration command (not `d1 execute --file`, which does not record a migration in `d1_migrations` and would let it silently re-run later): `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (from `v4/`) — this applies both pending migrations in one call.
2. Push `v4` (branch `main`), verify Cloudflare Pages deployment.
3. Push the outer repo (e2e test additions).
4. Production smoke-test: as Admin, open the new "Danh mục Sổ thu chi" page from the nav drawer, confirm the 14 categories list correctly (including "Giờ xanh Hiền Lê" under Thu and "Dịch vụ khác" where "Bán hàng" used to be), add a test category, confirm it appears immediately in the Sổ thu chi quick-add dropdown after a reload, then hide it again and confirm it disappears from the dropdown but any transaction still using it (if created during this smoke test) still displays its label correctly.
