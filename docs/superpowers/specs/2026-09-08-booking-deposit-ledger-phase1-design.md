# Booking Revenue Reconciliation — Phase 1: Multi-Entry Deposit Ledger — Design

## 1. Purpose

Room checkout revenue currently never reaches Sổ thu chi (`finance_transactions`) —
neither the room charge, nor deposits, nor guest services. This was surfaced by
a real production report: room Vip2 checked out with no corresponding entry
in Sổ thu chi. Investigation confirmed this is expected behavior today, not a
bug: `bookings.deposit_amount` is a single mutable number set via
`PATCH /api/bookings/:id/deposit`, and neither that endpoint nor
`POST /api/bookings/:id/check-out` nor `POST /api/bookings/:id/services` has
ever written to `finance_transactions`.

The full fix spans three sequential phases (this repo's booking lifecycle,
end to end):

1. **This phase — deposit ledger**: replace the single overwritable
   `deposit_amount` write path with an append-only history of individual
   deposit payments, each immediately recorded into Sổ thu chi at the moment
   it's collected.
2. **Phase 2 (future, depends on this phase)**: checkout settlement — room
   total minus deposits already recorded (read from this phase's ledger) plus
   any still-unpaid services, including the overpayment case.
3. **Phase 3 (future, depends on Phase 2)**: cancellation refunds — turning
   the existing refund *suggestion* (`cancel.js` already computes a
   percentage, but never moves money or tracks whether a refund was actually
   issued) into a real, trackable refund event that debits Sổ thu chi.

This spec covers **Phase 1 only**. Phases 2 and 3 are out of scope and will
each get their own brainstorm/spec/plan cycle once this phase ships.

## 2. Global Constraints

- `bookings.deposit_amount` keeps its current meaning and current read sites
  unchanged — it stays the live running total. Every place that already reads
  it (`functions/api/rooms/index.js`'s `booked_deposited` room-status check,
  `lib/receptionReminders.js`'s "chờ cọc" reminder, `cancel.js`'s refund
  calculation) keeps working with no changes to this phase.
- `booking_deposits` is append-only, mirroring this project's established
  immutable-history-plus-live-total pattern (the same shape as Phase 3a's
  `asset_source_rows` read-only-history alongside `assets`'s live state).
  Nothing in this phase updates or deletes a `booking_deposits` row.
- Every deposit recorded through the normal (reception-usable) path
  immediately creates a `finance_transactions` income row — no batching, no
  deferred reconciliation, matching this project's existing
  Giờ Xanh/Order-ăn-uống-close precedent of "closing/settling an action
  creates the ledger entry in the same request."
- No audit_log entry for the deposit-add action itself, matching the
  established precedent that Giờ Xanh's and Order-ăn-uống's auto-created
  `finance_transactions` rows carry no accompanying audit_log entry either
  (the `finance_transactions` row plus, here, the `booking_deposits` row are
  the record).
- Mandatory server-side permission checks — client-side gating is UX only.
- Reuse the existing 4-role model; no new role or permission concept.
- `PATCH /api/bookings/:id/deposit` (the existing raw-set endpoint) is
  narrowed to `admin`-only and never touches `finance_transactions` or
  `booking_deposits` — it remains purely a manual-correction escape hatch,
  not a normal-use path.

## 3. Data Model

### 3.1 `booking_deposits` (new)

```sql
CREATE TABLE booking_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'transfer')),
  note TEXT,
  finance_transaction_id INTEGER REFERENCES finance_transactions(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_booking_deposits_booking ON booking_deposits(booking_id);
```

No `UNIQUE`/dedupe constraint — a guest can legitimately pay two identical
amounts on two different days (e.g., 500.000đ now, 500.000đ later), and
nothing about this table needs to distinguish that from an accidental
double-submit; the existing `finance_transactions`
`void`/`account_permission_change`-style admin correction tools (§5) are the
answer to a mistaken entry, not a DB constraint.

`amount > 0` is enforced at the DB layer as well as in the endpoint — this
table only ever represents money that came in; a correction or reduction
never gets a negative-amount row here (that's out of this phase's scope
entirely, same as any refund handling — Phase 3's job).

### 3.2 No change to `bookings.deposit_amount`

Stays exactly as-is: `INTEGER NOT NULL DEFAULT 0`. This phase's only
interaction with it is an atomic increment (§4.1) — no new column, no
migration to its type or meaning.

## 4. API

### 4.1 `POST /api/bookings/:id/deposits` (new)

Role: `reception`, `manager`, `admin`.

Request body: `{ amount: number, paymentMethod: 'cash' | 'transfer', note?: string }`. `note` is optional and accepted for API completeness (e.g. future admin tooling or a direct API caller); this phase's own client (§5) never sends it, so it is always `null` for every deposit created through the reception UI.

Validation:
- `amount` must be a positive integer.
- `paymentMethod` must be exactly `'cash'` or `'transfer'`.
- Booking must exist (404) and have `status` in `('pending', 'confirmed', 'checked_in')` — 400 for `cancelled`/`checked_out` ("Không thể thêm cọc cho đặt phòng đã huỷ hoặc đã trả phòng").

Behavior, in this order:
1. `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('income', 'dich_vu', ?, ?, ?, 'confirmed', ?, ?)` — `note` is `Cọc — <guest_name>` (plus the caller's own `note`, appended, if given); `transaction_date` is today's date (`now.slice(0, 10)`), matching the Giờ Xanh/Order ăn uống precedent exactly. Capture `financeTransactionId` from `last_row_id`.
2. `env.DB.batch([...])` with exactly two statements:
   - `INSERT INTO booking_deposits (booking_id, amount, payment_method, note, finance_transaction_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
   - `UPDATE bookings SET deposit_amount = deposit_amount + ? WHERE id = ?`

No optimistic-lock/rollback dance is needed here (unlike Giờ Xanh's
close-if-still-open guard): `deposit_amount = deposit_amount + ?` is a single
atomic SQL statement — SQLite has no read-then-write gap for a self-relative
UPDATE, so there is no lost-update race to guard against. The Giờ Xanh
pattern's `changes === 0` check exists to guard a *state transition*
(open→closed) that a concurrent request could have already performed; an
increment has no equivalent transition to race.

Response: `201` with `{ ok: true, depositId, financeTransactionId, newTotal }`.

### 4.2 `PATCH /api/bookings/:id/deposit` (existing, narrowed)

Change `requireAuth(request, env, ['reception', 'manager', 'admin'])` to
`requireAuth(request, env, ['admin'])`. No other behavior changes — still a
raw `SET deposit_amount = ?`, still writes the existing `deposit_change`
audit_log entry, still never touches `finance_transactions` or
`booking_deposits`. This is now explicitly the "fix a mistake" tool, not the
"record a payment" tool.

### 4.3 `GET /api/bookings` (existing, extended)

Alongside the existing `r.services = byBooking[r.id] || []` assembly
(`functions/api/bookings/index.js`), add the identical pattern for deposits:

```js
const { results: depositRows } = await env.DB.prepare(
  `SELECT id, booking_id AS bookingId, amount, payment_method AS paymentMethod, note,
          created_by AS createdBy, created_at AS createdAt
   FROM booking_deposits
   WHERE booking_id IN (SELECT id FROM bookings ${where})
   ORDER BY created_at ASC, id ASC`
).bind(...params).all();
```
...grouped into `r.deposits = depositsByBooking[r.id] || []` the same way
`byBooking` already groups `serviceRows`. No new query parameters, no new
role gating — this rides the endpoint's existing role/observer-phone-redaction
behavior unchanged.

## 5. Client (`admin/reception.js`, `admin/reception.html`)

The card-level visibility gate for the whole deposit block currently reads
`(b.status === 'pending' || b.status === 'confirmed') && currentRole !==
'observer'` — this phase extends it to also include `checked_in`, matching
§4.1's own allowed-status list exactly (a guest may still be settling their
deposit balance during their stay, before eventual checkout — a deliberate,
low-risk expansion of today's behavior, not an oversight). A `checked_out` or
`cancelled` booking never shows the block, same as today.

Replace the current single `Cọc: [input] đ [Lưu cọc]` block
(`renderBookingCard`, lines ~617-661) with:

- A read-only history list — one line per `booking.deposits[]` entry:
  `"500.000 đ · Chuyển khoản · 08/09"` (amount formatted via the existing
  `formatVnd`, payment method label via a 2-entry map
  `{ cash: 'Tiền mặt', transfer: 'Chuyển khoản' }`, date via the existing
  `formatDate`).
- A "+ Thêm cọc" mini-form: a number input for the amount, two radio buttons
  for payment method (mirroring `admin/dine-in-order-detail.html`'s exact
  close-form markup: `<label class="checkbox-label"><input type="radio"
  name="paymentMethod" value="cash" /> 💵 Tiền mặt</label>` /
  `... value="transfer" /> 🏦 Chuyển khoản</label>`), and a "Lưu cọc" button
  that `POST`s to `/api/bookings/:id/deposits` and calls `refreshAll()` (or
  the same lighter-weight reload the existing deposit save already used) on
  success.
- The running total display (`Cọc: <deposit_amount> đ`) stays exactly as it
  is today — only its update mechanism changes (recomputed server-side from
  the new endpoint's response, not client-guessed).
- This form is hidden for `observer` (matches the existing convention: the
  whole deposit block today is gated on `currentRole !== 'observer'` — this
  phase keeps that gate, applying it to both the history list and the add
  form).

## 6. Testing

Follows the established pattern: endpoint unit tests hitting real D1
(`test/bookingDeposits.test.js`, new), and e2e coverage
(`tests/e2e/reception-ops-board.spec.js`, extended) mocking the new
route. Cases the plan must cover explicitly:

- `POST .../deposits`: creates a `finance_transactions` row (income,
  `dich_vu`, correct amount/note), a `booking_deposits` row linking to it,
  and increments `bookings.deposit_amount` by exactly the new amount (not
  overwriting it) — verified by adding two deposits in sequence and
  confirming the total is their sum, not just the second value.
- Rejects a non-positive amount, an invalid `paymentMethod`, a nonexistent
  booking (404), and a `cancelled`/`checked_out` booking (400).
- Role gate: reception/manager/admin succeed, observer 403.
- `PATCH .../deposit`: now rejects reception/manager (403), only admin
  succeeds; confirms it still never touches `finance_transactions` or
  `booking_deposits`.
- `GET /api/bookings`: confirms a booking's `deposits` array reflects
  multiple entries in creation order with the correct field names.
- e2e: adding a deposit renders it in the history list and updates the
  running total; the "+ Thêm cọc" form requires picking a payment method
  before submitting; observer never sees the add-form or history-list-with
  controls (read visibility follows the same pattern already tested for the
  rest of the booking card).
