# Finance Page Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hide-from-history, a filter-scoped revenue stat, 2 category pie charts, pagination, and a consolidated popup form + confirm-on-void flow to `admin/finance.html`.

**Architecture:** `GET /api/finance/transactions` changes response shape from a bare array to an envelope object carrying a paginated page of rows plus aggregates (`total`, `sumIncome`, `sumExpense`, `categoryTotals`, `chartRows`) computed over the full filtered set. `admin/finance.js`/`.html` are reworked to consume the new shape and to move the add/edit form into a popup reusing the existing `.confirm-overlay`/`.confirm-box` pattern. `finance_transactions` gains an `is_hidden` column and a `PATCH .../hide` endpoint following the exact pattern already proven for `gio_xanh_sessions`/`dine_in_orders`/`bookings`, but gated on `voided_at IS NOT NULL` instead of a terminal status (finance transactions have no terminal status — draft/confirmed/paid are all live financial records).

**Tech Stack:** Cloudflare Pages Functions + D1 (v4 repo), vanilla JS admin frontend (no build step), Playwright e2e (outer repo).

**Spec:** `docs/superpowers/specs/2026-09-06-finance-page-enhancements-design.md`

## Global Constraints

- `record_hide` action_type is ALREADY registered (from the prior hide-from-history plan) in `admin/audit-log.js`, `admin/audit-log.html`, `functions/api/audit-log/index.js` — this plan reuses the string verbatim and does NOT re-register it anywhere.
- `entity_type` for the new hide endpoint is `'finance_transaction'`, `entity_label` MUST use the existing exported `summarize(row, categoryMeta)` helper from `functions/api/finance/transactions/index.js` (already imported and used the same way by `functions/api/finance/transactions/[id]/void.js`) — never a hand-rolled label format.
- A finance transaction is hideable only when `voided_at IS NOT NULL` — draft/confirmed/paid (non-voided) transactions can never be hidden, regardless of status. This is a deliberate departure from the terminal-*status* gate used for `gio_xanh_sessions`/`dine_in_orders`/`bookings` (see spec §4): finance transactions have no "in-progress work" state that hiding could hide by mistake — only a voided (mistake/test) entry is ever a hide candidate.
- Popups reuse the exact existing `.confirm-overlay`/`.confirm-box` CSS classes (`admin/admin.css:276-283`) — never introduce a new modal class family.
- Action icons reuse the exact existing `.table-actions-btn`/`.btn-secondary` CSS classes — never introduce new button classes for this.
- `GET /api/finance/transactions`'s `pageSize` query param accepts only `10`, `25`, `50`, or `100` — any other value is a `400`.
- `includeHidden=1` on `GET /api/finance/transactions` only takes effect when `auth.role === 'admin'` — silently ignored (not an error) for `manager`.
- `admin/finance.js`/`admin/finance.html` are the ONLY consumers of `GET /api/finance/transactions` anywhere in either repo (confirmed by grep across `v4/admin/`, `v4/functions/`, and `tests/e2e/`) — the response-shape change in Task 2 is safe to make without a compatibility shim.

---

### Task 1: Migration — `is_hidden` on `finance_transactions`

**Files:**
- Create: `v4/migrations/0026_finance_hide_from_history.sql`
- Test: `v4/test/migrations.test.js`

**Interfaces:**
- Produces: `finance_transactions.is_hidden` column (`INTEGER NOT NULL DEFAULT 0`), consumed by Task 2's endpoint rework and Task 3's client checkbox.

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/migrations.test.js`, after the existing `describe('migration 0025', ...)` block (there are 31 existing tests in this file — confirm with `grep -c "  it(" v4/test/migrations.test.js` before and after):

```js
describe('migration 0026', () => {
  it('adds is_hidden defaulting to 0 on finance_transactions', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 100000, '2026-09-06', 'paid', 'system', '2026-09-06T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT is_hidden FROM finance_transactions WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.is_hidden).toBe(0);
  });

  it('accepts is_hidden = 1 on finance_transactions', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at, is_hidden) VALUES ('expense', 'vat_tu', 50000, '2026-09-06', 'confirmed', 'system', '2026-09-06T00:00:00Z', 1)`
    ).run();
    const row = await env.DB.prepare(`SELECT is_hidden FROM finance_transactions WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.is_hidden).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/migrations.test.js`
Expected: FAIL — `no such column: is_hidden` (table `finance_transactions` has no such column yet).

- [ ] **Step 3: Write the migration**

```sql
-- v4/migrations/0026_finance_hide_from_history.sql

ALTER TABLE finance_transactions ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/migrations.test.js`
Expected: PASS, 33/33 (31 existing + 2 new). If you hit the documented Windows Miniflare teardown flake (`AssertionError: Isolated storage failed`, `WorkersTestRunner.updateStackedStorage`, EBUSY on `.sqlite-wal` — not a real assertion failure), retry up to ~6 times.

- [ ] **Step 5: Commit**

```bash
cd v4
git add migrations/0026_finance_hide_from_history.sql test/migrations.test.js
git commit -m "feat: add is_hidden column to finance_transactions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — `GET /api/finance/transactions` rework + `PATCH .../hide`

**Files:**
- Modify: `v4/functions/api/finance/transactions/index.js`
- Create: `v4/functions/api/finance/transactions/[id]/hide.js`
- Test: `v4/test/financeTransactions.test.js`

**Interfaces:**
- Consumes: `summarize(row, categoryMeta)` (exported from `index.js` itself, already used by `void.js`), `loadCategoryMeta(env)` from `../../../../lib/financeCategories.js`, `requireAuth(request, env, roles)` from `../../../../lib/requireAuth.js`.
- Produces: `GET /api/finance/transactions` response shape `{ transactions, total, page, pageSize, sumIncome, sumExpense, categoryTotals, chartRows }` — Task 3's client code consumes every one of these fields by exact name. `PATCH /api/finance/transactions/:id/hide` (admin-only, body `{ hidden: boolean }`) — Task 3's client calls this exact path/body shape.

- [ ] **Step 1: Write the failing tests**

First, add this import at the top of `v4/test/financeTransactions.test.js` (alongside the existing imports):

```js
import { onRequestPatch as hideTransaction } from '../functions/api/finance/transactions/[id]/hide.js';
```

