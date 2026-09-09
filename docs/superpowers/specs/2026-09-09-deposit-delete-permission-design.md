# Booking Deposit Delete Permission — Design

## 1. Purpose

Reception or a manager can mistype a deposit amount, pick the wrong payment
method, or otherwise create a `booking_deposits` row (Phase 1 of the booking
revenue reconciliation roadmap, shipped) in error. There is currently no way
to correct this — the deposit history list is append-only, and the linked
`finance_transactions` income row it created stays in Sổ thu chi forever.

This adds a permission-gated deletion capability, modeled directly on the
existing "Xoá tài sản" (asset deletion) feature (Phase 3b, shipped): a
per-account toggle an admin controls, and a delete action restricted to
accounts with that toggle on. Unlike an asset, a deposit has already moved
money into Sổ thu chi the instant it was created — so deleting one must also
reverse that entry, not just remove the deposit record.

This is a small, standalone feature — independent of the (separately
planned, larger) room-pricing overhaul the same conversation raised.

## 2. Global Constraints

- Nothing in this codebase hard-deletes a user-facing record. Every existing
  "xoá"/"huỷ" action (asset delete, service void, booking cancel, finance
  transaction void) marks the row inactive and keeps it for audit —
  deposit deletion follows the same convention: **void, never a hard SQL
  `DELETE`.**
- Voiding a deposit must **directly void the original income row** in
  `finance_transactions` — it must never create a new offsetting expense
  entry. A reversal-via-new-expense-line would inflate both `totalIncome`
  and `totalExpense` in `finance/summary.js` while leaving `netChange`
  unchanged, which is explicitly the outcome to avoid.
- `finance/summary.js` already filters `voided_at IS NULL` on every read —
  voiding a `finance_transactions` row automatically and correctly removes
  it from every total; no other endpoint needs to change.
