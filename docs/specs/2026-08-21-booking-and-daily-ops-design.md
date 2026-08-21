# Booking Requests & Daily Operations Board — Design Spec

**Repo:** `hien-le-garden-v4` (unified frontend + backend, see `BACKEND.md`)
**Builds on:** `docs/specs/2026-08-20-crm-admin-management-design.md` (CRM admin — customers, templates, users; unrelated tables, no schema overlap)

## Problem

The homepage already has two guest-facing "booking" UIs — a quick bar
(`#booking` section, `handleBooking()`) and a modal (`#bmOverlay`,
`submitBooking()`), both wired to nothing: `handleBooking()` builds an
unused message string and opens a Facebook page in a new tab;
`submitBooking()` shows a client-side summary of what the guest typed and
tells them to call or message Zalo to actually book. Neither collects the
guest's name or phone number, and nothing is ever persisted. Six room
types are priced on `bang-gia/index.html`, backed by 16 real physical
units, with no system anywhere that knows how many of each are booked on
a given date.

On the staff side, `admin/reception.html` is a single-purpose promo-code
lookup tool. There is no list of who is arriving or leaving today, no
record of who is currently in-house, and no view of which of the 16
units are occupied, empty, or need cleaning between guests. That
information exists only in staff members' memory or an external
system outside this codebase.

This spec adds: a `bookings`/`rooms` data model, a public availability
check + booking-request API wired into the *existing* homepage modal
(no new guest-facing page), a staff-facing daily operations board that
replaces `admin/reception.html`'s current home, and the confirm/reject/
check-in/check-out lifecycle that connects the two.

## Scope decision: request-based, not real-time inventory

Two mechanisms were considered:

- **(Chosen) Request-based:** a guest's submission creates a `pending`
  booking that does **not** reduce the availability count shown to other
  guests. Staff review pending requests on the ops board and confirm
  (assigning one specific physical room) or reject. This mirrors how the
  business already operates by phone/Zalo — the form just replaces the
  phone call, and the real double-booking guard sits at the confirm step
  (see "Confirm-time conflict check" below), not at submission time.
- **(Rejected, for now) Soft-hold with expiry:** a pending request would
  immediately reduce the shown count, auto-expiring after a fixed window
  (e.g. 48h) if unconfirmed. Tighter, but needs an expiry mechanism
  (scheduled cleanup or lazy-expiry-on-read) this spec does not build.
  Worth revisiting once request volume is high enough that two guests
  regularly collide on the same dates.

No online payment, no guest login, no guest-facing "my booking" lookup —
out of scope for this iteration.

## Permissions matrix

| Capability | manager | reception | public |
|---|---|---|---|
| Check availability | ✅ | ✅ | ✅ (no auth) |
| Submit a booking request | ✅ | ✅ | ✅ (no auth) |
| Create a `confirmed` booking directly (phone/Zalo/walk-in) | ✅ | ✅ | ❌ |
| List/view bookings, the ops board | ✅ | ✅ | ❌ |
| Confirm / reject a pending request | ✅ | ✅ | ❌ |
| Check guests in / out | ✅ | ✅ | ❌ |
| View/update room cleaning status | ✅ | ✅ | ❌ |

Enforced server-side via `requireAuth(request, env, ['reception',
'manager'])` or `['manager']`, following the existing pattern in
`functions/api/policy.js`. Public endpoints (`GET /api/availability`,
`POST /api/bookings`) add no auth check, matching `functions/api/
feedback.js`'s precedent for guest-facing writes — but, unlike
`feedback.js` (which adds CORS because the survey page is designed to be
embeddable cross-origin), these add **no CORS handling**: the booking
modal lives in `index.html` itself and is only ever called same-origin,
matching the no-CORS precedent set by the admin-only endpoints
(`functions/api/policy.js`, `functions/api/gift-inventory.js`).

## Data model

### New table: `rooms`

```sql
CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  room_type TEXT NOT NULL CHECK (room_type IN
    ('triangle', 'circle', 'ede_cozy', 'vip', 'bungalow', 'dormitory')),
  is_active INTEGER NOT NULL DEFAULT 1,
  needs_cleaning INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_rooms_type_active ON rooms(room_type, is_active);
```

