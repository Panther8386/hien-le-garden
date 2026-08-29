# Finance Dashboard (Sổ thu chi) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual daily income/expense ledger to Hiền Lê Garden V4's admin area — record thu/chi transactions with categories, notes, dates, and a workflow status; show a real-time balance summary (opening/closing balance, totals, profit), a hand-drawn chart, and a filterable transaction list.

**Architecture:** New D1 tables (`finance_transactions`, `finance_opening_balance`) + new Cloudflare Pages Functions under `functions/api/finance/`, following every existing V4 convention exactly (`requireAuth`, `jsonError`, insert-only settings pattern, soft-delete-only, `audit_log` writes via `env.DB.batch`). New admin page `admin/finance.html`/`finance.js`, vanilla JS, no new libraries, registered into the existing nav-drawer/`_redirects` system.

**Tech Stack:** Cloudflare Pages Functions (D1/SQLite), vanilla JS admin frontend, vitest (`@cloudflare/vitest-pool-workers`) for API tests, Playwright for e2e — identical to every other feature in this codebase. No new dependency of any kind.

**Spec:** `docs/specs/2026-08-29-finance-dashboard-design.md`

## Global Constraints

- No new client-side library or framework of any kind (no chart library) — hand-drawn inline SVG only.
- `finance_opening_balance` is **insert-only**: writing a value always `INSERT`s a new row; reading uses `ORDER BY id DESC LIMIT 1` (or `ORDER BY period DESC, id DESC LIMIT 1` when finding the latest row at-or-before a period). Never `UPDATE` this table.
- `status` (`draft`/`confirmed`/`paid`) and void (`voided_by`/`voided_at`) are independent axes on `finance_transactions` — voiding never changes `status`, and a voided row is simply excluded from every balance/total computation by its `voided_at IS NULL` filter.
- Only rows with `status IN ('confirmed', 'paid')` AND `voided_at IS NULL` count toward `totalIncome`/`totalExpense`/balances. Draft rows are stored and listed but never counted.
- `category` is one shared, fixed list of exactly 8 slugs used identically for both `income` and `expense`: `cay_giong`, `vat_tu`, `nhan_cong`, `van_chuyen`, `bao_tri`, `ban_hang`, `dich_vu`, `khac`.
- `amount` is a positive integer VND value (`Number.isInteger(amount) && amount > 0`) — no floats, matching every existing money column in this codebase.
- No hard `DELETE` anywhere in this feature.
- Roles: `GET` (read) endpoints allow `manager`, `admin`, `observer`. `POST`/`PATCH` (write) endpoints allow only `manager`, `admin`. `reception` gets 401/403 from every endpoint here and the admin page itself is not linked or reachable for that role (no `_redirects` entry under `/reception/`).
- Error responses are always `{ "error": "<Vietnamese message>" }`, matching the `jsonError` helper pattern used in every existing endpoint file.
- Acting on a transaction that doesn't exist at all → `404`. Acting on one that exists but is already voided → `400` (this codebase's exact existing convention, confirmed in `functions/api/bookings/[id]/services/[itemId].js` — **not** `404` for the already-voided case).
- Every write (create/update/void a transaction, set an opening balance) inserts one `audit_log` row in the same `env.DB.batch([...])` as the primary write, matching `functions/api/bookings/[id]/deposit.js`'s exact pattern: `action_type`, `entity_type`, `entity_id`, `entity_label`, `old_value`, `new_value`, `actor` (= `auth.username`), `created_at`.
- Balances are always computed live from current rows on every request — nothing is cached or stored as a running total.
- Full-suite test runs on this Windows dev machine should use `npm test` (which runs `node scripts/test-with-retry.js`) rather than raw `npx vitest run` for the whole suite — that script already retries automatically past the known Windows-only Miniflare infra crashes (a WAL teardown race and a `vite-node/client` misresolution), exiting immediately on any *real* `"N failed"` assertion failure. Single-file runs (`npx vitest run test/specificFile.test.js`) are reliable enough directly and don't need the wrapper, though using it is never wrong.

---

### Task 1: Migration + list/create transaction endpoints

**Files:**
- Create: `migrations/0015_finance_transactions.sql`
- Create: `functions/api/finance/transactions/index.js`
- Test: `test/financeTransactions.test.js`

**Interfaces:**
- Produces: table `finance_transactions` (columns per spec §4); `GET /api/finance/transactions` (query: `from`, `to`, `type`, `category`, `status`, `q`, all optional) returning a JSON array of `{id, type, category, amount, note, transactionDate, status, createdBy, createdAt, updatedBy, updatedAt, voidedBy, voidedAt}`; `POST /api/finance/transactions` (body: `{type, category, amount, note?, transactionDate, status?}`) returning `201 {id, ok: true}`.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0015_finance_transactions.sql
CREATE TABLE finance_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category TEXT NOT NULL CHECK (category IN ('cay_giong', 'vat_tu', 'nhan_cong', 'van_chuyen', 'bao_tri', 'ban_hang', 'dich_vu', 'khac')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  transaction_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'paid')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  voided_by TEXT,
  voided_at TEXT
);
CREATE INDEX idx_finance_transactions_date ON finance_transactions(transaction_date);
CREATE INDEX idx_finance_transactions_status ON finance_transactions(status);

CREATE TABLE finance_opening_balance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  opening_balance INTEGER NOT NULL,
  set_by TEXT,
  set_at TEXT NOT NULL
);
CREATE INDEX idx_finance_opening_balance_period ON finance_opening_balance(period);
```

(Both tables are created together here — `finance_opening_balance` has no endpoint yet until Task 4, but creating it now avoids a second migration file and lets Task 1's own tests seed rows into it if ever needed later without a schema gap.)

- [ ] **Step 2: Apply the migration locally**

Run: `cd v4 && npx wrangler d1 migrations apply hien_le_garden_crm --local`
Expected: `0015_finance_transactions.sql` listed as applied, no errors. (`hien_le_garden_crm` is this project's D1 database name, confirmed in `wrangler.toml`'s `[[d1_databases]]` block — this is the exact same database name used for every prior migration this session, both `--local` and `--remote`.)

- [ ] **Step 3: Write the failing tests**

```js
// test/financeTransactions.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listTransactions, onRequestPost as createTransaction } from '../functions/api/finance/transactions/index.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM finance_transactions');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_fin', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_fin', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_fin', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_fin', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
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

describe('POST /api/finance/transactions', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await createTransaction({ request: new Request('https://x/api/finance/transactions', { method: 'POST' }), env });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', receptionToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 100000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', observerToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 100000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(403);
  });

  it('rejects an invalid type (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'other', category: 'vat_tu', amount: 100000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid category (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'unknown', amount: 100000, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a non-positive amount (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 0, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a non-integer amount (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 100.5, transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed transactionDate (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 100000, transactionDate: '29-08-2026' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid status when provided (400)', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 100000, transactionDate: '2026-08-29', status: 'archived' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('creates a transaction as manager, defaulting status to draft, and writes an audit_log row', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', managerToken, 'POST', { type: 'expense', category: 'vat_tu', amount: 500000, note: 'Mua phân bón', transactionDate: '2026-08-29' }),
      env,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);

    const row = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(body.id).first();
    expect(row.type).toBe('expense');
    expect(row.category).toBe('vat_tu');
    expect(row.amount).toBe(500000);
    expect(row.note).toBe('Mua phân bón');
    expect(row.transaction_date).toBe('2026-08-29');
    expect(row.status).toBe('draft');
    expect(row.created_by).toBe('quan_ly_fin');
    expect(row.voided_at).toBeNull();

    const auditRow = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ?`).bind(body.id).first();
    expect(auditRow).not.toBeNull();
    expect(auditRow.action_type).toBe('finance_transaction_create');
    expect(auditRow.actor).toBe('quan_ly_fin');
    expect(auditRow.old_value).toBeNull();
  });

  it('lets admin create with an explicit status', async () => {
    const response = await createTransaction({
      request: authedRequest('https://x/api/finance/transactions', adminToken, 'POST', { type: 'income', category: 'ban_hang', amount: 2000000, transactionDate: '2026-08-29', status: 'paid' }),
      env,
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT status FROM finance_transactions WHERE id = ?`).bind(body.id).first();
    expect(row.status).toBe('paid');
  });
});

