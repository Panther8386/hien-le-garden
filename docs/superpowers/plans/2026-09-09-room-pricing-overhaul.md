# Room Pricing Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `nights × ROOM_TYPES[room_type].priceVnd` room pricing with per-room, two-tier (weekday/weekend) night-by-night pricing, plus an admin-managed holiday calendar that bills holiday nights at the weekend rate.

**Architecture:** A new `rooms.price_weekday`/`price_weekend` column pair (nullable, falls back to the existing flat `lib/roomTypes.js` rate) and a new `holidays` table (date ranges) back a shared server-side pricing function (`lib/roomPricing.js`) that every money-computing call site — checkout settlement, the dashboard's month revenue — sums night-by-night instead of multiplying. A hand-duplicated client copy of the same logic drives the reception checkout preview. One new combined admin page ("Quản lý phòng") lets an admin edit both per-room prices and the holiday calendar.

**Tech Stack:** Cloudflare Pages Functions + D1 (SQLite), vanilla JS admin frontend (no build step), Vitest + `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-09-09-room-pricing-overhaul-design.md`

## Global Constraints

- Every room's `price_weekday`/`price_weekend` may be `NULL` independently. Whenever a tier's column is `NULL` for a room, fall back to that room's `room_type`'s flat `ROOM_TYPES[roomType].priceVnd` (`lib/roomTypes.js`) for nights resolving to that tier. `lib/roomTypes.js` is not deleted — it is the fallback source.
- Pricing is computed **night by night**, never `nights × single price`, everywhere a stay becomes a VNĐ amount.
- Holidays are admin-managed **date ranges** (`start_date`..`end_date`, inclusive). A night whose calendar date falls inside any holiday range bills at the weekend rate regardless of actual day of week.
- Weekday tier = Monday–Thursday. Weekend tier = Friday–Sunday, or any date inside a holiday range.
- `holidays` writes are genuine hard `DELETE`/plain `UPDATE` — no void-and-keep, no `audit_log` entry on any of `POST`/`PATCH`/`DELETE` (mirrors the one existing precedent, `cancellation_policy_tier`).
- `PATCH /api/rooms/:id/price` and all `holidays` writes are admin-only. Mandatory server-side checks; client-side gating is UX only.
- All dates in this feature are plain `YYYY-MM-DD` strings — no time-of-day, no timezone offset stored.
- Seeding real prices for the 16 existing rooms is **not part of this plan** — every room's `price_weekday`/`price_weekend` starts `NULL`; the admin enters real values later through the UI this plan builds.

---

### Task 1: Migration 0037 — room price columns + `holidays` table

**Files:**
- Create: `migrations/0037_room_pricing.sql`
- Test: `test/migrations.test.js` (extend)

**Interfaces:**
- Produces: `rooms.price_weekday INTEGER` (nullable), `rooms.price_weekend INTEGER` (nullable); `holidays` table with columns `id, name, start_date, end_date, updated_by, updated_at`.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0037_room_pricing.sql
ALTER TABLE rooms ADD COLUMN price_weekday INTEGER;
ALTER TABLE rooms ADD COLUMN price_weekend INTEGER;

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

- [ ] **Step 2: Write the failing tests**

Append to `test/migrations.test.js` (follow the exact style of the
`describe('migration 0036', ...)` block immediately above it in the same
file):

```javascript
describe('migration 0037', () => {
  it('adds price_weekday and price_weekend to rooms, defaulting to NULL', async () => {
    const room = await env.DB.prepare(`SELECT id, price_weekday, price_weekend FROM rooms LIMIT 1`).first();
    expect(room.price_weekday).toBeNull();
    expect(room.price_weekend).toBeNull();
  });

  it('creates the holidays table', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES ('Tết Dương lịch', '2027-01-01', '2027-01-01', 'system', '2026-09-09T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT name, start_date, end_date FROM holidays WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ name: 'Tết Dương lịch', start_date: '2027-01-01', end_date: '2027-01-01' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/migrations.test.js -t "migration 0037"`
Expected: FAIL — no such column `price_weekday` / no such table `holidays`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/migrations.test.js -t "migration 0037"`
Expected: PASS (2 tests). The test harness auto-discovers migration files
from `migrations/` (`vitest.config.js`'s `readD1Migrations`), so no other
wiring is needed for the migration itself to apply in tests.

- [ ] **Step 5: Commit**

```bash
git add migrations/0037_room_pricing.sql test/migrations.test.js
git commit -m "feat: add room_weekday/weekend prices and holidays table (migration 0037)"
```

---

### Task 2: `lib/roomPricing.js` — the shared night-by-night pricing formula

**Files:**
- Create: `lib/roomPricing.js`
- Test: `test/roomPricing.test.js` (new)

**Interfaces:**
- Consumes: `ROOM_TYPES` from `lib/roomTypes.js` (existing, unchanged).
- Produces: `priceForNight(dateStr, room, holidays)` and
  `computeRoomTotal(startDate, endDate, room, holidays)`, where `room` is
  `{ roomType, priceWeekday, priceWeekend }` (`priceWeekday`/
  `priceWeekend` may be `null`) and `holidays` is an array of
  `{ startDate, endDate }` (both `YYYY-MM-DD` strings, inclusive range).
  Every later task that computes a room charge imports these two named
  exports from `../lib/roomPricing.js` (adjust relative depth per file).

- [ ] **Step 1: Write the failing tests**

```javascript
// test/roomPricing.test.js
import { describe, it, expect } from 'vitest';
import { priceForNight, computeRoomTotal } from '../lib/roomPricing.js';

const configuredRoom = { roomType: 'vip', priceWeekday: 700000, priceWeekend: 900000 };
const unconfiguredRoom = { roomType: 'vip', priceWeekday: null, priceWeekend: null };
const noHolidays = [];

describe('priceForNight', () => {
  it('uses the configured weekday price for a Monday–Thursday date', () => {
    // 2026-09-08 is a Tuesday
    expect(priceForNight('2026-09-08', configuredRoom, noHolidays)).toBe(700000);
  });

  it('uses the configured weekend price for a Friday–Sunday date', () => {
    // 2026-09-11 is a Friday
    expect(priceForNight('2026-09-11', configuredRoom, noHolidays)).toBe(900000);
    // 2026-09-13 is a Sunday
    expect(priceForNight('2026-09-13', configuredRoom, noHolidays)).toBe(900000);
  });

  it('falls back to ROOM_TYPES flat price when the room has no configured price for that tier', () => {
    // 2026-09-08 is a Tuesday (weekday tier); vip flat rate is 900000
    expect(priceForNight('2026-09-08', unconfiguredRoom, noHolidays)).toBe(900000);
    // 2026-09-11 is a Friday (weekend tier); vip flat rate is still 900000
    expect(priceForNight('2026-09-11', unconfiguredRoom, noHolidays)).toBe(900000);
  });

  it('bills a holiday date at the weekend rate even when it falls on a weekday', () => {
    // 2026-09-08 is a Tuesday; put it inside a holiday range
    const holidays = [{ startDate: '2026-09-07', endDate: '2026-09-09' }];
    expect(priceForNight('2026-09-08', configuredRoom, holidays)).toBe(900000);
  });

  it('does not apply the holiday rate to a date outside every holiday range', () => {
    const holidays = [{ startDate: '2026-09-01', endDate: '2026-09-02' }];
    expect(priceForNight('2026-09-08', configuredRoom, holidays)).toBe(700000);
  });
});

