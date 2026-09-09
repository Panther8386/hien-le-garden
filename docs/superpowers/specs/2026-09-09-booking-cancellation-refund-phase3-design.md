# Booking Revenue Reconciliation — Phase 3: Cancellation Refund — Design

## 1. Purpose

Phases 1 and 2 (both shipped) made deposits and checkout settlement write real
`finance_transactions` rows the moment money changes hands. The one remaining
gap from the original roadmap: `POST /api/bookings/:id/cancel` computes a
refund *suggestion* (a percentage from `cancellation_policy_tier`, applied to
`bookings.deposit_amount`) and writes it to `bookings.refund_percent_applied`
and `audit_log` — but never moves money. The suggested refund never appears
in Sổ thu chi, and nothing distinguishes "we told the guest we'd refund X"
from "X was actually handed back."

This is the third and final phase of the roadmap. It stays deliberately
narrow — two items surfaced during design are explicitly **out of scope**:

- Services attached to a cancelled booking (paid or still-pending) are
  **untouched** by cancellation. Voiding or refunding them, if ever needed,
  is a separate action through the existing per-service void control — not
  this phase's concern.
- A paid service item folded into Phase 2's combined checkout-settlement
  income row currently has no way to be un-recorded from Sổ thu chi if
  voided afterward (flagged as a deferred finding in Phase 2's final
  review). That's a different code path (post-checkout, not pre-check-in
  cancellation) and a separate future task.

## 2. Global Constraints

- The refund **percentage policy itself does not change** — same
  `cancellation_policy_tier` lookup, same `daysBeforeCheckin` formula, same
  `Math.round(deposit_amount * refundPercentApplied / 100)` calculation
  already in `cancel.js`.
- The refund is recorded into Sổ thu chi **immediately** when cancellation
  succeeds — no separate "confirm refund paid" step. Matches this
  project's established "the settling action creates the ledger entry in
  the same request" precedent (Giờ Xanh, Phase 1, Phase 2).
- Category: reuse `hoan_coc` ("Hoàn cọc", expense — added by Phase 2),
  distinguished from Phase 2's excess-deposit refund only by note text
  (`"Hoàn cọc huỷ đặt phòng — <guest_name>"` vs Phase 2's
  `"Hoàn cọc dư — <guest_name>"`). No new category.
- `finance_transactions.amount` has `CHECK (amount > 0)` — a 0% refund
  creates no row at all, same as every other phase's zero-amount handling.
- `confirmed → cancelled` is a state transition, so it gets the same
  race-guard shape as Giờ Xanh/Phase 2's checkout: batch the status update
  conditioned on `status = 'confirmed'`, check `meta.changes === 0`, clean
  up any `finance_transactions` row already created in that request on a
  lost race, same cleanup in a catch block for any other failure.
