# Room Status Filters & Layout Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a date-scoped 5-state room status model with deposit tracking to the reception ops board, filterable by date/status by every role, and move room-reorder drag permission from a `manager`/`admin` role check to an independently-grantable `can_manage_room_layout` account flag with a staged save button and change log.

**Architecture:** `GET /api/rooms` gains an optional `?date=` parameter computing the 5-state model from bookings overlapping that date, falling back to today's real-time logic when omitted. A new `deposit_amount` column on `bookings` and a new `PATCH /api/bookings/:id/deposit` endpoint let staff record deposits inline. `PATCH /api/rooms/reorder`'s authorization moves from a role allow-list to an explicit `can_manage_room_layout` flag check, logged to a new `room_layout_log` table on every save. `reception.js` gains date/status filter controls, a staged-drag-then-explicit-save flow, and a small recent-changes list.

**Tech Stack:** Cloudflare Pages Functions + D1 (SQLite), vanilla JS, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/specs/2026-08-27-room-status-filters-design.md`

## Global Constraints

- The 5 date-scoped room statuses and their exact status-key strings: `empty`, `booked`, `booked_deposited`, `occupied`, `used` — derived from the non-cancelled booking (if any) overlapping the given date, per the mapping table in the spec.
- `needs_cleaning` stays a separate, always-real-time boolean flag (never date-scoped), rendered as a badge only when the viewed date is today.
- `GET /api/rooms` without `?date=` keeps its exact current behavior and response shape, unchanged, for backward compatibility.
- Deposit editing (`PATCH /api/bookings/:id/deposit`) is allowed to `['reception', 'manager', 'admin']` — never `observer`, matching every other write endpoint's role list in this codebase.
- `PATCH /api/rooms/reorder`'s authorization becomes flag-based (`auth.canManageRoomLayout === 1`), independent of role — a `manager`/`admin` account without the flag must get 403; a `reception` account with the flag must get 200.
- Every successful reorder writes one row to `room_layout_log` with the acting account's username.
- `GET /api/rooms/layout-log` is readable by all four roles (view-only).
- Every write endpoint this plan adds or changes must exclude `observer` by omission from its `requireAuth` allow-list — the established enforcement pattern in this codebase (never add `observer` to a write endpoint, never rely on client-side hiding alone).
- Never stage `test/policy.test.js` if it shows as modified with no real diff (known CRLF artifact in this checkout).
- D1 migrations are applied with `wrangler d1 migrations apply hien_le_garden_crm --remote` against production only after local tests pass, and (per this project's established practice) applied *before* pushing code that depends on them.
- After each backend task, run targeted `npx vitest run <name>` invocations, not the full `npm test` (this project's Windows environment has a documented, pre-existing infra flake in `@cloudflare/vitest-pool-workers` on full-suite runs — never a real assertion failure, per `scripts/test-with-retry.js`'s own comments). After each frontend/e2e task, use the project's established pattern: start `npx http-server . -p 4174 -s -c-1` from `v4/` in the background, curl-check readiness, run `npx playwright test <name> --project=v4` from the outer repo, then always find and kill the http-server process afterward via `netstat -ano | grep ":4174"` + `taskkill //F //PID <pid>`.

---

### Task 1: Schema — deposit, layout permission flag, and change-log table

**Files:**
- Create: `v4/migrations/0008_deposit_layout_permission.sql`
- Test: `v4/test/roomLayoutSchema.test.js`

**Interfaces:**
- Produces: `bookings.deposit_amount` (INTEGER, default 0), `staff_accounts.can_manage_room_layout` (INTEGER, default 0), table `room_layout_log(id, changed_by TEXT, old_order TEXT, new_order TEXT, changed_at TEXT)`.

- [ ] **Step 1: Write the failing test**

