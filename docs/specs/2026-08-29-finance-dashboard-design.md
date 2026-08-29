# Sổ thu chi hằng ngày (Finance Dashboard) — Design Spec

**Status:** Approved by user 2026-08-29, ready for implementation planning.

## 1. Goal

Add a manual daily income/expense ledger ("sổ thu chi") to Hiền Lê Garden V4's admin area: staff record thu (income) and chi (expense) transactions, classified into 8 fixed categories, and see a real-time balance summary (opening/closing balance, totals, profit) plus a simple chart and filterable transaction list — for whole-operation bookkeeping, not just booking revenue (which `dashboard.html` already covers separately and is untouched by this work).

## 2. Non-goals

- Not replacing or modifying `dashboard.html`'s existing booking-revenue analytics.
- Not integrating a real external accounting/ERP system — this is an internal manual ledger.
- Not building multi-currency support — VND only, matching the rest of the app.
- Not adding any new client-side library (no chart library, no framework) — the codebase has none and none is needed.
- Not exposing this page to the `reception` role at all (see §5).

## 3. Architecture fit

V4 is a Cloudflare Pages static site + Pages Functions (`functions/api/**`) backed by D1 (SQLite), with a vanilla-JS, no-build-step admin area under `admin/`. This feature follows every existing convention exactly:

