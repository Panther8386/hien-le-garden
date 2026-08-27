# Room Status Filters & Layout Permission — Design

**Date:** 2026-08-27
**Repo:** `hien-le-garden-v4` (`v4/` in this monorepo checkout)
**Status:** Approved by user, ready for implementation planning

## Problem

The "Trạng thái phòng" (room status) grid on the reception ops board only
shows a room's *current* state (`empty` / `occupied` / `needs_cleaning`),
computed from whether any booking for that room currently has
`status = 'checked_in'`. The user wants:

1. A richer 5-state model reflecting a room's booking lifecycle, viewable
   for any chosen date (not just "right now").
2. A deposit (cọc) amount trackable per booking, since one of the 5 states
   distinguishes a reservation with a deposit from one without.
3. Date + status filters on the grid, usable by every role including
   `observer` (this is a view/filter control, not a write action).
4. Drag-to-reorder room display order restricted to accounts with a new,
   independently-grantable permission flag (not tied to the `manager`/
   `admin` role directly) — initially only the `Vinhdx` account.
5. Reordering changes staged locally and committed via an explicit "Lưu bố
   cục" button (not auto-saved on drop, as today), with each save logged
   (who, when, before/after order) and a small recent-history list shown
   in the same area of the UI.

## Room Status Model

For a room and a chosen date `D`, find the (non-cancelled) booking for
that room where `check_in <= D < check_out` — at most one should exist.
Map it to a display status:

| Condition | Status key | Label | Color |
|---|---|---|---|
| No such booking | `empty` | Phòng trống | light green |
| booking found, `status` in (`pending`,`confirmed`), `deposit_amount` is 0/null | `booked` | Đã có khách đặt | amber |
| booking found, `status` in (`pending`,`confirmed`), `deposit_amount` > 0 | `booked_deposited` | Đã đặt & có cọc | blue |
| booking found, `status = 'checked_in'` | `occupied` | Đang có khách | orange/red |
| booking found, `status = 'checked_out'` | `used` | Đã sử dụng | gray |

`needs_cleaning` remains a separate, real-time-only flag (not date-scoped)
— rendered as a small badge/icon on top of a room's card, shown only when
the selected date is today (cleaning status has no meaning for a past or
future date). Cancelled bookings are excluded from the date lookup — a
room with only a cancelled booking overlapping `D` is `empty`.

## Deposit Tracking

Add `deposit_amount INTEGER NOT NULL DEFAULT 0` to `bookings` (VND,
whole-đồng integer, no cents). Editable inline on booking cards in the
"Cần xử lý" (pending), "Hôm nay → Khách đến hôm nay" (arrivals, which are
`confirmed`), and "Đã xác nhận (sắp tới)" (upcoming confirmed) lists —
i.e. any card whose booking `status` is `pending` or `confirmed`. Not
shown on checked-in/checked-out/cancelled cards (money already collected
or moot by then). A number input + "Lưu cọc" button per card; `observer`
never sees this control (write action, excluded per the existing
observer-read-only convention).

New endpoint `PATCH /api/bookings/:id/deposit`, body `{ depositAmount:
number }`, allowed roles `['reception', 'manager', 'admin']` (mirrors the
existing booking-action endpoints — `observer` excluded by omission, same
enforcement pattern as every other write endpoint in this codebase).
Validates `depositAmount` is a non-negative integer.

## Date/Status Filters

Two controls above the room grid: a date `<input type="date">` (defaults
to today) and a status `<select>` (Tất cả / Trống / Đã có khách đặt / Đã
đặt & có cọc / Đang có khách / Đã sử dụng). Status filtering happens
client-side (≤ ~20 rooms, no need for a server query param). Every role
including `observer` can use both — they're view controls, already backed
by `GET /api/rooms`, which `observer` already has read access to (granted
in an earlier plan).

