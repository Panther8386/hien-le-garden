# Room Pricing Overhaul — Design

## 1. Purpose

Room pricing today is a single flat number per `room_type` (`lib/roomTypes.js`,
6 entries), applied uniformly to every room of that type and every night of
every stay. This breaks in two ways the business actually cares about:

- **Two rooms of the same `room_type` can have different real prices.**
  Discovered directly: "VIP House 2" (`room_id=12`, `room_type='vip'`) rents
  at 700,000đ/night while "VIP House 1" rents at 900,000đ/night, even though
  both share `room_type='vip'` and therefore the same flat price today.
- **Price should vary by day of week** — a Mon–Thu rate and a higher
  Fri–Sun rate, with admin-defined holiday date ranges billed at the
  Fri–Sun rate regardless of weekday.

This overhaul moves the price onto each of the 16 real `rooms` rows (two
tiers each: weekday / weekend) and rewrites every place that turns a stay
into a VNĐ amount to sum day-by-day instead of `nights × one price`. It adds
an admin-managed `holidays` table (date ranges, from 2026 onward) that the
pricing formula consults to decide whether a given night bills at the
weekend rate.

**Origin:** found while manually backfilling a pre-Phase-2 Vip2 booking's
missing Sổ thu chi entries — the flat-price assumption for the backfill was
initially wrong (900,000đ) and the user corrected it to the room's actual
price (700,000đ), which is what prompted this request.

**Out of scope:**
- The 6 `room_type` values themselves stay fixed — this only adds pricing
  underneath them, it does not restructure room identity or add new types.
- `service_catalog`'s `luu_tru` category rows (the public "Bảng giá dịch
  vụ" price list) are a separate, purely informational display table —
  nothing in the codebase reads them to compute an actual booking charge
  (grep-confirmed: every reference is either the public catalog page or
  add-on `booking_service_items`, never room-night billing). They are not
  touched by this change; keeping them in sync with the new per-room prices
  is a manual, optional step for whoever maintains that page, not part of
  this spec.
- No public-facing page currently displays per-room or per-night pricing
  ahead of booking — none is added here.
- Seeding real `price_weekday`/`price_weekend` values for the 16 rooms is
  **not part of this work** — the user will enter them through the admin
  UI this spec builds, once it ships. Both columns start `NULL` on every
  room and the system runs correctly in that state via the fallback rule
  below.

## 2. Global Constraints

- Every room's `price_weekday`/`price_weekend` may be `NULL` independently
  (a room not yet configured, or configured on only one tier). Whenever a
  given tier's column is `NULL` for a room, the formula falls back to that
  room's `room_type`'s flat `ROOM_TYPES[roomType].priceVnd` (`lib/roomTypes.js`)
  for nights resolving to that tier. `lib/roomTypes.js` is not deleted — it
  becomes the fallback source, not the primary one.
- Pricing must be computed **night by night**, never `nights × single
  price`, in every place that turns a stay into a VNĐ amount. A stay
  crossing from weekday nights into weekend nights (or into a holiday
  range) must bill each night at its own resolved rate.
- Holidays are **admin-managed date ranges** (`start_date`..`end_date`,
  inclusive), not single dates. A night whose calendar date falls inside
  any holiday range bills at the weekend rate, regardless of that date's
  actual day of week.
- Weekday tier = Monday–Thursday. Weekend tier = Friday–Sunday, or any
  date inside a holiday range.
- `holidays` is genuine config data, not a financial record — like
  `cancellation_policy_tier`, deleting a holiday is a real hard SQL
  `DELETE`, and neither its create/update/delete writes an `audit_log`
  entry. This is a deliberate departure from this codebase's usual
  void-not-hard-delete convention, consistent with the one existing
  precedent (`cancellation_policy_tier`) — both are plain scheduling/config
  tables with no money attached to a specific row.
