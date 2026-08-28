# Audit Log Design

**Date:** 2026-08-28
**Status:** Approved
**Repo target:** `hien-le-garden-v4` (v4)

## Problem

Hiền Lê Garden V4 has one narrow audit trail today — `room_layout_log`,
written by `functions/api/rooms/reorder.js` and read by a small widget in
`admin/reception.js`. Four other sensitive mutations have no audit trail at
all: changing a booking's deposit amount, cancelling a booking, voiding a
posted service line, and changing a staff account's role or room-layout
permission. When something looks wrong (a deposit reset to 0, a booking
cancelled without explanation, a service voided after the fact), there is
no record of who did it or when.

## Goal

Clone the `room_layout_log` pattern into one shared `audit_log` table that
captures these four action families, plus a minimal read-only admin page
(manager/admin only) to browse the last 50 entries with an optional
type filter.

`room_layout_log` itself is explicitly out of scope — it keeps working
exactly as it does today, unmodified. This spec adds a second, independent
log table alongside it, not a replacement.

## Schema

New migration `0012_audit_log.sql`:

```sql
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  entity_label TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

No `CHECK` constraint on `action_type`/`entity_type` — consistent with this
codebase's established convention that `ALTER TABLE`-added enum-like
columns validate in the API layer only; `audit_log` is a `CREATE TABLE`,
but validation of `action_type` happens in the read endpoint regardless
(see below), so a `CHECK` would only duplicate that check redundantly for
five known write sites already under our control. Kept out for the same
reduced-uncertainty reasoning migration 0011 used.

`old_value`/`new_value` are free-text snapshots (never a live join) — this
mirrors the `old_order`/`new_order` TEXT columns on `room_layout_log`, and
the snapshot-at-write-time principle already established for
`booking_service_items` (`name`/`unit_price` captured at add time, never
re-read from `service_catalog` afterward). A booking, service item, or
staff account can be deleted or renamed later; the log row must still read
sensibly.

### `action_type` values and what each write site stores

| action_type | entity_type | entity_id | entity_label | old_value | new_value |
|---|---|---|---|---|---|
| `deposit_change` | `booking` | booking id | guest name | old deposit amount, digits only (e.g. `"0"`) | new deposit amount, digits only |
| `booking_cancel` | `booking` | booking id | guest name | `"confirmed"` | `"cancelled — hoàn <percent>% (<amount> đ)"`, plus `" — Lý do: <reason>"` appended when a reason was given |
| `service_void` | `service_item` | service item id | `"<service name> ×<quantity> — <guest name>"` | `"posted"` | `"voided"` |
| `account_role_change` | `staff_account` | staff account id | username | old role | new role |
| `account_permission_change` | `staff_account` | staff account id | username | `"Bật"` or `"Tắt"` (previous `can_manage_room_layout`) | `"Bật"` or `"Tắt"` (new value) |

Amounts are stored as plain digit strings (no currency formatting, no
thousands separators) — formatting is a read-side concern, kept in the
admin page's JS, matching how `formatVnd()` is applied client-side
elsewhere in this codebase rather than baked into stored values.

## Write-site changes

Each of the five write sites currently issues one `UPDATE ... run()`. Each
becomes a two-statement `env.DB.batch([update, logInsert])`, identical in
shape to the existing `reorder.js` pattern (`UPDATE rooms ...` + `INSERT
INTO room_layout_log ...` batched together). This keeps the mutation and
its audit row atomic — if either statement fails, neither commits.

### `functions/api/bookings/[id]/deposit.js`

Currently `SELECT id FROM bookings WHERE id = ?` before the update. Extend
the select to `SELECT id, guest_name, deposit_amount FROM bookings WHERE id
= ?` so both the pre-change amount (for `old_value`) and the guest name
(for `entity_label`) are available. Batch the existing `UPDATE bookings SET
deposit_amount = ?` with an `INSERT INTO audit_log (...) VALUES
('deposit_change', 'booking', ?, ?, ?, ?, ?, ?)` bound to
`(booking.id, booking.guest_name, String(booking.deposit_amount), String(depositAmount), auth.username, now)`.

### `functions/api/bookings/[id]/cancel.js`

Already selects `guest_name`... actually it currently selects `id, status,
check_in, deposit_amount` — extend to also select `guest_name`. Compose
`new_value` from the already-computed `refundPercentApplied`/`refundAmount`
and the `reason` field already destructured from the body:
```js
let newValue = `cancelled — hoàn ${refundPercentApplied}% (${refundAmount} đ)`;
if (reason) newValue += ` — Lý do: ${reason}`;
```
Batch the existing `UPDATE bookings SET status = 'cancelled', ...` with the
`audit_log` insert (`old_value = 'confirmed'`, `new_value` as composed
above, `entity_label = booking.guest_name`).

### `functions/api/bookings/[id]/services/[itemId].js`

Currently selects `id, booking_id, status` from `booking_service_items`.
Extend the select with a join to also pull the service's own `name` and
`quantity`, plus the parent booking's `guest_name`:
```sql
SELECT bsi.id, bsi.booking_id, bsi.status, bsi.name, bsi.quantity, b.guest_name
FROM booking_service_items bsi JOIN bookings b ON b.id = bsi.booking_id
WHERE bsi.id = ?
```
`entity_label = `${item.name} ×${item.quantity} — ${item.guest_name}``.
Batch the existing void `UPDATE` with the `audit_log` insert
(`old_value = 'posted'`, `new_value = 'voided'`).

### `functions/api/users/[id]/role.js`

Currently selects `role` only. Extend to `SELECT username, role FROM
staff_accounts WHERE id = ?` (username needed for `entity_label`). Batch
the existing `UPDATE staff_accounts SET role = ?` with the `audit_log`
insert (`old_value = target.role`, `new_value = role`).

### `functions/api/users/[id]/room-layout-access.js`

Currently selects `id, role`. Extend to `SELECT id, username, role,
can_manage_room_layout FROM staff_accounts WHERE id = ?` (this endpoint
did not previously need the current flag value at all — it does now, both
to compute `old_value` and because it's needed regardless of whether the
value actually changes). Batch the existing `UPDATE staff_accounts SET
can_manage_room_layout = ?` with the `audit_log` insert (`old_value =
target.can_manage_room_layout ? 'Bật' : 'Tắt'`, `new_value =
canManageRoomLayout ? 'Bật' : 'Tắt'`).

No site skips the log write when old and new values are identical — a
no-op edit (e.g. re-submitting the same role) still produces a log row.
This matches `reorder.js`, which logs every reorder including one that
happens to reproduce the existing order, and keeps every site's logic
uniform (no "did anything actually change" branch to get wrong).

## Read endpoint

New `functions/api/audit-log/index.js`:

```
GET /api/audit-log?type=<action_type>&limit=<n>
```

- `requireAuth(request, env, ['manager', 'admin'])` — narrower than the
  booking-mutating endpoints' usual `['reception','manager','admin']`,
  matching this session's established exception for admin-config-style
  screens (service catalog writes, cancellation-policy writes, password
  reset are all `['admin']`-only or `['manager','admin']`-only already).
- `limit`: same clamping pattern as `layout-log.js` — parse as int, valid
  positive integer capped at 100, default 50 when absent or invalid.
- `type`: optional. When present, must be one of the five known
  `action_type` values (`deposit_change`, `booking_cancel`,
  `service_void`, `account_role_change`, `account_permission_change`);
  anything else is a 400 (`"Loại thay đổi không hợp lệ"`). When absent,
  no filter — all action types returned.
- Response: array of `{ id, actionType, entityType, entityId, entityLabel,
  oldValue, newValue, actor, createdAt }`, ordered `id DESC` (most recent
  first), matching `layout-log.js`'s ordering.

## Admin page

New `admin/audit-log.html` + `admin/audit-log.js`, structurally modeled on
`admin/cancellation-policy.html`/`.js` (shared `admin.css`, same
nav-drawer script include, same `<meta name="robots" content="noindex,
nofollow">`, same Google Fonts links). Read-only — no create/edit/delete
controls, since nothing about a log entry is ever mutated.