`GET /api/rooms` gains an optional `?date=YYYY-MM-DD` query parameter.
Without it, the endpoint keeps its exact current behavior (real-time
`empty`/`occupied`/`needs_cleaning`, unchanged for backward compatibility
with any caller that doesn't pass it). With it, the endpoint returns the
5-state model above for that date, still including the always-live
`needsCleaning` flag alongside.

## Room Layout Permission

Add `can_manage_room_layout INTEGER NOT NULL DEFAULT 0` to
`staff_accounts`. A one-time data migration sets it to `1` for the
existing `Vinhdx` account. A new checkbox "Quản trị bố cục phòng" in the
Users management page lets a manager/admin toggle this flag for any
account going forward — the permission is independent of `role`, so an
`admin`/`manager`/`reception` account could have it, and a `manager` need
not have it by default.

`GET /api/auth/me` and the underlying session (`lib/auth.js`'s
`getSession`) both gain a `canManageRoomLayout` boolean, sourced from this
new column, so the frontend knows whether the logged-in account may drag.

Drag-and-drop in `reception.js` is gated on `canManageRoomLayout` (from
`/api/auth/me`) instead of the current `currentRole === 'manager'` check.
It's also disabled whenever the selected date filter isn't today —
reordering only makes sense for the live board, not a historical/future
view.

**Save flow changes**: dragging reorders cards in the DOM only (no
network call per drop, unlike today's auto-save-on-drop). A "Lưu bố cục"
button appears once the order differs from what's currently persisted,
and only that click calls `PATCH /api/rooms/reorder`. `functions/api/rooms
/reorder.js`'s `requireAuth` call changes from role-list-based
(`['manager','admin']`) to `requireAuth(request, env, null)` (any
authenticated staff) followed by an explicit `auth.canManageRoomLayout`
check inside the handler, returning 403 with a clear message if unset —
this is the shift the spec's Problem section describes (permission
independent of role).

## Change Log

New table `room_layout_log` (mirroring the existing `message_log`
pattern): `id, changed_by TEXT NOT NULL, old_order TEXT NOT NULL, new_order
TEXT NOT NULL, changed_at TEXT NOT NULL` (`old_order`/`new_order` are
JSON-encoded arrays of room ids in order). `reorder.js` inserts one row on
every successful save, using `auth.username` for `changed_by`.

New endpoint `GET /api/rooms/layout-log?limit=5` (default limit 5),
allowed to all four roles (view-only, matches the rest of this feature's
all-roles-can-view stance), returns the most recent rows newest-first with
`changedBy` and `changedAt` (the before/after orders aren't rendered in
the UI, just stored — the UI only needs "who changed it and when" for the
small history list; the full before/after stays in D1 for manual lookup
if ever needed).

A small section under/beside the room grid — "Lịch sử sắp xếp gần đây" —
lists up to 5 entries like `Vinhdx đã cập nhật bố cục — 27/08/2026 18:30`.

## Testing

- `test/roomsEndpoints.test.js` already has passing tests asserting that a
  `manager`/`admin` token can call `PATCH /api/rooms/reorder` successfully
  purely by role — these will start failing once the permission model
  becomes flag-based, since none of that file's existing fixtures set
  `can_manage_room_layout`. Update those fixtures/tests as part of this
  work (seed the flag for whichever fixture account the "can reorder"
  tests use; add a new fixture without the flag for the "cannot reorder"
  case), rather than leaving them broken.
- Vitest: extend `test/roomsEndpoints.test.js` with cases for the new
  `?date=` parameter across all 5 states (seed bookings with each status +
  a deposited and non-deposited pending booking), the unchanged
  no-`date`-param behavior, `PATCH /api/rooms/reorder`'s new
  permission-flag gate (403 for a manager without the flag, 200 for any
  role with it), and the new `room_layout_log` row being written on a
  successful reorder.
- New test file or extension for `PATCH /api/bookings/:id/deposit`
  (valid/invalid amounts, role gating, `observer` excluded).
- New test file for `GET /api/rooms/layout-log` (returns newest-first,
  respects `limit`, accessible to all 4 roles).
- Playwright: extend `tests/e2e/reception-ops-board.spec.js` — a manager
  without `canManageRoomLayout` cannot drag; an account with the flag can
  drag, sees the order change locally without a network call, then must
  click "Lưu bố cục" to persist; `observer` never sees deposit inputs or
  the drag affordance.