describe('GET /api/finance/transactions', () => {
  beforeEach(async () => {
    await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('expense', 'vat_tu', 100000, 'Vật tư A', '2026-08-01', 'confirmed', 'quan_ly_fin', '2026-08-01T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 3000000, 'Bán rau', '2026-08-15', 'paid', 'admin_fin', '2026-08-15T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at, voided_by, voided_at) VALUES ('expense', 'nhan_cong', 200000, 'Công cắt cỏ', '2026-08-20', 'confirmed', 'quan_ly_fin', '2026-08-20T00:00:00Z', 'admin_fin', '2026-08-21T00:00:00Z')`
    ).run();
  });

  it('rejects unauthenticated requests', async () => {
    const response = await listTransactions({ request: new Request('https://x/api/finance/transactions'), env });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', receptionToken, 'GET'), env });
    expect(response.status).toBe(403);
  });

  it('lets observer list (read-only role)', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', observerToken, 'GET'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(3);
  });

  it('includes voided transactions in the list (UI shows them struck-through)', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    const voided = body.find((t) => t.note === 'Công cắt cỏ');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidedBy).toBe('admin_fin');
  });

  it('orders newest transaction_date first', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((t) => t.transactionDate)).toEqual(['2026-08-20', '2026-08-15', '2026-08-01']);
  });

  it('filters by type', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?type=income', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('filters by category', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?category=nhan_cong', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((t) => t.note)).toEqual(['Công cắt cỏ']);
  });

  it('filters by status', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?status=paid', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('filters by date range', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?from=2026-08-10&to=2026-08-16', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('filters by keyword against note, case-insensitively', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?q=rau', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((t) => t.note)).toEqual(['Bán rau']);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd v4 && npx vitest run test/financeTransactions.test.js`
Expected: FAIL — `functions/api/finance/transactions/index.js` doesn't exist yet.

- [ ] **Step 5: Implement the endpoint**

```js
// functions/api/finance/transactions/index.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];
const VALID_CATEGORIES = ['cay_giong', 'vat_tu', 'nhan_cong', 'van_chuyen', 'bao_tri', 'ban_hang', 'dich_vu', 'khac'];
const VALID_STATUSES = ['draft', 'confirmed', 'paid'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

const CATEGORY_LABELS = {
  cay_giong: 'Cây giống',
  vat_tu: 'Vật tư',
  nhan_cong: 'Nhân công',
  van_chuyen: 'Vận chuyển',
  bao_tri: 'Bảo trì',
  ban_hang: 'Bán hàng',
  dich_vu: 'Dịch vụ',
  khac: 'Chi phí khác',
};

export function summarize(row) {
  const typeLabel = row.type === 'income' ? 'Thu' : 'Chi';
  return `${typeLabel} · ${CATEGORY_LABELS[row.category] || row.category} · ${Number(row.amount).toLocaleString('vi-VN')}đ`;
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
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const type = url.searchParams.get('type');
  const category = url.searchParams.get('category');
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');

  const clauses = [];
  const params = [];
  if (from) { clauses.push('transaction_date >= ?'); params.push(from); }
  if (to) { clauses.push('transaction_date <= ?'); params.push(to); }
  if (type) { clauses.push('type = ?'); params.push(type); }
  if (category) { clauses.push('category = ?'); params.push(category); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (q) { clauses.push('note LIKE ? COLLATE NOCASE'); params.push(`%${q}%`); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(
    `SELECT * FROM finance_transactions ${where} ORDER BY transaction_date DESC, id DESC`
  ).bind(...params).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { type, category, amount, note, transactionDate, status } = body || {};

  if (!VALID_TYPES.includes(type)) return jsonError('Loại giao dịch không hợp lệ', 400);
  if (!VALID_CATEGORIES.includes(category)) return jsonError('Danh mục không hợp lệ', 400);
  if (!Number.isInteger(amount) || amount <= 0) return jsonError('Số tiền phải là số nguyên dương', 400);
  if (typeof transactionDate !== 'string' || !DATE_FORMAT.test(transactionDate)) return jsonError('Ngày không hợp lệ', 400);
  const resolvedStatus = status !== undefined ? status : 'draft';
  if (!VALID_STATUSES.includes(resolvedStatus)) return jsonError('Trạng thái không hợp lệ', 400);

  const now = new Date().toISOString();
  const summary = summarize({ type, category, amount });

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

(Note: the INSERT and the audit_log INSERT are two sequential `.run()` calls rather than one `env.DB.batch([...])`, because the audit row needs the newly generated `id` from the first insert's `result.meta.last_row_id` — `env.DB.batch` runs all statements without letting a later one read an earlier one's result. Tasks 2 and 3, which update/void an *existing* row whose id is already known upfront, use `env.DB.batch([...])` for the primary write + audit write together, matching `deposit.js`'s exact pattern.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd v4 && npx vitest run test/financeTransactions.test.js`
Expected: PASS, all tests. Retry once or twice if you hit the documented Windows infra flake (a crash with an "Errors" count, never a real "N failed" line).

- [ ] **Step 7: Commit**

```bash
cd v4
git add migrations/0015_finance_transactions.sql functions/api/finance/transactions/index.js test/financeTransactions.test.js
git commit -m "feat: add finance_transactions schema and list/create endpoints"
```

---

### Task 2: Update + void transaction endpoints

**Files:**
- Create: `functions/api/finance/transactions/[id].js`
- Create: `functions/api/finance/transactions/[id]/void.js`
- Test: `test/financeTransactions.test.js` (extend)

**Interfaces:**
- Consumes: `summarize(row)` from Task 1 (`functions/api/finance/transactions/index.js`) — exported for reuse so the "before"/"after" audit summaries here match the exact same format Task 1's create-audit-log used.
- Produces: `PATCH /api/finance/transactions/:id` (partial update, body: any subset of `{type, category, amount, note, transactionDate, status}`) → `200 {ok: true}`; `PATCH /api/finance/transactions/:id/void` (no body) → `200 {ok: true}`.

**Cloudflare Pages Functions routing note:** `functions/api/finance/transactions/[id].js` (a FILE) will coexist in the same parent directory as `functions/api/finance/transactions/[id]/` (a DIRECTORY, containing `void.js`). This exact file+directory coexistence pattern was already verified twice via a live `npx wrangler pages dev . --d1=DB` process for an earlier V4 feature (`functions/api/catalog/[id].js` alongside `functions/api/catalog/[id]/`) and confirmed to route correctly — no fresh investigation is needed, but Step 6 below includes one confirming `curl` check against a running `wrangler pages dev` as cheap insurance before considering this task done.

- [ ] **Step 1: Write the failing tests**

Add these `describe` blocks to the end of `test/financeTransactions.test.js` (after the existing `describe('GET /api/finance/transactions', ...)` block). Add the two new imports at the top of the file alongside the existing ones:

```js
import { onRequestPatch as patchTransaction } from '../functions/api/finance/transactions/[id].js';
import { onRequestPatch as voidTransaction } from '../functions/api/finance/transactions/[id]/void.js';
```

```js
describe('PATCH /api/finance/transactions/:id', () => {
  let txId;
  beforeEach(async () => {
    const result = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('expense', 'vat_tu', 100000, 'Vật tư gốc', '2026-08-01', 'draft', 'quan_ly_fin', '2026-08-01T00:00:00Z')`
    ).run();
    txId = result.meta.last_row_id;
  });

  it('rejects reception (403)', async () => {
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, receptionToken, 'PATCH', { amount: 150000 }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, observerToken, 'PATCH', { amount: 150000 }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/999999`, managerToken, 'PATCH', { amount: 150000 }),
      env,
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
  });

  it('partially updates only the given fields, keeping the rest, and stamps updated_by/updated_at', async () => {
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, managerToken, 'PATCH', { amount: 250000, status: 'confirmed' }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(txId).first();
    expect(row.amount).toBe(250000);
    expect(row.status).toBe('confirmed');
    expect(row.category).toBe('vat_tu');
    expect(row.note).toBe('Vật tư gốc');
    expect(row.updated_by).toBe('quan_ly_fin');
    expect(row.updated_at).not.toBeNull();
  });

  it('rejects an invalid amount on update (400)', async () => {
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, managerToken, 'PATCH', { amount: -5 }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(400);
  });

  it('writes an audit_log row with before/after summaries', async () => {
    await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, adminToken, 'PATCH', { amount: 300000 }),
      env,
      params: { id: String(txId) },
    });
    const auditRow = await env.DB.prepare(
      `SELECT * FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ? AND action_type = 'finance_transaction_update'`
    ).bind(txId).first();
    expect(auditRow).not.toBeNull();
    expect(auditRow.old_value).toContain('100.000');
    expect(auditRow.new_value).toContain('300.000');
    expect(auditRow.actor).toBe('admin_fin');
  });

  it('400s when trying to edit an already-voided transaction', async () => {
    await env.DB.prepare(`UPDATE finance_transactions SET voided_by = ?, voided_at = ? WHERE id = ?`).bind('admin_fin', '2026-08-02T00:00:00Z', txId).run();
    const response = await patchTransaction({
      request: authedRequest(`https://x/api/finance/transactions/${txId}`, managerToken, 'PATCH', { amount: 1 }),
      env,
      params: { id: String(txId) },
    });
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/finance/transactions/:id/void', () => {
  let txId;
  beforeEach(async () => {
    const result = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 400000, 'Bán chuối', '2026-08-05', 'confirmed', 'quan_ly_fin', '2026-08-05T00:00:00Z')`
    ).run();
    txId = result.meta.last_row_id;
  });

  it('rejects reception (403)', async () => {
    const response = await voidTransaction({ request: authedRequest(`https://x/api/finance/transactions/${txId}/void`, receptionToken, 'PATCH', {}), env, params: { id: String(txId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await voidTransaction({ request: authedRequest(`https://x/api/finance/transactions/999999/void`, managerToken, 'PATCH', {}), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('voids a transaction, stamping voided_by/voided_at, and writes an audit_log row', async () => {
    const response = await voidTransaction({ request: authedRequest(`https://x/api/finance/transactions/${txId}/void`, adminToken, 'PATCH', {}), env, params: { id: String(txId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(txId).first();
    expect(row.voided_by).toBe('admin_fin');
    expect(row.voided_at).not.toBeNull();
    expect(row.status).toBe('confirmed');

    const auditRow = await env.DB.prepare(
      `SELECT * FROM audit_log WHERE entity_type = 'finance_transaction' AND entity_id = ? AND action_type = 'finance_transaction_void'`
    ).bind(txId).first();
    expect(auditRow).not.toBeNull();
    expect(auditRow.new_value).toBeNull();
  });

  it('400s when voiding an already-voided transaction', async () => {
    await voidTransaction({ request: authedRequest(`https://x/api/finance/transactions/${txId}/void`, managerToken, 'PATCH', {}), env, params: { id: String(txId) } });
    const response = await voidTransaction({ request: authedRequest(`https://x/api/finance/transactions/${txId}/void`, managerToken, 'PATCH', {}), env, params: { id: String(txId) } });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd v4 && npx vitest run test/financeTransactions.test.js`
Expected: FAIL — the two new files don't exist yet.

- [ ] **Step 3: Implement `functions/api/finance/transactions/[id].js`**

```js
// functions/api/finance/transactions/[id].js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { summarize } from './index.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_TYPES = ['income', 'expense'];
const VALID_CATEGORIES = ['cay_giong', 'vat_tu', 'nhan_cong', 'van_chuyen', 'bao_tri', 'ban_hang', 'dich_vu', 'khac'];
const VALID_STATUSES = ['draft', 'confirmed', 'paid'];
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy giao dịch', 404);
  if (existing.voided_at) return jsonError('Giao dịch này đã bị huỷ, không thể sửa', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }

  const type = body.type !== undefined ? body.type : existing.type;
  const category = body.category !== undefined ? body.category : existing.category;
  const amount = body.amount !== undefined ? body.amount : existing.amount;
  const note = body.note !== undefined ? body.note : existing.note;
  const transactionDate = body.transactionDate !== undefined ? body.transactionDate : existing.transaction_date;
  const status = body.status !== undefined ? body.status : existing.status;

  if (!VALID_TYPES.includes(type)) return jsonError('Loại giao dịch không hợp lệ', 400);
  if (!VALID_CATEGORIES.includes(category)) return jsonError('Danh mục không hợp lệ', 400);
  if (!Number.isInteger(amount) || amount <= 0) return jsonError('Số tiền phải là số nguyên dương', 400);
  if (typeof transactionDate !== 'string' || !DATE_FORMAT.test(transactionDate)) return jsonError('Ngày không hợp lệ', 400);
  if (!VALID_STATUSES.includes(status)) return jsonError('Trạng thái không hợp lệ', 400);

  const now = new Date().toISOString();
  const oldSummary = summarize(existing);
  const newSummary = summarize({ type, category, amount });

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE finance_transactions SET type = ?, category = ?, amount = ?, note = ?, transaction_date = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).bind(type, category, amount, note || null, transactionDate, status, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('finance_transaction_update', 'finance_transaction', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, newSummary, oldSummary, newSummary, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Implement `functions/api/finance/transactions/[id]/void.js`**

```js
// functions/api/finance/transactions/[id]/void.js
import { requireAuth } from '../../../../../lib/requireAuth.js';
import { summarize } from '../index.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy giao dịch', 404);
  if (existing.voided_at) return jsonError('Giao dịch này đã được huỷ trước đó', 400);

  const now = new Date().toISOString();
  const summary = summarize(existing);

  await env.DB.batch([
    env.DB.prepare(`UPDATE finance_transactions SET voided_by = ?, voided_at = ? WHERE id = ?`).bind(auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('finance_transaction_void', 'finance_transaction', ?, ?, ?, NULL, ?, ?)`
    ).bind(params.id, summary, summary, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd v4 && npx vitest run test/financeTransactions.test.js`
Expected: PASS, all tests (original Task 1 tests plus all new ones in this task).

- [ ] **Step 6: Confirm the file+directory routing coexistence with a live server**

```bash
cd v4
npx wrangler pages dev . --d1=DB &
# wait a few seconds for it to come up, then:
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://localhost:8788/api/finance/transactions/1
curl -s -o /dev/null -w "%{http_code}\n" -X PATCH http://localhost:8788/api/finance/transactions/1/void
```
Expected: both return `401` (not logged in — proves both routes resolve to real handlers, not a 404/routing conflict). Stop the `wrangler pages dev` process afterward.

- [ ] **Step 7: Commit**

```bash
cd v4
git add "functions/api/finance/transactions/[id].js" "functions/api/finance/transactions/[id]/void.js" test/financeTransactions.test.js
git commit -m "feat: add finance transaction update and void endpoints"
```

---

### Task 3: Summary endpoint (opening-balance carry-forward algorithm)

**Files:**
- Create: `functions/api/finance/summary.js`
- Test: `test/financeSummary.test.js`

**Interfaces:**
- Consumes: `finance_transactions`, `finance_opening_balance` tables (schema from Task 1).
- Produces: `GET /api/finance/summary?month=YYYY-MM` → `200 {month, openingBalance, openingBalanceSource, totalIncome, totalExpense, netChange, closingBalance}`. `openingBalanceSource` is exactly one of `'manual'`, `'carried_forward'`, `'default_zero'`. Later tasks (the admin page) read this response shape directly.

- [ ] **Step 1: Write the failing tests**

```js
// test/financeSummary.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getSummary } from '../functions/api/finance/summary.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM finance_transactions');
  await env.DB.exec('DELETE FROM finance_opening_balance');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_sum', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_sum', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_sum', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);
});

function authedRequest(url, token, method) {
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers });
}

async function insertTx({ type, category, amount, date, status = 'confirmed', voided = false }) {
  await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at, voided_by, voided_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'quan_ly_sum', '2026-08-01T00:00:00Z', ?, ?)`
  ).bind(type, category, amount, date, status, voided ? 'quan_ly_sum' : null, voided ? '2026-08-01T00:00:00Z' : null).run();
}

describe('GET /api/finance/summary', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getSummary({ request: new Request('https://x/api/finance/summary?month=2026-08'), env });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', receptionToken, 'GET'), env });
    expect(response.status).toBe(403);
  });

  it('lets observer read', async () => {
    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', observerToken, 'GET'), env });
    expect(response.status).toBe(200);
  });

  it('rejects a malformed month (400)', async () => {
    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-8', managerToken, 'GET'), env });
    expect(response.status).toBe(400);
  });

  it('rejects a missing month (400)', async () => {
    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary', managerToken, 'GET'), env });
    expect(response.status).toBe(400);
  });

  it('defaults to a zero opening balance when no manual value was ever set and there are no earlier transactions', async () => {
    await insertTx({ type: 'income', category: 'ban_hang', amount: 1000000, date: '2026-08-10' });
    await insertTx({ type: 'expense', category: 'vat_tu', amount: 300000, date: '2026-08-15' });

    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.openingBalanceSource).toBe('default_zero');
    expect(body.openingBalance).toBe(0);
    expect(body.totalIncome).toBe(1000000);
    expect(body.totalExpense).toBe(300000);
    expect(body.netChange).toBe(700000);
    expect(body.closingBalance).toBe(700000);
  });

  it('excludes draft transactions and voided transactions from totals', async () => {
    await insertTx({ type: 'income', category: 'ban_hang', amount: 1000000, date: '2026-08-10', status: 'confirmed' });
    await insertTx({ type: 'income', category: 'ban_hang', amount: 500000, date: '2026-08-11', status: 'draft' });
    await insertTx({ type: 'expense', category: 'vat_tu', amount: 200000, date: '2026-08-12', status: 'confirmed', voided: true });

    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.totalIncome).toBe(1000000);
    expect(body.totalExpense).toBe(0);
  });

  it('uses a manually-set opening balance for the exact requested month', async () => {
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-08', 5000000, 'quan_ly_sum', '2026-08-01T00:00:00Z')`).run();
    await insertTx({ type: 'income', category: 'ban_hang', amount: 1000000, date: '2026-08-10' });

    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.openingBalanceSource).toBe('manual');
    expect(body.openingBalance).toBe(5000000);
    expect(body.closingBalance).toBe(6000000);
  });

  it('carries forward from the most recent earlier manual value, summing all confirmed/paid transactions in between', async () => {
    // manual value set for June; no manual value for July or August
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-06', 2000000, 'quan_ly_sum', '2026-06-01T00:00:00Z')`).run();
    await insertTx({ type: 'income', category: 'ban_hang', amount: 1000000, date: '2026-06-15' }); // June: +1,000,000
    await insertTx({ type: 'expense', category: 'vat_tu', amount: 400000, date: '2026-07-05' });   // July: -400,000
    await insertTx({ type: 'income', category: 'dich_vu', amount: 300000, date: '2026-07-20' });   // July: +300,000
    await insertTx({ type: 'income', category: 'ban_hang', amount: 900000, date: '2026-08-05' });  // August (this month itself, not part of carry-forward)

    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    // openingBalance(Aug) = 2,000,000 (June anchor) + 1,000,000 (June txns) - 400,000 + 300,000 (July txns) = 2,900,000
    expect(body.openingBalanceSource).toBe('carried_forward');
    expect(body.openingBalance).toBe(2900000);
    expect(body.totalIncome).toBe(900000);
    expect(body.totalExpense).toBe(0);
    expect(body.closingBalance).toBe(3800000);
  });

  it('when a manual value exists for the exact month, ignores any earlier manual value (no double-carrying)', async () => {
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-06', 100, 'quan_ly_sum', '2026-06-01T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-08', 999000, 'quan_ly_sum', '2026-08-01T00:00:00Z')`).run();
    await insertTx({ type: 'expense', category: 'vat_tu', amount: 50000, date: '2026-07-10' }); // should NOT be subtracted; Aug has its own manual value

    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.openingBalanceSource).toBe('manual');
    expect(body.openingBalance).toBe(999000);
  });

  it('insert-only: the latest inserted row for a period wins even if an older row for the same period exists', async () => {
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-08', 1000, 'quan_ly_sum', '2026-08-01T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-08', 2000, 'quan_ly_sum', '2026-08-02T00:00:00Z')`).run();

    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.openingBalance).toBe(2000);
  });

  it('supports a negative opening balance', async () => {
    await env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-08', -300000, 'quan_ly_sum', '2026-08-01T00:00:00Z')`).run();
    const response = await getSummary({ request: authedRequest('https://x/api/finance/summary?month=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.openingBalance).toBe(-300000);
    expect(body.closingBalance).toBe(-300000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd v4 && npx vitest run test/financeSummary.test.js`
Expected: FAIL — `functions/api/finance/summary.js` doesn't exist yet.

- [ ] **Step 3: Implement the endpoint**

```js
// functions/api/finance/summary.js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const MONTH_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthStart(month) {
  return `${month}-01`;
}

async function sumIncomeExpense(env, fromDateInclusive, toDateExclusive) {
  const clauses = [`status IN ('confirmed', 'paid')`, `voided_at IS NULL`];
  const params = [];
  if (fromDateInclusive) { clauses.push('transaction_date >= ?'); params.push(fromDateInclusive); }
  if (toDateExclusive) { clauses.push('transaction_date < ?'); params.push(toDateExclusive); }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const incomeRow = await env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM finance_transactions ${where} AND type = 'income'`).bind(...params).first();
  const expenseRow = await env.DB.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM finance_transactions ${where} AND type = 'expense'`).bind(...params).first();
  return { income: incomeRow.total, expense: expenseRow.total };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const month = url.searchParams.get('month');
  if (!month || !MONTH_FORMAT.test(month)) {
    return jsonError('Tháng không hợp lệ, dùng định dạng YYYY-MM', 400);
  }

  const anchorRow = await env.DB.prepare(
    `SELECT period, opening_balance FROM finance_opening_balance WHERE period <= ? ORDER BY period DESC, id DESC LIMIT 1`
  ).bind(month).first();

  let openingBalance;
  let openingBalanceSource;
  if (!anchorRow) {
    const { income, expense } = await sumIncomeExpense(env, null, monthStart(month));
    openingBalance = income - expense;
    openingBalanceSource = 'default_zero';
  } else if (anchorRow.period === month) {
    openingBalance = anchorRow.opening_balance;
    openingBalanceSource = 'manual';
  } else {
    const { income, expense } = await sumIncomeExpense(env, monthStart(anchorRow.period), monthStart(month));
    openingBalance = anchorRow.opening_balance + income - expense;
    openingBalanceSource = 'carried_forward';
  }

  const { income: totalIncome, expense: totalExpense } = await sumIncomeExpense(env, monthStart(month), monthStart(nextMonth(month)));
  const netChange = totalIncome - totalExpense;
  const closingBalance = openingBalance + netChange;

  return new Response(
    JSON.stringify({ month, openingBalance, openingBalanceSource, totalIncome, totalExpense, netChange, closingBalance }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return next;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v4 && npx vitest run test/financeSummary.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/finance/summary.js test/financeSummary.test.js
git commit -m "feat: add finance summary endpoint with opening-balance carry-forward"
```

---

### Task 4: Opening-balance GET/PATCH endpoint

**Files:**
- Create: `functions/api/finance/opening-balance.js`
- Test: `test/financeSummary.test.js` (extend)

**Interfaces:**
- Produces: `GET /api/finance/opening-balance?period=YYYY-MM` → `200 {period, openingBalance, setBy, setAt}` (all null except `period` if never set for that exact period); `PATCH /api/finance/opening-balance` (body: `{period, openingBalance}`) → `200 {ok: true}`.

- [ ] **Step 1: Write the failing tests**

Add these imports to the top of `test/financeSummary.test.js`:

```js
import { onRequestGet as getOpeningBalance, onRequestPatch as setOpeningBalance } from '../functions/api/finance/opening-balance.js';
```

Add this `describe` block at the end of `test/financeSummary.test.js`:

```js
describe('GET/PATCH /api/finance/opening-balance', () => {
  it('GET rejects reception (403)', async () => {
    const response = await getOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance?period=2026-08', receptionToken, 'GET'), env });
    expect(response.status).toBe(403);
  });

  it('GET returns nulls when nothing was ever set for the exact period', async () => {
    const response = await getOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance?period=2026-08', managerToken, 'GET'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ period: '2026-08', openingBalance: null, setBy: null, setAt: null });
  });

  it('GET rejects a malformed period (400)', async () => {
    const response = await getOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance?period=2026-8', managerToken, 'GET'), env });
    expect(response.status).toBe(400);
  });

  it('PATCH rejects reception (403)', async () => {
    const response = await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', receptionToken, 'PATCH', { period: '2026-08', openingBalance: 1000 }), env });
    expect(response.status).toBe(403);
  });

  it('PATCH rejects observer (403)', async () => {
    const response = await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', observerToken, 'PATCH', { period: '2026-08', openingBalance: 1000 }), env });
    expect(response.status).toBe(403);
  });

  it('PATCH rejects a malformed period (400)', async () => {
    const response = await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', managerToken, 'PATCH', { period: 'August', openingBalance: 1000 }), env });
    expect(response.status).toBe(400);
  });

  it('PATCH rejects a non-integer openingBalance (400)', async () => {
    const response = await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', managerToken, 'PATCH', { period: '2026-08', openingBalance: 12.5 }), env });
    expect(response.status).toBe(400);
  });

  it('PATCH accepts a negative openingBalance', async () => {
    const response = await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', managerToken, 'PATCH', { period: '2026-08', openingBalance: -500 }), env });
    expect(response.status).toBe(200);
  });

  it('PATCH inserts a new row (never UPDATEs); GET reads the latest by id for that exact period', async () => {
    await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', managerToken, 'PATCH', { period: '2026-08', openingBalance: 1000 }), env });
    await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', adminToken, 'PATCH', { period: '2026-08', openingBalance: 2000 }), env });

    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM finance_opening_balance WHERE period = '2026-08'`).first();
    expect(countRow.c).toBe(2);

    const response = await getOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance?period=2026-08', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.openingBalance).toBe(2000);
    expect(body.setBy).toBe('admin_sum');
  });

  it('PATCH writes an audit_log row', async () => {
    await setOpeningBalance({ request: authedRequest('https://x/api/finance/opening-balance', managerToken, 'PATCH', { period: '2026-09', openingBalance: 777000 }), env });
    const auditRow = await env.DB.prepare(
      `SELECT * FROM audit_log WHERE entity_type = 'finance_opening_balance' AND action_type = 'finance_opening_balance_set'`
    ).first();
    expect(auditRow).not.toBeNull();
    expect(auditRow.entity_label).toBe('2026-09');
    expect(auditRow.new_value).toBe('777000');
    expect(auditRow.old_value).toBeNull();
  });
});
```

This test file's `beforeEach` (from Task 3) needs one more staff account added so `adminToken` exists. First, change the existing top-of-file `let` line from:

```js
let managerToken, receptionToken, observerToken;
```

to:

```js
let managerToken, receptionToken, observerToken, adminToken;
```

Then add these two lines inside the existing `beforeEach` in `test/financeSummary.test.js`, right after the existing `observerToken = await createSession(env.DB, o.meta.last_row_id);` line:

```js
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_sum', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, a.meta.last_row_id);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd v4 && npx vitest run test/financeSummary.test.js`
Expected: FAIL — `functions/api/finance/opening-balance.js` doesn't exist yet (and the new `adminToken` tests fail too).

- [ ] **Step 3: Implement the endpoint**

```js
// functions/api/finance/opening-balance.js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const PERIOD_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const period = url.searchParams.get('period');
  if (!period || !PERIOD_FORMAT.test(period)) {
    return jsonError('Kỳ không hợp lệ, dùng định dạng YYYY-MM', 400);
  }

  const row = await env.DB.prepare(
    `SELECT opening_balance, set_by, set_at FROM finance_opening_balance WHERE period = ? ORDER BY id DESC LIMIT 1`
  ).bind(period).first();

  return new Response(
    JSON.stringify({
      period,
      openingBalance: row ? row.opening_balance : null,
      setBy: row ? row.set_by : null,
      setAt: row ? row.set_at : null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { period, openingBalance } = body || {};

  if (typeof period !== 'string' || !PERIOD_FORMAT.test(period)) {
    return jsonError('Kỳ không hợp lệ, dùng định dạng YYYY-MM', 400);
  }
  if (!Number.isInteger(openingBalance)) {
    return jsonError('Số dư đầu kỳ phải là số nguyên', 400);
  }

  const now = new Date().toISOString();
  const previous = await env.DB.prepare(`SELECT opening_balance FROM finance_opening_balance WHERE period = ? ORDER BY id DESC LIMIT 1`).bind(period).first();

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES (?, ?, ?, ?)`).bind(period, openingBalance, auth.username, now),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('finance_opening_balance_set', 'finance_opening_balance', 0, ?, ?, ?, ?, ?)`
    ).bind(period, previous ? String(previous.opening_balance) : null, String(openingBalance), auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

(`entity_id` is hardcoded `0` here because `finance_opening_balance` rows aren't referenced by id anywhere in the UI — the period string is the meaningful identifier, stored in `entity_label` instead. `audit_log.entity_id` is `NOT NULL INTEGER`, so `0` is used as the "not applicable" sentinel rather than leaving it unset.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd v4 && npx vitest run test/financeSummary.test.js`
Expected: PASS, all tests (Task 3's tests plus this task's new ones).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/finance/opening-balance.js test/financeSummary.test.js
git commit -m "feat: add finance opening-balance get/set endpoints"
```

---

### Task 5: Admin page skeleton (nav, routing, CSS, auth gate)

**Files:**
- Create: `admin/finance.html`
- Create: `admin/finance.js`
- Modify: `admin/nav-drawer.js`
- Modify: `admin/admin.css`
- Modify: `_redirects`

**Interfaces:**
- Produces: a reachable `/admin/finance.html` page (and clean URLs `/manager/finance`, `/observer/finance`) that redirects unauthenticated visitors to `/admin`, and shows/hides its write-form section based on role — the concrete DOM ids `#financeForm`, `#financeError`, `#addTransactionSection` that Task 6 will populate are declared here as empty containers.

- [ ] **Step 1: Create `admin/finance.html`**

```html
<!-- v4/admin/finance.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Sổ thu chi — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Sổ thu chi</h1>
    <p id="financeError" class="error"></p>

    <div id="addTransactionSection" class="hidden">
      <h2>Thêm giao dịch</h2>
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
          <label>Số tiền (đ) <input type="number" name="amount" min="1" step="1000" required /></label>
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
        <button type="submit">Ghi giao dịch</button>
        <button type="button" id="financeCancelEditBtn" class="btn-secondary hidden">Huỷ sửa</button>
        <p id="financeFormError" class="error"></p>
      </form>
    </div>

    <h2>Cân đối</h2>
    <label>Chọn tháng <input type="month" id="financeMonthInput" /></label>
    <div class="stat-grid" id="financeStats"></div>
    <div id="openingBalanceEditor" class="hidden"></div>

    <h2>Biểu đồ</h2>
    <div class="filters" id="chartGranularity">
      <button type="button" class="tab-btn" data-granularity="day">Ngày</button>
      <button type="button" class="tab-btn active" data-granularity="week">Tuần</button>
      <button type="button" class="tab-btn" data-granularity="month">Tháng</button>
    </div>
    <div id="financeChart"></div>

    <h2>Giao dịch</h2>
    <div class="filters" id="financeFilters">
      <input type="date" id="filterFrom" />
      <input type="date" id="filterTo" />
      <select id="filterType">
        <option value="">Tất cả loại</option>
        <option value="income">Thu</option>
        <option value="expense">Chi</option>
      </select>
      <select id="filterCategory"></select>
      <select id="filterStatus">
        <option value="">Tất cả trạng thái</option>
        <option value="draft">Nháp</option>
        <option value="confirmed">Đã xác nhận</option>
        <option value="paid">Đã thanh toán</option>
      </select>
      <input type="text" id="filterKeyword" placeholder="Tìm ghi chú..." />
    </div>

    <p id="listError" class="error"></p>
    <div class="table-scroll" id="financeTableWrap">
      <table id="financeTable">
        <thead><tr><th>Ngày</th><th>Loại</th><th>Danh mục</th><th>Số tiền</th><th>Trạng thái</th><th>Ghi chú</th><th>Người tạo</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="booking-list" id="financeCardList"></div>
  </div>

  <script src="/admin/finance.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `admin/finance.js` (page-init IIFE + role gating only, no data logic yet)**

```js
// v4/admin/finance.js
let currentRole = null;

const CATEGORY_LABELS = {
  cay_giong: 'Cây giống',
  vat_tu: 'Vật tư',
  nhan_cong: 'Nhân công',
  van_chuyen: 'Vận chuyển',
  bao_tri: 'Bảo trì',
  ban_hang: 'Bán hàng',
  dich_vu: 'Dịch vụ',
  khac: 'Chi phí khác',
};

const STATUS_LABELS = { draft: 'Nháp', confirmed: 'Đã xác nhận', paid: 'Đã thanh toán' };

function formatVnd(amount) {
  return amount.toLocaleString('vi-VN') + 'đ';
}

function populateCategorySelect(select, includeAllOption) {
  select.innerHTML = '';
  if (includeAllOption) {
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'Tất cả danh mục';
    select.appendChild(allOpt);
  }
  Object.entries(CATEGORY_LABELS).forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  });
}

function showFinanceError(message) {
  document.getElementById('financeError').textContent = message || '';
}

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

  populateCategorySelect(document.querySelector('#financeForm select[name="category"]'), false);
  populateCategorySelect(document.getElementById('filterCategory'), true);

  if (currentRole === 'manager' || currentRole === 'admin') {
    document.getElementById('addTransactionSection').classList.remove('hidden');
    document.getElementById('openingBalanceEditor').classList.remove('hidden');
  }
})();
```

- [ ] **Step 3: Register the nav-drawer entry**

In `admin/nav-drawer.js`, inside the `NAV_GROUPS` array's first group (`label: 'Vận hành'`), add a new item right after the existing `dashboard.html` entry:

```js
      { page: 'dashboard.html', label: 'Tổng quan số liệu', icon: '📊', roles: ['manager', 'admin', 'observer'] },
      { page: 'finance.html', label: 'Sổ thu chi', icon: '💵', roles: ['manager', 'admin', 'observer'] },
      { page: 'reception.html', label: 'Vận hành hôm nay', icon: '🛎️', roles: ['reception', 'manager', 'admin', 'observer'] },
```

Also add `'finance.html': 'finance'` to the `pageSlug` object inside `buildDrawer` (find the line starting `const pageSlug = {`) — insert it anywhere in that object, e.g. right after `'dashboard.html': 'dashboard',`.

- [ ] **Step 4: Add the `_redirects` entries**

In `v4/_redirects`, add one line under the `/manager` section (right after the `/manager/dashboard` line) and one under the `/observer` section (right after the `/observer/dashboard` line):

```
/manager/dashboard            /admin/dashboard       200
/manager/finance               /admin/finance          200
```

```
/observer/dashboard            /admin/dashboard       200
/observer/finance               /admin/finance          200
```

Do **not** add a `/reception/finance` line — reception has no access to this page at all.

- [ ] **Step 5: Add the new status-badge CSS classes**

In `admin/admin.css`, add these three lines right after the existing `.status-cancelled` rule (near the other `.status-*` definitions):

```css
.status-draft { background: rgba(200, 200, 200, 0.15); color: #C9C9C9; }
.status-fin-confirmed { background: rgba(217,166,92,0.2); color: #D9A65C; }
.status-paid { background: rgba(120,200,140,0.2); color: #7FD99A; }
```

(`.status-fin-confirmed`, not `.status-confirmed`, to avoid colliding with the existing booking-status class of that name — same visual convention throughout this stylesheet: each domain gets its own class name even when the color is reused.)

- [ ] **Step 6: Manual verification**

Run: `cd v4 && node --check admin/finance.js`
Expected: no syntax errors.

Start `npx http-server . -p 4174 -s -c-1` (background, from the `v4` directory), poll `http://localhost:4174/admin/finance.html` until 200, then:
```bash
curl -s http://localhost:4174/admin/finance.html | grep -c "addTransactionSection\|financeStats\|financeChart\|id=\"financeTable\""
```
Expected: `4` (one matching line each for `addTransactionSection`, `financeStats`, `financeChart`, and the exact `id="financeTable"` attribute — quoting the attribute avoids also matching the `financeTableWrap` wrapper div's id, which contains "financeTable" as a substring). Stop the server afterward and free port 4174 (`netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>`).

- [ ] **Step 7: Commit**

```bash
cd v4
git add admin/finance.html admin/finance.js admin/nav-drawer.js admin/admin.css _redirects
git commit -m "feat: add finance.html page skeleton, nav entry, routes, and status badges"
```

---

### Task 6: Quick-add form + transaction list (desktop table + mobile cards)

**Files:**
- Modify: `admin/finance.js`

**Interfaces:**
- Consumes: `POST`/`GET /api/finance/transactions`, `PATCH /api/finance/transactions/:id`, `PATCH /api/finance/transactions/:id/void` (Tasks 1-2); `CATEGORY_LABELS`, `STATUS_LABELS`, `formatVnd`, `showFinanceError` (Task 5, already in this file).
- Produces: `loadTransactions(filters)` and `renderTransactions(list)` functions that Task 8 (filters) will call with a filter object.

- [ ] **Step 1: Add the list-loading, rendering, and form-submit logic**

Append this to the end of `admin/finance.js` (after the page-init IIFE from Task 5):

```js
let currentTransactions = [];

function transactionRowHtml(t) {
  const typeLabel = t.type === 'income' ? 'Thu' : 'Chi';
  const statusClass = t.status === 'draft' ? 'status-draft' : t.status === 'confirmed' ? 'status-fin-confirmed' : 'status-paid';
  const voidedStyle = t.voidedAt ? ' style="text-decoration: line-through; opacity: 0.5;"' : '';
  const canEdit = (currentRole === 'manager' || currentRole === 'admin') && !t.voidedAt;
  return { typeLabel, statusClass, voidedStyle, canEdit };
}

function renderTransactions(list) {
  currentTransactions = list;
  const tbody = document.querySelector('#financeTable tbody');
  const cardList = document.getElementById('financeCardList');
  tbody.innerHTML = '';
  cardList.innerHTML = '';

  list.forEach((t) => {
    const { typeLabel, statusClass, voidedStyle, canEdit } = transactionRowHtml(t);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td${voidedStyle}>${t.transactionDate}</td>
      <td${voidedStyle}>${typeLabel}</td>
      <td${voidedStyle}>${CATEGORY_LABELS[t.category] || t.category}</td>
      <td${voidedStyle}>${formatVnd(t.amount)}</td>
      <td><span class="status-badge ${statusClass}">${STATUS_LABELS[t.status]}</span></td>
      <td${voidedStyle}>${t.note || ''}</td>
      <td${voidedStyle}>${t.createdBy}</td>
      <td></td>
    `;
    if (canEdit) {
      const actionsCell = tr.lastElementChild;
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditTransaction(t));
      const voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'btn-secondary';
      voidBtn.textContent = 'Huỷ';
      voidBtn.addEventListener('click', () => voidTransaction(t.id));
      actionsCell.append(editBtn, voidBtn);
    }
    tbody.appendChild(tr);

    const card = document.createElement('div');
    card.className = 'booking-card';
    card.innerHTML = `
      <p${voidedStyle}><strong>${t.transactionDate}</strong> — ${typeLabel} · ${CATEGORY_LABELS[t.category] || t.category}</p>
      <p${voidedStyle}>${formatVnd(t.amount)} <span class="status-badge ${statusClass}">${STATUS_LABELS[t.status]}</span></p>
      <p${voidedStyle}>${t.note || ''}</p>
      <p${voidedStyle} style="opacity: 0.7; font-size: 0.85rem;">${t.createdBy}</p>
    `;
    if (canEdit) {
      const cardActions = document.createElement('div');
      cardActions.className = 'booking-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditTransaction(t));
      const voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'btn-secondary';
      voidBtn.textContent = 'Huỷ';
      voidBtn.addEventListener('click', () => voidTransaction(t.id));
      cardActions.append(editBtn, voidBtn);
      card.appendChild(cardActions);
    }
    cardList.appendChild(card);
  });
}

function currentFilters() {
  return {
    from: document.getElementById('filterFrom')?.value || '',
    to: document.getElementById('filterTo')?.value || '',
    type: document.getElementById('filterType')?.value || '',
    category: document.getElementById('filterCategory')?.value || '',
    status: document.getElementById('filterStatus')?.value || '',
    q: document.getElementById('filterKeyword')?.value || '',
  };
}

async function loadTransactions(filters) {
  const listError = document.getElementById('listError');
  listError.textContent = '';
  const params = new URLSearchParams();
  Object.entries(filters || currentFilters()).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  let response;
  try {
    response = await fetch(`/api/finance/transactions?${params.toString()}`);
  } catch (err) {
    listError.textContent = 'Có lỗi khi tải giao dịch';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi tải giao dịch';
    return;
  }
  renderTransactions(await response.json());
}

async function voidTransaction(id) {
  const listError = document.getElementById('listError');
  listError.textContent = '';
  const response = await fetch(`/api/finance/transactions/${id}/void`, { method: 'PATCH' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi huỷ giao dịch';
    return;
  }
  await loadTransactions();
  if (typeof refreshFinanceSummary === 'function') refreshFinanceSummary();
}

function openEditTransaction(t) {
  const form = document.getElementById('financeForm');
  form.querySelector('[name="type"]').value = t.type;
  form.querySelector('[name="category"]').value = t.category;
  form.querySelector('[name="amount"]').value = t.amount;
  form.querySelector('[name="transactionDate"]').value = t.transactionDate;
  form.querySelector('[name="note"]').value = t.note || '';
  form.querySelector('[name="status"]').value = t.status;
  form.dataset.editingId = t.id;
  document.querySelector('#financeForm button[type="submit"]').textContent = 'Lưu thay đổi';
  document.getElementById('financeCancelEditBtn').classList.remove('hidden');
}

function resetFinanceForm() {
  const form = document.getElementById('financeForm');
  form.reset();
  delete form.dataset.editingId;
  form.querySelector('[name="transactionDate"]').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  document.querySelector('#financeForm button[type="submit"]').textContent = 'Ghi giao dịch';
  document.getElementById('financeCancelEditBtn').classList.add('hidden');
}

document.getElementById('financeCancelEditBtn').addEventListener('click', () => {
  document.getElementById('financeFormError').textContent = '';
  resetFinanceForm();
});

document.getElementById('financeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('financeFormError');
  errorEl.textContent = '';

  const amount = Number(form.querySelector('[name="amount"]').value);
  if (!form.querySelector('[name="amount"]').value || !Number.isInteger(amount) || amount <= 0) {
    errorEl.textContent = 'Số tiền phải là số nguyên dương';
    return;
  }
  const transactionDate = form.querySelector('[name="transactionDate"]').value;
  if (!transactionDate) {
    errorEl.textContent = 'Vui lòng chọn ngày';
    return;
  }

  const payload = {
    type: form.querySelector('[name="type"]').value,
    category: form.querySelector('[name="category"]').value,
    amount,
    transactionDate,
    note: form.querySelector('[name="note"]').value || undefined,
    status: form.querySelector('[name="status"]').value,
  };

  const editingId = form.dataset.editingId;
  let response;
  try {
    response = await fetch(editingId ? `/api/finance/transactions/${editingId}` : '/api/finance/transactions', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi ghi giao dịch';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi ghi giao dịch';
    return;
  }

  resetFinanceForm();
  await loadTransactions();
  if (typeof refreshFinanceSummary === 'function') refreshFinanceSummary();
});

document.querySelectorAll('#financeFilters input, #financeFilters select').forEach((el) => {
  el.addEventListener('change', () => loadTransactions());
});
```

Note: `refreshFinanceSummary` is guarded with `typeof ... === 'function'` because it will be defined in Task 7, which lands after this task — this task's code must not throw if that function doesn't exist yet.

- [ ] **Step 2: Wire the initial load into the page-init IIFE**

In `admin/finance.js`, find the page-init IIFE from Task 5 (the `(async () => { ... })();` block) and add these two lines right before its closing `})();`, after the existing role-gating `if` block:

```js
  resetFinanceForm();
  await loadTransactions();
```

- [ ] **Step 3: Manual verification**

Run: `cd v4 && node --check admin/finance.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: wire finance quick-add form and transaction list (table + mobile cards)"
```

---

### Task 7: Balance summary stat cards + opening-balance editor

**Files:**
- Modify: `admin/finance.js`

**Interfaces:**
- Consumes: `GET /api/finance/summary`, `GET`/`PATCH /api/finance/opening-balance` (Tasks 3-4); `formatVnd` (Task 5).
- Produces: `refreshFinanceSummary()` — referenced (as an optional call) by Task 6's void/submit handlers.

- [ ] **Step 1: Add the summary-rendering and opening-balance-editor logic**

Append this to the end of `admin/finance.js`:

```js
function currentMonthValue() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 7);
}

function renderStatCards(summary) {
  const container = document.getElementById('financeStats');
  container.innerHTML = '';
  const cards = [
    { label: 'Số dư đầu kỳ', value: formatVnd(summary.openingBalance) },
    { label: 'Tổng thu', value: formatVnd(summary.totalIncome) },
    { label: 'Tổng chi', value: formatVnd(summary.totalExpense) },
    { label: 'Lợi nhuận tạm tính', value: formatVnd(summary.netChange) },
    { label: 'Số dư cuối kỳ', value: formatVnd(summary.closingBalance) },
  ];
  cards.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'stat-card';
    const value = document.createElement('div');
    value.className = 'stat-value';
    value.textContent = c.value;
    const label = document.createElement('div');
    label.className = 'stat-label';
    label.textContent = c.label;
    div.append(value, label);
    container.appendChild(div);
  });
}

function renderOpeningBalanceEditor(period, currentValue) {
  const container = document.getElementById('openingBalanceEditor');
  container.innerHTML = '';
  if (currentRole !== 'manager' && currentRole !== 'admin') return;

  const label = document.createElement('label');
  label.textContent = 'Sửa số dư đầu kỳ cho tháng này ';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '1000';
  input.value = currentValue != null ? currentValue : '';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Lưu';
  const errorEl = document.createElement('p');
  errorEl.className = 'error';

  saveBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const value = Number(input.value);
    if (input.value.trim() === '' || !Number.isInteger(value)) {
      errorEl.textContent = 'Số dư đầu kỳ phải là số nguyên';
      return;
    }
    const response = await fetch('/api/finance/opening-balance', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period, openingBalance: value }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi lưu số dư đầu kỳ';
      return;
    }
    await refreshFinanceSummary();
  });

  label.appendChild(input);
  container.append(label, saveBtn, errorEl);
}