Page contents:
- `<h1>Nhật ký thao tác</h1>` and one explanatory sentence.
- A `<select>` filter with options: "Tất cả" (default, no `type` param) and
  one option per `action_type`, labeled:
  - `deposit_change` → "Đổi tiền cọc"
  - `booking_cancel` → "Huỷ đặt phòng"
  - `service_void` → "Huỷ dịch vụ"
  - `account_role_change` → "Đổi vai trò tài khoản"
  - `account_permission_change` → "Đổi quyền sắp xếp phòng"
  Changing the filter re-fetches `/api/audit-log?type=<value>&limit=50`
  (or without `type` for "Tất cả") and re-renders the table.
- A table with columns: Thời gian, Loại thao tác, Người thực hiện, Đối
  tượng, Thay đổi. "Thời gian" formats `createdAt` the same way this
  codebase already formats ISO timestamps elsewhere in the admin section
  (locale-aware `toLocaleString('vi-VN')`, matching `formatVnd`'s
  `toLocaleString` use in `reception.js`). "Loại thao tác" renders the
  Vietnamese label from the mapping above. "Đối tượng" is `entityLabel`.
  "Thay đổi" renders `oldValue → newValue` as plain text — deposit amounts
  are re-formatted with the page's own `formatVnd`-equivalent helper
  (digits in, `"X đ"` out) since the API stores them as bare digit
  strings; the other four action types' old/new values are already
  human-readable strings and render as-is.