describe('computeRoomTotal', () => {
  it('sums a stay that only spans weekday nights', () => {
    // Mon 2026-09-07 check-in .. Fri 2026-09-11 check-out = 4 nights, all Mon–Thu
    expect(computeRoomTotal('2026-09-07', '2026-09-11', configuredRoom, noHolidays)).toBe(4 * 700000);
  });

  it('sums a stay that only spans weekend nights', () => {
    // Fri 2026-09-11 check-in .. Mon 2026-09-14 check-out = 3 nights, Fri/Sat/Sun
    expect(computeRoomTotal('2026-09-11', '2026-09-14', configuredRoom, noHolidays)).toBe(3 * 900000);
  });

  it('sums a stay crossing from weekday into weekend nights at each night\'s own rate', () => {
    // Thu 2026-09-10 check-in .. Sat 2026-09-12 check-out = 2 nights: Thu (weekday), Fri (weekend)
    expect(computeRoomTotal('2026-09-10', '2026-09-12', configuredRoom, noHolidays)).toBe(700000 + 900000);
  });

  it('bills a holiday night inside an otherwise-weekday stay at the weekend rate', () => {
    // Mon 2026-09-07 .. Thu 2026-09-10 = 3 nights: Mon, Tue, Wed; Tue is a holiday
    const holidays = [{ startDate: '2026-09-08', endDate: '2026-09-08' }];
    expect(computeRoomTotal('2026-09-07', '2026-09-10', configuredRoom, holidays)).toBe(700000 + 900000 + 700000);
  });

  it('sums a 1-night stay as exactly one night', () => {
    expect(computeRoomTotal('2026-09-07', '2026-09-08', configuredRoom, noHolidays)).toBe(700000);
  });

  it('returns 0 for a 0-night range', () => {
    expect(computeRoomTotal('2026-09-07', '2026-09-07', configuredRoom, noHolidays)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/roomPricing.test.js`
Expected: FAIL — `lib/roomPricing.js` does not exist.

- [ ] **Step 3: Write the implementation**

```javascript
// lib/roomPricing.js
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/roomPricing.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/roomPricing.js test/roomPricing.test.js
git commit -m "feat: add night-by-night room pricing formula (lib/roomPricing.js)"
```

---

### Task 3: `PATCH /api/rooms/:id/price` + `GET /api/rooms` price fields

**Files:**
- Create: `functions/api/rooms/[id]/price.js`
- Modify: `functions/api/rooms/index.js`
- Test: `test/roomsEndpoints.test.js` (extend)

**Interfaces:**
- Consumes: `requireAuth` from `../../../../lib/requireAuth.js` (existing;
  see `functions/api/rooms/[id]/clean.js` for the exact 4-level-up import
  depth this new sibling file uses).
- Produces: `PATCH /api/rooms/:id/price` accepting
  `{ priceWeekday: number|null, priceWeekend: number|null }` (either field
  omittable — omitted means "leave unchanged"); `GET /api/rooms` response
  rows gain `priceWeekday`/`priceWeekend` (both branches).

- [ ] **Step 1: Write the failing tests**

Add to `test/roomsEndpoints.test.js`, just after the existing
`describe('GET /api/rooms', ...)` block's closing `});` (around line 134)
add the import at the top of the file alongside the other route imports:

```javascript
import { onRequestPatch as setRoomPrice } from '../functions/api/rooms/[id]/price.js';
```

Then add these tests inside the existing `describe('GET /api/rooms', () => { ... })` block (append before its closing `});`):

```javascript
  it('returns priceWeekday/priceWeekend as null before any price is set', async () => {
    const response = await listRooms({ request: authedRequest('https://x/api/rooms'), env });
    const body = await response.json();
    expect(body.every((r) => r.priceWeekday === null && r.priceWeekend === null)).toBe(true);
  });

  it('reflects a room\'s configured price in both the bare and date-scoped response', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'vip' ORDER BY id LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(room.id).run();

    const bare = await listRooms({ request: authedRequest('https://x/api/rooms'), env }).then((r) => r.json());
    expect(bare.find((r) => r.id === room.id)).toMatchObject({ priceWeekday: 700000, priceWeekend: 900000 });

    const scoped = await listRooms({ request: authedRequest('https://x/api/rooms?date=2026-09-11'), env }).then((r) => r.json());
    expect(scoped.find((r) => r.id === room.id)).toMatchObject({ priceWeekday: 700000, priceWeekend: 900000 });
  });