async function refreshFinanceSummary() {
  const monthInput = document.getElementById('financeMonthInput');
  const month = monthInput.value || currentMonthValue();
  monthInput.value = month;

  const errorEl = document.getElementById('financeError');
  errorEl.textContent = '';

  let summaryResponse, openingResponse;
  try {
    [summaryResponse, openingResponse] = await Promise.all([
      fetch(`/api/finance/summary?month=${month}`),
      fetch(`/api/finance/opening-balance?period=${month}`),
    ]);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải số liệu cân đối';
    return;
  }
  if (!summaryResponse.ok || !openingResponse.ok) {
    errorEl.textContent = 'Có lỗi khi tải số liệu cân đối';
    return;
  }

  const summary = await summaryResponse.json();
  const opening = await openingResponse.json();
  renderStatCards(summary);
  renderOpeningBalanceEditor(month, opening.openingBalance);
}

document.getElementById('financeMonthInput').addEventListener('change', refreshFinanceSummary);
```

- [ ] **Step 2: Wire the initial summary load into the page-init IIFE**

In `admin/finance.js`'s page-init IIFE, add this line right after the `await loadTransactions();` line added in Task 6, before the closing `})();`:

```js
  document.getElementById('financeMonthInput').value = currentMonthValue();
  await refreshFinanceSummary();