Then **replace** the entire existing `describe('GET /api/finance/transactions', ...)` block (currently lines 193-280 — confirm the block's exact boundaries by searching for `describe('GET /api/finance/transactions'` and the following `describe('PATCH /api/finance/transactions/:id'`) with:

```js
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

  it('rejects observer (403) — transaction data is off-limits to this role entirely', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', observerToken, 'GET'), env });
    expect(response.status).toBe(403);
  });

  it('manager and admin still see both income and expense rows (no regression)', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions).toHaveLength(3);
    expect(body.transactions.some((t) => t.type === 'expense')).toBe(true);
  });

  it('includes voided transactions in the list (UI shows them struck-through)', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    const voided = body.transactions.find((t) => t.note === 'Công cắt cỏ');
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.voidedBy).toBe('admin_fin');
  });

  it('orders newest transaction_date first', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.transactionDate)).toEqual(['2026-08-20', '2026-08-15', '2026-08-01']);
  });

  it('filters by type', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?type=income', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('filters by category', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?category=nhan_cong', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.note)).toEqual(['Công cắt cỏ']);
  });

  it('filters by status', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?status=paid', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('filters by date range', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?from=2026-08-10&to=2026-08-16', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('filters by keyword against note, case-insensitively', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?q=rau', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.note)).toEqual(['Bán rau']);
  });

  it('includes null receipt fields for a transaction with no attachment', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    const row = body.transactions.find((t) => t.note === 'Bán rau');
    expect(row.receiptKey).toBeNull();
    expect(row.receiptFilename).toBeNull();
    expect(row.receiptUploadedAt).toBeNull();
  });

  it('rejects an invalid pageSize (400)', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?pageSize=7', managerToken, 'GET'), env });
    expect(response.status).toBe(400);
  });

  it('defaults to page=1, pageSize=25 when omitted', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    expect(body.transactions).toHaveLength(3);
  });

  it('paginates with pageSize=10 across multiple pages, keeping total/sums stable regardless of page', async () => {
    for (let i = 0; i < 12; i += 1) {
      await env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 100000, ?, ?, 'paid', 'admin_fin', '2026-08-05T00:00:00Z')`
      ).bind(`Extra ${i}`, `2026-08-0${(i % 9) + 1}`).run();
    }
    const page1Response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?pageSize=10&page=1', managerToken, 'GET'), env });
    const page1 = await page1Response.json();
    expect(page1.transactions).toHaveLength(10);
    expect(page1.total).toBe(15);

    const page2Response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?pageSize=10&page=2', managerToken, 'GET'), env });
    const page2 = await page2Response.json();
    expect(page2.transactions).toHaveLength(5);
    expect(page2.total).toBe(15);
    expect(page2.sumIncome).toBe(page1.sumIncome);
  });

  it('computes sumIncome/sumExpense over the full filtered set, not just the current page', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.sumIncome).toBe(3000000);
    expect(body.sumExpense).toBe(300000);
  });

  it('computes categoryTotals grouped by category and type', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.categoryTotals.vat_tu).toEqual({ income: 0, expense: 100000 });
    expect(body.categoryTotals.ban_hang).toEqual({ income: 3000000, expense: 0 });
    expect(body.categoryTotals.nhan_cong).toEqual({ income: 0, expense: 200000 });
  });

  it('returns chartRows with exactly transactionDate/type/amount/status/voidedAt for every filtered row', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.chartRows).toHaveLength(3);
    expect(Object.keys(body.chartRows[0]).sort()).toEqual(['amount', 'status', 'transactionDate', 'type', 'voidedAt']);
  });

  it('excludes hidden transactions by default', async () => {
    await env.DB.prepare(`UPDATE finance_transactions SET is_hidden = 1 WHERE note = 'Công cắt cỏ'`).run();
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.map((t) => t.note)).not.toContain('Công cắt cỏ');
    expect(body.total).toBe(2);
  });

  it('includeHidden=1 has no effect for a non-admin role', async () => {
    await env.DB.prepare(`UPDATE finance_transactions SET is_hidden = 1 WHERE note = 'Công cắt cỏ'`).run();
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?includeHidden=1', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.total).toBe(2);
  });

  it('includeHidden=1 as admin includes hidden transactions', async () => {
    await env.DB.prepare(`UPDATE finance_transactions SET is_hidden = 1 WHERE note = 'Công cắt cỏ'`).run();
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions?includeHidden=1', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.total).toBe(3);
    expect(body.transactions.map((t) => t.note)).toContain('Công cắt cỏ');
  });

  it('response includes isHidden as a real boolean on every row', async () => {
    const response = await listTransactions({ request: authedRequest('https://x/api/finance/transactions', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.transactions.every((t) => typeof t.isHidden === 'boolean')).toBe(true);
  });
});