```

Add a new `describe` block at the end of the file, before the final
closing of the file:

```javascript
describe('PATCH /api/rooms/:id/price', () => {
  it('lets an admin set both prices', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    const response = await setRoomPrice({
      request: authedBody(`https://x/api/rooms/${room.id}/price`, adminToken, 'PATCH', { priceWeekday: 700000, priceWeekend: 900000 }),
      env,
      params: { id: String(room.id) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT price_weekday, price_weekend FROM rooms WHERE id = ?`).bind(room.id).first();
    expect(row).toEqual({ price_weekday: 700000, price_weekend: 900000 });
  });

  it('leaves a field unchanged when omitted from the body', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(room.id).run();
    await setRoomPrice({
      request: authedBody(`https://x/api/rooms/${room.id}/price`, adminToken, 'PATCH', { priceWeekday: 750000 }),
      env,
      params: { id: String(room.id) },
    });
    const row = await env.DB.prepare(`SELECT price_weekday, price_weekend FROM rooms WHERE id = ?`).bind(room.id).first();
    expect(row).toEqual({ price_weekday: 750000, price_weekend: 900000 });
  });

  it('clears a price back to null when the field is explicitly sent as null', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(room.id).run();
    await setRoomPrice({
      request: authedBody(`https://x/api/rooms/${room.id}/price`, adminToken, 'PATCH', { priceWeekday: null, priceWeekend: null }),
      env,
      params: { id: String(room.id) },
    });
    const row = await env.DB.prepare(`SELECT price_weekday, price_weekend FROM rooms WHERE id = ?`).bind(room.id).first();
    expect(row).toEqual({ price_weekday: null, price_weekend: null });
  });

  it('rejects a non-admin (403)', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    const response = await setRoomPrice({
      request: authedBody(`https://x/api/rooms/${room.id}/price`, managerToken, 'PATCH', { priceWeekday: 700000 }),
      env,
      params: { id: String(room.id) },
    });
    expect(response.status).toBe(403);
  });

  it('rejects a negative price (400)', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    const response = await setRoomPrice({
      request: authedBody(`https://x/api/rooms/${room.id}/price`, adminToken, 'PATCH', { priceWeekday: -1 }),
      env,
      params: { id: String(room.id) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a non-integer price (400)', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    const response = await setRoomPrice({
      request: authedBody(`https://x/api/rooms/${room.id}/price`, adminToken, 'PATCH', { priceWeekend: 12.5 }),
      env,
      params: { id: String(room.id) },
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent room', async () => {
    const response = await setRoomPrice({
      request: authedBody('https://x/api/rooms/999999/price', adminToken, 'PATCH', { priceWeekday: 700000 }),
      env,
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms LIMIT 1`).first();
    const response = await setRoomPrice({
      request: new Request(`https://x/api/rooms/${room.id}/price`, { method: 'PATCH', body: JSON.stringify({ priceWeekday: 700000 }) }),
      env,
      params: { id: String(room.id) },
    });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/roomsEndpoints.test.js`
Expected: FAIL — `functions/api/rooms/[id]/price.js` does not exist;
`priceWeekday`/`priceWeekend` are `undefined` in `GET /api/rooms`
responses.

- [ ] **Step 3: Write the implementation**

`functions/api/rooms/index.js` — replace the single `SELECT` (lines
10-12) and both `mapped` builders:

```javascript
// functions/api/rooms/index.js
import { requireAuth } from '../../../lib/requireAuth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  const { results: rooms } = await env.DB.prepare(
    `SELECT id, name, room_type AS roomType, needs_cleaning AS needsCleaning, price_weekday AS priceWeekday, price_weekend AS priceWeekend
     FROM rooms WHERE is_active = 1 ORDER BY display_order, id`
  ).all();

  if (!date) {
    const { results: occupiedRows } = await env.DB.prepare(
      `SELECT DISTINCT room_id FROM bookings WHERE status = 'checked_in' AND room_id IS NOT NULL`
    ).all();
    const occupiedIds = new Set(occupiedRows.map((r) => r.room_id));

    const mapped = rooms.map((r) => ({
      id: r.id,
      name: r.name,
      roomType: r.roomType,
      status: r.needsCleaning ? 'needs_cleaning' : occupiedIds.has(r.id) ? 'occupied' : 'empty',
      priceWeekday: r.priceWeekday,
      priceWeekend: r.priceWeekend,
    }));

    return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const { results: overlapping } = await env.DB.prepare(
    `SELECT room_id, status, deposit_amount FROM bookings
     WHERE room_id IS NOT NULL AND status != 'cancelled' AND check_in <= ? AND ? < check_out`
  ).bind(date, date).all();
  const bookingByRoom = new Map(overlapping.map((b) => [b.room_id, b]));

  const mapped = rooms.map((r) => {
    const booking = bookingByRoom.get(r.id);
    let status;
    if (!booking) {
      status = 'empty';
    } else if (booking.status === 'checked_in') {
      status = 'occupied';
    } else if (booking.status === 'checked_out') {
      status = 'used';
    } else if (booking.deposit_amount > 0) {
      status = 'booked_deposited';
    } else {
      status = 'booked';
    }
    return {
      id: r.id,
      name: r.name,
      roomType: r.roomType,
      status,
      needsCleaning: !!r.needsCleaning,
      priceWeekday: r.priceWeekday,
      priceWeekend: r.priceWeekend,
    };
  });

  return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

New `functions/api/rooms/[id]/price.js`:

```javascript
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function isValidPrice(value) {
  return value === null || (Number.isInteger(value) && value >= 0);
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT price_weekday, price_weekend FROM rooms WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy phòng', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }

  const priceWeekday = body.priceWeekday !== undefined ? body.priceWeekday : existing.price_weekday;
  const priceWeekend = body.priceWeekend !== undefined ? body.priceWeekend : existing.price_weekend;

  if (!isValidPrice(priceWeekday) || !isValidPrice(priceWeekend)) {
    return jsonError('Giá phòng phải là số nguyên không âm hoặc để trống', 400);
  }

  await env.DB.prepare(`UPDATE rooms SET price_weekday = ?, price_weekend = ? WHERE id = ?`)
    .bind(priceWeekday, priceWeekend, params.id)
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/roomsEndpoints.test.js`
Expected: PASS (all existing tests still pass + new ones).

- [ ] **Step 5: Commit**

```bash
git add functions/api/rooms/index.js functions/api/rooms/[id]/price.js test/roomsEndpoints.test.js
git commit -m "feat: add PATCH /api/rooms/:id/price, extend GET /api/rooms with price fields"
```

---

### Task 4: `holidays` CRUD

**Files:**
- Create: `functions/api/holidays/index.js`
- Create: `functions/api/holidays/[id].js`
- Test: `test/holidaysEndpoints.test.js` (new)

**Interfaces:**
- Consumes: `requireAuth` from `../../../lib/requireAuth.js`;
  `createSession` from `../lib/auth.js` (test only).
- Produces: `GET /api/holidays` → `[{ id, name, startDate, endDate }]`
  ordered by `startDate`; `POST /api/holidays` (admin) → `201 { ok: true }`;
  `PATCH /api/holidays/:id` (admin) → `200 { ok: true }`;
  `DELETE /api/holidays/:id` (admin) → `204`. Later tasks (client) read
  `startDate`/`endDate` from the `GET` response.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/holidaysEndpoints.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getHolidays, onRequestPost as postHoliday } from '../functions/api/holidays/index.js';
import { onRequestPatch as patchHoliday, onRequestDelete as deleteHoliday } from '../functions/api/holidays/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM holidays');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_hd', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_hd', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_hd', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_hd', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  await env.DB.prepare(
    `INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES ('Tết Nguyên Đán', '2027-02-06', '2027-02-10', 'seed', '2026-08-01T00:00:00Z')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES ('Quốc khánh', '2026-09-02', '2026-09-02', 'seed', '2026-08-01T00:00:00Z')`
  ).run();
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/holidays', () => {
  it('lets reception view holidays, ordered by start date', async () => {
    const response = await getHolidays({ request: authedRequest('https://x/api/holidays', receptionToken, 'GET'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.map((h) => h.name)).toEqual(['Quốc khánh', 'Tết Nguyên Đán']);
  });

  it('lets observer view holidays', async () => {
    const response = await getHolidays({ request: authedRequest('https://x/api/holidays', observerToken, 'GET'), env });
    expect(response.status).toBe(200);
  });

  it('rejects no session (401)', async () => {
    const response = await getHolidays({ request: new Request('https://x/api/holidays'), env });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/holidays', () => {
  it('lets an admin add a holiday', async () => {
    const response = await postHoliday({
      request: authedRequest('https://x/api/holidays', adminToken, 'POST', { name: 'Giỗ Tổ Hùng Vương', startDate: '2027-04-16', endDate: '2027-04-16' }),
      env,
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM holidays WHERE name = 'Giỗ Tổ Hùng Vương'`).first();
    expect(row.start_date).toBe('2027-04-16');
  });

  it('rejects an empty name (400)', async () => {
    const response = await postHoliday({
      request: authedRequest('https://x/api/holidays', adminToken, 'POST', { name: '', startDate: '2027-04-16', endDate: '2027-04-16' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects endDate before startDate (400)', async () => {
    const response = await postHoliday({
      request: authedRequest('https://x/api/holidays', adminToken, 'POST', { name: 'X', startDate: '2027-04-16', endDate: '2027-04-15' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a non-admin (403)', async () => {
    const response = await postHoliday({
      request: authedRequest('https://x/api/holidays', managerToken, 'POST', { name: 'X', startDate: '2027-04-16', endDate: '2027-04-16' }),
      env,
    });
    expect(response.status).toBe(403);
  });
});

describe('PATCH /api/holidays/:id', () => {
  it('lets an admin edit a holiday', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM holidays WHERE name = 'Quốc khánh'`).first();
    const response = await patchHoliday({
      request: authedRequest(`https://x/api/holidays/${existing.id}`, adminToken, 'PATCH', { endDate: '2026-09-03' }),
      env,
      params: { id: String(existing.id) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT end_date FROM holidays WHERE id = ?`).bind(existing.id).first();
    expect(row.end_date).toBe('2026-09-03');
  });

  it('404s for a missing id', async () => {
    const response = await patchHoliday({
      request: authedRequest('https://x/api/holidays/999999', adminToken, 'PATCH', { endDate: '2026-09-03' }),
      env,
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/holidays/:id', () => {
  it('lets an admin delete a holiday (real hard delete)', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM holidays WHERE name = 'Quốc khánh'`).first();
    const response = await deleteHoliday({ request: authedRequest(`https://x/api/holidays/${existing.id}`, adminToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(204);

    const row = await env.DB.prepare(`SELECT id FROM holidays WHERE id = ?`).bind(existing.id).first();
    expect(row).toBeNull();

    const again = await deleteHoliday({ request: authedRequest(`https://x/api/holidays/${existing.id}`, adminToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(again.status).toBe(404);
  });

  it('writes no audit_log row on delete', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM holidays WHERE name = 'Quốc khánh'`).first();
    const before = await env.DB.prepare(`SELECT COUNT(*) AS c FROM audit_log`).first();
    await deleteHoliday({ request: authedRequest(`https://x/api/holidays/${existing.id}`, adminToken, 'DELETE'), env, params: { id: String(existing.id) } });
    const after = await env.DB.prepare(`SELECT COUNT(*) AS c FROM audit_log`).first();
    expect(after.c).toBe(before.c);
  });

  it('rejects reception (403)', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM holidays WHERE name = 'Quốc khánh'`).first();
    const response = await deleteHoliday({ request: authedRequest(`https://x/api/holidays/${existing.id}`, receptionToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/holidaysEndpoints.test.js`
Expected: FAIL — `functions/api/holidays/index.js` and `[id].js` do not exist.

- [ ] **Step 3: Write the implementation**

```javascript
// functions/api/holidays/index.js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function validate(name, startDate, endDate) {
  if (typeof name !== 'string' || name.trim() === '') return 'Tên ngày lễ không được để trống';
  if (typeof startDate !== 'string' || typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return 'Ngày phải theo định dạng YYYY-MM-DD';
  }
  if (endDate < startDate) return 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu';
  return null;
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT id, name, start_date AS startDate, end_date AS endDate FROM holidays ORDER BY start_date`
  ).all();

  return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { name, startDate, endDate } = body;

  const error = validate(name, startDate, endDate);
  if (error) return jsonError(error, 400);

  await env.DB.prepare(
    `INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(name, startDate, endDate, auth.username, new Date().toISOString()).run();

  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

```javascript
// functions/api/holidays/[id].js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function validate(name, startDate, endDate) {
  if (typeof name !== 'string' || name.trim() === '') return 'Tên ngày lễ không được để trống';
  if (typeof startDate !== 'string' || typeof endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return 'Ngày phải theo định dạng YYYY-MM-DD';
  }
  if (endDate < startDate) return 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu';
  return null;
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM holidays WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy ngày lễ', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }

  const name = body.name !== undefined ? body.name : existing.name;
  const startDate = body.startDate !== undefined ? body.startDate : existing.start_date;
  const endDate = body.endDate !== undefined ? body.endDate : existing.end_date;

  const error = validate(name, startDate, endDate);
  if (error) return jsonError(error, 400);

  await env.DB.prepare(
    `UPDATE holidays SET name = ?, start_date = ?, end_date = ?, updated_by = ?, updated_at = ? WHERE id = ?`
  ).bind(name, startDate, endDate, auth.username, new Date().toISOString(), params.id).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT id FROM holidays WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy ngày lễ', 404);

  await env.DB.prepare(`DELETE FROM holidays WHERE id = ?`).bind(params.id).run();
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/holidaysEndpoints.test.js`
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add functions/api/holidays test/holidaysEndpoints.test.js
git commit -m "feat: add holidays CRUD (GET/POST/PATCH/DELETE /api/holidays)"
```

---

### Task 5: Apply the formula to checkout settlement

**Files:**
- Modify: `functions/api/bookings/[id]/check-out.js`
- Test: `test/bookingLifecycle.test.js` (extend the `check-out` describe block)

**Interfaces:**
- Consumes: `computeRoomTotal` from `../../../../lib/roomPricing.js`
  (Task 2).

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('POST /api/bookings/:id/check-out', ...)`
block in `test/bookingLifecycle.test.js` (it already has a
`checkInBookingWithDepositAndServices` helper defined at line ~646 — reuse
it, but these new tests need a helper that also controls the exact
check-in/check-out dates and the room's configured prices, since the
existing helper hardcodes `checkIn = '2099-02-01'` and doesn't set room
prices). Add this new helper and tests right after the existing
`checkInBookingWithDepositAndServices` function definition:

```javascript
  async function checkInBookingWithDates({ roomType, roomId, checkIn, checkOut }) {
    const bookingInsert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, deposit_amount, created_at) VALUES ('Pricing Test Guest', '0900000098', ?, ?, ?, ?, 'checked_in', 'website', 0, ?)`
    ).bind(roomType, roomId, checkIn, checkOut, new Date().toISOString()).run();
    return bookingInsert.meta.last_row_id;
  }

  it('bills a stay crossing weekday into weekend nights at each night\'s own configured rate', async () => {
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(otherCircleRoomId).run();
    // Thu 2026-09-10 check-in .. Sat 2026-09-12 check-out = 2 nights: Thu (weekday=700000), Fri (weekend=900000)
    const bookingId = await checkInBookingWithDates({ roomType: 'circle', roomId: otherCircleRoomId, checkIn: '2026-09-10', checkOut: '2026-09-12' });

    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body.roomDue).toBe(700000 + 900000);
  });

  it('falls back to the flat room-type rate when the room has no configured prices', async () => {
    // otherCircleRoomId has NULL price_weekday/price_weekend by default; circle flat rate is 600000
    const bookingId = await checkInBookingWithDates({ roomType: 'circle', roomId: otherCircleRoomId, checkIn: '2026-09-10', checkOut: '2026-09-12' });

    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body.roomDue).toBe(2 * 600000);
  });

  it('bills a night inside an admin-defined holiday range at the weekend rate even on a weekday', async () => {
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(otherCircleRoomId).run();
    await env.DB.prepare(`INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES ('Test Holiday', '2026-09-08', '2026-09-08', 'seed', '2026-08-01T00:00:00Z')`).run();
    // Mon 2026-09-07 .. Wed 2026-09-09 = 2 nights: Mon (weekday), Tue=holiday (weekend rate)
    const bookingId = await checkInBookingWithDates({ roomType: 'circle', roomId: otherCircleRoomId, checkIn: '2026-09-07', checkOut: '2026-09-09' });

    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body.roomDue).toBe(700000 + 900000);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/bookingLifecycle.test.js -t "check-out"`
Expected: The 3 new tests FAIL (current code still does flat
`nights × ROOM_TYPES[...].priceVnd`, so the weekend-crossing and
holiday cases produce a different total than expected); all pre-existing
checkout tests in this file still PASS.

- [ ] **Step 3: Write the implementation**

`functions/api/bookings/[id]/check-out.js` — add the import, extend the
booking `SELECT` to join `rooms`, fetch `holidays`, and replace the
`nights`/`roomTotal` lines:

```javascript
import { requireAuth } from '../../../../lib/requireAuth.js';
import { ROOM_TYPES } from '../../../../lib/roomTypes.js';
import { computeRoomTotal } from '../../../../lib/roomPricing.js';
```

Replace lines 14-16 (`const booking = await env.DB.prepare(...)`):

```javascript
  const booking = await env.DB.prepare(
    `SELECT bk.id, bk.status, bk.room_id, bk.room_type, bk.check_in, bk.check_out, bk.guest_name, bk.deposit_amount,
            r.price_weekday AS priceWeekday, r.price_weekend AS priceWeekend
     FROM bookings bk LEFT JOIN rooms r ON r.id = bk.room_id
     WHERE bk.id = ?`
  ).bind(params.id).first();
```

Replace lines 33-34 (`const nights = ...` / `const roomTotal = ...`):

```javascript
  const { results: holidayRows } = await env.DB.prepare(
    `SELECT start_date AS startDate, end_date AS endDate FROM holidays`
  ).all();
  const roomTotal = computeRoomTotal(
    booking.check_in, booking.check_out,
    { roomType: booking.room_type, priceWeekday: booking.priceWeekday, priceWeekend: booking.priceWeekend },
    holidayRows
  );
```

The `ROOM_TYPES` import stays (it's still needed indirectly through
`computeRoomTotal`'s fallback — no, `ROOM_TYPES` is only used inside
`lib/roomPricing.js` now, not directly in this file anymore, so remove
the now-unused `import { ROOM_TYPES } from '../../../../lib/roomTypes.js';`
line instead of keeping it — confirm no other reference to `ROOM_TYPES`
remains in this file before removing it (there is none — the only prior
use was the deleted `roomTotal` line)).

Everything else in the file (deposit application, `roomDue`/
`servicesDue`/`refundAmount`, `needsPaymentMethod`, the finance-transaction
inserts, the race-guarded batch) is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/bookingLifecycle.test.js -t "check-out"`
Expected: PASS (all checkout tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add functions/api/bookings/\[id\]/check-out.js test/bookingLifecycle.test.js
git commit -m "feat: bill checkout room total night-by-night using per-room prices"
```

---

### Task 6: Apply the formula to the dashboard's month revenue

**Files:**
- Modify: `lib/dashboardMetrics.js`
- Test: `test/dashboardMetrics.test.js` (extend the `getMonthSummary` describe block)

**Interfaces:**
- Consumes: `computeRoomTotal` from `./roomPricing.js` (Task 2).
- Changes `nightsInRange`'s return type from a bare number to
  `{ nights, clampedStart, clampedEnd }` — this function is private to
  `lib/dashboardMetrics.js` (not exported), so this is a safe internal
  change with no other consumers.

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe('getMonthSummary', ...)` block in
`test/dashboardMetrics.test.js`, after the existing "correctly rolls over
the month boundary" test:

```javascript
  it('bills a booking\'s nights inside the month at each night\'s own configured weekday/weekend rate', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(room.id).run();
    // Thu 2026-09-10 .. Sat 2026-09-12 = 2 nights: Thu (weekday), Fri (weekend)
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('A', '090', 'circle', ?, '2026-09-10', '2026-09-12', 'confirmed', 'website', '2026-09-01T00:00:00Z')`
    ).bind(room.id).run();

    const summary = await getMonthSummary(env, '2026-09');
    expect(summary.roomRevenueVnd).toBe(700000 + 900000);
  });

  it('clamps a configured-price booking at the month boundary, billing only the in-month nights at their own rate', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(room.id).run();
    // Stay: Wed 2026-08-31 .. Fri 2026-09-04 (2026-09 has 3 in-month nights: Tue 09-01, Wed 09-02, Thu 09-03, all weekday)
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('A', '090', 'circle', ?, '2026-08-31', '2026-09-04', 'confirmed', 'website', '2026-08-01T00:00:00Z')`
    ).bind(room.id).run();

    const september = await getMonthSummary(env, '2026-09');
    expect(september.roomRevenueVnd).toBe(3 * 700000);
  });

  it('bills a holiday night inside the reported month at the weekend rate', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET price_weekday = 700000, price_weekend = 900000 WHERE id = ?`).bind(room.id).run();
    await env.DB.prepare(`INSERT INTO holidays (name, start_date, end_date, updated_by, updated_at) VALUES ('Test Holiday', '2026-09-08', '2026-09-08', 'seed', '2026-08-01T00:00:00Z')`).run();
    // Mon 2026-09-07 .. Wed 2026-09-09 = 2 nights: Mon (weekday), Tue=holiday (weekend rate)
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('A', '090', 'circle', ?, '2026-09-07', '2026-09-09', 'confirmed', 'website', '2026-09-01T00:00:00Z')`
    ).bind(room.id).run();

    const summary = await getMonthSummary(env, '2026-09');
    expect(summary.roomRevenueVnd).toBe(700000 + 900000);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/dashboardMetrics.test.js -t "getMonthSummary"`
Expected: The 3 new tests FAIL (current code multiplies `nights × flat
rate`, ignoring per-room prices and holidays entirely); all pre-existing
`getMonthSummary` tests still PASS (they use bookings with no `room_id`,
so they're unaffected by this task and must remain green).

- [ ] **Step 3: Write the implementation**

`lib/dashboardMetrics.js` — add the import, change `nightsInRange`, and
rewrite the `getMonthSummary` body:

```javascript
import { ROOM_TYPES } from './roomTypes.js';
import { computeRoomTotal } from './roomPricing.js';
```

Replace `nightsInRange` (lines 54-59):

```javascript
function nightsInRange(checkIn, checkOut, rangeStart, rangeEnd) {
  const clampedStart = checkIn > rangeStart ? checkIn : rangeStart;
  const clampedEnd = checkOut < rangeEnd ? checkOut : rangeEnd;
  const nights = (Date.parse(clampedEnd) - Date.parse(clampedStart)) / 86400000;
  return { nights: nights > 0 ? nights : 0, clampedStart, clampedEnd };
}
```

Replace the body of `getMonthSummary` from the `overlapping` query
(line 68) through the loop (line 88):

```javascript
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
```

The rest of `getMonthSummary` (`occupancyRate`, `adrVnd`,
`serviceRevenueRow`, `serviceRevenueVnd`, `totalRevenueVnd`, the final
`return`) is unchanged. Confirm `ROOM_TYPES` is still referenced
somewhere in this file after this edit (it isn't directly anymore, since
`computeRoomTotal` encapsulates the fallback) — remove the
`import { ROOM_TYPES } from './roomTypes.js';` line since nothing in
this file calls it directly anymore.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dashboardMetrics.test.js`
Expected: PASS (all `getTodaySnapshot` and `getMonthSummary` tests, old
and new).

- [ ] **Step 5: Commit**

```bash
git add lib/dashboardMetrics.js test/dashboardMetrics.test.js
git commit -m "feat: compute dashboard room revenue night-by-night using per-room prices"
```

---

### Task 7: Client — reception checkout preview uses live per-room prices

**Files:**
- Modify: `admin/reception.js`

**Interfaces:**
- Consumes: `GET /api/rooms` (Task 3, now returns `priceWeekday`/
  `priceWeekend`), `GET /api/holidays` (Task 4). Each `booking` object
  from `GET /api/bookings` already carries `roomId` (unchanged, confirmed
  at `functions/api/bookings/index.js:120`).
- Produces: module-level `cachedRooms`/`cachedHolidays`, refreshed by
  `refreshAll()`; `computeCheckoutPreview(booking)` keeps its existing
  return shape `{ roomDue, servicesDue, refundAmount, unpaidServicesTotal }`
  — only how `roomTotal` is computed inside it changes. No test file
  changes — this file has no existing unit-test coverage of its DOM logic
  (confirmed: no `test/reception*.test.js` exists); its behavior is
  covered by the e2e suite in Task 9's target repo, which already
  exercises the checkout dialog end-to-end.

- [ ] **Step 1: Add the module-level caches and duplicate the pricing helpers**

Add near the top of `admin/reception.js`, right after the existing
`ROOM_TYPE_PRICES` constant (line 21):

```javascript
let cachedRooms = [];
let cachedHolidays = [];

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

function priceForNightClient(dateStr, room, roomType, holidays) {
  const isWeekend = isWeekendDow(dateStr) || isHolidayDate(dateStr, holidays);
  const fallback = ROOM_TYPE_PRICES[roomType] || 0;
  const configured = room ? (isWeekend ? room.priceWeekend : room.priceWeekday) : null;
  return configured != null ? configured : fallback;
}

function computeRoomTotalClient(startDate, endDate, room, roomType, holidays) {
  let total = 0;
  let d = startDate;
  while (d < endDate) {
    total += priceForNightClient(d, room, roomType, holidays);
    d = addDays(d, 1);
  }
  return total;
}
```

- [ ] **Step 2: Load and cache rooms/holidays in `refreshAll()`**

Modify `refreshAll()` (line 103-105):

```javascript
async function refreshAll() {
  await Promise.all([loadPending(), loadArrivals(), loadDepartures(), loadUpcomingConfirmed(), loadInhouse(), loadBookingHistory(), loadRooms(), loadReminders(), loadPricingCaches()]);
}

async function loadPricingCaches() {
  cachedRooms = await fetch('/api/rooms').then((r) => (r.ok ? r.json() : [])).catch(() => []);
  cachedHolidays = await fetch('/api/holidays').then((r) => (r.ok ? r.json() : [])).catch(() => []);
}
```

- [ ] **Step 3: Rewrite `computeCheckoutPreview` to use the caches**

Replace lines 983-985:

```javascript
function computeCheckoutPreview(booking) {
  const room = cachedRooms.find((r) => r.id === booking.roomId) || null;
  const roomTotal = computeRoomTotalClient(booking.checkIn, booking.checkOut, room, booking.roomType, cachedHolidays);
```

(the rest of the function — `unpaidServicesTotal`, `deposit`, `roomDue`,
`leftoverDeposit`, `servicesDue`, `refundAmount`, the `return` — is
unchanged).

- [ ] **Step 4: Manual verification**

Run: `npm run dev` (or the project's existing local dev command) and
open the reception board. Open the checkout dialog for an in-house
booking; confirm the summary amount still renders (falls back to the flat
rate since no room has a configured price yet at this point in the
plan). This step has no automated test — flag any discrepancy before
proceeding, since Task 8 depends on this cache being wired correctly.

- [ ] **Step 5: Commit**

```bash
git add admin/reception.js
git commit -m "feat: reception checkout preview uses live per-room prices and holidays"
```

---

### Task 8: Client — "Quản lý phòng" combined admin page

**Files:**
- Create: `admin/rooms.html`
- Create: `admin/rooms.js`
- Modify: `admin/nav-drawer.js`

**Interfaces:**
- Consumes: `GET /api/rooms`, `PATCH /api/rooms/:id/price` (Task 3);
  `GET /api/holidays`, `POST /api/holidays`, `PATCH /api/holidays/:id`,
  `DELETE /api/holidays/:id` (Task 4).

- [ ] **Step 1: Create `admin/rooms.html`**

Follows `admin/cancellation-policy.html`'s exact structure and stylesheet
links, with two sections:

```html
<!-- v4/admin/rooms.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Quản lý phòng — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page">
    <h1>Quản lý phòng</h1>
    <p>Giá phòng theo từng phòng (T2–T5 và T6–CN) và lịch ngày lễ hằng năm — ngày lễ được tính theo giá T6–CN.</p>

    <h2>Giá phòng</h2>
    <p id="roomsListError" class="error"></p>
    <div class="table-scroll">
      <table id="roomsTable">
        <thead><tr><th>Tên phòng</th><th>Loại phòng</th><th>Giá T2–T5</th><th>Giá T6–CN</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <h2>Ngày lễ</h2>
    <form id="holidayForm" class="hidden">
      <input type="hidden" name="id" />
      <label>Tên ngày lễ <input type="text" name="name" required /></label>
      <label>Từ ngày <input type="date" name="startDate" required /></label>
      <label>Đến ngày <input type="date" name="endDate" required /></label>
      <button type="submit" id="holidaySubmitBtn">Thêm ngày lễ</button>
      <button type="button" id="holidayCancelBtn" class="btn-secondary">Huỷ</button>
      <p id="holidayFormError" class="error"></p>
    </form>

    <button type="button" id="addHolidayBtn" class="hidden">+ Thêm ngày lễ</button>

    <p id="holidaysListError" class="error"></p>
    <p id="holidaysEmptyState" class="hidden">Chưa cấu hình ngày lễ nào.</p>
    <div class="table-scroll">
      <table id="holidaysTable">
        <thead><tr><th>Tên ngày lễ</th><th>Từ ngày</th><th>Đến ngày</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script src="/admin/rooms.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `admin/rooms.js`**

Room-pricing section follows an inline-edit-per-row pattern; the holidays
section is a direct structural copy of `admin/cancellation-policy.js`'s
`resetForm`/`openEditForm`/submit-handler pattern, renamed to holidays:

```javascript
// v4/admin/rooms.js
let currentRole = null;
let editingRoomId = null;

const ROOM_TYPE_LABELS = {
  triangle: 'Triangle House',
  circle: 'Circle House',
  ede_cozy: 'Ê Đê Cozy House',
  vip: 'VIP House',
  bungalow: 'Bungalow Gia Đình',
  dormitory: 'Phòng Tập Thể',
};

function formatVnd(n) {
  return n == null ? '—' : `${Number(n).toLocaleString('vi-VN')} đ`;
}

(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;
  if (currentRole === 'admin') {
    document.getElementById('addHolidayBtn').classList.remove('hidden');
  }
  await loadRooms();
  await loadHolidays();
})();

async function loadRooms() {
  const listError = document.getElementById('roomsListError');
  listError.textContent = '';
  const response = await fetch('/api/rooms');
  if (!response.ok) {
    listError.textContent = 'Có lỗi khi tải danh sách phòng';
    return;
  }
  const rooms = await response.json();
  renderRoomsTable(rooms);
}

function renderRoomsTable(rooms) {
  const tbody = document.querySelector('#roomsTable tbody');
  tbody.innerHTML = '';

  rooms.forEach((room) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = room.name;

    const tdType = document.createElement('td');
    tdType.textContent = ROOM_TYPE_LABELS[room.roomType] || room.roomType;

    if (editingRoomId === room.id) {
      const tdWeekday = document.createElement('td');
      const weekdayInput = document.createElement('input');
      weekdayInput.type = 'number';
      weekdayInput.min = '0';
      weekdayInput.placeholder = 'Theo loại phòng';
      if (room.priceWeekday != null) weekdayInput.value = room.priceWeekday;
      tdWeekday.appendChild(weekdayInput);

      const tdWeekend = document.createElement('td');
      const weekendInput = document.createElement('input');
      weekendInput.type = 'number';
      weekendInput.min = '0';
      weekendInput.placeholder = 'Theo loại phòng';
      if (room.priceWeekend != null) weekendInput.value = room.priceWeekend;
      tdWeekend.appendChild(weekendInput);

      const tdActions = document.createElement('td');
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'table-actions-btn';
      saveBtn.textContent = 'Lưu';
      saveBtn.addEventListener('click', () => saveRoomPrice(room.id, weekdayInput.value, weekendInput.value));
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'table-actions-btn';
      cancelBtn.textContent = 'Huỷ';
      cancelBtn.addEventListener('click', () => {
        editingRoomId = null;
        loadRooms();
      });
      tdActions.append(saveBtn, cancelBtn);

      tr.append(tdName, tdType, tdWeekday, tdWeekend, tdActions);
    } else {
      const tdWeekday = document.createElement('td');
      tdWeekday.textContent = formatVnd(room.priceWeekday);

      const tdWeekend = document.createElement('td');
      tdWeekend.textContent = formatVnd(room.priceWeekend);

      const tdActions = document.createElement('td');
      if (currentRole === 'admin') {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'table-actions-btn';
        editBtn.textContent = 'Sửa';
        editBtn.addEventListener('click', () => {
          editingRoomId = room.id;
          loadRooms();
        });
        tdActions.appendChild(editBtn);
      }

      tr.append(tdName, tdType, tdWeekday, tdWeekend, tdActions);
    }

    tbody.appendChild(tr);
  });
}

async function saveRoomPrice(roomId, weekdayValue, weekendValue) {
  const listError = document.getElementById('roomsListError');
  listError.textContent = '';
  const payload = {
    priceWeekday: weekdayValue === '' ? null : Number(weekdayValue),
    priceWeekend: weekendValue === '' ? null : Number(weekendValue),
  };
  const response = await fetch(`/api/rooms/${roomId}/price`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi lưu giá phòng';
    return;
  }
  editingRoomId = null;
  await loadRooms();
}

async function loadHolidays() {
  const listError = document.getElementById('holidaysListError');
  listError.textContent = '';
  const response = await fetch('/api/holidays');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi tải danh sách ngày lễ';
    return;
  }
  const holidays = await response.json();
  renderHolidaysTable(holidays);
}

function renderHolidaysTable(holidays) {
  const tbody = document.querySelector('#holidaysTable tbody');
  tbody.innerHTML = '';
  document.getElementById('holidaysEmptyState').classList.toggle('hidden', holidays.length > 0);

  holidays.forEach((holiday) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = holiday.name;

    const tdStart = document.createElement('td');
    tdStart.textContent = holiday.startDate;

    const tdEnd = document.createElement('td');
    tdEnd.textContent = holiday.endDate;

    const tdActions = document.createElement('td');
    if (currentRole === 'admin') {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'table-actions-btn';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditHolidayForm(holiday));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'table-actions-btn';
      deleteBtn.textContent = 'Xoá';
      deleteBtn.addEventListener('click', () => deleteHoliday(holiday.id));
      tdActions.append(editBtn, deleteBtn);
    }

    tr.append(tdName, tdStart, tdEnd, tdActions);
    tbody.appendChild(tr);
  });
}

function resetHolidayForm() {
  const form = document.getElementById('holidayForm');
  form.reset();
  form.querySelector('input[name="id"]').value = '';
  document.getElementById('holidaySubmitBtn').textContent = 'Thêm ngày lễ';
}

document.getElementById('addHolidayBtn').addEventListener('click', () => {
  resetHolidayForm();
  document.getElementById('holidayForm').classList.remove('hidden');
});

document.getElementById('holidayCancelBtn').addEventListener('click', () => {
  document.getElementById('holidayForm').classList.add('hidden');
});

function openEditHolidayForm(holiday) {
  const form = document.getElementById('holidayForm');
  form.classList.remove('hidden');
  form.querySelector('input[name="id"]').value = holiday.id;
  form.querySelector('input[name="name"]').value = holiday.name;
  form.querySelector('input[name="startDate"]').value = holiday.startDate;
  form.querySelector('input[name="endDate"]').value = holiday.endDate;
  document.getElementById('holidaySubmitBtn').textContent = 'Lưu thay đổi';
}

async function deleteHoliday(id) {
  const listError = document.getElementById('holidaysListError');
  const response = await fetch(`/api/holidays/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi xoá ngày lễ';
    return;
  }
  await loadHolidays();
}

document.getElementById('holidayForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = document.getElementById('holidayFormError');
  errorEl.textContent = '';

  const id = data.get('id');
  const payload = {
    name: data.get('name'),
    startDate: data.get('startDate'),
    endDate: data.get('endDate'),
  };

  const response = await fetch(id ? `/api/holidays/${id}` : '/api/holidays', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu ngày lễ';
    return;
  }

  form.classList.add('hidden');
  await loadHolidays();
});
```

- [ ] **Step 3: Add the nav-drawer entry**

`admin/nav-drawer.js` — add to the `'Cấu hình & Quản trị'` group's
`items` array (after the `cancellation-policy.html` entry, line 37):

```javascript
      { page: 'rooms.html', label: 'Quản lý phòng', icon: '🛏️', roles: ['reception', 'manager', 'admin', 'observer'] },
```

And add `'rooms.html': 'rooms'` to the `pageSlug` map (line 52, inside
the existing object literal — insert alongside `'cancellation-policy.html': 'cancellation-policy'`).

- [ ] **Step 4: Manual verification**

Run the local dev server, log in as admin, navigate to "Quản lý phòng"
from the nav drawer. Confirm: all 16 rooms list with "—" for both price
columns; clicking "Sửa" on a row reveals two number inputs; entering
values and clicking "Lưu" persists them (reload confirms); the Ngày lễ
section's "+ Thêm ngày lễ" reveals the form, adding a holiday shows it in
the table, "Sửa"/"Xoá" work. Log in as a non-admin role and confirm the
"Sửa"/"Xoá"/"+ Thêm ngày lễ" controls are all absent, but both tables
still render with data.

- [ ] **Step 5: Commit**

```bash
git add admin/rooms.html admin/rooms.js admin/nav-drawer.js
git commit -m "feat: add combined 'Quản lý phòng' admin page (room pricing + holidays)"
```

---

### Task 9: E2e coverage (outer repo)

**Files:**
- Create (outer repo `D:\VDX\HienLeGarden\LandingPage`):
  `tests/e2e/admin-rooms.spec.js`

**Interfaces:**
- Consumes: `/admin/rooms.html` (Task 8), mocking `/api/auth/me`,
  `/api/rooms`, `/api/rooms/:id/price`, and `/api/holidays` via
  `page.route()` — this repo's e2e suite does not run against a live
  backend or use a login helper; every existing spec
  (`tests/e2e/admin-cancellation-policy.spec.js`, read in full as this
  task's direct template) drives the page by mocking its API calls
  in-browser and asserting on the resulting DOM. CommonJS
  (`require('@playwright/test')`), not ESM — matches the template
  exactly.

- [ ] **Step 1: Write the e2e spec**

```javascript
// tests/e2e/admin-rooms.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Quản lý phòng', () => {
  test('admin can edit a room price and see it reflected', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));

    let priceWeekday = null;
    let priceWeekend = null;
    await page.route('**/api/rooms', (route) => {
      const rooms = [{ id: 1, name: 'VIP House 1', roomType: 'vip', priceWeekday, priceWeekend }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rooms) });
    });
    await page.route('**/api/rooms/1/price', (route) => {
      const body = route.request().postDataJSON();
      priceWeekday = body.priceWeekday;
      priceWeekend = body.priceWeekend;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/holidays', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/admin/rooms.html');
    await expect(page.locator('#roomsTable tbody tr')).toContainText('—');
    await page.click('#roomsTable tbody tr button:has-text("Sửa")');
    await page.locator('#roomsTable tbody tr input').nth(0).fill('700000');
    await page.locator('#roomsTable tbody tr input').nth(1).fill('900000');
    await page.click('#roomsTable tbody tr button:has-text("Lưu")');
    await expect(page.locator('#roomsTable tbody tr')).toContainText('700.000');
    await expect(page.locator('#roomsTable tbody tr')).toContainText('900.000');
  });

  test('a non-admin role sees room prices and holidays read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan', role: 'reception' }) }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'VIP House 1', roomType: 'vip', priceWeekday: 700000, priceWeekend: 900000 }]) }));
    await page.route('**/api/holidays', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Quốc khánh', startDate: '2026-09-02', endDate: '2026-09-02' }]) }));

    await page.goto('/admin/rooms.html');
    await expect(page.locator('#roomsTable tbody')).toContainText('700.000');
    await expect(page.locator('#holidaysTable tbody')).toContainText('Quốc khánh');
    await expect(page.locator('#roomsTable tbody tr button', { hasText: 'Sửa' })).toHaveCount(0);
    await expect(page.locator('#addHolidayBtn')).toBeHidden();
    await expect(page.locator('#holidaysTable tbody tr button', { hasText: 'Xoá' })).toHaveCount(0);
  });

  test('admin can add and delete a holiday', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    let holidays = [];
    await page.route('**/api/holidays', (route) => {
      if (route.request().method() === 'POST') {
        holidays = [{ id: 1, name: 'Test Holiday E2E', startDate: '2027-05-01', endDate: '2027-05-02' }];
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(holidays) });
    });
    await page.route('**/api/holidays/1', (route) => {
      if (route.request().method() === 'DELETE') {
        holidays = [];
        return route.fulfill({ status: 204 });
      }
      return route.continue();
    });

    await page.goto('/admin/rooms.html');
    await expect(page.locator('#holidaysEmptyState')).toBeVisible();
    await page.click('#addHolidayBtn');
    await page.fill('#holidayForm input[name="name"]', 'Test Holiday E2E');
    await page.fill('#holidayForm input[name="startDate"]', '2027-05-01');
    await page.fill('#holidayForm input[name="endDate"]', '2027-05-02');
    await page.click('#holidaySubmitBtn');
    await expect(page.locator('#holidaysTable tbody')).toContainText('Test Holiday E2E');

    await page.click('#holidaysTable tbody tr button:has-text("Xoá")');
    await expect(page.locator('#holidaysTable tbody')).not.toContainText('Test Holiday E2E');
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/rooms.html');
    await page.waitForURL('**/admin/');
  });
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `npx playwright test tests/e2e/admin-rooms.spec.js`
Expected: PASS (4 tests).

- [ ] **Step 3: Add the nav-drawer entry to `crm-admin.spec.js`'s coverage (if present)**

Open `tests/e2e/crm-admin.spec.js` and check whether it asserts on the
full list of nav-drawer items (some sibling specs in this suite do this
for other pages, e.g. `cancellation-policy.html`'s entry). If it does,
add `'rooms.html'`/`'Quản lý phòng'` to that list following the exact
same style as the neighboring entries; if it doesn't enumerate nav items
at all, skip this step — do not add new coverage unrelated to what the
file already tests.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/admin-rooms.spec.js
git commit -m "test: add e2e coverage for the Quản lý phòng admin page"
```