```

- [ ] **Step 3: Manual verification**

Run: `cd v4 && node --check admin/finance.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: add finance balance summary stat cards and opening-balance editor"
```

---

### Task 8: Filters

**Files:**
- Modify: `admin/finance.js`

**Interfaces:**
- Consumes: `loadTransactions(filters)` (Task 6).

The filter `<input>`/`<select>` elements and their `change` listeners calling `loadTransactions()` were already wired in Task 6 Step 1 (`document.querySelectorAll('#financeFilters input, #financeFilters select').forEach(...)`). This task adds the one remaining piece: a debounce on the free-text keyword input, so a fetch doesn't fire on every keystroke.

- [ ] **Step 1: Replace the keyword filter's listener with a debounced version**

In `admin/finance.js`, find this line (added in Task 6):

```js
document.querySelectorAll('#financeFilters input, #financeFilters select').forEach((el) => {
  el.addEventListener('change', () => loadTransactions());
});
```

Replace it with:

```js
document.querySelectorAll('#financeFilters input:not(#filterKeyword), #financeFilters select').forEach((el) => {
  el.addEventListener('change', () => loadTransactions());
});

let keywordDebounceTimer;
document.getElementById('filterKeyword').addEventListener('input', () => {
  clearTimeout(keywordDebounceTimer);
  keywordDebounceTimer = setTimeout(() => loadTransactions(), 350);
});
```

- [ ] **Step 2: Manual verification**

Run: `cd v4 && node --check admin/finance.js`
Expected: no syntax errors.

- [ ] **Step 3: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: debounce the finance keyword filter"
```