```js
// v4/test/roomLayoutSchema.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM bookings');
  await env.DB.exec('DELETE FROM room_layout_log');
});

describe('room status filters schema', () => {
  it('bookings.deposit_amount defaults to 0', async () => {
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('A', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE guest_name = 'A'`).first();
    expect(row.deposit_amount).toBe(0);
  });

  it('staff_accounts.can_manage_room_layout defaults to 0', async () => {
    await env.DB.prepare(
      `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('flag_test', 'x', 'reception', '2026-08-27T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT can_manage_room_layout FROM staff_accounts WHERE username = 'flag_test'`).first();
    expect(row.can_manage_room_layout).toBe(0);
    await env.DB.prepare(`DELETE FROM staff_accounts WHERE username = 'flag_test'`).run();
  });

  it('room_layout_log accepts a row', async () => {
    await env.DB.prepare(
      `INSERT INTO room_layout_log (changed_by, old_order, new_order, changed_at) VALUES ('tester', '[1,2]', '[2,1]', '2026-08-27T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT changed_by, old_order, new_order FROM room_layout_log WHERE changed_by = 'tester'`).first();
    expect(row).toEqual({ changed_by: 'tester', old_order: '[1,2]', new_order: '[2,1]' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `v4/`): `npm run test:once -- roomLayoutSchema`
Expected: FAIL — `no such column: deposit_amount` (or similar) on the first test, since the migration doesn't exist yet.

- [ ] **Step 3: Write the migration**

```sql
-- v4/migrations/0008_deposit_layout_permission.sql
ALTER TABLE bookings ADD COLUMN deposit_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_accounts ADD COLUMN can_manage_room_layout INTEGER NOT NULL DEFAULT 0;

-- One-time grant for the existing Vinhdx account. A no-op locally/in test
-- environments where no such username exists yet -- expected, not an error.
UPDATE staff_accounts SET can_manage_room_layout = 1 WHERE username = 'Vinhdx';

CREATE TABLE room_layout_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_by TEXT NOT NULL,
  old_order TEXT NOT NULL,
  new_order TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
```

- [ ] **Step 4: Apply the migration locally and run the test**

Run: `wrangler d1 migrations apply hien_le_garden_crm --local` then `npm run test:once -- roomLayoutSchema`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/0008_deposit_layout_permission.sql test/roomLayoutSchema.test.js
git commit -m "Add deposit_amount, can_manage_room_layout, and room_layout_log"
```

---

### Task 2: `GET /api/rooms` — date-scoped 5-state model

**Files:**
- Modify: `v4/functions/api/rooms/index.js`
- Test: `v4/test/roomsEndpoints.test.js`

**Interfaces:**
- Consumes: `bookings.deposit_amount` (Task 1).
- Produces: `GET /api/rooms?date=YYYY-MM-DD` returns each room's `status` as one of `empty | booked | booked_deposited | occupied | used`, alongside the existing `needsCleaning` boolean. Without `?date=`, response shape and values are unchanged from today.

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/roomsEndpoints.test.js`, inside `describe('GET /api/rooms', ...)`, after the existing `'lets an observer view rooms'` test:

```js
  it('returns the date-scoped 5-state model when ?date= is passed', async () => {
    const rooms = await env.DB.prepare(`SELECT id, room_type FROM rooms WHERE is_active = 1 ORDER BY id`).all().then((r) => r.results);
    const [emptyRoom, bookedRoom, depositedRoom, occupiedRoom, usedRoom] = rooms;

    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('B', '090', ?, ?, '2026-09-10', '2026-09-12', 'pending', 'website', 0, '2026-08-27T00:00:00Z')`
    ).bind(bookedRoom.room_type, bookedRoom.id).run();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('C', '090', ?, ?, '2026-09-10', '2026-09-12', 'confirmed', 'website', 200000, '2026-08-27T00:00:00Z')`
    ).bind(depositedRoom.room_type, depositedRoom.id).run();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('D', '090', ?, ?, '2026-09-10', '2026-09-12', 'checked_in', 'website', '2026-08-27T00:00:00Z')`
    ).bind(occupiedRoom.room_type, occupiedRoom.id).run();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('E', '090', ?, ?, '2026-09-10', '2026-09-12', 'checked_out', 'website', '2026-08-27T00:00:00Z')`
    ).bind(usedRoom.room_type, usedRoom.id).run();
    // A cancelled booking overlapping the date must not affect the room's status.
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('F', '090', ?, ?, '2026-09-10', '2026-09-12', 'cancelled', 'website', '2026-08-27T00:00:00Z')`
    ).bind(emptyRoom.room_type, emptyRoom.id).run();

    const response = await listRooms({ request: authedRequest('https://x/api/rooms?date=2026-09-11'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    const byId = Object.fromEntries(body.map((r) => [r.id, r]));
    expect(byId[emptyRoom.id].status).toBe('empty');
    expect(byId[bookedRoom.id].status).toBe('booked');
    expect(byId[depositedRoom.id].status).toBe('booked_deposited');
    expect(byId[occupiedRoom.id].status).toBe('occupied');
    expect(byId[usedRoom.id].status).toBe('used');
  });

  it('does not include a booking whose date range does not cover the queried date', async () => {
    const room = await env.DB.prepare(`SELECT id, room_type FROM rooms WHERE is_active = 1 LIMIT 1`).first();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, created_at)
       VALUES ('G', '090', ?, ?, '2026-09-10', '2026-09-12', 'confirmed', 'website', '2026-08-27T00:00:00Z')`
    ).bind(room.room_type, room.id).run();

    const response = await listRooms({ request: authedRequest('https://x/api/rooms?date=2026-09-20'), env });
    const body = await response.json();
    expect(body.find((r) => r.id === room.id).status).toBe('empty');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:once -- roomsEndpoints`
Expected: FAIL on the two new tests (status is always the old `empty`/`occupied`/`needs_cleaning` model regardless of `?date=`, since the parameter isn't read yet).

- [ ] **Step 3: Implement the date-scoped model**

Replace the full contents of `functions/api/rooms/index.js` with:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const date = url.searchParams.get('date');

  const { results: rooms } = await env.DB.prepare(
    `SELECT id, name, room_type AS roomType, needs_cleaning AS needsCleaning FROM rooms WHERE is_active = 1 ORDER BY display_order, id`
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
    };
  });

  return new Response(JSON.stringify(mapped), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:once -- roomsEndpoints`
Expected: PASS (all tests in this file, including the pre-existing ones — the no-`date` branch is byte-identical in behavior to the original code).

- [ ] **Step 5: Commit**

```bash
git add functions/api/rooms/index.js test/roomsEndpoints.test.js
git commit -m "Add date-scoped 5-state room status model to GET /api/rooms"
```

---

### Task 3: `PATCH /api/bookings/:id/deposit`

**Files:**
- Create: `v4/functions/api/bookings/[id]/deposit.js`
- Modify: `v4/functions/api/bookings/index.js`
- Test: `v4/test/bookingsEndpoints.test.js`

**Interfaces:**
- Consumes: `bookings.deposit_amount` (Task 1).
- Produces: `PATCH /api/bookings/:id/deposit`, body `{ depositAmount: number }`, 200 on success, 400 on invalid amount, 404 if the booking doesn't exist, 403 for `observer`. `GET /api/bookings`'s response rows gain a `depositAmount` field (Task 9 depends on this being present).

- [ ] **Step 0: Add `depositAmount` to `GET /api/bookings`'s response**

`functions/api/bookings/index.js`'s `onRequestGet` does not currently select or return `deposit_amount`. In its `SELECT`, change:

```js
  const { results } = await env.DB.prepare(
    `SELECT id, guest_name AS guestName, phone, email, room_type AS roomType, room_id AS roomId,
            check_in AS checkIn, check_out AS checkOut, guests_count AS guestsCount, notes, status, source,
            created_at AS createdAt, created_by AS createdBy, confirmed_by AS confirmedBy, confirmed_at AS confirmedAt,
            cancel_reason AS cancelReason
     FROM bookings ${where} ORDER BY check_in ASC`
```

to:

```js
  const { results } = await env.DB.prepare(
    `SELECT id, guest_name AS guestName, phone, email, room_type AS roomType, room_id AS roomId,
            check_in AS checkIn, check_out AS checkOut, guests_count AS guestsCount, notes, status, source,
            deposit_amount AS depositAmount,
            created_at AS createdAt, created_by AS createdBy, confirmed_by AS confirmedBy, confirmed_at AS confirmedAt,
            cancel_reason AS cancelReason
     FROM bookings ${where} ORDER BY check_in ASC`
```

Read the rest of this handler after the `SELECT` — if it maps `results` into a new array/object (rather than returning `results` directly), confirm `depositAmount` passes through that mapping too (add it explicitly if the mapping is an allow-list of named fields rather than a spread).

Add one assertion to any existing `GET /api/bookings` test in `test/bookingsEndpoints.test.js` confirming a seeded booking's `depositAmount` comes back correctly (0 by default, or the seeded value) — extend whichever existing "lists bookings" style test is most appropriate, following the file's established pattern, rather than writing a whole new test just for this one field.

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/bookingsEndpoints.test.js`, a new `describe` block (read the file first for its exact `authedRequest`/token-fixture pattern — it currently only has a `managerToken` fixture; add `receptionToken` and `observerToken` fixtures the same way `roomsEndpoints.test.js` does, with ids 2 and 3 respectively, if they don't already exist in this file from an earlier task):

```js
describe('PATCH /api/bookings/:id/deposit', () => {
  it('lets reception set a deposit amount', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 200000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(row.deposit_amount).toBe(200000);
  });

  it('rejects a negative amount (400)', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test 2', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${managerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: -1 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent booking', async () => {
    const request = new Request('https://x/api/bookings/999999/deposit', {
      method: 'PATCH',
      headers: { Cookie: `session=${managerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an observer (403)', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test 3', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${observerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const request = new Request('https://x/api/bookings/1/deposit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: '1' } });
    expect(response.status).toBe(401);
  });
});
```

Add the import at the top of the file alongside the existing imports:
```js
import { onRequestPatch as setDeposit } from '../functions/api/bookings/[id]/deposit.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:once -- bookingsEndpoints`
Expected: FAIL — the endpoint file doesn't exist yet (import error) or all requests 404/error.

- [ ] **Step 3: Create the endpoint**

```js
// v4/functions/api/bookings/[id]/deposit.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { depositAmount } = body || {};

  if (!Number.isInteger(depositAmount) || depositAmount < 0) {
    return jsonError('Số tiền cọc phải là số nguyên không âm', 400);
  }

  const booking = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }

  await env.DB.prepare(`UPDATE bookings SET deposit_amount = ? WHERE id = ?`).bind(depositAmount, params.id).run();
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:once -- bookingsEndpoints`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/api/bookings/[id]/deposit.js test/bookingsEndpoints.test.js
git commit -m "Add PATCH /api/bookings/:id/deposit"
```

---

### Task 4: Flag-based room-layout permission, reorder auth migration, and change log

**Files:**
- Modify: `v4/lib/auth.js`
- Modify: `v4/functions/api/auth/me.js`
- Modify: `v4/functions/api/rooms/reorder.js`
- Test: `v4/test/roomsEndpoints.test.js`
- Test: `v4/test/authMeEndpoint.test.js`

**Interfaces:**
- Consumes: `staff_accounts.can_manage_room_layout`, `room_layout_log` (Task 1).
- Produces: `getSession()` returns `{ staffId, username, role, canManageRoomLayout }`; `GET /api/auth/me` response includes `canManageRoomLayout`; `PATCH /api/rooms/reorder` is now gated on `auth.canManageRoomLayout === 1` (any role) instead of `['manager', 'admin']`, and writes one `room_layout_log` row per successful save.

- [ ] **Step 1: Update `getSession`**

In `lib/auth.js`, change:

```js
export async function getSession(db, token) {
  const row = await db
    .prepare(
      `SELECT s.staff_id AS staffId, a.username, a.role FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, new Date().toISOString())
    .first();

  if (!row) return null;
  return { staffId: row.staffId, username: row.username, role: row.role };
}
```

to:

```js
export async function getSession(db, token) {
  const row = await db
    .prepare(
      `SELECT s.staff_id AS staffId, a.username, a.role, a.can_manage_room_layout AS canManageRoomLayout FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, new Date().toISOString())
    .first();

  if (!row) return null;
  return { staffId: row.staffId, username: row.username, role: row.role, canManageRoomLayout: !!row.canManageRoomLayout };
}
```

- [ ] **Step 2: Update `GET /api/auth/me`**

In `functions/api/auth/me.js`, change:

```js
  return new Response(JSON.stringify({ username: auth.username, role: auth.role }), {
```

to:

```js
  return new Response(JSON.stringify({ username: auth.username, role: auth.role, canManageRoomLayout: auth.canManageRoomLayout }), {
```

- [ ] **Step 3: Write the failing tests for the permission change**

First, read `v4/test/roomsEndpoints.test.js`'s current `beforeEach` (it seeds `managerToken`, `receptionToken`, `adminToken`, `observerToken` with ids 1-4, none with the layout flag set). Add one more fixture with the flag set, and update the existing reorder tests that currently assume role-based access:

Add to the `beforeEach`, right after the existing four inserts:
```js
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, can_manage_room_layout, created_at) VALUES (5, 'le_tan_b', 'x', 'reception', 1, '2026-08-01T00:00:00Z')`).run();
  const layoutToken = await createSession(env.DB, 5);
```
(Add `layoutToken` to the top `let managerToken, receptionToken, adminToken, observerToken;` line.)

Replace the existing `'lets a manager save a new display order, reflected by GET /api/rooms'` test's request line — it currently uses `managerToken`, which after this task's change no longer has the flag by default — with `layoutToken`:
```js
    const response = await reorderRooms({ request: authedBody('https://x/api/rooms/reorder', layoutToken, 'PATCH', { order: reversed }), env });
```
(Leave the rest of that test unchanged.)

Delete the `'lets an admin reorder rooms'` test entirely — role no longer determines this permission, so "an admin can reorder" is no longer a meaningful assertion on its own. Replace it with:
```js
  it('rejects a manager without the layout flag (403)', async () => {
    const { results: rooms } = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 ORDER BY display_order, id`).all();
    const response = await reorderRooms({ request: authedBody('https://x/api/rooms/reorder', managerToken, 'PATCH', { order: rooms.map((r) => r.id) }), env });
    expect(response.status).toBe(403);
  });

  it('lets a reception account with the layout flag reorder', async () => {
    const { results: rooms } = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 ORDER BY display_order, id`).all();
    const reversed = rooms.map((r) => r.id).reverse();
    const response = await reorderRooms({ request: authedBody('https://x/api/rooms/reorder', layoutToken, 'PATCH', { order: reversed }), env });
    expect(response.status).toBe(200);
  });

  it('logs a room_layout_log row on a successful reorder', async () => {
    const { results: rooms } = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 ORDER BY display_order, id`).all();
    const reversed = rooms.map((r) => r.id).reverse();
    await reorderRooms({ request: authedBody('https://x/api/rooms/reorder', layoutToken, 'PATCH', { order: reversed }), env });
    const row = await env.DB.prepare(`SELECT changed_by FROM room_layout_log ORDER BY id DESC LIMIT 1`).first();
    expect(row.changed_by).toBe('le_tan_b');
  });
```

Change the existing `'rejects a reception account (403)'` test's name to clarify it's now about the missing flag, not the role — rename to `'rejects a reception account without the layout flag (403)'` (body unchanged, `receptionToken` still has no flag set, so this still passes as-is).

Change every other existing test in this `describe` block that used `managerToken` to reach the validation logic (the five `'rejects ...(400)'` tests and `'rejects unauthenticated requests'`) to use `layoutToken` instead of `managerToken`, so they get past the permission check and reach the validation code they're actually testing. `'rejects unauthenticated requests'` needs no token change (it has none).

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm run test:once -- roomsEndpoints`
Expected: FAIL — `reorder.js` still checks role, not the flag, so `layoutToken` (a `reception` account) gets 403 where the new tests expect 200, and `managerToken` still gets 200 where the new "rejects a manager without the flag" test expects 403.

- [ ] **Step 5: Update the reorder endpoint**

Replace the full contents of `functions/api/rooms/reorder.js` with:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAuth(request, env, null);
  if (auth instanceof Response) return auth;
  if (!auth.canManageRoomLayout) {
    return jsonError('Tài khoản không có quyền sắp xếp phòng', 403);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { order } = body || {};

  if (!Array.isArray(order) || order.length === 0 || !order.every((id) => Number.isInteger(id))) {
    return jsonError('Danh sách thứ tự phòng không hợp lệ', 400);
  }
  if (new Set(order).size !== order.length) {
    return jsonError('Danh sách thứ tự phòng có mã phòng trùng lặp', 400);
  }

  const { results: activeRooms } = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 ORDER BY display_order, id`).all();
  const activeIds = new Set(activeRooms.map((r) => r.id));

  if (order.length !== activeIds.size || !order.every((id) => activeIds.has(id))) {
    return jsonError('Danh sách thứ tự phòng phải khớp đúng tất cả phòng đang hoạt động', 400);
  }

  const oldOrder = activeRooms.map((r) => r.id);
  const statements = order.map((id, index) =>
    env.DB.prepare(`UPDATE rooms SET display_order = ? WHERE id = ?`).bind(index, id)
  );
  statements.push(
    env.DB.prepare(
      `INSERT INTO room_layout_log (changed_by, old_order, new_order, changed_at) VALUES (?, ?, ?, ?)`
    ).bind(auth.username, JSON.stringify(oldOrder), JSON.stringify(order), new Date().toISOString())
  );
  await env.DB.batch(statements);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

(Note: `requireAuth(request, env, null)` means "any authenticated staff, any role" — matches the pattern already used by `functions/api/auth/change-password.js`. The 403 for a missing flag is now a distinct, explicit check inside the handler, not part of `requireAuth`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:once -- roomsEndpoints`
Expected: PASS (all tests in the file).

- [ ] **Step 7: Check and extend the `/api/auth/me` test file**

Read `v4/test/authMeEndpoint.test.js`, then add a test confirming the new `canManageRoomLayout` field appears in the response for an account with the flag set and is `false` for one without, following the file's existing pattern for constructing a request and reading the JSON body.

Run: `npm run test:once -- <that file's name>`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/auth.js functions/api/auth/me.js functions/api/rooms/reorder.js test/roomsEndpoints.test.js test/authMeEndpoint.test.js
git commit -m "Move room-reorder permission to a flag; log every reorder"
```

(Adjust the `git add` file list to match whatever the actual auth-me test file is named, per Step 7.)

---

### Task 5: `GET /api/rooms/layout-log`

**Files:**
- Create: `v4/functions/api/rooms/layout-log.js`
- Test: `v4/test/roomsEndpoints.test.js`

**Interfaces:**
- Consumes: `room_layout_log` (Task 1).
- Produces: `GET /api/rooms/layout-log?limit=N` (default 5), returns `[{ changedBy, changedAt }, ...]` newest-first, accessible to all 4 roles.

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/roomsEndpoints.test.js`, a new `describe` block and the corresponding import at the top of the file (`import { onRequestGet as getLayoutLog } from '../functions/api/rooms/layout-log.js';`):

```js
describe('GET /api/rooms/layout-log', () => {
  it('returns recent entries newest-first, respecting limit', async () => {
    await env.DB.prepare(`DELETE FROM room_layout_log`).run();
    await env.DB.prepare(`INSERT INTO room_layout_log (changed_by, old_order, new_order, changed_at) VALUES ('a', '[]', '[]', '2026-08-27T10:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO room_layout_log (changed_by, old_order, new_order, changed_at) VALUES ('b', '[]', '[]', '2026-08-27T11:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO room_layout_log (changed_by, old_order, new_order, changed_at) VALUES ('c', '[]', '[]', '2026-08-27T12:00:00Z')`).run();

    const response = await getLayoutLog({ request: authedRequest('https://x/api/rooms/layout-log?limit=2'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([
      { changedBy: 'c', changedAt: '2026-08-27T12:00:00Z' },
      { changedBy: 'b', changedAt: '2026-08-27T11:00:00Z' },
    ]);
  });

  it('defaults to 5 entries when limit is omitted', async () => {
    const response = await getLayoutLog({ request: authedRequest('https://x/api/rooms/layout-log'), env });
    expect(response.status).toBe(200);
  });

  it('lets an observer view the log', async () => {
    const request = new Request('https://x/api/rooms/layout-log', { headers: { Cookie: `session=${observerToken}` } });
    const response = await getLayoutLog({ request, env });
    expect(response.status).toBe(200);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await getLayoutLog({ request: new Request('https://x/api/rooms/layout-log'), env });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:once -- roomsEndpoints`
Expected: FAIL — the endpoint file doesn't exist yet.

- [ ] **Step 3: Create the endpoint**

```js
// v4/functions/api/rooms/layout-log.js
import { requireAuth } from '../../../lib/requireAuth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const limitParam = parseInt(url.searchParams.get('limit'), 10);
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 5;

  const { results } = await env.DB.prepare(
    `SELECT changed_by AS changedBy, changed_at AS changedAt FROM room_layout_log ORDER BY id DESC LIMIT ?`
  ).bind(limit).all();

  return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:once -- roomsEndpoints`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/api/rooms/layout-log.js test/roomsEndpoints.test.js
git commit -m "Add GET /api/rooms/layout-log"
```

---

### Task 6: Toggle endpoint for the layout permission flag

**Files:**
- Create: `v4/functions/api/users/[id]/room-layout-access.js`
- Test: `v4/test/userManagement.test.js`

**Interfaces:**
- Produces: `PATCH /api/users/:id/room-layout-access`, body `{ canManageRoomLayout: boolean }`, allowed roles `['manager', 'admin']`.

- [ ] **Step 1: Write the failing tests**

Read `v4/test/userManagement.test.js` first (it uses auto-increment ids captured via `.meta.last_row_id`, not hardcoded ids — see its existing `beforeEach`). Add the import (`import { onRequestPatch as setRoomLayoutAccess } from '../functions/api/users/[id]/room-layout-access.js';`) and a new `describe` block:

```js
describe('PATCH /api/users/:id/room-layout-access', () => {
  it('lets a manager grant the flag', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/room-layout-access`, managerAToken, 'PATCH', { canManageRoomLayout: true });
    const response = await setRoomLayoutAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT can_manage_room_layout FROM staff_accounts WHERE id = ?`).bind(receptionId).first();
    expect(row.can_manage_room_layout).toBe(1);
  });

  it('lets a manager revoke the flag', async () => {
    await env.DB.prepare(`UPDATE staff_accounts SET can_manage_room_layout = 1 WHERE id = ?`).bind(receptionId).run();
    const request = authedRequest(`https://x/api/users/${receptionId}/room-layout-access`, managerAToken, 'PATCH', { canManageRoomLayout: false });
    const response = await setRoomLayoutAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT can_manage_room_layout FROM staff_accounts WHERE id = ?`).bind(receptionId).first();
    expect(row.can_manage_room_layout).toBe(0);
  });

  it('rejects a reception account (403)', async () => {
    const request = authedRequest(`https://x/api/users/${managerBId}/room-layout-access`, receptionToken, 'PATCH', { canManageRoomLayout: true });
    const response = await setRoomLayoutAccess({ request, env, params: { id: String(managerBId) } });
    expect(response.status).toBe(403);
  });

  it('returns 404 for a nonexistent account', async () => {
    const request = authedRequest('https://x/api/users/999999/room-layout-access', managerAToken, 'PATCH', { canManageRoomLayout: true });
    const response = await setRoomLayoutAccess({ request, env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects a non-boolean value (400)', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/room-layout-access`, managerAToken, 'PATCH', { canManageRoomLayout: 'yes' });
    const response = await setRoomLayoutAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:once -- userManagement`
Expected: FAIL — endpoint file doesn't exist.

- [ ] **Step 3: Create the endpoint**

```js
// v4/functions/api/users/[id]/room-layout-access.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { canManageRoomLayout } = body || {};

  if (typeof canManageRoomLayout !== 'boolean') {
    return jsonError('Giá trị không hợp lệ', 400);
  }

  const target = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE id = ?`).bind(params.id).first();
  if (!target) {
    return jsonError('Không tìm thấy tài khoản', 404);
  }

  await env.DB.prepare(`UPDATE staff_accounts SET can_manage_room_layout = ? WHERE id = ?`).bind(canManageRoomLayout ? 1 : 0, params.id).run();
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:once -- userManagement`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/api/users/[id]/room-layout-access.js test/userManagement.test.js
git commit -m "Add PATCH /api/users/:id/room-layout-access"
```

---

### Task 7: Users page — layout-permission checkbox

**Files:**
- Modify: `v4/admin/users.js`

**Interfaces:**
- Consumes: `PATCH /api/users/:id/room-layout-access` (Task 6). `GET /api/users` already returns full rows per-account — this task adds `can_manage_room_layout` to the columns rendered, sourced from the same existing response (confirm the field name the `GET /api/users` response actually uses by reading `functions/api/users/index.js`'s `SELECT` before wiring the checkbox's initial `checked` state — likely `canManageRoomLayout` if the SELECT is updated to alias it, or `can_manage_room_layout` if not; this task includes updating that SELECT to alias it consistently with the rest of this codebase's camelCase API convention).

- [ ] **Step 1: Add `canManageRoomLayout` to `GET /api/users`'s response**

In `functions/api/users/index.js`'s `onRequestGet`, change:

```js
  const { results } = await env.DB.prepare(
    `SELECT id, username, role, created_at AS createdAt FROM staff_accounts ORDER BY username`
  ).all();
```

to:

```js
  const { results } = await env.DB.prepare(
    `SELECT id, username, role, can_manage_room_layout AS canManageRoomLayout, created_at AS createdAt FROM staff_accounts ORDER BY username`
  ).all();
```

- [ ] **Step 2: Add the checkbox to `users.js`'s per-row rendering**

In `admin/users.js`'s `loadUsers()`, after the existing `tdRole.appendChild(roleSelect);` line, add a new cell:

```js
    const tdLayout = document.createElement('td');
    const layoutCheckbox = document.createElement('input');
    layoutCheckbox.type = 'checkbox';
    layoutCheckbox.checked = !!u.canManageRoomLayout;
    layoutCheckbox.title = 'Quản trị bố cục phòng';
    layoutCheckbox.addEventListener('change', async () => {
      const response = await fetch(`/api/users/${u.id}/room-layout-access`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canManageRoomLayout: layoutCheckbox.checked }),
      });
      const listError = document.getElementById('listError');
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        listError.textContent = body.error || 'Có lỗi khi cập nhật quyền bố cục phòng';
        layoutCheckbox.checked = !layoutCheckbox.checked;
        return;
      }
      listError.textContent = '';
    });
    tdLayout.appendChild(layoutCheckbox);
```

Then change the row-assembly line from:

```js
    tr.append(tdName, tdRole, tdCreated, tdActions);
```

to:

```js
    tr.append(tdName, tdRole, tdLayout, tdCreated, tdActions);
```

- [ ] **Step 3: Add the matching header cell in `users.html`**

In `admin/users.html`, the `<thead>` row currently reads:

```html
        <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Ngày tạo</th><th></th></tr></thead>
```

Change to:

```html
        <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Bố cục phòng</th><th>Ngày tạo</th><th></th></tr></thead>
```

- [ ] **Step 4: Manual verification**

No automated test exists for this page's JS (consistent with `users.js`'s existing lack of coverage — it's exercised only via the outer repo's Playwright `crm-users.spec.js`, which this task doesn't need to extend since it doesn't test this specific checkbox). Read both files back and confirm the checkbox's `checked` state reads `u.canManageRoomLayout`, the `<thead>` column count now matches the `<tbody>` row's cell count (5, not 4), and the endpoint URL matches Task 6's route exactly.

- [ ] **Step 5: Commit**

```bash
git add admin/users.js admin/users.html functions/api/users/index.js
git commit -m "Add room-layout-permission checkbox to user management"
```

---

### Task 8: Reception ops board markup — filters, save button, history section, status colors

**Files:**
- Modify: `v4/admin/reception.html`
- Modify: `v4/admin/admin.css`

**Interfaces:**
- Produces: new DOM ids `roomDateFilter`, `roomStatusFilter`, `saveRoomOrderBtn` (initially hidden), `roomLayoutHistory`, consumed by Task 9's `reception.js` changes. New CSS classes `.room-booked`, `.room-booked_deposited`, `.room-used`, `.room-needs-cleaning-badge`.

- [ ] **Step 1: Add the filter controls and save button above the room grid**

In `admin/reception.html`, change:

```html
    <h2>Trạng thái phòng</h2>
    <div id="roomsGrid" class="rooms-grid"></div>
```

to:

```html
    <h2>Trạng thái phòng</h2>
    <div class="room-filters">
      <label>Ngày <input type="date" id="roomDateFilter" /></label>
      <label>Trạng thái
        <select id="roomStatusFilter">
          <option value="">Tất cả</option>
          <option value="empty">Phòng trống</option>
          <option value="booked">Đã có khách đặt</option>
          <option value="booked_deposited">Đã đặt & có cọc</option>
          <option value="occupied">Đang có khách</option>
          <option value="used">Đã sử dụng</option>
        </select>
      </label>
      <button type="button" id="saveRoomOrderBtn" class="hidden">Lưu bố cục</button>
    </div>
    <div id="roomsGrid" class="rooms-grid"></div>
    <div id="roomLayoutHistory" class="room-layout-history"></div>
```

- [ ] **Step 2: Add CSS for the new status colors and the needs-cleaning badge**

In `admin/admin.css`, after the existing room-status rules (`.room-empty`, `.room-occupied`, `.room-needs_cleaning`, `.room-draggable`, `.room-dragging`), add:

```css
.room-booked { background: rgba(217,166,92,0.15); }
.room-booked_deposited { background: rgba(120,160,220,0.18); }
.room-used { background: rgba(160,160,160,0.15); }
.room-needs-cleaning-badge { display: inline-block; margin-left: 6px; }
.room-filters { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
.room-layout-history { margin-top: 8px; font-size: 0.85rem; color: var(--text-muted); }
```

(`.room-occupied`'s existing color stays as-is — it's already used for the real-time "currently checked in" state and the date-scoped "occupied" state uses the identical status key, so no separate rule is needed.)

- [ ] **Step 3: Manual verification**

Read both files back. Confirm `roomsGrid`'s existing id/class are unchanged (Task 9's JS still targets it), the new elements' ids exactly match what's listed in this task's Interfaces section, and `#saveRoomOrderBtn` starts with class `hidden` (already defined in `admin.css` as `display: none !important;`).

- [ ] **Step 4: Commit**

```bash
git add admin/reception.html admin/admin.css
git commit -m "Add room status filters, save-layout button, and history section markup"
```

---

### Task 9: Reception ops board JS — filters, staged drag-and-save, deposit input, history

**Files:**
- Modify: `v4/admin/reception.js`

**Interfaces:**
- Consumes: `GET /api/rooms?date=`, `PATCH /api/rooms/reorder`, `GET /api/rooms/layout-log`, `PATCH /api/bookings/:id/deposit`, `canManageRoomLayout` from `/api/auth/me` (all from Tasks 2-6), and the DOM ids from Task 8.

- [ ] **Step 1: Track `canManageRoomLayout` and wire the filter controls**

Change the top-level auth IIFE from:

```js
(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;
  if (currentRole === 'observer') {
    document.getElementById('newBookingSection').classList.add('hidden');
    document.getElementById('promoLookupSection').classList.add('hidden');
  }
  await refreshAll();
})();
```

to:

```js
let canManageRoomLayout = false;

(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role, canManageRoomLayout: layoutFlag } = await res.json();
  currentRole = role;
  canManageRoomLayout = !!layoutFlag;
  if (currentRole === 'observer') {
    document.getElementById('newBookingSection').classList.add('hidden');
    document.getElementById('promoLookupSection').classList.add('hidden');
  }
  document.getElementById('roomDateFilter').value = todayISO();
  document.getElementById('roomDateFilter').addEventListener('change', loadRooms);
  document.getElementById('roomStatusFilter').addEventListener('change', applyRoomStatusFilter);
  await refreshAll();
  await loadLayoutHistory();
})();
```

- [ ] **Step 2: Add the deposit input to booking cards for pending/confirmed bookings**

Change `renderBookingCard` from:

```js
function renderBookingCard(b) {
  const card = document.createElement('div');
  card.className = 'booking-card';

  const nameLine = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = b.guestName;
  nameLine.appendChild(strong);
  nameLine.appendChild(document.createTextNode(` — ${b.phone || '—'}`));
  card.appendChild(nameLine);

  const detailLine = document.createElement('p');
  detailLine.textContent = `${ROOM_TYPE_LABELS[b.roomType] || b.roomType} — ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}${b.guestsCount ? ` — ${b.guestsCount} khách` : ''}`;
  card.appendChild(detailLine);

  if (b.notes) {
    const notesLine = document.createElement('p');
    notesLine.textContent = `Ghi chú: ${b.notes}`;
    card.appendChild(notesLine);
  }

  const statusLine = document.createElement('p');
  const badge = document.createElement('span');
  badge.className = `status-badge status-${b.status}`;
  badge.textContent = statusLabel(b.status);
  statusLine.appendChild(badge);
  card.appendChild(statusLine);

  const actions = document.createElement('div');
  actions.className = 'booking-actions';
  card.appendChild(actions);

  return { card, actions };
}
```

to:

```js
function renderBookingCard(b) {
  const card = document.createElement('div');
  card.className = 'booking-card';

  const nameLine = document.createElement('p');
  const strong = document.createElement('strong');
  strong.textContent = b.guestName;
  nameLine.appendChild(strong);
  nameLine.appendChild(document.createTextNode(` — ${b.phone || '—'}`));
  card.appendChild(nameLine);

  const detailLine = document.createElement('p');
  detailLine.textContent = `${ROOM_TYPE_LABELS[b.roomType] || b.roomType} — ${formatDate(b.checkIn)} → ${formatDate(b.checkOut)}${b.guestsCount ? ` — ${b.guestsCount} khách` : ''}`;
  card.appendChild(detailLine);

  if (b.notes) {
    const notesLine = document.createElement('p');
    notesLine.textContent = `Ghi chú: ${b.notes}`;
    card.appendChild(notesLine);
  }

  const statusLine = document.createElement('p');
  const badge = document.createElement('span');
  badge.className = `status-badge status-${b.status}`;
  badge.textContent = statusLabel(b.status);
  statusLine.appendChild(badge);
  card.appendChild(statusLine);

  if ((b.status === 'pending' || b.status === 'confirmed') && currentRole !== 'observer') {
    const depositLine = document.createElement('p');
    const depositInput = document.createElement('input');
    depositInput.type = 'number';
    depositInput.min = '0';
    depositInput.step = '1000';
    depositInput.value = b.depositAmount || 0;
    depositInput.style.width = '120px';
    const depositBtn = document.createElement('button');
    depositBtn.type = 'button';
    depositBtn.textContent = 'Lưu cọc';
    depositBtn.className = 'btn-secondary';
    depositBtn.addEventListener('click', async () => {
      const amount = Number(depositInput.value);
      if (!Number.isInteger(amount) || amount < 0) {
        showOpsError('Số tiền cọc phải là số nguyên không âm');
        return;
      }
      let response;
      try {
        response = await fetch(`/api/bookings/${b.id}/deposit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depositAmount: amount }),
        });
      } catch (err) {
        showOpsError('Có lỗi khi lưu tiền cọc');
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showOpsError(body.error || 'Có lỗi khi lưu tiền cọc');
        return;
      }
      showOpsError('');
    });
    depositLine.appendChild(document.createTextNode('Cọc: '));
    depositLine.appendChild(depositInput);
    depositLine.appendChild(document.createTextNode(' đ '));
    depositLine.appendChild(depositBtn);
    card.appendChild(depositLine);
  }

  const actions = document.createElement('div');
  actions.className = 'booking-actions';
  card.appendChild(actions);

  return { card, actions };
}
```

(`b.depositAmount` comes from the `GET /api/bookings` response, which Task 3 already extended to include this field.)

- [ ] **Step 3: Rewrite `loadRooms` for the date/status filter and staged drag**

Replace the full `loadRooms` function:

```js
let currentRoomsData = [];

