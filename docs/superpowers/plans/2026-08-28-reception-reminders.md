# Reception Reminders Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "🔔 Nhắc việc hôm nay" reminders section to the reception ops board, surfacing three configurable-threshold alerts (pending bookings without a deposit, today's arrivals, rooms uncleaned too long) computed from existing booking/room data plus one small new timestamp column.

**Architecture:** One migration (a nullable timestamp column on `rooms` + a new single-row `reminder_settings` table), two existing write sites gain one extra column write each, one new `lib/receptionReminders.js` module (mirrors `lib/dashboardMetrics.js`), two new read/write endpoint files, and two admin-page frontend additions (reception ops board + manager config page).

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS admin frontend, vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/specs/2026-08-28-reception-reminders-design.md`

## Global Constraints

- `rooms.needs_cleaning_since` is nullable, no `CHECK` constraint (matches this codebase's convention for `ALTER TABLE`-added columns).
- `reminder_settings` follows the `notification_settings` pattern: every update **inserts a new row**, never an in-place `UPDATE`; the current values are always the row with the highest `id`.
- Exactly two existing files write `rooms.needs_cleaning`: `functions/api/bookings/[id]/check-out.js` (sets it to `1`) and `functions/api/rooms/[id]/clean.js` (sets it to `0`). Both must now also write/clear `needs_cleaning_since` in the same `UPDATE` statement. No other file touches this column.
- `GET /api/reception/reminders` and `GET /api/reminder-settings`: `requireAuth(request, env, ['reception', 'manager', 'admin', 'observer'])` — same viewer set as the rest of the reception ops board.
- `PATCH /api/reminder-settings`: `requireAuth(request, env, ['admin'])` — matches this codebase's established convention for admin-config writes (`catalog`, `cancellation-policy`).
- Default thresholds: 2 hours (pending-without-deposit), 60 minutes (room not cleaned).
- `lib/receptionReminders.js`'s `getReminders(env)` must fall back to `{ pendingDepositHours: 2, cleaningMinutes: 60 }` in JS if `reminder_settings` is ever empty — never assume a row exists, even though the migration seeds one.
- A room with `needs_cleaning = 1` and a `NULL` `needs_cleaning_since` (a pre-migration historical gap) must never appear in the "rooms not cleaned" reminder — guard with `needs_cleaning_since IS NOT NULL` in that query.
- No action buttons on reminder rows — informational only, per spec's explicit out-of-scope section.
- The pre-existing `currentRole === 'manager'`-only gating of other sections on `admin/manager.js` (excluding `admin` from `policyForm`/`giftInventorySection`/`notifySettingsSection`) is untouched — the new reminder-settings section gets its own independent `currentRole === 'admin'` gate, matching its endpoint's actual `['admin']`-only write access.

---

### Task 1: `needs_cleaning_since` column + `reminder_settings` table + write-site wiring

**Files:**
- Create: `migrations/0013_reception_reminders.sql`
- Modify: `functions/api/bookings/[id]/check-out.js`
- Modify: `functions/api/rooms/[id]/clean.js`
- Test: `test/bookingLifecycle.test.js` (extend the existing `describe('POST /api/bookings/:id/check-out', ...)` block)
- Test: `test/roomsEndpoints.test.js` (extend the existing `describe('POST /api/rooms/:id/clean', ...)` block)

**Interfaces:**
- Produces: `rooms.needs_cleaning_since` (nullable TEXT, ISO timestamp) — set whenever `needs_cleaning` becomes `1`, cleared to `NULL` whenever it becomes `0`. Task 3's SQL queries depend on this column existing and being correctly maintained.
- Produces: `reminder_settings` table (`id, pending_deposit_hours, cleaning_minutes, updated_by, updated_at`), seeded with one row `(2, 60, ...)`. Tasks 2 and 3 both read/write this table.

- [ ] **Step 1: Write the migration**

```sql
-- v4/migrations/0013_reception_reminders.sql
ALTER TABLE rooms ADD COLUMN needs_cleaning_since TEXT;

CREATE TABLE reminder_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_deposit_hours INTEGER NOT NULL DEFAULT 2,
  cleaning_minutes INTEGER NOT NULL DEFAULT 60,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO reminder_settings (pending_deposit_hours, cleaning_minutes, updated_at)
VALUES (2, 60, '2026-08-28T00:00:00Z');
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx wrangler d1 migrations apply hien_le_garden_crm --local`
Expected: `0013_reception_reminders.sql` listed with a ✅ status.

- [ ] **Step 3: Write the failing tests**

Add inside the existing `describe('POST /api/bookings/:id/check-out', ...)` block in `test/bookingLifecycle.test.js`, right after the `'checks out a checked-in booking and flags its room for cleaning'` test:

```js
  it('records when the room started needing cleaning', async () => {
    await confirmBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/confirm`, managerToken, { rooms: [{ roomType: 'circle', roomId: circleRoomId }] }), env, params: { id: String(pendingBookingId) } });
    await checkInBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-in`, managerToken), env, params: { id: String(pendingBookingId) } });

    const before = new Date().toISOString();
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-out`, managerToken),
      env,
      params: { id: String(pendingBookingId) },
    });
    expect(response.status).toBe(200);

    const roomRow = await env.DB.prepare(`SELECT needs_cleaning_since FROM rooms WHERE id = ?`).bind(circleRoomId).first();
    expect(roomRow.needs_cleaning_since).not.toBeNull();
    expect(roomRow.needs_cleaning_since >= before).toBe(true);
  });
```