Seeded with the real inventory (16 rows): `Triangle House 1..3`,
`Circle House 1..5`, `Ê Đê Cozy House 1..2`, `VIP House 1..2`,
`Bungalow Gia Đình 1..3`, `Phòng Tập Thể 1`. `room_type` values map to
the six priced categories on `bang-gia/index.html`; the mapping from
`room_type` to its Vietnamese display label and matching room-type
option already used in the booking modal (`Triangle House`, `Circle
House`, `Ede Cozy Room`, `VIP House`, `Bungalow`, `Dormitory`) lives in
one shared JS constant, not duplicated across files (see "Room-type
label mapping" below).

`is_active = 0` marks a unit temporarily out of service (renovation,
etc.) — excluded from availability counts and new confirmations, but
existing bookings already assigned to it are unaffected. `needs_cleaning`
is a plain flag staff toggle by hand at check-out and clear by hand once
done — no automatic housekeeping scheduling.

### New table: `bookings`

```sql
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  room_type TEXT NOT NULL CHECK (room_type IN
    ('triangle', 'circle', 'ede_cozy', 'vip', 'bungalow', 'dormitory')),
  room_id INTEGER REFERENCES rooms(id),
  check_in TEXT NOT NULL,
  check_out TEXT NOT NULL,
  guests_count INTEGER,
  notes TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled'))
    DEFAULT 'pending',
  source TEXT NOT NULL CHECK (source IN
    ('website', 'phone', 'zalo', 'walk_in')) DEFAULT 'website',
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT
);

CREATE INDEX idx_bookings_dates ON bookings(check_in, check_out);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_room ON bookings(room_id);
```

- `room_id` is `NULL` until a `pending` request is confirmed; `room_type`
  is set from the start (what the guest asked for or staff selected).
- `created_by` is `NULL` for a guest-submitted request (`source =
  'website'`); it's the staff username for anything staff create
  directly (`source IN ('phone', 'zalo', 'walk_in')`).
- `check_in`/`check_out` are ISO date strings (`YYYY-MM-DD`), consistent
  with every other date column already in this schema. A stay occupies
  the room for `[check_in, check_out)` — the standard hospitality
  convention (checkout day itself is not counted as occupied), matching
  the checkout-day-cleaning logic below.
- Status lifecycle: `pending → confirmed → checked_in → checked_out`, or
  `pending → cancelled` / `confirmed → cancelled`. No transition skips a
  step (e.g. `checked_in` requires the booking to currently be
  `confirmed`); each transition is its own endpoint and re-validates the
  current status server-side rather than trusting the client.

### Room-type label mapping

A single shared constant (`lib/roomTypes.js`), consumed by both the
availability/booking endpoints and the ops-board admin JS, maps the six
`room_type` DB values to their Vietnamese display label and the price
already shown on `bang-gia/index.html` (kept here only for display, not
recalculated or charged anywhere — this feature does not touch payment):

```js
export const ROOM_TYPES = {
  triangle: { label: 'Triangle House', priceVnd: 300000 },
  circle:   { label: 'Circle House', priceVnd: 600000 },
  ede_cozy: { label: 'Ê Đê Cozy House', priceVnd: 700000 },
  vip:      { label: 'VIP House', priceVnd: 900000 },
  bungalow: { label: 'Bungalow Gia Đình', priceVnd: 700000 },
  dormitory:{ label: 'Phòng Tập Thể', priceVnd: 1200000 },
};
```

## API endpoints

All under `functions/api/bookings/` and `functions/api/rooms/`, following
this codebase's existing `jsonError(message, status)` / Vietnamese
error-message conventions (see `functions/api/policy.js`,
`functions/api/customers/index.js`).

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/availability` | GET | public | `?roomType=circle&checkIn=2026-09-01&checkOut=2026-09-03` → `{ roomType, totalRooms, bookedCount, available, availableRooms: [{ id, name }] }`. Counts (and lists) overlapping `confirmed`/`checked_in` bookings against active rooms of that type only — `pending` requests never affect this number (see Scope decision). The guest-facing modal only reads `available`; the ops board's confirm-flow room picker (below) calls this same endpoint and reads `availableRooms` to populate its choices — one query shape serves both, rather than a second endpoint duplicating the same overlap logic. |
| `/api/bookings` | POST | public | Guest submits a request. Body: `{ guestName, phone, email?, roomType, checkIn, checkOut, guestsCount?, notes? }`. Validates required fields, `checkOut > checkIn`, `checkIn >= today`, `roomType` is one of the six values. Always creates `status = 'pending'`, `source = 'website'`. Does **not** check availability server-side beyond "the room type exists" — a guest can request a sold-out type; staff will see and reject it. (The client-side availability check before submit is a courtesy, not an enforcement point.) |
| `/api/bookings/staff` | POST | reception+manager | Staff creates a booking directly for a phone/Zalo/walk-in guest. Same body shape and the same field validation as `POST /api/bookings` (including `checkIn >= today` — a walk-in already on the property today satisfies this since `today` counts), plus `source` (`phone`\|`zalo`\|`walk_in`, required) and `roomId` (required — staff must pick a specific unit up front, since this is an immediate confirmation, not a request). Creates `status = 'confirmed'` directly, `created_by` = the authenticated username, runs the same conflict check as `/confirm` (below) against the chosen room. Kept as a separate route from the public `POST /api/bookings` rather than branching one handler on session presence — one endpoint with two different authorization-dependent behaviors is a sharper edge to maintain and to get wrong than two small, single-purpose ones. |
| `/api/bookings` | GET | reception+manager | List/filter: `?status=pending`, `?date=2026-08-21&view=today` (arrivals+departures for that date), `?status=checked_in` (in-house). Powers every list on the ops board — see "Ops board data needs" below for the exact query shapes it must support. |
| `/api/bookings/:id/confirm` | POST | reception+manager | Body: `{ roomId }`. Requires current status `pending`. Runs the **confirm-time conflict check** (below); on success sets `status='confirmed'`, `room_id`, `confirmed_by`, `confirmed_at`. |
| `/api/bookings/:id/reject` | POST | reception+manager | Body: `{ reason? }`. Requires current status `pending`. Sets `status='cancelled'`, `cancel_reason`. |
| `/api/bookings/:id/check-in` | POST | reception+manager | Requires current status `confirmed`. Sets `status='checked_in'`. |
| `/api/bookings/:id/check-out` | POST | reception+manager | Requires current status `checked_in`. Sets `status='checked_out'`; sets that booking's `rooms.needs_cleaning = 1`. |
| `/api/rooms` | GET | reception+manager | All active rooms with a computed `status` per room: `occupied` (a `checked_in` booking today), `needs_cleaning`, or `empty` — `needs_cleaning` wins the display over `empty` when both would otherwise apply. |
| `/api/rooms/:id/clean` | POST | reception+manager | Sets `needs_cleaning = 0`. |

### Confirm-time conflict check

The one place double-booking is actually prevented. On `POST /:id/
confirm` (and on `/api/bookings/staff`, which confirms immediately):

```sql
SELECT id FROM bookings
WHERE room_id = ?
  AND status IN ('confirmed', 'checked_in')
  AND check_in < ?   -- new checkout
  AND check_out > ?  -- new checkin
```

Any row returned → `409` with a clear Vietnamese message naming the
conflicting date range, so staff picks a different unit instead of the
request silently overwriting another guest's stay.

## Guest-facing UI changes (`index.html`)

No new page. Both existing entry points funnel into one real flow:

- The `#booking` quick bar's own `handleBooking()` (currently: builds an
  unused message, opens Facebook) is replaced with a call to
  `openBookingModal()`, carrying over any dates/room-type the guest
  already entered into the bar — the bar becomes a shortcut into the
  modal rather than a second, parallel submission path.