async function loadRooms() {
  const date = document.getElementById('roomDateFilter').value || todayISO();
  let response;
  try {
    response = await fetch(`/api/rooms?date=${date}`);
  } catch (err) {
    showOpsError('Có lỗi khi tải trạng thái phòng');
    return;
  }
  if (!response.ok) {
    showOpsError('Có lỗi khi tải trạng thái phòng');
    return;
  }
  currentRoomsData = await response.json();
  renderRoomsGrid();
}

const ROOM_STATUS_LABELS = {
  empty: 'Trống',
  booked: 'Đã có khách đặt',
  booked_deposited: 'Đã đặt & có cọc',
  occupied: 'Đang có khách',
  used: 'Đã sử dụng',
  needs_cleaning: 'Cần dọn',
};

let roomOrderDirty = false;

function renderRoomsGrid() {
  const container = document.getElementById('roomsGrid');
  const statusFilter = document.getElementById('roomStatusFilter').value;
  const dateFilter = document.getElementById('roomDateFilter').value || todayISO();
  const isToday = dateFilter === todayISO();
  container.innerHTML = '';

  const visible = statusFilter ? currentRoomsData.filter((r) => r.status === statusFilter) : currentRoomsData;

  visible.forEach((r) => {
    const card = document.createElement('div');
    card.className = `room-card room-${r.status}`;
    card.dataset.roomId = r.id;
    if (canManageRoomLayout && isToday) {
      card.classList.add('room-draggable');
      card.style.touchAction = 'none';
    }

    const nameEl = document.createElement('div');
    nameEl.className = 'room-name';
    nameEl.textContent = r.name;
    card.appendChild(nameEl);

    const statusEl = document.createElement('div');
    statusEl.textContent = ROOM_STATUS_LABELS[r.status] || r.status;
    if (isToday && r.needsCleaning) {
      const badge = document.createElement('span');
      badge.className = 'room-needs-cleaning-badge';
      badge.title = 'Cần dọn';
      badge.textContent = '🧹';
      statusEl.appendChild(badge);
    }
    card.appendChild(statusEl);

    if (isToday && r.needsCleaning && currentRole !== 'observer') {
      const btn = document.createElement('button');
      btn.textContent = 'Đã dọn xong';
      btn.addEventListener('click', async () => {
        let cleanResponse;
        try {
          cleanResponse = await fetch(`/api/rooms/${r.id}/clean`, { method: 'POST' });
        } catch (err) {
          showOpsError('Có lỗi khi cập nhật trạng thái dọn phòng');
          return;
        }
        if (!cleanResponse.ok) {
          showOpsError('Có lỗi khi cập nhật trạng thái dọn phòng');
          return;
        }
        showOpsError('');
        await loadRooms();
      });
      card.appendChild(btn);
    }

    container.appendChild(card);
  });

  roomOrderDirty = false;
  document.getElementById('saveRoomOrderBtn').classList.add('hidden');

  if (canManageRoomLayout && isToday) {
    enableRoomDragAndDrop(container);
  }
}

