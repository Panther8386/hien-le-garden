# Booking Revenue Reconciliation — Phase 2: Checkout Settlement — Design

## 1. Purpose

Phase 1 (shipped, in production) gave deposits an itemized, append-only
ledger recorded into Sổ thu chi the moment each one is collected. Two gaps
from the original problem (Vip2 checked out with nothing landing in Sổ thu
chi) remain:

1. **Room charge at checkout** has never been recorded into
   `finance_transactions` — `POST /api/bookings/:id/check-out` only flips
   `bookings.status` and marks the room for cleaning.
2. **Guest services** (`booking_service_items`, both `service_catalog` and
   `dine_in_menu_items` rows) have *never*, at any point in their lifecycle,
   written to `finance_transactions` — not when marked `paid` at order time,
   not at checkout. `payment_status` is a bookkeeping flag only; nothing
   downstream of it currently exists.

This phase closes both gaps in one pass, since they interact: a service
marked paid *before* checkout must not be billed again *at* checkout, and
the checkout-time settlement must be deposit-aware to avoid double-counting
against Phase 1's ledger.

This is Phase 2 of the 3-phase roadmap from Phase 1's spec. Phase 3
(cancellation refund reconciliation) remains out of scope and unaffected —
`cancel.js` only ever operates on `status = 'confirmed'` bookings (before
check-in), so nothing in this phase's `checked_in → checked_out` path can
interact with it; a checked-out booking can never subsequently be cancelled.

## 2. Global Constraints

- Room total uses the same formula the Dashboard (`lib/dashboardMetrics.js`)
  already uses live: `nights × ROOM_TYPES[roomType].priceVnd`. There is no
  locked-in final/discounted price column on `bookings` — none exists today,
  and this phase does not add one. This also means the number this phase
  writes to Sổ thu chi will always agree with what the Dashboard already
  shows for that booking — the two views stay consistent by construction.
- Deposits (`bookings.deposit_amount`, Phase 1) are subtracted from the
  **combined** total (room + unpaid services), room first: a deposit fully
  covers the room charge before any of it is applied to unpaid services.
  Leftover deposit beyond both becomes an automatic refund.
- Two income categories, matching Phase 1's split: room → `dich_vu`
  ("Lưu trú Hiền Lê"), services → `ban_hang` ("Dịch vụ khác"). A new expense
  category, `hoan_coc` ("Hoàn cọc"), is added for the excess-deposit refund
  case. `finance_transactions.category` has no `CHECK` constraint (dropped
  in migration `0019`) — adding `hoan_coc` is a `finance_categories` seed
  row only, no table rebuild.
- Every settling action creates its Sổ thu chi entry in the same request
  that performs the settlement — no batching, no deferred reconciliation,
  matching Phase 1 and the pre-existing Giờ Xanh/Order-ăn-uống-close
  precedent.