- `PATCH /api/rooms/:id/price` and all `holidays` writes are admin-only
  (mirrors `cancellation-policy`'s exact split: broadly readable, admin-only
  writes). Mandatory server-side checks; client-side gating is UX only.
- All dates in this feature are plain `YYYY-MM-DD` strings, consistent with
  `bookings.check_in`/`check_out` and `cancellation_policy_tier` elsewhere
  in the codebase — no time-of-day, no timezone offset stored.

## 3. Data Model

### 3.1 `rooms.price_weekday` / `rooms.price_weekend` (new columns)

```sql
ALTER TABLE rooms ADD COLUMN price_weekday INTEGER;
ALTER TABLE rooms ADD COLUMN price_weekend INTEGER;
```

Both nullable, VNĐ integers. `NULL` means "not yet configured for this
room" — see the fallback rule in Global Constraints. No default value is
seeded by the migration (per the Out of Scope note above); every existing
room starts with both columns `NULL`.

### 3.2 `holidays` (new table)

```sql
CREATE TABLE holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_holidays_range ON holidays(start_date, end_date);
```

Shape mirrors `cancellation_policy_tier` (migration `0009`): a flat list of
rows, `updated_by`/`updated_at` stamped on every write, no `is_active`
flag — a holiday that's no longer wanted is hard-deleted, not deactivated.

## 4. Pricing Formula

New shared server module `lib/roomPricing.js`:

```js
import { ROOM_TYPES } from './roomTypes.js';

function isWeekendDow(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 5 || dow === 6; // Sun, Fri, Sat
}

function isHolidayDate(dateStr, holidays) {
  return holidays.some((h) => dateStr >= h.startDate && dateStr <= h.endDate);
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function priceForNight(dateStr, room, holidays) {
  const isWeekend = isWeekendDow(dateStr) || isHolidayDate(dateStr, holidays);
  const fallback = ROOM_TYPES[room.roomType].priceVnd;
  const configured = isWeekend ? room.priceWeekend : room.priceWeekday;
  return configured != null ? configured : fallback;
}

export function computeRoomTotal(startDate, endDate, room, holidays) {
  let total = 0;
  let d = startDate;
  while (d < endDate) {
    total += priceForNight(d, room, holidays);
    d = addDays(d, 1);
  }
  return total;
}
```

`room` is `{ roomType, priceWeekday, priceWeekend }` — `priceWeekday`/
`priceWeekend` may be `null` (unconfigured room, or a `room_id`-less
booking that never resolved to a specific room; both cases fall back to
the flat rate for every night uniformly, which is the existing
pre-this-spec behavior).

`computeRoomTotal(startDate, endDate, ...)` sums every night in
`[startDate, endDate)` — callers pass either a booking's full
`check_in`/`check_out` (checkout settlement) or a report-clamped
sub-range (dashboard month summary); the function itself has no notion of
"whole stay" vs. "clamped" — that distinction lives entirely in what its
caller passes as `startDate`/`endDate`.

### 4.1 `functions/api/bookings/[id]/check-out.js`

Current (line 14-16, 34): single-table `SELECT`, then
`const roomTotal = nights * ROOM_TYPES[booking.room_type].priceVnd;`.

New: `SELECT` joins `rooms` for the price columns, and `roomTotal` is
computed night-by-night. Add `import { computeRoomTotal } from '../../../../lib/roomPricing.js';`
alongside the file's existing `ROOM_TYPES` import:

```js
const booking = await env.DB.prepare(
  `SELECT bk.id, bk.status, bk.room_id, bk.room_type, bk.check_in, bk.check_out, bk.guest_name, bk.deposit_amount,
          r.price_weekday AS priceWeekday, r.price_weekend AS priceWeekend
   FROM bookings bk LEFT JOIN rooms r ON r.id = bk.room_id
   WHERE bk.id = ?`
).bind(params.id).first();
// ...
const { results: holidayRows } = await env.DB.prepare(
  `SELECT start_date AS startDate, end_date AS endDate FROM holidays`
).all();
const roomTotal = computeRoomTotal(
  booking.check_in, booking.check_out,
  { roomType: booking.room_type, priceWeekday: booking.priceWeekday, priceWeekend: booking.priceWeekend },
  holidayRows
);
```