- A deposit may only be deleted while its booking is still in `pending`,
  `confirmed`, or `checked_in` — **never** after `checked_out` or
  `cancelled`. Once a booking reaches either terminal state, its deposit
  total has already been consumed by a settlement calculation (Phase 2's
  checkout, or Phase 3's cancellation refund) that was itself recorded into
  Sổ thu chi at that moment — deleting the deposit afterward cannot retroactively
  correct that already-recorded number, so it must not be allowed to happen at
  all.
- Mandatory server-side permission checks; client-side gating is UX only.
- The permission-check bug fixed in the asset-delete feature (the endpoint
  originally forgot to also reject `role === 'observer'`, even though an
  observer could never legitimately hold the `can_delete_asset` flag)
  must not be repeated here — the new deposit-delete endpoint checks both
  `canDeleteDeposit` and `role !== 'observer'` explicitly.

## 3. Data Model

### 3.1 `staff_accounts.can_delete_deposit` (new column)

```sql
ALTER TABLE staff_accounts ADD COLUMN can_delete_deposit INTEGER NOT NULL DEFAULT 0;
```

Mirrors `can_delete_asset` exactly: boolean-as-integer, defaults off,
admin-only to grant, never grantable to an `observer` account.

### 3.2 `booking_deposits.voided_by` / `.voided_at` (new columns)

```sql
ALTER TABLE booking_deposits ADD COLUMN voided_by TEXT;
ALTER TABLE booking_deposits ADD COLUMN voided_at TEXT;
```

Both nullable. A deposit with `voided_at IS NULL` is active (counted in
`bookings.deposit_amount` and in the deposit history list); one with
`voided_at` set is deleted (excluded from both).

## 4. API

### 4.1 `PATCH /api/users/:id/deposit-delete-access` (new)

Direct copy of `functions/api/users/[id]/asset-delete-access.js`'s shape,
renamed:

- Role: `admin` only.
- Body: `{ canDeleteDeposit: boolean }`.
- Rejects granting the flag to an account whose `role === 'observer'`
  (400).
- `UPDATE staff_accounts SET can_delete_deposit = ? WHERE id = ?` +
  `audit_log` insert (`action_type = 'account_permission_change'`, same
  shape as the asset-delete-access endpoint's own audit entry), in one
  `env.DB.batch([...])`.
- Response: `{ ok: true }`.

### 4.2 `DELETE /api/bookings/:id/deposits/:depositId` (new)

- Auth: `requireAuth(request, env, null)` (any authenticated role, matching
  the asset-delete endpoint's own shape — the real gate is the flag check
  below, not the role list).
- **`if (!auth.canDeleteDeposit || auth.role === 'observer') return 403`**
  — both conditions explicit, closing the gap the asset-delete endpoint
  originally had.
- Look up the deposit (`SELECT id, booking_id, amount, finance_transaction_id, voided_at FROM booking_deposits WHERE id = ?`), joined or
  followed by a lookup of its booking's `status`. 404 if the deposit
  doesn't exist or its `booking_id` doesn't match the `:id` in the URL
  (mirrors the existing service-item-void endpoint's same
  belongs-to-this-booking check). 400 "Dòng cọc này đã bị xoá trước đó"
  if `voided_at` is already set.
- 400 "Chỉ có thể xoá cọc khi đặt phòng còn đang chờ, đã xác nhận, hoặc
  đang lưu trú" if the booking's `status` is `checked_out` or `cancelled`.
**Important correctness note, deliberately NOT the same shape as Phase
2/3's race-guarded batches:** D1's `env.DB.batch([...])` runs every
statement in the array regardless of whether an earlier one's `WHERE`
clause matched zero rows — a batch does not stop or roll back partway
because one `UPDATE` was a no-op. Phase 2/3 could put their guarded
status-changing `UPDATE` in the same batch as everything else only
because every *other* statement in those batches was itself naturally
idempotent (setting `needs_cleaning = 1` again is harmless; an `UPDATE
... WHERE payment_status = 'pending'` matches zero rows on a retry once
the winner has already flipped them). The `deposit_amount` decrement
here is **not** naturally idempotent — running it twice would subtract
the same amount twice. So the guarded void and the decrement must **not**
be sent in the same batch:

1. First, standalone: `UPDATE booking_deposits SET voided_by = ?, voided_at = ? WHERE id = ? AND voided_at IS NULL`, awaited on its own via
   `.run()`.
2. Check `result.meta.changes`. If `0` (another request already voided
   this deposit, or the not-already-voided check above raced), return 409
   "Dòng cọc này vừa được xử lý bởi thao tác khác, vui lòng tải lại"
   immediately — **nothing else executes**, so `deposit_amount` is never
   touched by the loser of the race.
3. Only once step 1 confirms `changes === 1` (this request genuinely
   performed the void), run `env.DB.batch([...])` with the remaining
   three statements, which are safe to group together (none of them can
   double-apply, since step 1 already guaranteed exactly one winner):
   - `UPDATE bookings SET deposit_amount = deposit_amount - ? WHERE id = ?`
     (atomic decrement, symmetric with the deposit-creation endpoint's own
     atomic increment).
   - `UPDATE finance_transactions SET voided_by = ?, voided_at = ? WHERE id = ? AND voided_at IS NULL` — only if the deposit had a
     `finance_transaction_id` (it always should, per Phase 1, but guard
     defensively). The `AND voided_at IS NULL` makes this a safe no-op if
     that row was somehow already voided through the separate, existing
     manual `finance/transactions/:id/void` endpoint — this must not fail
     the whole deletion.
   - `INSERT INTO audit_log (...)` — `action_type = 'deposit_delete'`,
     `entity_type = 'booking_deposit'`, `entity_id` = the deposit's id,
     `entity_label` = the booking's guest name, `old_value` = the deposit
     amount formatted, `new_value` = NULL, `actor`, `created_at`.
- Response: `{ ok: true }`.

## 5. Client

### 5.1 Permission propagation (mirrors `canDeleteAsset` exactly)

- `lib/auth.js`'s `getSession`: add `a.can_delete_deposit AS canDeleteDeposit` to the `SELECT`, `canDeleteDeposit: !!row.canDeleteDeposit` to the
  returned object.
- `functions/api/auth/me.js`: add `canDeleteDeposit: auth.canDeleteDeposit`
  to the response.
- `functions/api/users/index.js`: add `can_delete_deposit AS canDeleteDeposit` to the list `SELECT`.

### 5.2 `admin/users.html` / `admin/users.js`

Add a second checkbox column, "Xoá cọc", next to the existing "Xoá tài
sản" column — same structure: only rendered when
`window.__currentRole === 'admin'`, `PATCH`es
`/api/users/:id/deposit-delete-access` with `{ canDeleteDeposit }`,
reverts the checkbox on failure, same error-display pattern as the
existing `financeTxCheckbox`/`deleteAssetCheckbox` handlers.

### 5.3 `admin/reception.js`

`currentRole`'s existing module-level pattern gets a sibling:
`canDeleteDeposit` (boolean, set from the `/api/auth/me` response
alongside `currentRole`, same place that response is already parsed).

The deposit history list (`renderBookingCard`, the `.deposit-history`
block rendering each `booking.deposits[]` entry as
`"<amount> · <method> · <date>"`) gains a "Xoá" button per line, appended
after the existing text — visible only when `canDeleteDeposit &&
currentRole !== 'observer'`. Click: `confirm()` dialog ("Xoá dòng cọc
này?"), then `DELETE /api/bookings/:bookingId/deposits/:depositId`,
`refreshAll()` on success, `showOpsError` with the server's message on
failure (the "booking not in an editable state" and "already deleted"
cases surface here verbatim — no special client handling needed beyond
displaying them).

## 6. Testing

- New `test/depositDeleteAccess.test.js` or extend an existing suite:
  `PATCH /api/users/:id/deposit-delete-access` — admin can grant/revoke;
  non-admin rejected; granting to an observer account rejected (400).
- Extend `test/bookingDeposits.test.js` (or wherever Phase 1's deposit
  tests live) with a new `describe('DELETE /api/bookings/:id/deposits/:depositId', ...)`: a flagged account can delete a deposit on a
  `pending`/`confirmed`/`checked_in` booking, correctly decrementing
  `deposit_amount` and voiding the linked `finance_transactions` row (and
  confirming that row now stops appearing in a `finance/summary`-style
  sum); an unflagged account gets 403; an observer with the flag
  (shouldn't be possible to create, but test the endpoint's own defense
  anyway) gets 403; deleting on a `checked_out` or `cancelled` booking
  gets 400 and touches nothing; double-deleting the same deposit gets 400;
  a deposit belonging to a different booking than the URL's `:id` gets
  404; deleting one of several deposits on the same booking only affects
  that one row and correctly leaves `deposit_amount` reduced by exactly
  its own amount (not the whole total).
- e2e: the "Xoá" button is absent for an account without the flag, present
  and functional for one with it; deleting removes the line from the
  history list and reduces the displayed running total; the button is
  never shown to an observer regardless of the flag.