- `bookings` gains two nullable columns for consistency with every other
  settling action in this codebase (`gio_xanh_sessions.finance_transaction_id`/`.payment_method`, `booking_deposits.finance_transaction_id`/`.payment_method`, Phase 2's `bookings.checkout_payment_method`): `refund_finance_transaction_id` and `cancel_refund_payment_method`. Nothing reads these back yet — they exist for audit-trail consistency and future use, the same reasoning Phase 2 already applied to its own analogous columns.
- Services on the cancelled booking are never read or written by this
  phase's code — confirmed out of scope in §1.
- Mandatory server-side permission checks; client-side gating is UX only.
  No new role concept — same `reception`/`manager`/`admin` access `cancel.js`
  already has.

## 3. Data Model

### 3.1 New columns on `bookings`

```sql
ALTER TABLE bookings ADD COLUMN refund_finance_transaction_id INTEGER REFERENCES finance_transactions(id);
ALTER TABLE bookings ADD COLUMN cancel_refund_payment_method TEXT;
```

Both nullable, both `NULL` unless the cancellation actually created a refund
row (`refundAmount > 0`).

## 4. API

### 4.1 `POST /api/bookings/:id/cancel` (existing, extended)

Role unchanged: `reception`, `manager`, `admin`. Existing guards unchanged:
404 if missing, 400 if `status !== 'confirmed'`. Existing formula
unchanged: `daysBeforeCheckin` → tier lookup → `refundPercentApplied` →
`refundAmount = Math.round(deposit_amount * refundPercentApplied / 100)`.

New request field: `paymentMethod` (`'cash' | 'transfer' | null`), required
only when `refundAmount > 0` — 400 "Vui lòng chọn hình thức thanh toán"
otherwise. `reason` stays optional and unchanged (still never prompted by
the client today, per §5 — this phase doesn't add a reason input, matching
the existing gap rather than expanding scope to fix it).

Behavior, in this order, wrapped for cleanup on partial failure (mirroring
Phase 2's checkout endpoint's single-refund-row case — see
`functions/api/bookings/[id]/check-out.js`'s `hoan_coc` branch for the
exact shape to follow, simplified here to at most one row instead of up to
three):

1. If `refundAmount > 0`: `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('expense', 'hoan_coc', ?, ?, ?, 'confirmed', ?, ?)` — note `"Hoàn cọc huỷ đặt phòng — <guest_name>"`, `transaction_date` = today (`now.slice(0, 10)`). Capture `refundFinanceTransactionId`.
2. `env.DB.batch([...])`:
   - `UPDATE bookings SET status = 'cancelled', cancel_reason = ?, refund_percent_applied = ?, refund_finance_transaction_id = ?, cancel_refund_payment_method = ? WHERE id = ? AND status = 'confirmed'` (race-guarded).
   - The existing `audit_log` insert, unchanged content/format.
3. If the bookings update's `changes === 0` (lost race): delete the refund row if one was created, return 409.

Response unchanged: `{ ok: true, refundPercentApplied, refundAmount }` — the
client doesn't need `refundFinanceTransactionId` back (nothing reads it, per
§2's audit-trail-only rationale).

## 5. Client (`admin/reception.js`, `admin/reception.html`)

The "Hủy đặt phòng" button appears in two places — `loadArrivals()` and
`loadUpcomingConfirmed()` — both currently wired directly to `cancelBooking(id)`,
which fires the POST immediately with no confirmation and no way to supply
a `paymentMethod`. Both are rewired to open a confirmation dialog instead
(new `#cancelOverlay`, mirroring Phase 2's `#checkoutOverlay` structure and
`.confirm-overlay`/`.confirm-box` styling — no new CSS needed, same as
Phase 2).

On open: fetch `GET /api/cancellation-policy` (existing endpoint, already
readable by all four roles including observer) once and cache the tier
list for the session; compute `daysBeforeCheckin` client-side (a direct
hand-duplicate of the server's own function — same reasoning as Phase 2's
`ROOM_TYPE_PRICES` duplication: no bundler, no shared import between
server `lib/` and browser `admin/*.js`); find the matching tier (the
API already returns tiers `ORDER BY min_days_before_checkin DESC`, so the
first tier whose `minDaysBeforeCheckin <= daysBefore` is the match, falling
back to 0% if none matches — identical logic to the server's `ORDER BY ...
DESC LIMIT 1`); compute `refundAmount = Math.round(depositAmount * refundPercent / 100)`.

- If `refundAmount > 0`: show "Hoàn cọc: `<percent>`% (`<amount>`)", two
  payment-method radios, required before submit.
- Else: show "Không hoàn cọc (theo chính sách huỷ hiện tại)", direct
  submit, no radios — mirrors Phase 2's "no radios, direct submit" branch
  exactly.

Submit: `POST /api/bookings/:id/cancel` with `{ paymentMethod }` (`null`
when no radios shown), `refreshAll()` on success, surface the server's
error message on failure (409 race case included, same as Phase 2 — no
special client handling beyond showing the message).

The old `cancelBooking(id)` function is removed once both call sites are
rewired to `openCancelDialog(booking)` — confirm via grep that no other
call site exists before deleting it.

## 6. Testing

### 6.1 v4 unit tests

- `test/migrations.test.js`: both new `bookings` columns default to `NULL`.
- `test/bookingLifecycle.test.js` (existing `describe('POST /api/bookings/:id/cancel', ...)`, extended — **not** a full-block replacement like Phase 2's checkout tests, since most existing tests use a 0-deposit booking and are unaffected; only the one existing test with a nonzero refund (`'applies the matching tier at the exact day-boundary'`, 100% tier, refund 300.000) needs a `paymentMethod` added to its request, exactly as it stands today plus that one field):
  - Creates a `finance_transactions` row (expense, `hoan_coc`, correct amount/note) and sets `bookings.refund_finance_transaction_id`/`cancel_refund_payment_method` when `refundAmount > 0`.
  - Creates no `finance_transactions` row and leaves both new columns `NULL` when `refundAmount` is exactly 0 (existing 0%-tier tests, unaffected by the `paymentMethod` requirement — confirm this explicitly with a dedicated assertion, not just reusing an existing test's incidental behavior).
  - Rejects a cancellation needing a payment method when none is supplied (400).
  - Race case: a lost race returns 409 and cleans up the refund row created in that request (same caveat as Phase 2's analogous test — this exercises the pre-existing status guard via a simulated already-cancelled row, not a literal concurrent-request race, matching this codebase's established testing limit for these race guards).
  - A service item (paid or pending) attached to the cancelled booking is confirmed untouched (`payment_status`/`status` unchanged) after cancellation — a direct, explicit test for the out-of-scope decision in §1, not an assumption.

### 6.2 e2e (`tests/e2e/reception-ops-board.spec.js`, extended)

- Cancelling a booking with a nonzero-refund tier shows the computed
  percentage/amount and requires a payment method before submitting.
- Cancelling a booking that falls under a 0%-refund tier shows no radios
  and submits directly.
- The existing, already-documented, pre-existing-and-out-of-scope flaky
  test (`'cancelling a booking with a deposit shows the computed refund
  suggestion'`) is **not** this phase's concern to fix — it asserts against
  `#opsError` text using the *old* immediate-fire flow; once the client is
  rewired to the dialog in §5, this specific test's interaction pattern
  (click "Hủy đặt phòng" and immediately assert on `#opsError`) will need
  updating to go through the new dialog, which is an in-scope, necessary
  update (not "fixing the flake") — its underlying shared-`#opsError`-race
  root cause across concurrent fetches is unrelated and stays out of scope.