The `nights` variable is no longer used for the money calculation, but
stays if anything else in the file still reads a plain night count (it
doesn't, per the current file — it can be removed). Everything downstream
of `roomTotal` (deposit application, `roomDue`/`servicesDue`/
`refundAmount`, the finance-transaction inserts, `needsPaymentMethod`) is
unchanged — only how `roomTotal` itself is computed changes.

### 4.2 `lib/dashboardMetrics.js`

Current `getMonthSummary` (lines 68-88) selects `room_type` only and does
`roomRevenueVnd += nights * ROOM_TYPES[b.roomType].priceVnd`. New: join
`rooms` for the price columns, fetch `holidays` once per call (outside the
loop — same list applies to every booking), and change `nightsInRange` to
also return the clamped boundaries so the revenue sum can walk the same
clamped window `occupiedNights` already uses. Add
`import { computeRoomTotal } from './roomPricing.js';` alongside the
file's existing `ROOM_TYPES` import:

```js
function nightsInRange(checkIn, checkOut, rangeStart, rangeEnd) {
  const clampedStart = checkIn > rangeStart ? checkIn : rangeStart;
  const clampedEnd = checkOut < rangeEnd ? checkOut : rangeEnd;
  const nights = (Date.parse(clampedEnd) - Date.parse(clampedStart)) / 86400000;
  return { nights: nights > 0 ? nights : 0, clampedStart, clampedEnd };
}

export async function getMonthSummary(env, month) {
  const { start, end } = monthBounds(month);
  const daysInMonth = (Date.parse(end) - Date.parse(start)) / 86400000;

  const activeRoomsRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE is_active = 1`).first();
  const activeRoomsCount = activeRoomsRow.c;

  const { results: overlapping } = await env.DB.prepare(
    `SELECT bk.status, bk.source, bk.room_type AS roomType, bk.check_in AS checkIn, bk.check_out AS checkOut,
            r.price_weekday AS priceWeekday, r.price_weekend AS priceWeekend
     FROM bookings bk LEFT JOIN rooms r ON r.id = bk.room_id
     WHERE bk.check_in < ? AND bk.check_out > ?`
  ).bind(end, start).all();

  const { results: holidayRows } = await env.DB.prepare(
    `SELECT start_date AS startDate, end_date AS endDate FROM holidays`
  ).all();

  const statusFunnel = { pending: 0, confirmed: 0, checked_in: 0, checked_out: 0, cancelled: 0 };
  const sourceBreakdown = { website: 0, phone: 0, zalo: 0, walk_in: 0 };
  let occupiedNights = 0;
  let roomRevenueVnd = 0;

  for (const b of overlapping) {
    statusFunnel[b.status]++;
    if (b.status !== 'cancelled') {
      sourceBreakdown[b.source]++;
    }
    if (b.status === 'confirmed' || b.status === 'checked_in' || b.status === 'checked_out') {
      const { nights, clampedStart, clampedEnd } = nightsInRange(b.checkIn, b.checkOut, start, end);
      occupiedNights += nights;
      roomRevenueVnd += computeRoomTotal(
        clampedStart, clampedEnd,
        { roomType: b.roomType, priceWeekday: b.priceWeekday, priceWeekend: b.priceWeekend },
        holidayRows
      );
    }
  }
  // ... rest unchanged (occupancyRate, adrVnd, serviceRevenueVnd, totalRevenueVnd)
}
```

`getTodaySnapshot` (lines 3-43) does not compute any VNĐ amount — untouched.

### 4.3 `admin/reception.js` (client duplicate)

This codebase hand-duplicates server constants on the client rather than
sharing imports (established convention — `ROOM_TYPE_PRICES`,
`daysBeforeCheckin`). `ROOM_TYPE_PRICES` (lines 14-21) and
`computeCheckoutPreview` (lines 983-996) get the same treatment:

- On page load (in the existing `(async () => {...})()` init block
  alongside the `/api/auth/me` fetch), also fetch `/api/rooms` (extended,
  §5.1) and `/api/holidays`, caching both module-level:
  `let cachedRooms = []; let cachedHolidays = [];`.
- Hand-duplicate `priceForNight`/`computeRoomTotal` from §4 as plain
  functions in this file (same isWeekendDow/isHolidayDate/addDays logic).
- `computeCheckoutPreview(booking)` looks up `cachedRooms.find(r => r.id === booking.roomId)`
  (booking objects from `GET /api/bookings` already carry `roomId` —
  confirmed at `functions/api/bookings/index.js:120`) to get that room's
  `priceWeekday`/`priceWeekend`, falling back to `ROOM_TYPE_LABELS`'s
  sibling `ROOM_TYPE_PRICES[booking.roomType]` flat map when
  `booking.roomId` is null or the room isn't found (mirrors the server's
  `LEFT JOIN` fallback behavior), then calls the duplicated
  `computeRoomTotal(booking.checkIn, booking.checkOut, room, cachedHolidays)`
  in place of the current `nights * (ROOM_TYPE_PRICES[booking.roomType] || 0)`
  line. `ROOM_TYPE_PRICES` itself is kept as the client-side fallback
  table, unchanged.
- `cachedRooms`/`cachedHolidays` refresh on every `refreshAll()` cycle
  (the reception board's existing periodic-refresh entry point) — no
  separate invalidation hook is needed since there's no specific
  server error this staleness could soft-lock behind (unlike the
  cancellation-tier cache, which guarded a payment-method validation
  path); a room's price or a holiday range changing mid-session is a rare
  admin action, and the next periodic refresh naturally picks it up.

## 5. API

### 5.1 `GET /api/rooms` (extended)

`functions/api/rooms/index.js` — both response branches (bare status map,
date-scoped occupancy map) add `priceWeekday`/`priceWeekend` to the room
row it already selects and maps:

```js
const { results: rooms } = await env.DB.prepare(
  `SELECT id, name, room_type AS roomType, needs_cleaning AS needsCleaning,
          price_weekday AS priceWeekday, price_weekend AS priceWeekend
   FROM rooms WHERE is_active = 1 ORDER BY display_order, id`
).all();
```

Both `mapped` array-builders (no-`date` branch and `date`-scoped branch)
add `priceWeekday: r.priceWeekday, priceWeekend: r.priceWeekend` to each
returned room object. Auth requirement (`['reception', 'manager', 'admin', 'observer']`)
is unchanged — this is read access, same broad audience as today.

### 5.2 `PATCH /api/rooms/:id/price` (new)

New file `functions/api/rooms/[id]/price.js`.

- Auth: `admin` only.
- Body: `{ priceWeekday: number|null, priceWeekend: number|null }`.
- 404 if the room doesn't exist.
- Each provided field, if not `null`, must be a positive integer (400
  otherwise); `null` is valid and means "clear this tier back to the
  flat `room_type` fallback." A field omitted from the body leaves that
  column unchanged (same partial-update convention as
  `cancellation-policy/[id].js`'s `PATCH`).
- `UPDATE rooms SET price_weekday = ?, price_weekend = ? WHERE id = ?`.
  No `audit_log` entry (matches `rooms/reorder.js`'s own precedent — this
  codebase has no fixed audit-log convention for `rooms`-table writes;
  `reorder.js` logs to its own dedicated `room_layout_log` instead, which
  is out of scope here).
- Response: `{ ok: true }`.

### 5.3 `holidays` CRUD (new) — mirrors `cancellation-policy` exactly

New files `functions/api/holidays/index.js` and
`functions/api/holidays/[id].js`, structurally identical to
`functions/api/cancellation-policy/index.js` and `/[id].js`:

**`GET /api/holidays`** — auth `['reception', 'manager', 'admin', 'observer']`.
```sql
SELECT id, name, start_date AS startDate, end_date AS endDate
FROM holidays ORDER BY start_date
```

**`POST /api/holidays`** — auth `admin` only. Body: `{ name, startDate, endDate }`.
- `name`: non-empty string (400 otherwise).
- `startDate`/`endDate`: `YYYY-MM-DD` strings, `endDate >= startDate`
  (400 otherwise — reuse this codebase's existing date-string comparison
  convention, no `Date` parsing needed since ISO date strings compare
  lexicographically).
- `INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)`.
- Response: `{ ok: true }`, 201.
- Deliberately no overlap check — overlapping holiday ranges are harmless
  to the pricing formula (`isHolidayDate` is an OR across every range).

**`PATCH /api/holidays/:id`** — auth `admin` only, same partial-update /
same validation as `POST`, 404 if missing.

**`DELETE /api/holidays/:id`** — auth `admin` only, 404 if missing,
`DELETE FROM holidays WHERE id = ?`, 204. Genuine hard delete — no
`voided_at`, no `audit_log` entry (§2).

## 6. Admin UI

One new combined page, `admin/rooms.html` + `admin/rooms.js` ("Quản lý
phòng"), holding both the per-room pricing table and the holiday-CRUD
section — per explicit correction during design ("trang cấu hình 'Ngày
lễ' nên bố trí chung với trang 'Quản lý phòng' nhé") — not two separate
pages.

- **Nav entry:** added to the existing "Cấu hình & Quản trị" group in
  `admin/nav-drawer.js`, `roles: ['reception', 'manager', 'admin', 'observer']`
  — broad read, matching `cancellation-policy.html`'s and `catalog.html`'s
  precedent (reception/manager benefit from seeing current prices and
  upcoming holiday dates as reference when quoting guests), not
  `finance-categories.html`/`dine-in-menu.html`'s admin-only pattern
  (those hide config that's meaningless to non-admins to see at all;
  room prices and holiday dates are meaningful to see, just not to edit).
- **Access control:** follows `cancellation-policy.js`'s exact idiom —
  the page's init block redirects to `/admin` only if `/api/auth/me`
  itself fails (not logged in at all); every authenticated role can view
  the page. Admin-only controls (price-edit inputs, the holiday
  add/edit form, "Sửa"/"Xoá" buttons) are shown only when
  `currentRole === 'admin'` — confirmed by reading both
  `cancellation-policy.js` (no redirect, `if (currentRole === 'admin')`
  gates around the add button and the per-row actions cell) and
  `dine-in-menu.js` (same shape: redirects only on failed auth, gates
  add-forms on `currentRole === 'admin'`) — this is the established
  pattern for every broadly-readable, admin-edit config page in this
  codebase, not a new decision.
- **Room pricing section:** a table, one row per active room (from
  `GET /api/rooms`, no `date` query param — the bare status-map branch,
  extended per §5.1), columns: Tên phòng, Loại phòng (label via the
  existing `ROOM_TYPE_LABELS`-equivalent lookup), Giá T2–T5, Giá T6–CN,
  and (admin only) an "Sửa" button per row. Clicking "Sửa" reveals two
  number inputs inline for that row (pre-filled with the room's current
  values, or blank/placeholder "Theo loại phòng" when `null`), with
  Lưu/Huỷ — `Lưu` sends `PATCH /api/rooms/:id/price` with both fields
  (blank input serializes to `null`), then reloads the rooms list.
- **Holidays section:** structurally identical to
  `cancellation-policy.html`'s tier table — a list table (Tên ngày lễ,
  Từ ngày, Đến ngày, admin-only Sửa/Xoá actions column) plus a single
  add/edit `<form>` toggled via `.hidden`, using the exact
  `resetForm`/`openEditForm` pattern from `cancellation-policy.js`
  (§ read in full as this feature's direct template): an "+ Thêm ngày
  lễ" button reveals the blank form, "Sửa" pre-fills it with that
  holiday's `id`/`name`/`startDate`/`endDate` and repoints the submit to
  `PATCH`, submit does `POST`/`PATCH` to `/api/holidays[/:id]` depending
  on whether the hidden `id` field is set, "Xoá" calls
  `DELETE /api/holidays/:id` directly with no confirm dialog (matching
  `cancellation-policy.js`'s own `deleteTier`, which has none either —
  consistency with the direct precedent this section is copied from).

## 7. Testing

- **`lib/roomPricing.js` unit tests** (new `test/roomPricing.test.js`):
  `priceForNight` — weekday date with configured price, weekend date with
  configured price, `NULL`-configured tier falls back to
  `ROOM_TYPES[...].priceVnd`, a date inside a holiday range on an
  otherwise-weekday date resolves to the weekend price, a date outside
  any holiday range on a weekday resolves to the weekday price.
  `computeRoomTotal` — a stay spanning only weekdays, a stay spanning
  only the weekend, a stay crossing from weekday into weekend nights
  (sums correctly, not `nights × either price`), a stay whose middle
  night falls inside a holiday range while its other nights don't, a
  1-night stay, a 0-night edge case (`startDate === endDate` sums to 0).
- **`functions/api/rooms/[id]/price.js`** (new, extend
  `test/roomsEndpoints.test.js`): admin can set both fields; admin can
  set one field and leave the other unchanged; admin can clear a field
  back to `null`; non-admin gets 403; a negative or non-integer price
  gets 400; unknown room id gets 404.
- **`GET /api/rooms`** (extend `test/roomsEndpoints.test.js`): response
  rows include `priceWeekday`/`priceWeekend`, both `null` before any
  `PATCH`, both reflecting the last `PATCH` after one.
- **`holidays` CRUD** (new `test/holidaysEndpoints.test.js`, structured
  like `test/cancellationPolicyEndpoints.test.js`): admin can create,
  update, delete; non-admin gets 403 on write, 200 on read; `endDate`
  before `startDate` gets 400; empty `name` gets 400; unknown id gets
  404 on `PATCH`/`DELETE`; `DELETE` performs a real row removal (a
  second `DELETE` on the same id then 404s) and writes no `audit_log`
  row.
- **`functions/api/bookings/[id]/check-out.js`** (extend
  `test/bookingLifecycle.test.js`'s existing checkout describe block):
  a booking on a room with configured weekday/weekend prices whose stay
  crosses the weekend boundary settles at the correct summed total
  (not the old `nights × flat` figure); a booking on a room with `NULL`
  prices still settles at the old flat-rate figure (fallback
  correctness); a stay whose one night falls inside an admin-defined
  holiday range bills that night at the weekend rate even though it
  falls on a weekday.
- **`lib/dashboardMetrics.js`** (extend `test/dashboardMetrics.test.js`):
  a booking entirely inside the reported month with mixed weekday/weekend
  nights sums `roomRevenueVnd` correctly; a booking that starts before
  the month and is clamped at the month boundary sums only the
  in-month nights at each night's own correct rate (the month-boundary
  correctness case this refactor is riskiest for); a holiday range
  affects `roomRevenueVnd` inside the reported month.
- **e2e** (outer repo, new coverage in a `reception-ops-board.spec.js`-
  adjacent file or a new `admin-rooms.spec.js`): the "Quản lý phòng" page
  is reachable from the nav drawer for every role; price-edit and
  holiday add/edit/delete controls are absent for non-admin and present
  for admin; editing a room's price and reloading shows the new value;
  adding a holiday, then reloading the reception board's checkout
  preview for a stay overlapping that date, reflects the weekend rate.