describe('PATCH /api/finance/transactions/:id/hide', () => {
  let voidedTxId, activeTxId;

  beforeEach(async () => {
    const voided = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at, voided_by, voided_at) VALUES ('expense', 'vat_tu', 50000, 'Nhập nhầm', '2026-08-22', 'confirmed', 'quan_ly_fin', '2026-08-22T00:00:00Z', 'admin_fin', '2026-08-23T00:00:00Z')`
    ).run();
    voidedTxId = voided.meta.last_row_id;
    const active = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('expense', 'vat_tu', 60000, 'Còn hiệu lực', '2026-08-24', 'confirmed', 'quan_ly_fin', '2026-08-24T00:00:00Z')`
    ).run();
    activeTxId = active.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/hide`, null, 'PATCH', { hidden: true }), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(401);
  });

  it('rejects manager (403) — hide is admin-only', async () => {
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/hide`, managerToken, 'PATCH', { hidden: true }), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(403);
  });

  it('rejects reception (403)', async () => {
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/hide`, receptionToken, 'PATCH', { hidden: true }), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await hideTransaction({ request: authedRequest('https://x/api/finance/transactions/999999/hide', adminToken, 'PATCH', { hidden: true }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('400s when the transaction has not been voided', async () => {
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${activeTxId}/hide`, adminToken, 'PATCH', { hidden: true }), env, params: { id: String(activeTxId) } });
    expect(response.status).toBe(400);
  });

  it('400s when hidden is missing or not a boolean', async () => {
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/hide`, adminToken, 'PATCH', {}), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(400);
  });

  it('hides a voided transaction and writes an audit_log row using summarize()', async () => {
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/hide`, adminToken, 'PATCH', { hidden: true }), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM finance_transactions WHERE id = ?`).bind(voidedTxId).first();
    expect(row.is_hidden).toBe(1);
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'record_hide' AND entity_id = ?`).bind(voidedTxId).first();
    expect(audit.entity_type).toBe('finance_transaction');
    expect(audit.entity_label).toContain('Nhập nhầm');
    expect(audit.new_value).toBe('ẩn');
  });

  it('unhides a hidden transaction', async () => {
    await env.DB.prepare(`UPDATE finance_transactions SET is_hidden = 1 WHERE id = ?`).bind(voidedTxId).run();
    const response = await hideTransaction({ request: authedRequest(`https://x/api/finance/transactions/${voidedTxId}/hide`, adminToken, 'PATCH', { hidden: false }), env, params: { id: String(voidedTxId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM finance_transactions WHERE id = ?`).bind(voidedTxId).first();
    expect(row.is_hidden).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/financeTransactions.test.js`
Expected: FAIL — the GET tests fail because `hide.js` doesn't exist yet (import error) and because the current `onRequestGet` still returns a bare array (`body.transactions` is `undefined`).

- [ ] **Step 3: Rewrite `onRequestGet` in `v4/functions/api/finance/transactions/index.js`**

Replace the existing `coerceRow` function with:

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
    isHidden: !!r.is_hidden,
  };
}
```

Replace the existing `onRequestGet` function entirely with:

```js
const VALID_PAGE_SIZES = [10, 25, 50, 100];

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const type = url.searchParams.get('type');
  const category = url.searchParams.get('category');
  const status = url.searchParams.get('status');
  const q = url.searchParams.get('q');
  const includeHidden = url.searchParams.get('includeHidden') === '1' && auth.role === 'admin';

  const pageParam = url.searchParams.get('page');
  const pageSizeParam = url.searchParams.get('pageSize');
  const page = pageParam ? Number(pageParam) : 1;
  const pageSize = pageSizeParam ? Number(pageSizeParam) : 25;
  if (!Number.isInteger(page) || page < 1) return jsonError('Trang không hợp lệ', 400);
  if (!VALID_PAGE_SIZES.includes(pageSize)) return jsonError('Số mục/trang không hợp lệ', 400);

  const clauses = [];
  const params = [];
  if (from) { clauses.push('transaction_date >= ?'); params.push(from); }
  if (to) { clauses.push('transaction_date <= ?'); params.push(to); }
  if (type) { clauses.push('type = ?'); params.push(type); }
  if (category) { clauses.push('category = ?'); params.push(category); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (q) { clauses.push('note LIKE ? COLLATE NOCASE'); params.push(`%${q}%`); }
  if (!includeHidden) { clauses.push('is_hidden = 0'); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results: allRows } = await env.DB.prepare(
    `SELECT * FROM finance_transactions ${where} ORDER BY transaction_date DESC, id DESC`
  ).bind(...params).all();

  const total = allRows.length;
  let sumIncome = 0;
  let sumExpense = 0;
  const categoryTotals = {};
  const chartRows = [];
  for (const r of allRows) {
    if (r.type === 'income') sumIncome += r.amount; else sumExpense += r.amount;
    if (!categoryTotals[r.category]) categoryTotals[r.category] = { income: 0, expense: 0 };
    categoryTotals[r.category][r.type] += r.amount;
    chartRows.push({ transactionDate: r.transaction_date, type: r.type, amount: r.amount, status: r.status, voidedAt: r.voided_at });
  }

  const offset = (page - 1) * pageSize;
  const pageRows = allRows.slice(offset, offset + pageSize);

  return new Response(JSON.stringify({
    transactions: pageRows.map(coerceRow),
    total,
    page,
    pageSize,
    sumIncome,
    sumExpense,
    categoryTotals,
    chartRows,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

(`onRequestPost` in this file is unchanged — leave it exactly as-is.)

- [ ] **Step 4: Create `v4/functions/api/finance/transactions/[id]/hide.js`**

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';
import { summarize } from '../index.js';
import { loadCategoryMeta } from '../../../../../lib/financeCategories.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM finance_transactions WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy giao dịch', 404);
  if (!existing.voided_at) return jsonError('Chỉ có thể ẩn giao dịch đã huỷ', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { hidden } = body || {};
  if (typeof hidden !== 'boolean') return jsonError('Thiếu trạng thái ẩn/hiện', 400);

  const categoryMeta = await loadCategoryMeta(env);
  const summary = summarize(existing, categoryMeta);
  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(`UPDATE finance_transactions SET is_hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('record_hide', 'finance_transaction', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, summary, existing.is_hidden ? 'ẩn' : 'hiện', hidden ? 'ẩn' : 'hiện', auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/financeTransactions.test.js`
Expected: PASS, 63/63 — the file had 45 tests before this task; the GET describe block above REPLACES the existing 12-test block with a 21-test one (net +9), and the hide describe block is entirely new (9 tests): 45 - 12 + 21 + 9 = 63. Recount with `grep -c "  it("` against the final file to confirm exactly 63 — do not trust this arithmetic over the actual count. Retry up to ~6 times if you hit the Windows Miniflare teardown flake.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/finance/transactions/index.js "functions/api/finance/transactions/[id]/hide.js" test/financeTransactions.test.js
git commit -m "feat: paginate/aggregate GET /api/finance/transactions, add hide endpoint

GET /api/finance/transactions now returns { transactions, total, page,
pageSize, sumIncome, sumExpense, categoryTotals, chartRows } instead of
a bare array — sums/categoryTotals/chartRows are computed over the full
filtered set (not just the returned page), needed by the client's new
revenue stat, category pie charts, and existing time chart. Adds
PATCH .../hide (admin-only, gated on voided_at IS NOT NULL — finance
transactions have no terminal status, so only a voided entry is ever a
hide candidate), reusing the already-registered record_hide action_type.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Client — Sổ thu chi UI rework

**Files:**
- Modify: `v4/admin/finance.html`
- Modify: `v4/admin/finance.js`
- Modify: `v4/admin/admin.css`

**Interfaces:**
- Consumes: `GET /api/finance/transactions` response shape from Task 2 (`transactions`, `total`, `page`, `pageSize`, `sumIncome`, `sumExpense`, `categoryTotals`, `chartRows`), `PATCH /api/finance/transactions/:id/hide` from Task 2.
- Produces: nothing consumed by a later task in this plan (Task 4's e2e tests read DOM ids this task creates — see below).

**DOM ids this task creates or renames** (Task 4 depends on these exact names): `#openAddTransactionBtn` (replaces `#addTransactionSection`), `#financeFormOverlay`, `#financeFormTitle`, `#financeFormCloseBtn` (replaces `#financeCancelEditBtn`, which is removed), `#financeVoidOverlay`, `#financeVoidSummary`, `#financeVoidConfirmBtn`, `#financeVoidCancelBtn`, `#financeVoidError`, `#showHiddenTransactionsWrap`, `#showHiddenTransactions`, `#financeFilteredStats`, `#financePagination`, `#financePageSize`, `#financePrevPageBtn`, `#financeNextPageBtn`, `#financePageInfo`, `#chartTypeToggle`.

- [ ] **Step 1: Add the `.confirm-box.wide` CSS rule**

In `v4/admin/admin.css`, immediately after the existing `.confirm-box { ... }` rule (around line 280-283), add:

```css
.confirm-box.wide { max-width: 560px; }
```

- [ ] **Step 2: Replace `v4/admin/finance.html` entirely with:**

```html
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
    <p id="financeStorageWarning" class="warning-banner hidden"></p>

    <button type="button" id="openAddTransactionBtn" class="hidden">+ Thêm giao dịch</button>

    <div id="financeFormOverlay" class="confirm-overlay hidden">
      <div class="confirm-box wide">
        <h3 id="financeFormTitle">Thêm giao dịch</h3>
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
          <button type="button" id="financeFormCloseBtn" class="btn-secondary">Đóng</button>
          <p id="financeFormError" class="error"></p>
        </form>
      </div>
    </div>

    <div id="financeVoidOverlay" class="confirm-overlay hidden">
      <div class="confirm-box">
        <h3>Xác nhận huỷ giao dịch</h3>
        <p id="financeVoidSummary"></p>
        <button type="button" id="financeVoidConfirmBtn">Huỷ giao dịch</button>
        <button type="button" id="financeVoidCancelBtn" class="btn-secondary">Đóng</button>
        <p id="financeVoidError" class="error"></p>
      </div>
    </div>

    <h2>Cân đối</h2>
    <label>Chọn tháng <input type="month" id="financeMonthInput" /></label>
    <div class="stat-grid" id="financeStats"></div>
    <div id="openingBalanceEditor" class="hidden"></div>

    <h2>Biểu đồ</h2>
    <div class="filters" id="chartTypeToggle">
      <button type="button" class="tab-btn active" data-chart-type="time">Theo thời gian</button>
      <button type="button" class="tab-btn" data-chart-type="category">Theo danh mục</button>
    </div>
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
    <label class="checkbox hidden" id="showHiddenTransactionsWrap"><input type="checkbox" id="showHiddenTransactions" /> Hiển thị các log đã ẩn</label>

    <div class="stat-grid" id="financeFilteredStats"></div>

    <p id="listError" class="error"></p>
    <div class="table-scroll" id="financeTableWrap">
      <table id="financeTable">
        <thead><tr><th>Ngày</th><th>Loại</th><th>Danh mục</th><th>Số tiền</th><th>Trạng thái</th><th>Ghi chú</th><th>Người tạo</th><th>Chứng từ</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <div class="booking-list" id="financeCardList"></div>

    <div class="filters" id="financePagination">
      <select id="financePageSize">
        <option value="10">10 / trang</option>
        <option value="25" selected>25 / trang</option>
        <option value="50">50 / trang</option>
        <option value="100">100 / trang</option>
      </select>
      <button type="button" id="financePrevPageBtn" class="btn-secondary">← Trước</button>
      <span id="financePageInfo"></span>
      <button type="button" id="financeNextPageBtn" class="btn-secondary">Sau →</button>
    </div>
  </div>

  <script src="/admin/finance.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Replace `v4/admin/finance.js` entirely with:**

```js
// v4/admin/finance.js
let currentRole = null;

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

function categoryLabel(slug) {
  return categoryMeta[slug] ? categoryMeta[slug].label : slug;
}

const STATUS_LABELS = { draft: 'Nháp', confirmed: 'Đã xác nhận', paid: 'Đã thanh toán' };

function formatVnd(amount) {
  return amount.toLocaleString('vi-VN') + 'đ';
}

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
    // localStorage unavailable — the toggle still updates the button state
    // below, it just won't persist across reloads.
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

function showFinanceError(message) {
  document.getElementById('financeError').textContent = message || '';
}

function openFinanceFormOverlay() {
  document.getElementById('financeFormOverlay').classList.remove('hidden');
}

function closeFinanceFormOverlay() {
  document.getElementById('financeFormOverlay').classList.add('hidden');
}

document.getElementById('openAddTransactionBtn').addEventListener('click', () => {
  resetFinanceForm();
  openFinanceFormOverlay();
});

document.getElementById('financeFormCloseBtn').addEventListener('click', () => {
  document.getElementById('financeFormError').textContent = '';
  resetFinanceForm();
  closeFinanceFormOverlay();
});

let pendingVoidId = null;

function openVoidConfirm(t) {
  pendingVoidId = t.id;
  document.getElementById('financeVoidError').textContent = '';
  const typeLabel = t.type === 'income' ? 'Thu' : 'Chi';
  document.getElementById('financeVoidSummary').textContent = `${t.transactionDate} — ${typeLabel} · ${categoryLabel(t.category)} · ${formatVnd(t.amount)}`;
  document.getElementById('financeVoidOverlay').classList.remove('hidden');
}

function closeVoidConfirm() {
  pendingVoidId = null;
  document.getElementById('financeVoidOverlay').classList.add('hidden');
}

document.getElementById('financeVoidCancelBtn').addEventListener('click', closeVoidConfirm);

document.getElementById('financeVoidConfirmBtn').addEventListener('click', async () => {
  if (!pendingVoidId) return;
  const ok = await voidTransaction(pendingVoidId);
  if (ok) closeVoidConfirm();
});

let currentPage = 1;
let currentPageSize = 25;
let currentTotal = 0;
let currentCategoryTotals = {};
let currentChartRows = [];
let currentChartType = 'time';

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

  await loadCategoryMeta();

  setDefaultTypePreference(defaultTypePreference());
  populateCategorySelect(document.getElementById('filterCategory'), { includeAllOption: true });

  if (currentRole === 'manager' || currentRole === 'admin') {
    document.getElementById('openAddTransactionBtn').classList.remove('hidden');
    document.getElementById('openingBalanceEditor').classList.remove('hidden');
  }

  if (currentRole === 'admin') {
    document.getElementById('showHiddenTransactionsWrap').classList.remove('hidden');
  }
  document.getElementById('showHiddenTransactions').addEventListener('change', () => {
    currentPage = 1;
    loadTransactions();
  });

  resetFinanceForm();
  await loadTransactions();
  document.getElementById('financeMonthInput').value = currentMonthValue();
  await refreshFinanceSummary();
  await refreshStorageWarning();
})();

let currentTransactions = [];

function transactionRowHtml(t) {
  const typeLabel = t.type === 'income' ? 'Thu' : 'Chi';
  const statusClass = t.status === 'draft' ? 'status-draft' : t.status === 'confirmed' ? 'status-fin-confirmed' : 'status-paid';
  const canEdit = (currentRole === 'manager' || currentRole === 'admin') && !t.voidedAt;
  return { typeLabel, statusClass, canEdit };
}

async function toggleHideTransaction(t) {
  const errorEl = document.getElementById('listError');
  errorEl.textContent = '';
  const response = await fetch(`/api/finance/transactions/${t.id}/hide`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: !t.isHidden }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi ẩn/hiện giao dịch';
    return;
  }
  await loadTransactions();
}

function buildActionButtons(t) {
  const { canEdit } = transactionRowHtml(t);
  const container = document.createDocumentFragment();
  if (canEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'table-actions-btn';
    editBtn.title = 'Sửa';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => openEditTransaction(t));
    const voidBtn = document.createElement('button');
    voidBtn.type = 'button';
    voidBtn.className = 'btn-secondary table-actions-btn';
    voidBtn.title = 'Huỷ';
    voidBtn.textContent = '🗑';
    voidBtn.addEventListener('click', () => openVoidConfirm(t));
    container.append(editBtn, voidBtn);
  }
  if (currentRole === 'admin' && t.voidedAt) {
    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'btn-secondary table-actions-btn';
    hideBtn.title = t.isHidden ? 'Hiện' : 'Ẩn';
    hideBtn.textContent = t.isHidden ? '👁️' : '🙈';
    hideBtn.addEventListener('click', () => toggleHideTransaction(t));
    container.appendChild(hideBtn);
  }
  return container;
}

function renderTransactions(list) {
  currentTransactions = list;
  const tbody = document.querySelector('#financeTable tbody');
  const cardList = document.getElementById('financeCardList');
  tbody.innerHTML = '';
  cardList.innerHTML = '';

  function applyVoidedStyle(el, voided) {
    if (voided) {
      el.style.textDecoration = 'line-through';
      el.style.opacity = '0.5';
    }
  }

  list.forEach((t) => {
    const { typeLabel, statusClass } = transactionRowHtml(t);

    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = t.transactionDate;
    applyVoidedStyle(tdDate, t.voidedAt);
    const tdType = document.createElement('td');
    tdType.textContent = typeLabel;
    applyVoidedStyle(tdType, t.voidedAt);
    const tdCategory = document.createElement('td');
    tdCategory.textContent = categoryLabel(t.category);
    applyVoidedStyle(tdCategory, t.voidedAt);
    const tdAmount = document.createElement('td');
    tdAmount.textContent = formatVnd(t.amount);
    applyVoidedStyle(tdAmount, t.voidedAt);
    const tdStatus = document.createElement('td');
    const statusBadge = document.createElement('span');
    statusBadge.className = `status-badge ${statusClass}`;
    statusBadge.textContent = STATUS_LABELS[t.status];
    applyVoidedStyle(statusBadge, t.voidedAt);
    tdStatus.appendChild(statusBadge);
    const tdNote = document.createElement('td');
    tdNote.textContent = t.note || '';
    applyVoidedStyle(tdNote, t.voidedAt);
    const tdCreatedBy = document.createElement('td');
    tdCreatedBy.textContent = t.createdBy;
    applyVoidedStyle(tdCreatedBy, t.voidedAt);
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
    const tdActions = document.createElement('td');
    tdActions.appendChild(buildActionButtons(t));
    tr.append(tdDate, tdType, tdCategory, tdAmount, tdStatus, tdNote, tdCreatedBy, tdAttachment, tdActions);
    tbody.appendChild(tr);

    const card = document.createElement('div');
    card.className = 'booking-card';
    const pHeader = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = t.transactionDate;
    pHeader.append(strong, ` — ${typeLabel} · ${categoryLabel(t.category)}`);
    applyVoidedStyle(pHeader, t.voidedAt);
    const pAmount = document.createElement('p');
    const amountBadge = document.createElement('span');
    amountBadge.className = `status-badge ${statusClass}`;
    amountBadge.textContent = STATUS_LABELS[t.status];
    pAmount.append(`${formatVnd(t.amount)} `, amountBadge);
    applyVoidedStyle(pAmount, t.voidedAt);
    const pNote = document.createElement('p');
    pNote.textContent = t.note || '';
    applyVoidedStyle(pNote, t.voidedAt);
    const pCreatedBy = document.createElement('p');
    pCreatedBy.textContent = t.createdBy;
    pCreatedBy.style.opacity = '0.7';
    pCreatedBy.style.fontSize = '0.85rem';
    applyVoidedStyle(pCreatedBy, t.voidedAt);
    card.append(pHeader, pAmount, pNote, pCreatedBy);
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
    const cardActions = document.createElement('div');
    cardActions.className = 'booking-actions';
    cardActions.appendChild(buildActionButtons(t));
    if (cardActions.childNodes.length > 0) card.appendChild(cardActions);
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

function renderFilteredStats(sumIncome) {
  const container = document.getElementById('financeFilteredStats');
  container.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'stat-card';
  const value = document.createElement('div');
  value.className = 'stat-value';
  value.textContent = formatVnd(sumIncome);
  const label = document.createElement('div');
  label.className = 'stat-label';
  label.textContent = 'Tổng doanh thu (theo bộ lọc)';
  div.append(value, label);
  container.appendChild(div);
}

function renderPagination() {
  const info = document.getElementById('financePageInfo');
  const totalPages = Math.max(1, Math.ceil(currentTotal / currentPageSize));
  info.textContent = `Trang ${currentPage}/${totalPages} (${currentTotal} giao dịch)`;
  document.getElementById('financePrevPageBtn').disabled = currentPage <= 1;
  document.getElementById('financeNextPageBtn').disabled = currentPage >= totalPages;
}

document.getElementById('financePageSize').addEventListener('change', (event) => {
  currentPageSize = Number(event.target.value);
  currentPage = 1;
  loadTransactions();
});

document.getElementById('financePrevPageBtn').addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    loadTransactions();
  }
});

document.getElementById('financeNextPageBtn').addEventListener('click', () => {
  const totalPages = Math.max(1, Math.ceil(currentTotal / currentPageSize));
  if (currentPage < totalPages) {
    currentPage += 1;
    loadTransactions();
  }
});

async function loadTransactions(filters) {
  const listError = document.getElementById('listError');
  listError.textContent = '';
  const params = new URLSearchParams();
  Object.entries(filters || currentFilters()).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  params.set('page', String(currentPage));
  params.set('pageSize', String(currentPageSize));
  if (currentRole === 'admin' && document.getElementById('showHiddenTransactions').checked) {
    params.set('includeHidden', '1');
  }
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
  const body = await response.json();
  currentTotal = body.total;
  currentCategoryTotals = body.categoryTotals;
  currentChartRows = body.chartRows;
  renderTransactions(body.transactions);
  renderFilteredStats(body.sumIncome);
  renderPagination();
  renderChart();
}

async function voidTransaction(id) {
  const errorEl = document.getElementById('financeVoidError');
  errorEl.textContent = '';
  const response = await fetch(`/api/finance/transactions/${id}/void`, { method: 'PATCH' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi huỷ giao dịch';
    return false;
  }
  await loadTransactions();
  if (typeof refreshFinanceSummary === 'function') refreshFinanceSummary();
  return true;
}

function openEditTransaction(t) {
  const form = document.getElementById('financeForm');
  form.querySelector('[name="type"]').value = t.type;
  const select = form.querySelector('[name="category"]');
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
  document.getElementById('financeFormTitle').textContent = 'Sửa giao dịch';
  renderAttachmentEditor(t);
  openFinanceFormOverlay();
}

function resetFinanceForm() {
  const form = document.getElementById('financeForm');
  form.reset();
  delete form.dataset.editingId;
  const defaultType = defaultTypePreference();
  form.querySelector('[name="type"]').value = defaultType;
  populateCategorySelect(form.querySelector('[name="category"]'), { type: defaultType });
  form.querySelector('[name="transactionDate"]').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  document.querySelector('#financeForm button[type="submit"]').textContent = 'Ghi giao dịch';
  document.getElementById('financeFormTitle').textContent = 'Thêm giao dịch';
  renderAttachmentEditor(null);
}

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
    note: form.querySelector('[name="note"]').value,
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

  const body = await response.json();
  const transactionId = editingId || body.id;
  const fileInput = form.querySelector('[name="receipt"]');
  const file = fileInput.files[0];
  let attachmentFailed = false;
  if (file) {
    const uploadForm = new FormData();
    uploadForm.append('file', file);
    try {
      const uploadResponse = await fetch(`/api/finance/transactions/${transactionId}/attachment`, { method: 'POST', body: uploadForm });
      if (!uploadResponse.ok) {
        errorEl.textContent = 'Đã lưu giao dịch nhưng tải chứng từ lên thất bại — có thể thử lại bằng nút Sửa';
        attachmentFailed = true;
      }
    } catch (err) {
      errorEl.textContent = 'Đã lưu giao dịch nhưng tải chứng từ lên thất bại — có thể thử lại bằng nút Sửa';
      attachmentFailed = true;
    }
  }

  await loadTransactions();
  if (typeof refreshFinanceSummary === 'function') refreshFinanceSummary();
  if (attachmentFailed) {
    // Keep the popup open so the error stays visible and the user can retry
    // the attachment via "Sửa" — the transaction record itself already saved.
    return;
  }
  resetFinanceForm();
  closeFinanceFormOverlay();
});

document.querySelectorAll('#financeFilters input:not(#filterKeyword), #financeFilters select').forEach((el) => {
  el.addEventListener('change', () => {
    currentPage = 1;
    loadTransactions();
  });
});

let keywordDebounceTimer;
document.getElementById('filterKeyword').addEventListener('input', () => {
  clearTimeout(keywordDebounceTimer);
  keywordDebounceTimer = setTimeout(() => {
    currentPage = 1;
    loadTransactions();
  }, 350);
});

function currentMonthValue() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 7);
}

function renderStatCards(summary) {
  const container = document.getElementById('financeStats');
  container.innerHTML = '';
  const sourceLabels = { manual: 'nhập tay', carried_forward: 'kế thừa kỳ trước', default_zero: 'mặc định' };
  const sourceLabel = sourceLabels[summary.openingBalanceSource];
  const cards = [];
  if (summary.openingBalance !== undefined) {
    cards.push({ label: sourceLabel ? `Số dư đầu kỳ (${sourceLabel})` : 'Số dư đầu kỳ', value: formatVnd(summary.openingBalance) });
  }
  if (summary.totalIncome !== undefined) cards.push({ label: 'Tổng thu', value: formatVnd(summary.totalIncome) });
  if (summary.totalExpense !== undefined) cards.push({ label: 'Tổng chi', value: formatVnd(summary.totalExpense) });
  if (summary.netChange !== undefined) cards.push({ label: 'Lợi nhuận tạm tính', value: formatVnd(summary.netChange) });
  if (summary.closingBalance !== undefined) cards.push({ label: 'Số dư cuối kỳ', value: formatVnd(summary.closingBalance) });
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

  const isPrivileged = currentRole === 'manager' || currentRole === 'admin';

  let summaryResponse, openingResponse;
  try {
    [summaryResponse, openingResponse] = await Promise.all([
      fetch(`/api/finance/summary?month=${month}`),
      isPrivileged ? fetch(`/api/finance/opening-balance?period=${month}`) : Promise.resolve(null),
    ]);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải số liệu cân đối';
    return;
  }
  if (!summaryResponse.ok || (openingResponse && !openingResponse.ok)) {
    const failedResponse = !summaryResponse.ok ? summaryResponse : openingResponse;
    const body = await failedResponse.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải số liệu cân đối';
    return;
  }

  const summary = await summaryResponse.json();
  const opening = openingResponse ? await openingResponse.json() : { openingBalance: null };
  renderStatCards(summary);
  renderOpeningBalanceEditor(month, opening.openingBalance);
}

async function refreshStorageWarning() {
  if (currentRole !== 'manager' && currentRole !== 'admin') return;
  const banner = document.getElementById('financeStorageWarning');
  let response;
  try {
    response = await fetch('/api/finance/receipts-usage');
  } catch (err) {
    return;
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

document.getElementById('financeMonthInput').addEventListener('change', refreshFinanceSummary);

let currentGranularity = 'week';

function isoWeekMonday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
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

function buildBuckets(rows, granularity) {
  const map = new Map();
  rows
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

function renderTimeChart(granularity) {
  currentGranularity = granularity || currentGranularity;
  const container = document.getElementById('financeChart');
  const buckets = buildBuckets(currentChartRows, currentGranularity);

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

const CHART_COLORS = ['#C9A84C', '#ff8a8a', '#7fb8a4', '#8aa8ff', '#e0a458', '#c084fc', '#5ec8d8', '#f28fa3', '#9fca5a', '#d9906c', '#7f9fc9', '#e8c15a'];

function buildPieSlices(totals, key) {
  const entries = Object.entries(totals)
    .map(([slug, t]) => ({ slug, value: t[key] }))
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);
  const sum = entries.reduce((s, e) => s + e.value, 0);
  return { entries, sum };
}

function renderPie(containerId, totals, key, titleText) {
  const container = document.getElementById(containerId);
  const { entries, sum } = buildPieSlices(totals, key);
  if (sum === 0) {
    container.innerHTML = `<h4 style="margin:8px 0 4px;">${titleText}</h4><p style="opacity:0.6;">Không có dữ liệu để vẽ biểu đồ.</p>`;
    return;
  }
  const cx = 90;
  const cy = 90;
  const r = 80;
  let angle = -90;
  let svg = `<svg viewBox="0 0 180 180" role="img" aria-label="Biểu đồ ${titleText} theo danh mục" style="width: 180px; height: 180px; flex-shrink: 0;">`;
  entries.forEach((e, i) => {
    const fraction = e.value / sum;
    const sweep = fraction * 360;
    const x1 = cx + r * Math.cos((Math.PI / 180) * angle);
    const y1 = cy + r * Math.sin((Math.PI / 180) * angle);
    const endAngle = angle + sweep;
    const x2 = cx + r * Math.cos((Math.PI / 180) * endAngle);
    const y2 = cy + r * Math.sin((Math.PI / 180) * endAngle);
    const largeArc = sweep > 180 ? 1 : 0;
    const color = CHART_COLORS[i % CHART_COLORS.length];
    svg += `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}" />`;
    angle = endAngle;
  });
  svg += `</svg>`;

  const legend = entries.map((e, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const pct = ((e.value / sum) * 100).toFixed(1);
    return `<div style="display:flex;align-items:center;gap:6px;font-size:0.85rem;"><span style="display:inline-block;width:10px;height:10px;background:${color};border-radius:2px;"></span>${categoryLabel(e.slug)} — ${pct}% (${formatVnd(e.value)})</div>`;
  }).join('');

  container.innerHTML = `<h4 style="margin:8px 0 4px;">${titleText}</h4><div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">${svg}<div style="display:flex;flex-direction:column;gap:4px;">${legend}</div></div>`;
}

function renderCategoryPies() {
  const container = document.getElementById('financeChart');
  container.innerHTML = '<div id="financePieIncome"></div><div id="financePieExpense"></div>';
  renderPie('financePieIncome', currentCategoryTotals, 'income', 'Thu');
  renderPie('financePieExpense', currentCategoryTotals, 'expense', 'Chi');
}

function renderChart() {
  if (currentChartType === 'category') {
    renderCategoryPies();
  } else {
    renderTimeChart(currentGranularity);
  }
}

document.querySelectorAll('#chartTypeToggle .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chartTypeToggle .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentChartType = btn.dataset.chartType;
    document.getElementById('chartGranularity').classList.toggle('hidden', currentChartType !== 'time');
    renderChart();
  });
});

document.querySelectorAll('#chartGranularity .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chartGranularity .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderTimeChart(btn.dataset.granularity);
  });
});
```

- [ ] **Step 4: Kiểm tra thủ công bằng trình duyệt thật**

Đây là thay đổi client thuần trên diện rộng — `node -c` chỉ kiểm tra cú pháp, KHÔNG phát hiện lỗi runtime. Bắt buộc dùng trình duyệt thật (Playwright headless Chrome, hoặc `wrangler pages dev .` — KHÔNG dùng `npm run dev`, flag `--d1=DB` của nó trỏ vào 1 file D1 local KHÁC với file `wrangler d1 migrations apply`/`d1 execute` dùng) để xác nhận, với dữ liệu giao dịch thật (bao gồm ít nhất 1 giao dịch đã huỷ để test Ẩn/Hiện):
- Trang tải không lỗi console.
- Manager/admin thấy nút "+ Thêm giao dịch"; bấm mở đúng popup, điền form, submit tạo giao dịch mới, popup tự đóng, danh sách+Cân đối cập nhật.
- Bấm ✏️ trên 1 dòng mở đúng popup ở chế độ Sửa (tiêu đề "Sửa giao dịch", nút "Lưu thay đổi"), form điền sẵn đúng dữ liệu dòng đó.
- Bấm 🗑 mở popup xác nhận Huỷ, bấm "Đóng" không huỷ gì; bấm "Huỷ giao dịch" mới thực sự gọi `PATCH .../void`, danh sách cập nhật.
- Admin thấy checkbox "Hiển thị các log đã ẩn" + nút 🙈/👁️ trên dòng đã huỷ; manager không thấy checkbox lẫn nút này.
- Ẩn 1 giao dịch đã huỷ → biến mất khỏi mặc định → tick checkbox → hiện lại.
- Đổi `pageSize`, bấm Trước/Sau hoạt động đúng, `#financePageInfo` hiển thị đúng số trang/tổng.
- "Tổng doanh thu (theo bộ lọc)" đổi đúng khi thay đổi bộ lọc Giao dịch.
- Gạt "Theo danh mục" hiện đúng 2 pie chart (Thu/Chi), gạt lại "Theo thời gian" hiện đúng lại biểu đồ cột cũ với 3 nút Ngày/Tuần/Tháng.