- The modal (`#bmFormState`) gains two required fields — **Họ tên**,
  **Số điện thoại** — added to the existing `bm-grid` alongside the
  current check-in/out/guests/room fields, plus an optional **Ghi chú**.
- On check-in/out/room-type change, call `GET /api/availability` and
  show the result inline (e.g. "Còn 3 phòng trống" / "Đã hết phòng loại
  này trong khoảng ngày này"). This is a hint only, not a gate:
  submission still proceeds even when `available = 0`, consistent with
  `POST /api/bookings` itself never checking availability server-side
  (see that endpoint's row above) — a guest can still ask for a
  sold-out type and staff resolves it, the same as every other
  capacity question in this request-based design.
- `submitBooking()` calls `POST /api/bookings` instead of only rendering
  a local summary. The confirm state keeps the existing summary rows and
  the call/Zalo buttons (guests who want instant human contact still
  have it) but its heading changes from "Liên hệ để xác nhận đặt phòng"
  to "Yêu cầu đã được gửi — Hiền Lê Garden sẽ liên hệ xác nhận trong 24h
  qua số điện thoại bạn cung cấp", with the contact buttons re-framed as
  "hoặc liên hệ ngay nếu cần gấp" rather than the only path forward.
- On a failed submission (validation error, network failure), the modal
  shows the error inline on `bmFormState` and does not advance to the
  confirm state — mirrors the `response.ok`-check convention already
  established across the admin pages in `docs/superpowers/plans/
  2026-08-20-crm-admin-management-plan.md`'s task reviews.

## Staff-facing UI: `admin/reception.html` becomes the daily ops board

Replaces the page's current sole purpose (promo-code lookup), which
moves down as a secondary section on the same page — no new nav entry
needed, no page removed.

Top to bottom:

1. **+ Tạo đặt phòng mới** — a compact form for phone/Zalo/walk-in
   guests: same fields as the guest modal, plus a required room picker
   (same `GET /api/availability` → `availableRooms` source as the
   confirm-flow picker below) and a source selector. Submits to
   `POST /api/bookings/staff`.
2. **Cần xử lý** — every `pending` request, soonest `check_in` first:
   guest name, phone, room type, dates, guest count, notes, a **Xác
   nhận** button (opens a room picker populated by `GET /api/availability`'s
   `availableRooms` for that request's room type and dates — only units
   actually free for those exact dates are selectable) and a **Từ chối**
   button (optional reason).
3. **Hôm nay** — two lists: arrivals (`confirmed`, `check_in = today`)
   each with a **Check-in** button; departures (`checked_in`, `check_out
   = today`) each with a **Check-out** button.
4. **Đang ở** — `checked_in` bookings where `check_out > today`.
5. **Trạng thái phòng** — a grid of the 16 units grouped by type, each
   showing Trống / Đang có khách / Cần dọn, with a **Đã dọn xong** button
   appearing only on units currently flagged `needs_cleaning`.
6. **Tra cứu & đổi mã ưu đãi** — existing promo-lookup section, unchanged
   behavior, moved to the bottom of the page.

### Ops board data needs (drives the `GET /api/bookings` filter shapes)

- Pending queue: `status = 'pending'`, all dates, ordered by `check_in`.
- Today's arrivals: `status = 'confirmed' AND check_in = :today`.
- Today's departures: `status = 'checked_in' AND check_out = :today`.
- In-house: `status = 'checked_in' AND check_out > :today`.

`GET /api/bookings` supports each via query params (`status`, `date`,
`view`) rather than four separate routes — one list endpoint, client
picks the filter combination it needs per section.

## Migration

`migrations/0004_bookings_and_rooms.sql` — creates `rooms` and `bookings`
with the schema above, seeds the 16 real rooms. Applied locally via the
existing `vitest.config.js`/`test/apply-migrations.js` machinery
automatically; applying to the **real remote D1** happens once, after
this spec's implementation plan is fully merged — same manual, documented
step as `migrations/0003` (see `BACKEND.md`'s "Applying a new migration
to production" section), not part of any individual implementation task.

## Testing

Same conventions as the rest of this backend: Vitest +
`@cloudflare/vitest-pool-workers`, one test file per endpoint group,
`authedRequest(url, token, method, body)` helper defined locally per file
(existing project convention, no shared test-helpers file). The
confirm-time conflict check gets explicit coverage: two `pending`
requests for the same room type/overlapping dates, confirm one to a
specific room, attempt to confirm the other to the *same* room, expect
`409`; confirming the second to a *different* room in the same type
succeeds.

`admin/reception.html`'s new markup/JS has no automated test coverage,
matching every other admin page built in the CRM admin management plan —
verified by manual reasoning-trace during implementation instead. A
Playwright e2e spec (in the sibling `hien-le-garden-landing` repo's
`tests/e2e/`, mocking `/api/*` via `page.route()`, following the
established `crm-admin.spec.js` pattern) covers the guest booking modal's
happy path and the ops board's confirm/check-in/check-out actions against
mocked responses — not exercising the live D1 backend, same division of
responsibility BACKEND.md already documents for the existing suite.

## Out of scope (explicitly deferred)

- Online payment / deposit collection.
- Soft-hold-with-expiry availability locking (see Scope decision above).
- Guest login or a "look up my booking" self-service page.
- Automatic housekeeping scheduling or turnaround-time enforcement.
- OTA sync (Agoda/Booking.com/iCal) — noted as a long-term item in the
  earlier site-wide roadmap analysis, not part of this spec.
- A UI for managing the `rooms` inventory itself (adding a unit, retiring
  one permanently, renaming). The 16 real units are seeded by the
  migration; a unit going temporarily out of service is a rare, low-
  frequency change a manager can make with a direct D1 write (`wrangler
  d1 execute ... --remote`) rather than earning a dedicated admin screen
  in this iteration.