---

### Task 9: Chart (SVG bar chart, day/week/month granularity)

**Files:**
- Modify: `admin/finance.js`

**Interfaces:**
- Consumes: `currentTransactions` (module-level array populated by `renderTransactions`, Task 6).
- Produces: `renderChart(granularity)`, called after every `loadTransactions()` resolves and on granularity-toggle clicks.

- [ ] **Step 1: Add the bucketing and SVG-rendering logic**

Append this to the end of `admin/finance.js`:

```js
let currentGranularity = 'week';

function isoWeekMonday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + diffToMonday);
  return date.toISOString().slice(0, 10);
}

function bucketKey(dateStr, granularity) {
  if (granularity === 'day') return dateStr;
  if (granularity === 'month') return dateStr.slice(0, 7);
  return isoWeekMonday(dateStr);
}

function bucketLabel(key, granularity) {
  if (granularity === 'month') {
    const [y, m] = key.split('-');
    return `${m}/${y}`;
  }
  const [, m, d] = key.split('-');
  return `${d}/${m}`;
}

function buildBuckets(transactions, granularity) {
  const map = new Map();
  transactions
    .filter((t) => !t.voidedAt && (t.status === 'confirmed' || t.status === 'paid'))
    .forEach((t) => {
      const key = bucketKey(t.transactionDate, granularity);
      if (!map.has(key)) map.set(key, { key, income: 0, expense: 0 });
      const bucket = map.get(key);
      if (t.type === 'income') bucket.income += t.amount;
      else bucket.expense += t.amount;
    });
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function renderChart(granularity) {
  currentGranularity = granularity || currentGranularity;
  const container = document.getElementById('financeChart');
  const buckets = buildBuckets(currentTransactions, currentGranularity);

  if (buckets.length === 0) {
    container.innerHTML = '<p style="opacity: 0.6;">Không có dữ liệu để vẽ biểu đồ.</p>';
    return;
  }

  const width = Math.max(320, buckets.length * 70);
  const height = 220;
  const chartTop = 10;
  const chartBottom = 180;
  const chartHeight = chartBottom - chartTop;
  const maxValue = Math.max(1, ...buckets.map((b) => Math.max(b.income, b.expense)));
  const barGroupWidth = width / buckets.length;
  const barWidth = Math.min(24, barGroupWidth / 3);

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Biểu đồ thu chi theo ${currentGranularity === 'day' ? 'ngày' : currentGranularity === 'week' ? 'tuần' : 'tháng'}" style="width: 100%; height: auto; max-width: 100%;">`;
  svg += `<line x1="0" y1="${chartBottom}" x2="${width}" y2="${chartBottom}" stroke="currentColor" stroke-opacity="0.3" />`;

  buckets.forEach((b, i) => {
    const groupCenter = i * barGroupWidth + barGroupWidth / 2;
    const incomeHeight = (b.income / maxValue) * chartHeight;
    const expenseHeight = (b.expense / maxValue) * chartHeight;

    svg += `<rect x="${groupCenter - barWidth - 2}" y="${chartBottom - incomeHeight}" width="${barWidth}" height="${incomeHeight}" fill="#C9A84C" />`;
    svg += `<rect x="${groupCenter + 2}" y="${chartBottom - expenseHeight}" width="${barWidth}" height="${expenseHeight}" fill="#ff8a8a" />`;
    svg += `<text x="${groupCenter}" y="${chartBottom + 16}" text-anchor="middle" font-size="10" fill="currentColor" fill-opacity="0.8">${bucketLabel(b.key, currentGranularity)}</text>`;
  });

  svg += `</svg>`;
  container.innerHTML = `<div class="table-scroll">${svg}</div><p style="font-size: 0.85rem; opacity: 0.7;"><span style="color: #C9A84C;">■</span> Thu &nbsp; <span style="color: #ff8a8a;">■</span> Chi</p>`;
}