- Empty state: "Chưa có thao tác nào được ghi nhận." when the response
  array is empty.
- No pagination — the 50-row cap from the read endpoint is the entire
  page; this matches the "tối giản" (minimal) framing of the request.

### Navigation

`admin/nav-drawer.js`: add one entry to the existing "Cấu hình & Quản trị"
group:
```js
{ page: 'audit-log.html', label: 'Nhật ký thao tác', icon: '📜', roles: ['manager', 'admin'] },
```
and one entry to the `pageSlug` map: `'audit-log.html': 'audit-log'`.

`_redirects`: one new line, placed alongside the other manager/admin-only
entries (`/manager/users`):
```
/manager/audit-log             /admin/audit-log        200
```
No `/reception/audit-log` or `/observer/audit-log` entries — matching how
`users.html` (also manager/admin-only) has no reception/observer redirect
today. A reception or observer account never sees the nav link (filtered
by `roles`) and has no route to reach the page directly; this is the same
protection `users.html` already relies on.

## Testing

New `test/auditLog.test.js`:
- `GET /api/audit-log` requires manager or admin (403 for reception and
  observer, using the existing `authedRequest` helper pattern).
- Returns entries ordered newest-first, respects `limit`.
- `type` filter returns only matching rows; an invalid `type` value is a
  400.
- Default `limit` is 50 when omitted; an out-of-range or non-numeric
  `limit` falls back to 50 (matching `layout-log.js`'s clamping test
  coverage, adapted to the 100 cap here).

Each of the five write-site changes gets its assertions extended (or a new
`it` block added) in its existing test file — `test/bookingLifecycle.test.js`
or `test/bookingsEndpoints.test.js` for deposit/cancel/service-void,
`test/userManagement.test.js` for role/permission — asserting the resulting
`audit_log` row has the expected `action_type`, `entity_label`,
`old_value`, `new_value`, and `actor` after each mutation. No new fixtures
should be needed; each of these test files already authenticates as
reception/manager/admin/observer accounts and already has bookings/service
items/staff accounts to mutate.

Playwright: one new test in a suitable existing e2e spec (or a small new
`tests/e2e/audit-log.spec.js`) that mocks `GET /api/audit-log`, navigates
to `/admin/audit-log.html`, and asserts the table renders the mocked rows
and that changing the type filter re-requests with the right `type` query
param.

## Out of scope

- `room_layout_log` migration/consolidation — deliberately left alone.
- Pagination beyond the 50-row (default) / 100-row (max) cap.
- Any UI to filter by date range, actor, or entity — type filter only.
- Retention/deletion policy for old audit rows — rows accumulate
  indefinitely, same as every other table in this schema.