function applyRoomStatusFilter() {
  renderRoomsGrid();
}
```

- [ ] **Step 4: Change drag-and-drop to stage locally instead of auto-saving**

Replace `enableRoomDragAndDrop` and `saveRoomOrder`:

```js
let draggedRoomCard = null;

function enableRoomDragAndDrop(container) {
  container.onpointerdown = (event) => {
    const card = event.target.closest('.room-card');
    if (!card || event.target.closest('button')) return;

    draggedRoomCard = card;
    card.classList.add('room-dragging');
    card.setPointerCapture(event.pointerId);

    container.onpointermove = (moveEvent) => {
      if (!draggedRoomCard) return;
      const cards = [...container.querySelectorAll('.room-card')];
      const draggedIndex = cards.indexOf(draggedRoomCard);
      let closest = null;
      let closestDistance = Infinity;
      cards.forEach((c) => {
        if (c === draggedRoomCard) return;
        const box = c.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const distance = Math.hypot(moveEvent.clientX - cx, moveEvent.clientY - cy);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = c;
        }
      });
      if (!closest) return;
      const closestIndex = cards.indexOf(closest);
      if (closestIndex < draggedIndex) {
        container.insertBefore(draggedRoomCard, closest);
      } else {
        container.insertBefore(draggedRoomCard, closest.nextSibling);
      }
    };

    container.onpointerup = () => {
      container.onpointermove = null;
      container.onpointerup = null;
      if (draggedRoomCard) {
        draggedRoomCard.classList.remove('room-dragging');
        draggedRoomCard = null;
      }
      roomOrderDirty = true;
      document.getElementById('saveRoomOrderBtn').classList.remove('hidden');
    };
  };
}