document.querySelectorAll('#chartGranularity .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chartGranularity .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderChart(btn.dataset.granularity);
  });
});
```

- [ ] **Step 2: Call `renderChart` after the transaction list loads**

In `admin/finance.js`, find `renderTransactions` (added in Task 6) and add one line at the very end of the function, right before its closing `}`:

```js
  renderChart(currentGranularity);
```

- [ ] **Step 3: Manual verification**

Run: `cd v4 && node --check admin/finance.js`
Expected: no syntax errors.

Start `npx http-server . -p 4174 -s -c-1` (background, from `v4`), poll until ready, then:
```bash
curl -s http://localhost:4174/admin/finance.js | grep -c "function renderChart\|function buildBuckets\|isoWeekMonday"
```
Expected: `4` (one line each for the `renderChart` and `buildBuckets` function definitions, plus two lines containing `isoWeekMonday` — its own function definition and the one call site inside `bucketKey`). Stop the server afterward and free port 4174.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/finance.js
git commit -m "feat: add hand-drawn SVG income/expense chart with day/week/month granularity"
```

---

### Task 10: Playwright coverage

**Files:**
- Create: `tests/e2e/finance-dashboard.spec.js` (outer repo)

**Interfaces:**
- Consumes: `admin/finance.html`/`finance.js` (Tasks 5-9), mocked API responses matching Tasks 1-4's exact shapes.