- [ ] **Step 5: Commit**

```bash
cd v4
git add admin/finance.html admin/finance.js admin/admin.css
git commit -m "feat: rework Sổ thu chi UI — popup form, compact action icons, void confirm, hide checkbox, filtered revenue stat, pagination, category pie charts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: E2e coverage (outer repo)

**Files:**
- Modify: `tests/e2e/finance-dashboard.spec.js`

**Interfaces:**
- Consumes: every DOM id listed in Task 3's Interfaces section, and the `GET`/`PATCH` contracts from Task 2.

**Why a full-file replace, not a diff list:** the popup rework (Task 3) changes 3 things this file's EVERY test touches — `#addTransactionSection` no longer exists, `#financeForm` is hidden until `#openAddTransactionBtn` (or `openEditTransaction`) is clicked, the "Huỷ" button is now an icon matched by `title="Huỷ"` instead of visible text, and `GET /api/finance/transactions` returns an envelope not a bare array. Nearly every existing test needs at least one of these 4 fixes. Giving a "here's one example, apply the same pattern elsewhere" instruction for a file this interconnected is exactly the ambiguity the plan format exists to avoid — so this step gives the complete final file instead.

- [ ] **Step 1: Replace `tests/e2e/finance-dashboard.spec.js` entirely with:**