- `checked_in → checked_out` is a genuine state transition (unlike Phase
  1's pure-increment deposit write), so it needs the same race-guard Giờ
  Xanh's close endpoint uses: update `bookings.status` conditioned on
  `AND status = 'checked_in'`, check `changes === 0`, and on a lost race
  clean up (delete) any `finance_transactions` rows this request just
  created before returning 409. The same try/catch-cleanup-on-unexpected-
  error shape applies.
- Mandatory server-side permission checks — client-side gating is UX only.
  Reuses the existing 4-role model; no new role concept, except the one
  explicit new rule below (§4.3).
- `finance_transactions.amount` has `CHECK (amount > 0)` — a computed
  amount of exactly 0 (room, services, or refund) means that row is skipped
  entirely, not inserted with a zero amount.

## 3. Data Model

### 3.1 `bookings.checkout_payment_method` (new column)

```sql
ALTER TABLE bookings ADD COLUMN checkout_payment_method TEXT;
```

Nullable. Set only when checkout actually moves money (collecting a balance
or issuing a refund) — `NULL` when a booking's deposit lands exactly on the
combined total and nothing changes hands. Mirrors `gio_xanh_sessions
.payment_method` / `booking_deposits.payment_method` — every settling
action in this codebase records its own payment method; checkout gets the
same treatment on `bookings` since there's no itemized child table for a
one-time terminal event.

### 3.2 `booking_service_items.finance_transaction_id` (new column)

```sql
ALTER TABLE booking_service_items ADD COLUMN finance_transaction_id INTEGER REFERENCES finance_transactions(id);
```

Nullable. Set only for a service item created with `paid = true` (§4.1) —
the link that lets an admin's later void (§4.3) find and void the matching
Sổ thu chi row. A service item that stays `pending` until checkout never
gets its own `finance_transaction_id`; its value is folded into the single
combined services row checkout creates (§4.2), which nothing links back to
individual `booking_service_items` rows (matching Phase 1's own choice not
to build a reverse index from `finance_transactions` back to its source —
the `note` field is the human-readable trace).

### 3.3 `finance_categories` seed addition

```sql
INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at)
VALUES ('hoan_coc', 'Hoàn cọc', 'expense', 1, 'system', '2026-09-08T00:00:00Z');
```

## 4. API

### 4.1 `POST /api/bookings/:id/services` (existing, extended)

Role unchanged: `reception`, `manager`, `admin`. All existing validation
(catalog/menu-item lookup, price/quantity checks, scheduling/capacity logic,
terms acceptance) is unchanged and runs first, exactly as today.

The booking lookup at the top of the handler currently does
`SELECT id, status FROM bookings WHERE id = ?` — extend to
`SELECT id, status, guest_name FROM bookings WHERE id = ?` (needed for the
new transaction's note).

The function has two independent branches, each with its own early
`return` — the menu-item branch (`hasMenuItemId`, ends ~line 117) and the
catalog-item branch (`hasCatalogId`, ends ~line 190). Each already computes
its own local `amount = unitPrice * quantity` and `now` right before its own
`INSERT INTO booking_service_items`. **The block below is inserted into
both branches independently, immediately before each branch's own
`INSERT INTO booking_service_items`** — not factored into one shared
location, matching this file's existing per-branch structure (each branch
already duplicates its own amount/now/paymentStatus computation rather than
sharing a helper):

```js
let financeTransactionId = null;
if (paid === true) {
  const note = `${menuItem.name} ×${quantity} — ${booking.guest_name}`; // catalog branch: catalogItem.name
  try {
    const txInsert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
       VALUES ('income', 'ban_hang', ?, ?, ?, 'confirmed', ?, ?)`
    ).bind(amount, note, now.slice(0, 10), auth.username, now).run();
    financeTransactionId = txInsert.meta.last_row_id;
  } catch (err) {
    return jsonError('Có lỗi khi ghi nhận thanh toán dịch vụ, vui lòng thử lại', 500);
  }
}
```

(In the catalog branch, `note` uses `catalogItem.name` instead of
`menuItem.name` — otherwise the two copies are identical.)

The existing `INSERT INTO booking_service_items` in both branches gains
`finance_transaction_id` as a new bound column, value `financeTransactionId`
(`null` when `paid` was falsy). If that `INSERT` throws *after* the finance
row above was created, catch it and delete the just-created
`finance_transactions` row before re-throwing/returning 500 — same
orphan-prevention shape as Giờ Xanh's close endpoint, applied here because
these are two separate statements with a real (if narrow) partial-failure
window between them.

No other change to this endpoint. Response shape unchanged
(`{ id, ok: true }`).

### 4.2 `POST /api/bookings/:id/check-out` (existing, extended)

Role unchanged: `reception`, `manager`, `admin`. Existing guards unchanged:
404 if booking missing, 400 if `status !== 'checked_in'`.

Body (new): `{ paymentMethod: 'cash' | 'transfer' | null }`.

Extend the initial `SELECT` to
`SELECT id, status, room_id, room_type, check_in, check_out, guest_name, deposit_amount FROM bookings WHERE id = ?`.

Compute, before touching the database:

```js
const nights = (Date.parse(booking.check_out) - Date.parse(booking.check_in)) / 86400000;
const roomTotal = nights * ROOM_TYPES[booking.room_type].priceVnd;

const unpaidRow = await env.DB.prepare(
  `SELECT COALESCE(SUM(amount), 0) AS total FROM booking_service_items
   WHERE booking_id = ? AND status = 'posted' AND payment_status = 'pending'`
).bind(params.id).first();
const unpaidServicesTotal = unpaidRow.total;