- [ ] **Step 1: Write the spec**

```js
// tests/e2e/finance-dashboard.spec.js
const { test, expect } = require('@playwright/test');

function mockCommonRoutes(page, { role, summary, openingBalance, transactions }) {
  return Promise.all([
    page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) })),
    page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summary) })),
    page.route('**/api/finance/opening-balance**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(openingBalance) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(transactions) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
  ]);
}

const DEFAULT_SUMMARY = { month: '2026-08', openingBalance: 1000000, openingBalanceSource: 'manual', totalIncome: 2000000, totalExpense: 500000, netChange: 1500000, closingBalance: 2500000 };
const DEFAULT_OPENING = { period: '2026-08', openingBalance: 1000000, setBy: 'quan_ly_a', setAt: '2026-08-01T00:00:00Z' };
const SAMPLE_TX = [
  { id: 1, type: 'income', category: 'ban_hang', amount: 2000000, note: 'Bán rau', transactionDate: '2026-08-10', status: 'paid', createdBy: 'quan_ly_a', createdAt: '2026-08-10T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
  { id: 2, type: 'expense', category: 'vat_tu', amount: 500000, note: 'Mua phân bón', transactionDate: '2026-08-12', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-12T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
];

test.describe('Finance dashboard (sổ thu chi)', () => {
  test('manager sees the add-transaction form and can see the balance stat cards', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#addTransactionSection')).toBeVisible();
    await expect(page.locator('#financeStats')).toContainText('2.500.000');
    await expect(page.locator('#financeStats')).toContainText('1.000.000');
  });

  test('observer does not see the add-transaction form or opening-balance editor', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'observer', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#addTransactionSection')).toBeHidden();
    await expect(page.locator('#openingBalanceEditor')).toBeEmpty();
  });

  test('reception stays on the page but the API 403s hide all data and the write form', async ({ page }) => {
    // This codebase's established convention for a role-restricted admin page (confirmed in
    // admin/audit-log.js and admin/manager.js) is: no client-side role redirect — only a truly
    // unauthenticated visit (401 from /api/auth/me) redirects to /admin. An authenticated-but-
    // wrong-role visit stays on the page, and every API call 403s, surfaced as an error message
    // via the page's existing <p class="error"> elements. finance.html/js follows this exactly.
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance.html');
    await expect(page).toHaveURL(/\/admin\/finance/);
    await expect(page.locator('#addTransactionSection')).toBeHidden();
    await expect(page.locator('#openingBalanceEditor')).toBeEmpty();
    await expect(page.locator('#listError')).toContainText('Không đủ quyền');
    await expect(page.locator('#financeError')).toContainText('Không đủ quyền');
  });

  test('adding a transaction submits the correct payload and refreshes the list', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX) });
    });

    await page.goto('/admin/finance.html');
    await page.selectOption('#financeForm select[name="type"]', 'expense');
    await page.selectOption('#financeForm select[name="category"]', 'nhan_cong');
    await page.fill('#financeForm input[name="amount"]', '300000');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-20');
    await page.fill('#financeForm input[name="note"]', 'Công tưới cây');
    await page.click('#financeForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ type: 'expense', category: 'nhan_cong', amount: 300000, transactionDate: '2026-08-20', note: 'Công tưới cây' });
  });

  test('rejects a non-positive amount client-side without submitting', async ({ page }) => {
    let posted = false;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions', (route) => {
      if (route.request().method() === 'POST') posted = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX) });
    });

    await page.goto('/admin/finance.html');
    await page.fill('#financeForm input[name="amount"]', '0');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-20');
    await page.click('#financeForm button[type="submit"]');

    await expect(page.locator('#financeFormError')).toContainText('số nguyên dương');
    expect(posted).toBe(false);
  });

  test('voiding a transaction strikes it through in the table', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions/1/void', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));

    await page.goto('/admin/finance.html');
    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button', { hasText: 'Huỷ' }).click();

    await expect(page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('td').first()).toHaveCSS('text-decoration-line', 'line-through');
  });

  test('filters re-fetch the transaction list with the selected query params', async ({ page }) => {
    let lastUrl = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') lastUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX) });
    });

    await page.goto('/admin/finance.html');
    await page.selectOption('#filterType', 'expense');

    await expect.poll(() => lastUrl).toContain('type=expense');
  });

  test('the chart granularity toggle switches the active button', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await page.click('#chartGranularity button[data-granularity="day"]');
    await expect(page.locator('#chartGranularity button[data-granularity="day"]')).toHaveClass(/active/);
    await expect(page.locator('#financeChart svg')).toBeVisible();
  });

  test('mobile viewport shows the card list instead of the table', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeTableWrap')).toBeHidden();
    await expect(page.locator('#financeCardList')).toBeVisible();
    await expect(page.locator('#financeCardList')).toContainText('Bán rau');
  });
});
```