```js
// tests/e2e/finance-dashboard.spec.js
const { test, expect } = require('@playwright/test');

function toEnvelope(transactions, overrides = {}) {
  const sumIncome = transactions.filter((t) => t.type === 'income' && !t.voidedAt).reduce((s, t) => s + t.amount, 0);
  const sumExpense = transactions.filter((t) => t.type === 'expense' && !t.voidedAt).reduce((s, t) => s + t.amount, 0);
  const categoryTotals = {};
  transactions.forEach((t) => {
    if (!categoryTotals[t.category]) categoryTotals[t.category] = { income: 0, expense: 0 };
    categoryTotals[t.category][t.type] += t.amount;
  });
  const chartRows = transactions.map((t) => ({ transactionDate: t.transactionDate, type: t.type, amount: t.amount, status: t.status, voidedAt: t.voidedAt }));
  return { transactions, total: transactions.length, page: 1, pageSize: 25, sumIncome, sumExpense, categoryTotals, chartRows, ...overrides };
}

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
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(transactions)) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
    page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CATEGORIES) })),
  ]);
}

const DEFAULT_SUMMARY = { month: '2026-08', openingBalance: 1000000, openingBalanceSource: 'manual', totalIncome: 2000000, totalExpense: 500000, netChange: 1500000, closingBalance: 2500000 };
const DEFAULT_OPENING = { period: '2026-08', openingBalance: 1000000, setBy: 'quan_ly_a', setAt: '2026-08-01T00:00:00Z' };
const SAMPLE_TX = [
  { id: 1, type: 'income', category: 'ban_hang', amount: 2000000, note: 'Bán rau', transactionDate: '2026-08-10', status: 'paid', createdBy: 'quan_ly_a', createdAt: '2026-08-10T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
  { id: 2, type: 'expense', category: 'vat_tu', amount: 500000, note: 'Mua phân bón', transactionDate: '2026-08-12', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-12T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
];
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

test.describe('Finance dashboard (sổ thu chi)', () => {
  test('manager sees the add-transaction trigger and can see the balance stat cards', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#openAddTransactionBtn')).toBeVisible();
    await expect(page.locator('#financeStats')).toContainText('2.500.000');
    await expect(page.locator('#financeStats')).toContainText('1.000.000');
  });

  test('observer stays on the page but the API 403s hide all data and the write form', async ({ page }) => {
    // Revenue/expense figures are off-limits to this role entirely — every finance/*
    // endpoint 403s, mirroring the established reception-on-this-page pattern exactly.
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat_a', role: 'observer' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance.html');
    await expect(page).toHaveURL(/\/admin\/finance/);
    await expect(page.locator('#openAddTransactionBtn')).toBeHidden();
    await expect(page.locator('#openingBalanceEditor')).toBeEmpty();
    await expect(page.locator('#listError')).toContainText('Không đủ quyền');
    await expect(page.locator('#financeError')).toContainText('Không đủ quyền');
  });

  test('reception stays on the page but the API 403s hide all data and the write form', async ({ page }) => {
    // This codebase's established convention for a role-restricted admin page: no
    // client-side role redirect — only a truly unauthenticated visit (401 from
    // /api/auth/me) redirects to /admin. An authenticated-but-wrong-role visit stays
    // on the page, and every API call 403s, surfaced via the page's <p class="error">
    // elements. finance.html/js follows this exactly.
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance.html');
    await expect(page).toHaveURL(/\/admin\/finance/);
    await expect(page.locator('#openAddTransactionBtn')).toBeHidden();
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
    });

    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
    });

    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');
    await page.fill('#financeForm input[name="amount"]', '0');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-20');
    await page.click('#financeForm button[type="submit"]');

    await expect(page.locator('#financeFormError')).toContainText('số nguyên dương');
    expect(posted).toBe(false);
  });

  test('voiding a transaction requires confirmation and strikes it through in the table', async ({ page }) => {
    // Made the transactions GET mock stateful on the void flag below, matching this repo's
    // established convention for a void-then-reload flow. finance.js re-fetches the list
    // via GET after a successful void, exactly like a real backend would — a static mock
    // array can't reflect that, so without this the row never picks up its struck-through
    // style.
    let voided = false;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    // Registered before the /1/void route below so the latter (more specific, registered
    // later) takes priority for that URL — Playwright checks routes last-registered-first.
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') {
        const list = voided
          ? SAMPLE_TX.map((t) => (t.id === 1 ? { ...t, voidedBy: 'test_user', voidedAt: '2026-08-20T00:00:00Z' } : t))
          : SAMPLE_TX;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(list)) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    });
    await page.route('**/api/finance/transactions/1/void', (route) => {
      voided = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/finance.html');
    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button[title="Huỷ"]').click();
    await expect(page.locator('#financeVoidOverlay')).toBeVisible();

    await page.click('#financeVoidCancelBtn');
    await expect(page.locator('#financeVoidOverlay')).toBeHidden();
    expect(voided).toBe(false);

    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button[title="Huỷ"]').click();
    await page.click('#financeVoidConfirmBtn');
    await expect.poll(() => voided).toBe(true);
    await expect(page.locator('#financeVoidOverlay')).toBeHidden();
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('td').first()).toHaveCSS('text-decoration-line', 'line-through');
  });

  test('filters re-fetch the transaction list with the selected query params', async ({ page }) => {
    let lastUrl = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') lastUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
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

  test('category dropdown re-filters when the type changes, dropping a now-invalid selection', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');

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
    await page.click('#openAddTransactionBtn');

    await page.click('#defaultTypeToggle button[data-default-type="income"]');
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);

    await page.reload();
    await page.click('#openAddTransactionBtn');
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);
    await expect(page.locator('#financeForm select[name="type"]')).toHaveValue('income');
  });

  test('uploading a receipt file shows the 📎 indicator after the transaction is created', async ({ page }) => {
    let uploadedFilename = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      const withReceipt = [...SAMPLE_TX, { id: 3, type: 'expense', category: 'vat_tu', amount: 100000, note: 'Có chứng từ', transactionDate: '2026-08-21', status: 'draft', createdBy: 'test_user', createdAt: '2026-08-21T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null, receiptKey: 'finance-receipts/3/x-bill.pdf', receiptFilename: 'bill.pdf', receiptUploadedAt: '2026-08-21T00:00:00Z' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(withReceipt)) });
    });
    await page.route('**/api/finance/transactions/3/attachment', (route) => {
      uploadedFilename = 'bill.pdf';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptFilename: 'bill.pdf' }) });
    });

    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');
    await page.fill('#financeForm input[name="amount"]', '100000');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-21');
    await page.fill('#financeForm input[name="note"]', 'Có chứng từ');
    await page.setInputFiles('#financeForm input[name="receipt"]', { name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await page.click('#financeForm button[type="submit"]');

    await expect.poll(() => uploadedFilename).toBe('bill.pdf');
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Có chứng từ' })).toContainText('📎');
  });

  test('manager sees the storage warning banner when receipt usage is over 9GB', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/receipts-usage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalBytes: 9800000000, thresholdBytes: 9663676416, overThreshold: true }) }));

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStorageWarning')).toBeVisible();
    await expect(page.locator('#financeStorageWarning')).toContainText('9GB');
  });

  test('observer never triggers a receipts-usage fetch (no banner, no request)', async ({ page }) => {
    let usageRequested = false;
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat_a', role: 'observer' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/receipts-usage', (route) => {
      usageRequested = true;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) });
    });

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStorageWarning')).toBeHidden();
    expect(usageRequested).toBe(false);
  });

  test('clicking "Sửa" opens the popup pre-filled with the row\'s data', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeFormOverlay')).toBeHidden();
    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button[title="Sửa"]').click();
    await expect(page.locator('#financeFormOverlay')).toBeVisible();
    await expect(page.locator('#financeFormTitle')).toHaveText('Sửa giao dịch');
    await expect(page.locator('#financeForm input[name="amount"]')).toHaveValue('2000000');
  });

  test('non-admin does not see the "Hiển thị các log đã ẩn" checkbox or Ẩn/Hiện button, even on a voided row', async ({ page }) => {
    const voidedTx = { id: 3, type: 'expense', category: 'vat_tu', amount: 50000, note: 'Nhập nhầm', transactionDate: '2026-08-05', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-05T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: 'admin_a', voidedAt: '2026-08-06T00:00:00Z', isHidden: false };
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: [...SAMPLE_TX, voidedTx] });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#showHiddenTransactionsWrap')).toBeHidden();
    await expect(page.locator('button[title="Ẩn"]')).toHaveCount(0);
  });

  test('admin sees the checkbox and Ẩn/Hiện button on voided rows; ticking it requests includeHidden=1', async ({ page }) => {
    const voidedTx = { id: 3, type: 'expense', category: 'vat_tu', amount: 50000, note: 'Nhập nhầm', transactionDate: '2026-08-05', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-05T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: 'admin_a', voidedAt: '2026-08-06T00:00:00Z', isHidden: false };
    const all = [...SAMPLE_TX, voidedTx];
    await mockCommonRoutes(page, { role: 'admin', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: all });

    let includeHiddenRequested = false;
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
      const url = new URL(route.request().url());
      if (url.searchParams.get('includeHidden') === '1') includeHiddenRequested = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(all)) });
    });

    await page.goto('/admin/finance.html');
    await expect(page.locator('#showHiddenTransactionsWrap')).toBeVisible();
    await expect(page.locator('button[title="Ẩn"]')).toHaveCount(1);

    await page.locator('#showHiddenTransactions').check();
    await expect.poll(() => includeHiddenRequested).toBe(true);
  });

  test('changing pageSize and paging forward/back requests the correct page params', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });

    const requestedPages = [];
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
      const url = new URL(route.request().url());
      requestedPages.push({ page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX, { total: 30, page: Number(url.searchParams.get('page')), pageSize: Number(url.searchParams.get('pageSize')) })) });
    });

    await page.goto('/admin/finance.html');
    await page.selectOption('#financePageSize', '10');
    await expect.poll(() => requestedPages.at(-1)).toMatchObject({ page: '1', pageSize: '10' });

    await page.click('#financeNextPageBtn');
    await expect.poll(() => requestedPages.at(-1)).toMatchObject({ page: '2', pageSize: '10' });

    await page.click('#financePrevPageBtn');
    await expect.poll(() => requestedPages.at(-1)).toMatchObject({ page: '1', pageSize: '10' });
  });

  test('"Tổng doanh thu (theo bộ lọc)" reflects the response\'s sumIncome', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeFilteredStats')).toContainText('2.000.000');
  });

  test('toggling to "Theo danh mục" renders 2 pie charts; toggling back restores the time chart controls', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');
    await expect(page.locator('#chartGranularity')).toBeVisible();

    await page.click('#chartTypeToggle button[data-chart-type="category"]');
    await expect(page.locator('#chartGranularity')).toBeHidden();
    await expect(page.locator('#financePieIncome svg')).toBeVisible();
    await expect(page.locator('#financePieExpense svg')).toBeVisible();

    await page.click('#chartTypeToggle button[data-chart-type="time"]');
    await expect(page.locator('#chartGranularity')).toBeVisible();
    await expect(page.locator('#financeChart svg')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the full file**

Run: `npx playwright test tests/e2e/finance-dashboard.spec.js --project=v4`
Expected: PASS, 20/20 (14 tests carried over from the current file, restructured as described above, plus 6 new: "Sửa" popup, non-admin hide check, admin hide check, pagination, filtered revenue stat, category pie toggle — the standalone "Huỷ confirmation" behavior is folded into the existing "voiding a transaction" test rather than kept separate, since both exercise the same click-through). Confirm the exact count yourself with `grep -c "  test(" tests/e2e/finance-dashboard.spec.js` against the file you just wrote.

- [ ] **Step 3: Run the full v4 project to confirm no regressions**

Run: `npx playwright test --project=v4`
Expected: PASS, current baseline (157 tests listed via `npx playwright test --project=v4 --list`, confirmed before this task started) + 6 net new = 163, same single pre-existing unrelated failure in `reception-ops-board.spec.js` if it's still present — do not attempt to fix that one.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/finance-dashboard.spec.js
git commit -m "test: e2e coverage for Sổ thu chi UI rework (popup, void confirm, hide checkbox, pagination, category pie charts)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0026 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), deploy qua `npx wrangler pages deploy .` (dự án này không tự deploy theo git push).
3. Push repo ngoài (e2e test mới).
4. Smoke-test thực tế trên `admin/finance.html`: popup Thêm/Sửa, xác nhận Huỷ, checkbox Ẩn (admin), phân trang, 2 pie chart, tổng doanh thu theo bộ lọc. Dọn dữ liệu test sau khi xong (ẩn hoặc huỷ, không xoá cứng).