const deposit = booking.deposit_amount || 0;
const roomDue = Math.max(roomTotal - deposit, 0);
const leftoverDeposit = Math.max(deposit - roomTotal, 0);
const servicesDue = Math.max(unpaidServicesTotal - leftoverDeposit, 0);
const refundAmount = Math.max(leftoverDeposit - unpaidServicesTotal, 0);

const needsPaymentMethod = roomDue > 0 || servicesDue > 0 || refundAmount > 0;
if (needsPaymentMethod && paymentMethod !== 'cash' && paymentMethod !== 'transfer') {
  return jsonError('Vui lòng chọn hình thức thanh toán', 400);
}
```

Then, in this order, each wrapped so a failure part-way cleans up every
`finance_transactions` row already created in this request (same
try/catch shape as §4.1 and as Giờ Xanh's close endpoint — collect created
ids in an array, delete them all on any subsequent failure):

1. If `roomDue > 0`: `INSERT INTO finance_transactions (...) VALUES ('income', 'dich_vu', roomDue, 'Tiền phòng — <guest_name>', today, 'confirmed', ...)`.
2. If `servicesDue > 0`: `INSERT INTO finance_transactions (...) VALUES ('income', 'ban_hang', servicesDue, 'Dịch vụ lưu trú — <guest_name>', today, 'confirmed', ...)`.
3. If `refundAmount > 0`: `INSERT INTO finance_transactions (...) VALUES ('expense', 'hoan_coc', refundAmount, 'Hoàn cọc dư — <guest_name>', today, 'confirmed', ...)`.
4. `env.DB.batch([...])`:
   - `UPDATE bookings SET status = 'checked_out', checkout_payment_method = ? WHERE id = ? AND status = 'checked_in'` (`checkout_payment_method` is `paymentMethod` if `needsPaymentMethod`, else `null`).
   - `UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = ? WHERE id = ?` (only if `booking.room_id`, unchanged from today).
   - `UPDATE booking_service_items SET payment_status = 'paid', payment_method = ? WHERE booking_id = ? AND status = 'posted' AND payment_status = 'pending'` (`payment_method` is `paymentMethod` if `needsPaymentMethod` else `null` — this runs unconditionally whenever any `pending` rows exist, independent of whether step 2 created an income row, since a pending item can be fully absorbed by leftover deposit with `servicesDue = 0` and still needs to flip to `paid`).
5. If the `bookings` update's `changes === 0` (another request already
   checked this booking out — race): delete every `finance_transactions`
   row created in steps 1-3, return 409 ("Đặt phòng này vừa được check-out
   bởi thao tác khác, vui lòng tải lại").

Response: `200` with
`{ ok: true, roomDue, servicesDue, refundAmount, checkoutPaymentMethod }`.

### 4.3 `PATCH /api/bookings/:id/services/:itemId` (existing void endpoint, extended)

Currently `requireAuth(request, env, ['reception', 'manager', 'admin'])`
unconditionally. New rule: if the target item's `payment_status === 'paid'`,
require `admin` specifically (403 for reception/manager); a `pending` item
keeps today's three-role access unchanged.

```js
const item = await env.DB.prepare(
  `SELECT bsi.id, bsi.booking_id, bsi.status, bsi.payment_status, bsi.finance_transaction_id,
          bsi.name, bsi.quantity, b.guest_name AS guestName
   FROM booking_service_items bsi JOIN bookings b ON b.id = bsi.booking_id
   WHERE bsi.id = ?`
).bind(params.itemId).first();
```

(adds `payment_status`, `finance_transaction_id` to the existing `SELECT`).
After the existing not-found/already-voided checks, before the existing
`env.DB.batch([...])`:

```js
if (item.payment_status === 'paid' && auth.role !== 'admin') {
  return jsonError('Chỉ Admin mới có quyền huỷ dịch vụ đã thanh toán', 403);
}
```

(`requireAuth` was already called with the 3-role list above so `auth.role`
is available; this is a second, narrower check on top of it — the same
shape as other endpoints in this codebase that gate a specific action more
tightly than the endpoint's baseline role list.)

If `item.payment_status === 'paid'`, add one statement to the existing
`env.DB.batch([...])` (which today only voids the service item and writes
`audit_log`):

```js
env.DB.prepare(`UPDATE finance_transactions SET voided_by = ?, voided_at = ? WHERE id = ?`)
  .bind(auth.username, now, item.finance_transaction_id),