- [ ] **Step 2: Add the mobile-vs-desktop CSS this last test depends on**

Task 5-9 never added a rule making the finance table hide on narrow viewports (only `.booking-card`-style cards were reused for rendering; nothing hid the table yet). Add this to `admin/admin.css`, right after the existing `.booking-empty` rule:

```css
#financeCardList { display: none; }
@media (max-width: 639px) {
  #financeTableWrap { display: none; }
  #financeCardList { display: flex; }
}
```

(Scoped to `#financeTableWrap`/`#financeCardList` specifically — `#financeTableWrap` is the `id` added to the `.table-scroll` div wrapping `#financeTable` in Task 5's HTML, so hiding it also hides the table inside. This does not touch `.table-scroll`'s behavior anywhere else in the app, since every other page's `.table-scroll` div has no matching id here.)

- [ ] **Step 3: Run this spec to verify it passes**

Start the v4 static server first (from the `v4` repo directory): `npx http-server . -p 4174 -s -c-1` in the background, poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/admin/finance.html` until it returns `200`.

Run (from the outer `hien-le-garden` repo): `npx playwright test finance-dashboard --project=v4`
Expected: PASS, all 9 tests.

- [ ] **Step 4: Run the full v4 Playwright suite for regressions**

Run: `npx playwright test --project=v4`
Expected: PASS (all tests, previous count + 9). Stop the http-server afterward and free port 4174.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/finance-dashboard.spec.js
git commit -m "test: cover finance dashboard add/edit/void/filter/chart/responsive behavior"
```

(This commit is in the outer `hien-le-garden` repo, not `hien-le-garden-v4`. The `admin.css` change from Step 2 above belongs in the `v4` repo — commit it there separately: `cd v4 && git add admin/admin.css && git commit -m "feat: hide the finance table and show the card list below 640px"`.)

---

## Reference: local/demo sample data (not a task, not applied to production)

Per spec §9, the migration never seeds rows into production. For local development or a demo, apply the migration with `--local`, then optionally paste this into `npx wrangler d1 execute DB --local --command "..."` (or a `.sql` scratch file passed via `--file`) — realistic Hiền Lê Garden transactions spanning a few months so the dashboard's carry-forward opening balance and chart have something to show:

```sql
INSERT INTO finance_opening_balance (period, opening_balance, set_by, set_at) VALUES ('2026-06', 5000000, 'quan_ly_demo', '2026-06-01T00:00:00Z');

INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES
  ('expense', 'cay_giong', 800000, 'Mua giống chuối', '2026-06-05', 'paid', 'quan_ly_demo', '2026-06-05T00:00:00Z'),
  ('expense', 'vat_tu', 350000, 'Phân bón & thuốc trừ sâu sinh học', '2026-06-10', 'paid', 'quan_ly_demo', '2026-06-10T00:00:00Z'),
  ('income', 'ban_hang', 2200000, 'Bán chuối & rau tại vườn', '2026-06-20', 'paid', 'quan_ly_demo', '2026-06-20T00:00:00Z'),
  ('expense', 'nhan_cong', 600000, 'Công cắt cỏ tuần', '2026-07-03', 'paid', 'quan_ly_demo', '2026-07-03T00:00:00Z'),
  ('income', 'dich_vu', 1500000, 'Thu tiền vé tham quan vườn', '2026-07-12', 'confirmed', 'quan_ly_demo', '2026-07-12T00:00:00Z'),
  ('expense', 'bao_tri', 900000, 'Bảo trì máy bơm nước', '2026-07-18', 'paid', 'quan_ly_demo', '2026-07-18T00:00:00Z'),
  ('expense', 'van_chuyen', 250000, 'Vận chuyển vật tư từ thị trấn', '2026-08-02', 'confirmed', 'quan_ly_demo', '2026-08-02T00:00:00Z'),
  ('income', 'ban_hang', 3100000, 'Bán trái cây & mật ong', '2026-08-14', 'paid', 'quan_ly_demo', '2026-08-14T00:00:00Z'),
  ('expense', 'khac', 150000, 'Chi phí phát sinh khác', '2026-08-22', 'draft', 'quan_ly_demo', '2026-08-22T00:00:00Z');
```

The last row is intentionally left in `draft` status so a developer can see the "draft doesn't count toward totals" behavior live on the dashboard.

## After all tasks: deploy checklist (not a task — for the controller after the final review)

1. Apply `migrations/0015_finance_transactions.sql` to production D1 (`npx wrangler d1 migrations apply hien_le_garden_crm --remote`) **before** pushing/deploying the dependent code — same ordering rule every prior plan's final review this session has flagged as critical.
2. Push the `v4` repo, then the outer repo.
3. Verify the Cloudflare Pages deployment picked up the new commit (`wrangler pages deployment list --project-name=hien-le-garden-v4`).
4. Smoke-test production: log in as manager/admin, open `/manager/finance`, add a real income and a real expense transaction with today's date, confirm the stat cards update, set an opening balance for the current month, void a test transaction and confirm it's struck through and no longer counted, then confirm reception's account cannot reach the page and observer can view but not write.