- **New page:** `admin/finance.html` + `admin/finance.js`, structured like `admin/catalog.html`/`catalog.js` (page-init IIFE checks `GET /api/auth/me`, redirects to `/admin` if unauthenticated, shows/hides sections by role).
- **New API:** `functions/api/finance/` (transactions list/create, per-id update/void, summary, opening-balance), using `lib/requireAuth.js` exactly as every other endpoint does.
- **New migration:** `migrations/0015_finance_transactions.sql`, next in the existing numbered sequence.
- **Nav registration:** add one entry to `admin/nav-drawer.js`'s `NAV_GROUPS` (in the "Vận hành" group, icon 💵, label "Sổ thu chi"), roles `['manager', 'admin', 'observer']`.
- **Clean URLs:** add `/manager/finance` and `/observer/finance` lines to `v4/_redirects` (both → `/admin/finance`, HTTP 200 rewrite) — no `/reception/finance` line, matching how `audit-log.html` is currently only reachable under `/manager/audit-log` for the roles that have access to it.
- **Styling:** reuses existing `admin.css` classes only — `.stat-grid`/`.stat-card` (from the existing dashboard stat cards), `.filters`, `.table-scroll`, `.booking-card`/`.booking-list` (for the mobile card view), `.error`, `.checkbox-label`, `.btn-secondary`, `.status-badge` (new badge color variants added for this feature's own status values, following the exact existing `.status-*` pattern). No new CSS component families are introduced.
- **Audit logging:** every write (create/update/void a transaction, set an opening balance) inserts into the existing `audit_log` table, in the same `env.DB.batch([...])` transaction as the primary write, following the exact pattern in `functions/api/bookings/[id]/deposit.js`.

Nothing in this feature touches the public landing page, other admin pages, or existing tables.

## 4. Data model

`migrations/0015_finance_transactions.sql`:

```sql
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

Notes on the model, each a deliberate match to an existing pattern elsewhere in this codebase:

- `finance_opening_balance` is **insert-only**, exactly like `experience_booking_settings`/`reminder_settings`: writing a new value for a period always `INSERT`s a new row, never `UPDATE`s. Reading a period's manually-set value is `SELECT ... WHERE period = ? ORDER BY id DESC LIMIT 1`. This preserves a full history of who changed the opening balance for a given month and when — appropriate for financial data.
- `status` (draft/confirmed/paid) and the void markers (`voided_by`/`voided_at`) are **two independent axes**, exactly like `booking_service_items` separates its own `status` (posted/voided) from `payment_status` (pending/paid). A voided transaction keeps whatever `status` it had; it is simply excluded from every balance/total computation once voided.
- `category` is a fixed, shared list used identically for both `income` and `expense` transactions (per the approved design decision) — the 8 values are the exact ones the user specified, transliterated to snake_case slugs matching every other enum-like column in this codebase (`service_catalog.category`, `bookings.status`, etc.).
- `amount` is a positive integer VND amount, matching the existing money-column convention (`booking_service_items.unit_price`, `bookings.deposit_amount`, etc. are all integer VND, no floating point).
- No hard `DELETE` anywhere in this feature — matches the established soft-delete-only convention for financial/booking records.

## 5. Roles and access

| Role | GET (view) | POST/PATCH (write) |
|---|---|---|
| `admin` | ✅ | ✅ |
| `manager` | ✅ | ✅ |
| `observer` | ✅ | ❌ (403) |
| `reception` | ❌ (403; page itself is not even linked/reachable for this role) | ❌ (403) |

This mirrors the approved design decision: only manager/admin record money movements; observer can view; reception has no access to this page at all (not even read-only) — the ledger is treated the same as the existing promo/config pages that reception cannot see.

## 6. Balance calculation

All balance figures are **computed live** on every read — nothing is cached or stored as a running total, so editing, voiding, or adding a transaction is reflected correctly on the very next fetch with no separate recomputation step.

For a given month `M` (`YYYY-MM`):

```
totalIncome(M)  = SUM(amount) FROM finance_transactions
                  WHERE type = 'income' AND status IN ('confirmed','paid')
                    AND voided_at IS NULL
                    AND transaction_date is within month M

totalExpense(M) = same, type = 'expense'

openingBalance(M):
  1. Look up the single most recent finance_opening_balance row with period <= M
     (by string comparison — 'YYYY-MM' sorts correctly), i.e.
     SELECT opening_balance, period FROM finance_opening_balance
     WHERE period <= M ORDER BY period DESC, id DESC LIMIT 1
  2. If found (anchorPeriod, anchorValue):
       openingBalance(M) = anchorValue
                          + SUM(income - expense) for all confirmed/paid,
                            non-voided transactions with
                            transaction_date >= start of anchorPeriod
                            AND transaction_date <  start of M
     (When anchorPeriod == M exactly, that sum window is empty, so this
     correctly reduces to just anchorValue — the manually-entered value
     for M itself takes precedence over any carry-forward math.)
  3. If no finance_opening_balance row exists at all (ever): openingBalance(M) = 0,
     and the carry-forward sum in step 2 runs with no lower bound (from the
     beginning of all recorded transactions) up to the start of M.

closingBalance(M) = openingBalance(M) + totalIncome(M) - totalExpense(M)
```

This is a single well-defined computation per request — no unbounded recursion, no per-month caching table needed. `GET /api/finance/summary?month=M` implements exactly this and returns the resolved numbers plus which case applied (`openingBalanceSource: 'manual' | 'carried_forward' | 'default_zero'`), so the UI can show the user whether the opening balance shown is one they (or someone) explicitly entered, or a computed carry-forward.

**"Lợi nhuận/tồn quỹ tạm tính"** (shown as its own stat card) = `totalIncome(M) - totalExpense(M)` for the selected month — i.e. the period's own net change, distinct from the running `closingBalance`.

## 7. API contract

All endpoints under `functions/api/finance/`. All error responses are `{ "error": "<Vietnamese message>" }` with an appropriate HTTP status, matching every existing endpoint's `jsonError` helper convention.

### `GET /api/finance/transactions`

Roles: `manager`, `admin`, `observer`.

Query params (all optional): `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `type` (`income`|`expense`), `category` (one of the 8 slugs), `status` (`draft`|`confirmed`|`paid`), `q` (keyword, matched against `note` case-insensitively via SQL `LIKE`).

Returns `200` with a JSON array, newest `transaction_date` first (ties broken by `id` descending), each item shaped:

```json
{
  "id": 1,
  "type": "expense",
  "category": "vat_tu",
  "amount": 500000,
  "note": "Mua phân bón",
  "transactionDate": "2026-08-29",
  "status": "confirmed",
  "createdBy": "quan_ly_a",
  "createdAt": "2026-08-29T02:00:00.000Z",
  "updatedBy": null,
  "updatedAt": null,
  "voidedBy": null,
  "voidedAt": null
}
```

Voided transactions (`voidedAt IS NOT NULL`) are included in this list (so the UI can show them struck-through, matching how voided service items are shown on the reception board) but are always excluded from every balance/total computation.

### `POST /api/finance/transactions`

Roles: `manager`, `admin`.

Body: `{ type, category, amount, note, transactionDate, status }`. `note` and `status` are optional (`status` defaults to `'draft'` server-side if omitted). All other fields required.

Validation (400 with a specific Vietnamese message per failure, checked in this order):
1. `type` must be exactly `'income'` or `'expense'`.
2. `category` must be one of the 8 fixed slugs.
3. `amount` must be a positive integer (`Number.isInteger(amount) && amount > 0`).
4. `transactionDate` must match `/^\d{4}-\d{2}-\d{2}$/`.
5. `status`, if provided, must be one of `'draft'`, `'confirmed'`, `'paid'`.

On success: inserts the row (`created_by` = `auth.username`, `created_at` = now), writes an `audit_log` row (`action_type: 'finance_transaction_create'`, `entity_type: 'finance_transaction'`, `entity_id` = new row id, `entity_label` = a short human-readable summary such as `"Chi · Vật tư · 500.000đ"`, `old_value: null`, `new_value` = the same summary string), both in one `env.DB.batch([...])`. Returns `201 { id, ok: true }`.

### `PATCH /api/finance/transactions/:id`

Roles: `manager`, `admin`. Partial update — any subset of `{ type, category, amount, note, transactionDate, status }`, each validated the same as POST when present, falling back to the existing stored value when omitted (exact pattern of `functions/api/catalog/[id].js`'s `onRequestPatch`). `404` if the id doesn't exist at all; `400` (matching the exact existing convention in `functions/api/bookings/[id]/services/[itemId].js` for the analogous "already voided" case) if it exists but is already voided — editing a voided transaction is not allowed, void first and create a NEW transaction if a correction is needed, preserving history. Writes an audit_log row (`action_type: 'finance_transaction_update'`, `old_value`/`new_value` = the before/after summary strings). Returns `200 { ok: true }`.

### `PATCH /api/finance/transactions/:id/void`

Roles: `manager`, `admin`. No body needed. Sets `voided_by`/`voided_at`; `404` if not found, `400` if already voided (same convention as the PATCH endpoint above). Writes an audit_log row (`action_type: 'finance_transaction_void'`, `old_value` = the transaction's summary string, `new_value: null`). Returns `200 { ok: true }`.

### `GET /api/finance/summary`

Roles: `manager`, `admin`, `observer`. Query: `month` (YYYY-MM, required — 400 if missing/malformed).

Returns `200`:
```json
{
  "month": "2026-08",
  "openingBalance": 12000000,
  "openingBalanceSource": "carried_forward",
  "totalIncome": 8000000,
  "totalExpense": 3500000,
  "netChange": 4500000,
  "closingBalance": 16500000
}
```
Computed exactly per §6.

### `GET /api/finance/opening-balance`

Roles: `manager`, `admin`, `observer`. Query: `period` (YYYY-MM, required). Returns the raw manually-set row for that exact period if one exists (`200 { period, openingBalance, setBy, setAt }`), or `200 { period, openingBalance: null, setBy: null, setAt: null }` if none was ever set for that exact period (distinct from the summary endpoint's carry-forward resolution — this endpoint is what the edit form reads to know whether to show a blank input or a previously-entered value for the currently-selected month).

### `PATCH /api/finance/opening-balance`

Roles: `manager`, `admin`. Body: `{ period, openingBalance }`. `period` must match `/^\d{4}-(0[1-9]|1[0-2])$/`; `openingBalance` must be an integer (may be negative — a farmstay can plausibly start a period in debt). Always `INSERT`s a new row (insert-only pattern, §4). Writes an audit_log row (`action_type: 'finance_opening_balance_set'`, `entity_type: 'finance_opening_balance'`, `entity_label` = the period string, `old_value` = previous value for that period if any else `null`, `new_value` = the new value). Returns `200 { ok: true }`.

## 8. UI: `admin/finance.html` / `finance.js`

Page sections, top to bottom:

1. **Quick-add form** (manager/admin only — hidden entirely, not just disabled, for observer): always visible at the top of the page (not behind a toggle button, since this is meant for fast daily data entry) — fields: loại (radio/select thu·chi), số tiền, danh mục (select, 8 options with Vietnamese labels), ngày (date input, defaults to today), ghi chú (text), trạng thái (select: Nháp/Đã xác nhận/Đã thanh toán, defaults to Nháp). Submit button "Ghi giao dịch". Validation errors surface in a `<p class="error">` under the form, matching every other form in the app — never an `alert()`, never breaking layout.
2. **Balance summary** — a `<input type="month">` picker (defaulting to the current month, matching `dashboard.html`'s `#monthInput` exactly) driving a `.stat-grid` of 5 `.stat-card`s: Số dư đầu kỳ, Tổng thu, Tổng chi, Lợi nhuận tạm tính, Số dư cuối kỳ, populated from `GET /api/finance/summary?month=...`. Next to the month picker, an inline "Sửa số dư đầu kỳ" control (manager/admin only) that reads/writes `GET`/`PATCH /api/finance/opening-balance` for the selected month.
3. **Chart** — hand-drawn inline SVG bar chart (two bars per bucket: thu vs chi, colored via the existing `--gold` accent for thu and a muted red/rose for chi consistent with the existing `.status-expired`/`.status-policy-off` red already used elsewhere in `admin.css`), with a 3-way granularity toggle (Ngày/Tuần/Tháng) that re-buckets the currently-filtered transaction list **client-side** (no separate API call per granularity — the already-fetched filtered list is grouped in JS). Buckets and axis labels are computed from `transactionDate`; income bars and expense bars are both visible per bucket (grouped, not stacked) so over/under is visually obvious at a glance.
4. **Filters** (`.filters` class) — from/to date, loại, danh mục, trạng thái, từ khoá — apply to the transaction list and the chart (independent of the month picker used for the balance cards, per the approved design: the summary cards always answer "what's the balance for month X", while the filtered list/chart answer "show me these specific transactions").
5. **Transaction list** — a `<table>` in `.table-scroll` for ≥640px viewports (columns: Ngày, Loại, Danh mục, Số tiền, Trạng thái badge, Ghi chú, Người tạo, Sửa/Xoá buttons for manager/admin), and a parallel `.booking-list`/`.booking-card`-styled card list rendered for <640px viewports (same data, one card per transaction) — both rendered from the same fetched data by the same render function, toggled via CSS media query (`display: none` on one or the other), not two separate fetches. A voided transaction renders with the existing struck-through/dimmed treatment (matching how voided service items already render on the reception board).

New `.status-draft`/`.status-confirmed-fin`/`.status-paid` badge color classes are added to `admin.css` following the exact existing `.status-*` naming/color convention (small, semantically colored pill).

## 9. Sample/demo data

The migration does **not** seed rows into production (kept clean, matching every other migration in this codebase). The implementation plan will include a documented, ready-to-paste set of realistic sample transactions (in Hiền Lê Garden's own vocabulary — e.g. "Mua giống chuối", "Công cắt cỏ tuần", "Thu tiền vé tham quan", "Bảo trì máy bơm nước"...) for local/demo use only, applied via `wrangler d1 execute ... --local` if a developer wants to see the page populated — never auto-applied to `--remote`.

## 10. Testing

Following this codebase's established TDD convention exactly:
- `test/financeTransactions.test.js` — vitest coverage for all 4 transaction endpoints: role gates (403 for reception/observer-on-write, 401 unauthenticated), every validation rule in §7, void-then-list-still-shows-but-excluded-from-totals, edit-a-voided-transaction rejected, audit_log rows written correctly for create/update/void.
- `test/financeSummary.test.js` — vitest coverage for the summary/opening-balance endpoints: default-zero case, manual-value case, carried-forward case (multi-month gap), negative opening balance, insert-only behavior (two PATCHes for the same period both persist, latest wins on read).
- `tests/e2e/finance-dashboard.spec.js` (outer repo) — Playwright coverage: role visibility (manager/admin see the form, observer doesn't, reception can't reach the page at all), add/edit/void a transaction and see the stat cards update, filters narrow the list, chart re-buckets on granularity toggle, mobile card view renders below 640px.

## 11. Open implementation-time details left for the plan

- Exact SVG chart markup/dimensions (viewBox sizing, bar widths, label rotation for many buckets) — a plan task will work this out concretely with real sample data, following this session's established inline-SVG conventions (native shapes, `currentColor`/theme-consistent palette, no external libraries). "Tuần" buckets are ISO weeks (Monday-start), the standard Vietnamese business-week convention — a bucket's label is its Monday's date (`dd/mm`).
- Exact Vietnamese category label strings for the 8 slugs (e.g. `cay_giong` → "Cây giống") — trivial, fixed in the plan's first task alongside the migration.