document.getElementById('saveRoomOrderBtn').addEventListener('click', async () => {
  const container = document.getElementById('roomsGrid');
  const orderedIds = [...container.querySelectorAll('.room-card')].map((c) => Number(c.dataset.roomId));
  let response;
  try {
    response = await fetch('/api/rooms/reorder', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: orderedIds }),
    });
  } catch (err) {
    showOpsError('Có lỗi khi lưu thứ tự phòng');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showOpsError(body.error || 'Có lỗi khi lưu thứ tự phòng');
    return;
  }
  showOpsError('');
  roomOrderDirty = false;
  document.getElementById('saveRoomOrderBtn').classList.add('hidden');
  await loadLayoutHistory();
});
```

(Note: the "Lưu bố cục" button click handler reads room order directly from the DOM's current state, and applies regardless of the active status filter — dragging only reorders visible cards, so saving while a status filter narrows the grid would silently drop the filtered-out rooms from the new order. Since the reorder endpoint validates that the submitted `order` array covers every active room exactly, this would 400. To keep this simple and match the spec's "reordering only makes sense for the live board" framing, add one line at the very top of `enableRoomDragAndDrop`'s `onpointerdown` handler: `if (document.getElementById('roomStatusFilter').value) return;` — i.e. dragging is inert whenever a status filter narrows the grid, only active when the filter is "Tất cả". This is a small addition beyond the literal snippets above; include it.)

- [ ] **Step 5: Add `loadLayoutHistory`**

Add this new function anywhere after `renderRoomsGrid`:

```js
async function loadLayoutHistory() {
  let response;
  try {
    response = await fetch('/api/rooms/layout-log?limit=5');
  } catch (err) {
    return;
  }
  if (!response.ok) return;
  const entries = await response.json();
  const container = document.getElementById('roomLayoutHistory');
  container.innerHTML = '';
  if (entries.length === 0) return;
  const title = document.createElement('p');
  title.innerHTML = '<strong>Lịch sử sắp xếp gần đây</strong>';
  container.appendChild(title);
  entries.forEach((e) => {
    const p = document.createElement('p');
    p.textContent = `${e.changedBy} đã cập nhật bố cục — ${new Date(e.changedAt).toLocaleString('vi-VN')}`;
    container.appendChild(p);
  });
}
```

- [ ] **Step 6: Manual verification**

Read the full modified file back. Confirm: `loadRooms` is still called from `refreshAll` (unchanged) and now also from the date filter's `change` listener; `currentRoomsData` is populated before `renderRoomsGrid` ever runs; the old unconditional `if (currentRole === 'manager') { enableRoomDragAndDrop(container); }` block at the end of the old `loadRooms` is fully gone, replaced by the `canManageRoomLayout && isToday` check inside `renderRoomsGrid`; no leftover reference to the deleted top-level `saveRoomOrder` function name remains anywhere in the file.

- [ ] **Step 7: Commit**

```bash
git add admin/reception.js
git commit -m "Wire room status filters, staged drag-and-save, deposit input, and layout history"
```

---

### Task 10: End-to-end verification

**Files:**
- Modify: `tests/e2e/reception-ops-board.spec.js` (outer repo)

**Interfaces:**
- Consumes: everything from Tasks 1-9.

- [ ] **Step 1: Write the failing tests**

Read the current file first (it already has three tests: redirect-to-login, a happy-path confirm flow, and the observer read-only test from an earlier plan). Add, following its existing `page.route` mocking style:

```js
  test('date filter re-fetches room status for the chosen date', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let requestedDate = null;
    await page.route('**/api/rooms?**', (route) => {
      requestedDate = new URL(route.request().url()).searchParams.get('date');
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Triangle 1', roomType: 'triangle', status: 'empty', needsCleaning: false }]) });
    });
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await page.locator('#roomDateFilter').fill('2026-09-15');
    await expect.poll(() => requestedDate).toBe('2026-09-15');
  });

  test('an account without the layout flag cannot drag rooms', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Triangle 1', roomType: 'triangle', status: 'empty', needsCleaning: false }]) }));
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    const card = page.locator('.room-card').first();
    await expect(card).not.toHaveClass(/room-draggable/);
    await expect(page.locator('#saveRoomOrderBtn')).toBeHidden();
  });

  test('an account with the layout flag can drag and must explicitly save', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'vinhdx', role: 'manager', canManageRoomLayout: true }) }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, name: 'Triangle 1', roomType: 'triangle', status: 'empty', needsCleaning: false },
          { id: 2, name: 'Triangle 2', roomType: 'triangle', status: 'empty', needsCleaning: false },
        ]),
      })
    );
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let reorderCalled = false;
    await page.route('**/api/rooms/reorder', (route) => {
      reorderCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await page.locator('.room-card').first().scrollIntoViewIfNeeded();
    const cards = page.locator('.room-card');
    await expect(cards.first()).toHaveClass(/room-draggable/);

    const firstBox = await cards.nth(0).boundingBox();
    const secondBox = await cards.nth(1).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 5 });
    await page.mouse.up();

    expect(reorderCalled).toBe(false);
    await expect(page.locator('#saveRoomOrderBtn')).toBeVisible();
    await page.click('#saveRoomOrderBtn');
    await expect.poll(() => reorderCalled).toBe(true);
  });

  test('observer never sees the deposit input', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, guestName: 'Khách A', phone: null, roomType: 'triangle', checkIn: '2026-09-01', checkOut: '2026-09-02', status: 'pending', depositAmount: 0 }]) })
    );
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#pendingList')).toContainText('Khách A');
    await expect(page.locator('#pendingList input[type="number"]')).toHaveCount(0);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (per this project's local http-server + Playwright pattern, from `v4/`: `npx http-server . -p 4174 -s -c-1` in background, curl-check, then from the outer repo): `npx playwright test reception-ops-board --project=v4 --reporter=list`
Expected: FAIL on the four new tests (the filter controls, staged-save behavior, and layout flag gating don't exist in the pre-Task-8/9 code — but Tasks 1-9 should already be committed by the time this task runs, so this should only fail if something in Tasks 1-9 was missed; if all of Tasks 1-9 are correctly in place, some of these may already pass — run them regardless to confirm real behavior, not assumed behavior).

- [ ] **Step 3: Run the full v4 Playwright project**

Run: `npx playwright test --project=v4 --reporter=list`
Expected: all tests pass, including the four new ones and every pre-existing test (in particular, the existing `reception-ops-board.spec.js` tests that assume the old auto-save-on-drop and role-based `manager` drag gating — read those existing tests too, and update any that now contradict the new staged-save/flag-based behavior, following this same file's established mocking patterns).

- [ ] **Step 4: Clean up**

Find and kill the http-server process: `netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>`.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reception-ops-board.spec.js
git commit -m "Add e2e coverage for room status filters, staged layout save, and deposit visibility"
```