```

No new endpoint, no new race-guard here — voiding is idempotent-guarded
already (`item.status === 'voided'` check, unchanged) and this is a single
`batch`, not two sequential requests with a partial-failure window.

## 5. Client (`admin/reception.js`, `admin/reception.html`)

### 5.1 Checkout form

Replace the current single "Check-out" button
(`doBookingAction(b.id, 'check-out')`, no body) with a confirm-style form,
following the same shape as Giờ Xanh's/Dine-in's close forms and Phase 1's
own "+ Thêm cọc" form:

- On open, compute and display the breakdown client-side from data already
  on the booking object (`roomTotal` via the same nights/price formula,
  `unpaidServicesTotal` by summing `booking.services` where
  `paymentStatus === 'pending'`, `deposit` from `booking.depositAmount`) —
  purely informational preview; the server recomputes authoritatively and
  is the only source of truth for what actually gets written.
- If `roomDue + servicesDue > 0`: show "Cần thu thêm: `<N>` đ" and two
  radio buttons (`checkoutPaymentMethod-${b.id}`, mirroring Phase 1's
  per-booking-unique radio naming), required before submit.
- Else if `refundAmount > 0`: show "Cần hoàn khách: `<N>` đ" with the same
  two radios, required before submit.
- Else (both zero): show "Cọc đã khớp đủ, không cần thu/hoàn thêm" and a
  single "Xác nhận Check-out" button with no radios.
- Submit: `POST /api/bookings/:id/check-out` with
  `{ paymentMethod }` (`null` in the no-radios case), `refreshAll()` on
  success, `showOpsError` with the server's message on failure (the 409
  race case included — the server's message is used verbatim, no special
  client handling for it beyond that).

### 5.2 Service void button gating

The existing "Huỷ dịch vụ" button, wherever a booking's service list is
rendered, is hidden (not just disabled) when the item's `paymentStatus ===
'paid'` and `currentRole !== 'admin'` — reception and manager no longer see
it at all for a paid item; they keep seeing it, unchanged, for a `pending`
one. Admin always sees it for both.

## 6. Testing

### 6.1 v4 unit tests

- `test/migrations.test.js`: `checkout_payment_method` and
  `finance_transaction_id` columns exist; `hoan_coc` present in
  `finance_categories` as an expense category.
- `test/bookingsEndpoints.test.js` (services POST, extended): `paid: true`
  creates exactly one `finance_transactions` row (`income`, `ban_hang`,
  correct amount/note) and the new `booking_service_items` row's
  `finance_transaction_id` matches it; `paid` omitted/`false` creates zero
  `finance_transactions` rows and a `null` `finance_transaction_id`.
- New `test/bookingCheckout.test.js`: every branch of §4.2's formula —
  deposit less than room total (room partially due, services due in full);
  deposit covers room exactly plus part of services; deposit exceeds
  combined total (refund row created, correct category/amount); zero
  deposit; zero unpaid services; deposit exactly equal to combined total
  (no rows created, no `paymentMethod` required, `checkout_payment_method`
  stays `null`); all previously-`pending` service items end up `paid` after
  checkout regardless of which branch fired; race case — two concurrent
  check-out calls on the same booking, one succeeds, the other gets 409 and
  every `finance_transactions` row it created is gone afterward (query
  `finance_transactions` by the expected note/amount to confirm zero rows
  survive from the losing request).
- `test/bookingsEndpoints.test.js` (services void PATCH, extended): a
  `paid` item voided by reception or manager → 403, item and linked
  `finance_transactions` row both untouched; voided by admin → 200, item
  `status = 'voided'`, linked `finance_transactions` row has
  `voided_at`/`voided_by` set; a `pending` item voided by reception →
  unchanged 200 behavior, confirms no `finance_transactions` interaction
  (there is none to touch).

### 6.2 e2e (`tests/e2e/reception-ops-board.spec.js`, extended)

- Checking out a booking with an unpaid balance shows the computed
  breakdown and requires a payment method before the button submits.
- Checking out a booking whose deposit exceeds the combined total shows
  the refund amount and still requires a payment method.
- Checking out a booking where the deposit exactly matches the combined
  total shows no radios and submits directly.
- A paid service item's "Huỷ dịch vụ" button is absent for reception/
  manager and present for admin; a pending item's button is present for
  all three roles, unchanged from today.