Add inside the existing `describe('POST /api/rooms/:id/clean', ...)` block in `test/roomsEndpoints.test.js`, right after the `'clears the needs_cleaning flag'` test:

```js
  it('clears needs_cleaning_since alongside the flag', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'bungalow' ORDER BY id LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = '2026-08-01T00:00:00Z' WHERE id = ?`).bind(room.id).run();

    const response = await cleanRoom({ request: authedRequest(`https://x/api/rooms/${room.id}/clean`, 'POST'), env, params: { id: String(room.id) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT needs_cleaning_since FROM rooms WHERE id = ?`).bind(room.id).first();
    expect(row.needs_cleaning_since).toBeNull();
  });
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/bookingLifecycle.test.js`
Expected: FAIL — `roomRow.needs_cleaning_since` is `null` (column doesn't exist yet / not written).

Run: `npx vitest run test/roomsEndpoints.test.js`
Expected: FAIL — same reason (column doesn't exist yet locally until Step 2's migration is applied; if Step 2 was already run, this fails instead because the write site doesn't set it yet).

- [ ] **Step 5: Implement the write-site changes**

In `functions/api/bookings/[id]/check-out.js`, replace the room-update statement:

```js
  const statements = [
    env.DB.prepare(`UPDATE bookings SET status = 'checked_out' WHERE id = ?`).bind(params.id),
  ];
  if (booking.room_id) {
    statements.push(env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1 WHERE id = ?`).bind(booking.room_id));
  }
  await env.DB.batch(statements);
```

with:

```js
  const statements = [
    env.DB.prepare(`UPDATE bookings SET status = 'checked_out' WHERE id = ?`).bind(params.id),
  ];
  if (booking.room_id) {
    statements.push(env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = ? WHERE id = ?`).bind(new Date().toISOString(), booking.room_id));
  }
  await env.DB.batch(statements);
```

In `functions/api/rooms/[id]/clean.js`, replace:

```js
  await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 0 WHERE id = ?`).bind(params.id).run();
```

with:

```js
  await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 0, needs_cleaning_since = NULL WHERE id = ?`).bind(params.id).run();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/bookingLifecycle.test.js`
Expected: PASS (all tests in the file). If it fails with an "Isolated storage failed" / AssertionError teardown-only error after otherwise-passing test lines, retry the exact same single-file command up to 2 more times — this is a known Windows Miniflare teardown flake, not a code defect.

Run: `npx vitest run test/roomsEndpoints.test.js`
Expected: PASS (all tests in the file). Same retry note applies.

- [ ] **Step 7: Commit**

```bash
git add migrations/0013_reception_reminders.sql "functions/api/bookings/[id]/check-out.js" "functions/api/rooms/[id]/clean.js" test/bookingLifecycle.test.js test/roomsEndpoints.test.js
git commit -m "feat: track needs_cleaning_since and add reminder_settings table"
```

---

### Task 2: `GET`/`PATCH /api/reminder-settings`

**Files:**
- Create: `functions/api/reminder-settings.js`
- Test: `test/reminderSettings.test.js`

**Interfaces:**
- Consumes: `reminder_settings` table from Task 1.
- Produces: `GET /api/reminder-settings` → `200` `{ pendingDepositHours, cleaningMinutes, updatedAt }` (or `{ pendingDepositHours: 2, cleaningMinutes: 60, updatedAt: null }` if the table is empty). `PATCH /api/reminder-settings` with body `{ pendingDepositHours, cleaningMinutes }` → `200` `{ ok: true }` on success, `400` for a non-integer or non-positive value in either field. Task 6 (manager.js frontend) consumes both of these exactly.

- [ ] **Step 1: Write the failing test**

```js
// v4/test/reminderSettings.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getSettings, onRequestPatch as patchSettings } from '../functions/api/reminder-settings.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM reminder_settings');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_r', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'le_tan_r', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  receptionToken = await createSession(env.DB, 2);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'admin_r', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 3);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (4, 'quan_sat_r', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  observerToken = await createSession(env.DB, 4);
});

function authedRequest(url, token, method = 'GET', body) {
  const headers = token ? { Cookie: `session=${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/reminder-settings', () => {
  it('returns the default 2/60 when the table is empty', async () => {
    const response = await getSettings({ request: authedRequest('https://x/api/reminder-settings', managerToken), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ pendingDepositHours: 2, cleaningMinutes: 60, updatedAt: null });
  });

  it('returns the seeded values when a row exists', async () => {
    await env.DB.prepare(`INSERT INTO reminder_settings (pending_deposit_hours, cleaning_minutes, updated_at) VALUES (3, 90, '2026-08-27T00:00:00Z')`).run();
    const response = await getSettings({ request: authedRequest('https://x/api/reminder-settings', receptionToken), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pendingDepositHours).toBe(3);
    expect(body.cleaningMinutes).toBe(90);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await getSettings({ request: new Request('https://x/api/reminder-settings'), env });
    expect(response.status).toBe(401);
  });
});

describe('PATCH /api/reminder-settings', () => {
  it('lets an admin update the thresholds', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/reminder-settings', adminToken, 'PATCH', { pendingDepositHours: 4, cleaningMinutes: 45 }), env });
    expect(response.status).toBe(200);

    const getResponse = await getSettings({ request: authedRequest('https://x/api/reminder-settings', adminToken), env });
    const body = await getResponse.json();
    expect(body.pendingDepositHours).toBe(4);
    expect(body.cleaningMinutes).toBe(45);
  });

  it('inserts a new row rather than mutating the existing one', async () => {
    await patchSettings({ request: authedRequest('https://x/api/reminder-settings', adminToken, 'PATCH', { pendingDepositHours: 4, cleaningMinutes: 45 }), env });
    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reminder_settings`).first();
    expect(countRow.n).toBe(1);

    await patchSettings({ request: authedRequest('https://x/api/reminder-settings', adminToken, 'PATCH', { pendingDepositHours: 5, cleaningMinutes: 30 }), env });
    const countRow2 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reminder_settings`).first();
    expect(countRow2.n).toBe(2);
  });

  it('rejects a manager (403) -- admin-only', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/reminder-settings', managerToken, 'PATCH', { pendingDepositHours: 4, cleaningMinutes: 45 }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a reception account (403)', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/reminder-settings', receptionToken, 'PATCH', { pendingDepositHours: 4, cleaningMinutes: 45 }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a zero value (400)', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/reminder-settings', adminToken, 'PATCH', { pendingDepositHours: 0, cleaningMinutes: 45 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a non-integer value (400)', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/reminder-settings', adminToken, 'PATCH', { pendingDepositHours: 2.5, cleaningMinutes: 45 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await patchSettings({ request: new Request('https://x/api/reminder-settings', { method: 'PATCH' }), env });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/reminderSettings.test.js`
Expected: FAIL — `Cannot find module '../functions/api/reminder-settings.js'`

- [ ] **Step 3: Implement the endpoint**

```js
// v4/functions/api/reminder-settings.js
import { requireAuth } from '../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(
    `SELECT pending_deposit_hours AS pendingDepositHours, cleaning_minutes AS cleaningMinutes, updated_at AS updatedAt FROM reminder_settings ORDER BY id DESC LIMIT 1`
  ).first();

  const result = row || { pendingDepositHours: 2, cleaningMinutes: 60, updatedAt: null };
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { pendingDepositHours, cleaningMinutes } = body || {};

  if (!Number.isInteger(pendingDepositHours) || pendingDepositHours <= 0 || !Number.isInteger(cleaningMinutes) || cleaningMinutes <= 0) {
    return jsonError('Số giờ/phút phải là số nguyên dương', 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO reminder_settings (pending_deposit_hours, cleaning_minutes, updated_by, updated_at) VALUES (?, ?, ?, ?)`
  ).bind(pendingDepositHours, cleaningMinutes, auth.username, now).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/reminderSettings.test.js`
Expected: PASS (11 tests). Retry once or twice on the known Windows teardown-only flake before treating a failure as real.

- [ ] **Step 5: Commit**

```bash
git add functions/api/reminder-settings.js test/reminderSettings.test.js
git commit -m "feat: add GET/PATCH /api/reminder-settings"
```

---

### Task 3: `lib/receptionReminders.js` + `GET /api/reception/reminders`

**Files:**
- Create: `lib/receptionReminders.js`
- Create: `functions/api/reception/reminders.js`
- Test: `test/receptionReminders.test.js`

**Interfaces:**
- Consumes: `reminder_settings`, `bookings`, `rooms` tables (Task 1 for the new column/table; `bookings`/`rooms` already exist).
- Produces: `getReminders(env)` returning `{ pendingNoDeposit: [{id, guestName, phone, createdAt, hoursWaiting}], arrivingToday: [{id, guestName, phone, roomType, checkIn}], roomsNotCleaned: [{id, name, roomType, needsCleaningSince, minutesWaiting}], thresholds: {pendingDepositHours, cleaningMinutes} }`. Produces `GET /api/reception/reminders` → `200` with that exact object as JSON. Task 4 (reception.js frontend) consumes this response shape exactly.

- [ ] **Step 1: Write the failing test**

```js
// v4/test/receptionReminders.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getReminders } from '../lib/receptionReminders.js';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM bookings');
  await env.DB.exec('DELETE FROM reminder_settings');
  await env.DB.exec('UPDATE rooms SET needs_cleaning = 0, needs_cleaning_since = NULL');
  await env.DB.prepare(`INSERT INTO reminder_settings (pending_deposit_hours, cleaning_minutes, updated_at) VALUES (2, 60, '2026-08-01T00:00:00Z')`).run();
});

describe('getReminders', () => {
  it('returns empty lists when there is nothing to flag', async () => {
    const result = await getReminders(env);
    expect(result.pendingNoDeposit).toEqual([]);
    expect(result.arrivingToday).toEqual([]);
    expect(result.roomsNotCleaned).toEqual([]);
    expect(result.thresholds).toEqual({ pendingDepositHours: 2, cleaningMinutes: 60 });
  });

  it('flags a pending booking older than the deposit threshold with no deposit', async () => {
    const old = new Date(Date.now() - 3 * 3600000).toISOString();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('Old Pending', '090', 'circle', '2099-01-01', '2099-01-03', 'pending', 'website', 0, ?)`
    ).bind(old).run();

    const result = await getReminders(env);
    expect(result.pendingNoDeposit.length).toBe(1);
    expect(result.pendingNoDeposit[0].guestName).toBe('Old Pending');
    expect(result.pendingNoDeposit[0].hoursWaiting).toBeGreaterThanOrEqual(3);
  });

  it('does not flag a pending booking younger than the deposit threshold', async () => {
    const recent = new Date(Date.now() - 30 * 60000).toISOString();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('Recent Pending', '090', 'circle', '2099-01-01', '2099-01-03', 'pending', 'website', 0, ?)`
    ).bind(recent).run();

    const result = await getReminders(env);
    expect(result.pendingNoDeposit).toEqual([]);
  });

  it('does not flag an old pending booking that already has a deposit', async () => {
    const old = new Date(Date.now() - 3 * 3600000).toISOString();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('Deposited', '090', 'circle', '2099-01-01', '2099-01-03', 'pending', 'website', 100000, ?)`
    ).bind(old).run();

    const result = await getReminders(env);
    expect(result.pendingNoDeposit).toEqual([]);
  });

  it('does not flag an old confirmed booking (not pending) even without a deposit', async () => {
    const old = new Date(Date.now() - 3 * 3600000).toISOString();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('Confirmed No Deposit', '090', 'circle', '2099-01-01', '2099-01-03', 'confirmed', 'website', 0, ?)`
    ).bind(old).run();

    const result = await getReminders(env);
    expect(result.pendingNoDeposit).toEqual([]);
  });

  it('flags a confirmed booking checking in today', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Arriving Today', '090', 'circle', ?, '2099-01-03', 'confirmed', 'website', '2026-08-01T00:00:00Z')`
    ).bind(today).run();

    const result = await getReminders(env);
    expect(result.arrivingToday.length).toBe(1);
    expect(result.arrivingToday[0].guestName).toBe('Arriving Today');
  });

  it('does not flag a confirmed booking checking in tomorrow', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Arriving Tomorrow', '090', 'circle', ?, '2099-01-03', 'confirmed', 'website', '2026-08-01T00:00:00Z')`
    ).bind(tomorrow).run();

    const result = await getReminders(env);
    expect(result.arrivingToday).toEqual([]);
  });

  it('does not flag a pending booking checking in today (not yet confirmed)', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Still Pending', '090', 'circle', ?, '2099-01-03', 'pending', 'website', '2026-08-01T00:00:00Z')`
    ).bind(today).run();

    const result = await getReminders(env);
    expect(result.arrivingToday).toEqual([]);
  });

  it('flags a room whose needs_cleaning_since is older than the cleaning threshold', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    const old = new Date(Date.now() - 90 * 60000).toISOString();
    await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = ? WHERE id = ?`).bind(old, room.id).run();

    const result = await getReminders(env);
    expect(result.roomsNotCleaned.length).toBe(1);
    expect(result.roomsNotCleaned[0].id).toBe(room.id);
    expect(result.roomsNotCleaned[0].minutesWaiting).toBeGreaterThanOrEqual(90);
  });

  it('does not flag a room whose needs_cleaning_since is within the cleaning threshold', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    const recent = new Date(Date.now() - 10 * 60000).toISOString();
    await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = ? WHERE id = ?`).bind(recent, room.id).run();

    const result = await getReminders(env);
    expect(result.roomsNotCleaned).toEqual([]);
  });

  it('does not flag a room with needs_cleaning = 0 regardless of needs_cleaning_since', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    const old = new Date(Date.now() - 90 * 60000).toISOString();
    await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 0, needs_cleaning_since = ? WHERE id = ?`).bind(old, room.id).run();

    const result = await getReminders(env);
    expect(result.roomsNotCleaned).toEqual([]);
  });

  it('does not flag a room with needs_cleaning = 1 but a NULL needs_cleaning_since (historical gap)', async () => {
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = NULL WHERE id = ?`).bind(room.id).run();

    const result = await getReminders(env);
    expect(result.roomsNotCleaned).toEqual([]);
  });

  it('respects a configured threshold different from the default', async () => {
    await env.DB.exec('DELETE FROM reminder_settings');
    await env.DB.prepare(`INSERT INTO reminder_settings (pending_deposit_hours, cleaning_minutes, updated_at) VALUES (1, 20, '2026-08-27T00:00:00Z')`).run();

    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE room_type = 'circle' ORDER BY id LIMIT 1`).first();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60000).toISOString();
    await env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = ? WHERE id = ?`).bind(thirtyMinAgo, room.id).run();

    // 30 minutes ago is older than a 20-minute threshold, so this now flags -- it would NOT
    // have flagged under the default 60-minute threshold, proving the configured value is read.
    const result = await getReminders(env);
    expect(result.roomsNotCleaned.length).toBe(1);
    expect(result.thresholds).toEqual({ pendingDepositHours: 1, cleaningMinutes: 20 });
  });

  it('falls back to the 2/60 default when reminder_settings is empty', async () => {
    await env.DB.exec('DELETE FROM reminder_settings');
    const result = await getReminders(env);
    expect(result.thresholds).toEqual({ pendingDepositHours: 2, cleaningMinutes: 60 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/receptionReminders.test.js`
Expected: FAIL — `Cannot find module '../lib/receptionReminders.js'`

- [ ] **Step 3: Implement `lib/receptionReminders.js`**

```js
// v4/lib/receptionReminders.js
export async function getReminders(env) {
  const settingsRow = await env.DB.prepare(
    `SELECT pending_deposit_hours AS pendingDepositHours, cleaning_minutes AS cleaningMinutes FROM reminder_settings ORDER BY id DESC LIMIT 1`
  ).first();
  const { pendingDepositHours, cleaningMinutes } = settingsRow || { pendingDepositHours: 2, cleaningMinutes: 60 };

  const now = new Date();
  const depositCutoff = new Date(now.getTime() - pendingDepositHours * 3600000).toISOString();
  const cleaningCutoff = new Date(now.getTime() - cleaningMinutes * 60000).toISOString();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

  const { results: pendingRows } = await env.DB.prepare(
    `SELECT id, guest_name AS guestName, phone, created_at AS createdAt
     FROM bookings
     WHERE status = 'pending' AND deposit_amount = 0 AND created_at < ?
     ORDER BY created_at ASC`
  ).bind(depositCutoff).all();
  const pendingNoDeposit = pendingRows.map((r) => ({
    ...r,
    hoursWaiting: Math.floor((now - Date.parse(r.createdAt)) / 3600000),
  }));

  const { results: arrivingRows } = await env.DB.prepare(
    `SELECT id, guest_name AS guestName, phone, room_type AS roomType, check_in AS checkIn
     FROM bookings
     WHERE status = 'confirmed' AND check_in = ?
     ORDER BY guest_name ASC`
  ).bind(today).all();

  const { results: roomRows } = await env.DB.prepare(
    `SELECT id, name, room_type AS roomType, needs_cleaning_since AS needsCleaningSince
     FROM rooms
     WHERE is_active = 1 AND needs_cleaning = 1 AND needs_cleaning_since IS NOT NULL AND needs_cleaning_since < ?
     ORDER BY needs_cleaning_since ASC`
  ).bind(cleaningCutoff).all();
  const roomsNotCleaned = roomRows.map((r) => ({
    ...r,
    minutesWaiting: Math.floor((now - Date.parse(r.needsCleaningSince)) / 60000),
  }));

  return {
    pendingNoDeposit,
    arrivingToday: arrivingRows,
    roomsNotCleaned,
    thresholds: { pendingDepositHours, cleaningMinutes },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/receptionReminders.test.js`
Expected: PASS (15 tests). Retry once or twice on the known Windows teardown-only flake before treating a failure as real.

- [ ] **Step 5: Implement the endpoint**

```js
// v4/functions/api/reception/reminders.js
import { requireAuth } from '../../../lib/requireAuth.js';
import { getReminders } from '../../../lib/receptionReminders.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const result = await getReminders(env);
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 6: Write the failing endpoint test**

```js
// v4/test/receptionRemindersEndpoint.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getReminders } from '../functions/api/reception/reminders.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM bookings');
  await env.DB.exec('UPDATE rooms SET needs_cleaning = 0, needs_cleaning_since = NULL');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_re', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'le_tan_re', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  receptionToken = await createSession(env.DB, 2);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'admin_re', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 3);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (4, 'quan_sat_re', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  observerToken = await createSession(env.DB, 4);
});

function authedRequest(url, token) {
  return new Request(url, { headers: token ? { Cookie: `session=${token}` } : {} });
}

describe('GET /api/reception/reminders', () => {
  it('returns the reminders shape', async () => {
    const response = await getReminders({ request: authedRequest('https://x/api/reception/reminders', managerToken), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('pendingNoDeposit');
    expect(body).toHaveProperty('arrivingToday');
    expect(body).toHaveProperty('roomsNotCleaned');
    expect(body).toHaveProperty('thresholds');
  });

  it('lets reception, manager, admin, and observer all view it', async () => {
    for (const token of [receptionToken, managerToken, adminToken, observerToken]) {
      const response = await getReminders({ request: authedRequest('https://x/api/reception/reminders', token), env });
      expect(response.status).toBe(200);
    }
  });

  it('rejects unauthenticated requests', async () => {
    const response = await getReminders({ request: new Request('https://x/api/reception/reminders'), env });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 7: Run the endpoint test to verify it passes**

Run: `npx vitest run test/receptionRemindersEndpoint.test.js`
Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add lib/receptionReminders.js functions/api/reception/reminders.js test/receptionReminders.test.js test/receptionRemindersEndpoint.test.js
git commit -m "feat: add getReminders lib and GET /api/reception/reminders"
```

---

### Task 4: Reminders section on the reception ops board

**Files:**
- Modify: `admin/reception.html`
- Modify: `admin/reception.js`

**Interfaces:**
- Consumes: `GET /api/reception/reminders` from Task 3, returning `{ pendingNoDeposit, arrivingToday, roomsNotCleaned, thresholds }` exactly as shaped there.

- [ ] **Step 1: Add the HTML section**

In `admin/reception.html`, right after `<p id="opsError" class="error"></p>` and before `<div id="newBookingSection">`, add:

```html
    <h2>🔔 Nhắc việc hôm nay</h2>
    <div id="remindersSection"></div>
```

- [ ] **Step 2: Add `loadReminders()` and wire it into `refreshAll()`**

In `admin/reception.js`, change:

```js
async function refreshAll() {
  await Promise.all([loadPending(), loadArrivals(), loadDepartures(), loadUpcomingConfirmed(), loadInhouse(), loadRooms()]);
}
```

to:

```js
async function refreshAll() {
  await Promise.all([loadPending(), loadArrivals(), loadDepartures(), loadUpcomingConfirmed(), loadInhouse(), loadRooms(), loadReminders()]);
}

async function loadReminders() {
  const container = document.getElementById('remindersSection');
  container.innerHTML = '';
  let response;
  try {
    response = await fetch('/api/reception/reminders');
  } catch (err) {
    return;
  }
  if (!response.ok) return;
  const data = await response.json();

  const { pendingNoDeposit, arrivingToday, roomsNotCleaned, thresholds } = data;

  if (pendingNoDeposit.length === 0 && arrivingToday.length === 0 && roomsNotCleaned.length === 0) {
    const okLine = document.createElement('p');
    okLine.textContent = '✅ Không có việc cần nhắc.';
    container.appendChild(okLine);
    return;
  }

  if (pendingNoDeposit.length > 0) {
    const heading = document.createElement('p');
    heading.innerHTML = `<strong>Chờ cọc quá ${thresholds.pendingDepositHours} giờ (${pendingNoDeposit.length})</strong>`;
    container.appendChild(heading);
    pendingNoDeposit.forEach((b) => {
      const p = document.createElement('p');
      p.textContent = `${b.guestName} — ${b.phone} — chờ ${b.hoursWaiting} giờ`;
      container.appendChild(p);
    });
  }

  if (arrivingToday.length > 0) {
    const heading = document.createElement('p');
    heading.innerHTML = `<strong>Khách sắp đến hôm nay (${arrivingToday.length})</strong>`;
    container.appendChild(heading);
    arrivingToday.forEach((b) => {
      const p = document.createElement('p');
      p.textContent = `${b.guestName} — ${b.phone} — ${ROOM_TYPE_LABELS[b.roomType] || b.roomType}`;
      container.appendChild(p);
    });
  }

  if (roomsNotCleaned.length > 0) {
    const heading = document.createElement('p');
    heading.innerHTML = `<strong>Phòng chưa dọn quá ${thresholds.cleaningMinutes} phút (${roomsNotCleaned.length})</strong>`;
    container.appendChild(heading);
    roomsNotCleaned.forEach((r) => {
      const p = document.createElement('p');
      p.textContent = `${r.name} — ${ROOM_TYPE_LABELS[r.roomType] || r.roomType} — ${r.minutesWaiting} phút`;
      container.appendChild(p);
    });
  }
}
```

- [ ] **Step 3: Manual verification**

Run: `npx http-server . -p 4174 -s -c-1` (background), wait for readiness
(`curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/admin/reception.html` returns `200`),
then confirm `admin/reception.js` parses (`node --check admin/reception.js`, since it's not
a Node module — this just checks for syntax errors) and visually confirm
the new `<h2>🔔 Nhắc việc hôm nay</h2>` markup is present in the served
HTML (`curl -s http://localhost:4174/admin/reception.html | grep "Nhắc việc"`).
Stop the server and free port 4174 afterward
(`netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>`).
Full behavioral verification (real login session, real data) happens via
the Playwright spec in Task 6.

- [ ] **Step 4: Commit**

```bash
git add admin/reception.html admin/reception.js
git commit -m "feat: show reminders section on the reception ops board"
```

---

### Task 5: Reminder-threshold settings form on the manager config page

**Files:**
- Modify: `admin/manager.html`
- Modify: `admin/manager.js`

**Interfaces:**
- Consumes: `GET`/`PATCH /api/reminder-settings` from Task 2.

- [ ] **Step 1: Add the HTML section**

In `admin/manager.html`, right after the closing `</div>` of `notifySettingsSection` and before the final closing `</div>` of `.page`, add:

```html
    <div id="reminderSettingsSection" class="hidden">
      <h2>Ngưỡng nhắc việc</h2>
      <form id="reminderSettingsForm">
        <label>Booking chờ quá (giờ) chưa có cọc <input type="number" name="pendingDepositHours" min="1" required /></label>
        <label>Phòng chưa dọn quá (phút) sau checkout <input type="number" name="cleaningMinutes" min="1" required /></label>
        <button type="submit">Lưu ngưỡng</button>
        <p id="reminderSettingsError" class="error"></p>
      </form>
    </div>
```

- [ ] **Step 2: Add the JS**

In `admin/manager.js`, add this function anywhere alongside the other `load*` functions (e.g. right after `loadNotifySettings`):

```js
async function loadReminderSettings() {
  const errorEl = document.getElementById('reminderSettingsError');
  let response;
  try {
    response = await fetch('/api/reminder-settings');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải ngưỡng nhắc việc';
    return;
  }
  if (!response.ok) {
    errorEl.textContent = 'Có lỗi khi tải ngưỡng nhắc việc';
    return;
  }
  const data = await response.json();
  const form = document.getElementById('reminderSettingsForm');
  form.querySelector('input[name="pendingDepositHours"]').value = data.pendingDepositHours;
  form.querySelector('input[name="cleaningMinutes"]').value = data.cleaningMinutes;
}
```

Add this submit handler alongside the existing `policyForm`/`giftForm` submit handlers:

```js
document.getElementById('reminderSettingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const errorEl = document.getElementById('reminderSettingsError');
  errorEl.textContent = '';

  const response = await fetch('/api/reminder-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pendingDepositHours: Number(data.get('pendingDepositHours')),
      cleaningMinutes: Number(data.get('cleaningMinutes')),
    }),
  });

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi khi lưu ngưỡng nhắc việc';
    return;
  }

  await loadReminderSettings();
});
```

Change the role-gating IIFE from:

```js
  if (currentRole === 'manager') {
    document.getElementById('policyForm').classList.remove('hidden');
    document.getElementById('policyDeleteHeader').classList.remove('hidden');
    document.getElementById('giftInventorySection').classList.remove('hidden');
    document.getElementById('notifySettingsSection').classList.remove('hidden');
    loadNotifySettings();
  }

  loadPolicies();
  loadGiftInventory();
})();
```

to:

```js
  if (currentRole === 'manager') {
    document.getElementById('policyForm').classList.remove('hidden');
    document.getElementById('policyDeleteHeader').classList.remove('hidden');
    document.getElementById('giftInventorySection').classList.remove('hidden');
    document.getElementById('notifySettingsSection').classList.remove('hidden');
    loadNotifySettings();
  }

  if (currentRole === 'admin') {
    document.getElementById('reminderSettingsSection').classList.remove('hidden');
    loadReminderSettings();
  }

  loadPolicies();
  loadGiftInventory();
})();
```

This adds the new independent `admin`-only gate without altering the existing `manager`-only gate on the other three sections (see Global Constraints).

- [ ] **Step 3: Manual verification**

Run: `node --check admin/manager.js` to confirm no syntax errors. Start the
local server as in Task 4 Step 3, confirm
`curl -s http://localhost:4174/admin/manager.html | grep "Ngưỡng nhắc việc"`
finds the new heading. Stop the server and free the port afterward. Full
behavioral verification (admin login, save round-trip) happens via the
Playwright spec in Task 6.

- [ ] **Step 4: Commit**

```bash
git add admin/manager.html admin/manager.js
git commit -m "feat: add admin-only reminder-threshold settings form"
```

---

### Task 6: Playwright coverage

**Files:**
- Create: `tests/e2e/reception-reminders.spec.js` (outer repo — `hien-le-garden`, not `hien-le-garden-v4`)
- Create: `tests/e2e/manager-reminder-settings.spec.js` (outer repo — a new file, not an addition to `tests/e2e/manager-dashboard.spec.js`, since that existing spec covers `dashboard.html`, a different page from `manager.html`)

**Interfaces:**
- Consumes: `admin/reception.html`/`.js` (Task 4), `admin/manager.html`/`.js` (Task 5), and mocked `/api/reception/reminders` and `/api/reminder-settings` responses.

- [ ] **Step 1: Write the reception reminders test**

```js
// tests/e2e/reception-reminders.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Reception reminders', () => {
  test('shows all three reminder lists when there is something to flag', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/reception/reminders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pendingNoDeposit: [{ id: 1, guestName: 'Chờ Cọc', phone: '0900000001', createdAt: '2026-08-28T00:00:00Z', hoursWaiting: 5 }],
          arrivingToday: [{ id: 2, guestName: 'Khách Đến', phone: '0900000002', roomType: 'circle', checkIn: '2099-01-01' }],
          roomsNotCleaned: [{ id: 3, name: 'Circle House 1', roomType: 'circle', needsCleaningSince: '2026-08-28T00:00:00Z', minutesWaiting: 90 }],
          thresholds: { pendingDepositHours: 2, cleaningMinutes: 60 },
        }),
      })
    );

    await page.goto('/admin/reception.html');

    await expect(page.locator('#remindersSection')).toContainText('Chờ cọc quá 2 giờ (1)');
    await expect(page.locator('#remindersSection')).toContainText('Chờ Cọc');
    await expect(page.locator('#remindersSection')).toContainText('chờ 5 giờ');
    await expect(page.locator('#remindersSection')).toContainText('Khách sắp đến hôm nay (1)');
    await expect(page.locator('#remindersSection')).toContainText('Khách Đến');
    await expect(page.locator('#remindersSection')).toContainText('Phòng chưa dọn quá 60 phút (1)');
    await expect(page.locator('#remindersSection')).toContainText('Circle House 1');
    await expect(page.locator('#remindersSection')).toContainText('90 phút');
  });

  test('shows the all-clear message when there is nothing to flag', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/reception/reminders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pendingNoDeposit: [], arrivingToday: [], roomsNotCleaned: [], thresholds: { pendingDepositHours: 2, cleaningMinutes: 60 } }),
      })
    );

    await page.goto('/admin/reception.html');
    await expect(page.locator('#remindersSection')).toContainText('Không có việc cần nhắc');
  });
});
```

- [ ] **Step 2: Write the manager reminder-settings test**

```js
// tests/e2e/manager-reminder-settings.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Manager reminder-settings config', () => {
  test('an admin can view and save the thresholds', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/policy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gift-inventory', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

    let saved = null;
    await page.route('**/api/reminder-settings', (route) => {
      if (route.request().method() === 'PATCH') {
        saved = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingDepositHours: 2, cleaningMinutes: 60, updatedAt: '2026-08-28T00:00:00Z' }) });
    });

    await page.goto('/admin/manager.html');
    await expect(page.locator('#reminderSettingsSection')).toBeVisible();
    await expect(page.locator('input[name="pendingDepositHours"]')).toHaveValue('2');
    await expect(page.locator('input[name="cleaningMinutes"]')).toHaveValue('60');

    await page.fill('input[name="pendingDepositHours"]', '4');
    await page.fill('input[name="cleaningMinutes"]', '45');
    await page.click('#reminderSettingsForm button[type="submit"]');

    expect(saved).toEqual({ pendingDepositHours: 4, cleaningMinutes: 45 });
  });

  test('a manager (not admin) never sees the reminder-settings section', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_ly_a', role: 'manager' }) }));
    await page.route('**/api/policy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gift-inventory', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.route('**/api/notification-settings', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));

    await page.goto('/admin/manager.html');
    await expect(page.locator('#reminderSettingsSection')).toBeHidden();
  });
});
```

- [ ] **Step 3: Run both specs to verify they fail or pass appropriately**

Start the v4 static server first (from the `v4` repo directory):
`npx http-server . -p 4174 -s -c-1` in the background, poll
`curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/admin/reception.html`
until it returns `200`.

Run (from the outer `hien-le-garden` repo):
`npx playwright test reception-reminders manager-reminder-settings --project=v4`
Expected: PASS (4 tests total) if Tasks 4 and 5 already landed (they do, per
this plan's task order). If for any reason Task 4/5 haven't landed yet when
this step runs, it FAILs with a selector-not-found error instead — in that
case stop and confirm Tasks 4/5 are actually complete before re-running.

- [ ] **Step 4: Run the full v4 Playwright suite for regressions**

Run: `npx playwright test --project=v4`
Expected: PASS (all tests, previous count + 4). Stop the http-server
afterward and free port 4174 (`netstat -ano | grep ":4174"` then
`taskkill //F //PID <pid>`).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reception-reminders.spec.js tests/e2e/manager-reminder-settings.spec.js
git commit -m "test: cover reception reminders and admin reminder-settings form"
```

(This commit is in the outer `hien-le-garden` repo, not `hien-le-garden-v4`.)

---

## After all tasks: deploy checklist (not a task — for the controller after the final review)

1. Apply `migrations/0013_reception_reminders.sql` to production D1
   (`npx wrangler d1 migrations apply hien_le_garden_crm --remote`) **before**
   pushing/deploying the dependent code — same ordering rule flagged as
   critical by this session's earlier plans' final reviews.
2. Push the `v4` repo, then the outer repo.
3. Verify the Cloudflare Pages deployment picked up the new commit
   (`wrangler pages deployment list`).
4. Smoke-test production: log in as reception/manager, open the ops board,
   confirm the reminders section loads (all-clear or populated, depending
   on real data); log in as admin, open `manager.html`, confirm the
   reminder-settings form loads and a save round-trips.
