# Định danh khách & Phiếu đăng ký lưu trú Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a booking's lead-guest ID number (CCCD/hộ chiếu) and nationality, and let reception print a "Phiếu đăng ký lưu trú" (stay registration form) for that guest on demand.

**Architecture:** Two new nullable columns on the existing `bookings` table (plain `ALTER TABLE`, no rebuild needed). Two new narrow-action endpoints follow this codebase's existing `functions/api/bookings/[id]/*.js` convention exactly (matching `confirm.js`/`check-in.js`/`deposit.js`). A new standalone print page — the app's first print-oriented page — fetches a single booking's full detail (including a joined room name) and renders both an editable identity form and the printable document itself, with `@media print` CSS hiding everything except the document when the browser's print dialog opens.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS, Vitest + `@cloudflare/vitest-pool-workers`, Playwright for e2e (outer repo).

**Spec:** `docs/superpowers/specs/2026-09-04-guest-identity-and-stay-registration-design.md` (this plan argues from that spec; read both).

**Repos:** Backend/frontend/unit-test work happens in the `v4` repo (`D:\VDX\HienLeGarden\LandingPage\v4`, branch `main`). Task 5 touches the outer repo (`D:\VDX\HienLeGarden\LandingPage`, branch `main`) for e2e coverage.

## Global Constraints

- No general "edit booking" endpoint exists in this codebase and this plan does not add one — only the two narrow, single-purpose endpoints the spec calls for.
- `idNumber`/`nationality` are free text, no format validation beyond a 200-character cap (matching the existing `guestName`/`phone` length-cap convention in `functions/api/bookings/staff.js`) — different ID document types (CCCD, older CMND, foreign passports) have different shapes.
- Neither field is required before check-in — the "Check-in" action and the "In phiếu" action are fully independent.
- `GET /api/bookings/:id` and `PATCH /api/bookings/:id/identity` — roles `reception`, `manager`, `admin` only (no `observer` — this is an operational tool, not a reporting view).
- Every field-changing action endpoint in this codebase writes an `audit_log` row (see `functions/api/bookings/[id]/deposit.js` for the exact precedent) — the new identity-PATCH endpoint follows this convention, and its new `action_type` must be registered in all three of this codebase's audit-log registries in the same task that introduces it (a gap the previous session's finance-categories feature shipped and had to fix in its final review — this plan gets it right the first time).
- Every push/migrate/deploy step requires explicit user confirmation before it happens — standing rule for this project.

---

## Task 1: Migration — `bookings.id_number` + `bookings.nationality`

**Files:**
- Create: `v4/migrations/0020_bookings_identity.sql`
- Modify: `v4/test/migrations.test.js`

**Interfaces:**
- Produces: `bookings.id_number` (TEXT, nullable), `bookings.nationality` (TEXT, nullable) — Task 2 and Task 3 both read/write these columns.

- [ ] **Step 1: Write the failing tests**

Append to `v4/test/migrations.test.js`:

```js
describe('migration 0020', () => {
  it('adds id_number and nationality columns, defaulting to null', async () => {
    const result = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Test Guest', '090', 'circle', '2026-09-10', '2026-09-11', 'pending', 'website', '2026-09-04T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT id_number, nationality FROM bookings WHERE id = ?`).bind(result.meta.last_row_id).first();
    expect(row).toEqual({ id_number: null, nationality: null });
  });

  it('accepts a value for both new columns', async () => {
    const result = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, id_number, nationality, created_at)
       VALUES ('Test Guest 2', '091', 'circle', '2026-09-10', '2026-09-11', 'pending', 'website', '079123456789', 'Việt Nam', '2026-09-04T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT id_number, nationality FROM bookings WHERE id = ?`).bind(result.meta.last_row_id).first();
    expect(row).toEqual({ id_number: '079123456789', nationality: 'Việt Nam' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

From `v4/`: `npx vitest run test/migrations.test.js`
Expected: FAIL — `id_number`/`nationality` columns don't exist yet.

If this is a Windows Miniflare "Isolated storage failed" teardown-only flake (no assertion failure, just a teardown error), retry the same command up to 2-3 times before treating it as real.

- [ ] **Step 3: Write the migration**

Create `v4/migrations/0020_bookings_identity.sql`:

```sql
ALTER TABLE bookings ADD COLUMN id_number TEXT;
ALTER TABLE bookings ADD COLUMN nationality TEXT;
```

- [ ] **Step 4: Run the tests to verify they pass**

`npx vitest run test/migrations.test.js`
Expected: PASS — all tests, including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
cd v4
git add migrations/0020_bookings_identity.sql test/migrations.test.js
git commit -m "feat: add id_number and nationality columns to bookings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `GET /api/bookings/:id`

**Files:**
- Create: `v4/functions/api/bookings/[id]/index.js`
- Create: `v4/test/bookingIdentity.test.js`

**Interfaces:**
- Consumes: `bookings.id_number`/`nationality` (Task 1).
- Produces: `GET /api/bookings/:id` → `200 { id, guestName, phone, email, roomType, roomId, roomName, checkIn, checkOut, guestsCount, notes, status, idNumber, nationality }` — Task 4's print page fetches this.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/bookingIdentity.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getBooking } from '../functions/api/bookings/[id]/index.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM bookings');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_id', 'x', 'manager', '2026-09-04T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_id', 'x', 'reception', '2026-09-04T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_id', 'x', 'observer', '2026-09-04T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/bookings/:id', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getBooking({ request: new Request('https://x/api/bookings/1'), env, params: { id: '1' } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await getBooking({ request: authedRequest('https://x/api/bookings/1', observerToken, 'GET'), env, params: { id: '1' } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await getBooking({ request: authedRequest('https://x/api/bookings/999999', receptionToken, 'GET'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('returns full booking detail including the joined room name', async () => {
    const room = await env.DB.prepare(`SELECT id, name FROM rooms WHERE room_type = 'triangle' LIMIT 1`).first();
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, guests_count, status, source, created_at)
       VALUES ('Nguyễn Văn A', '0900000001', 'triangle', ?, '2026-09-10', '2026-09-12', 2, 'checked_in', 'website', '2026-09-04T00:00:00Z')`
    ).bind(room.id).run();
    const id = created.meta.last_row_id;

    const response = await getBooking({ request: authedRequest(`https://x/api/bookings/${id}`, managerToken, 'GET'), env, params: { id: String(id) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      id, guestName: 'Nguyễn Văn A', phone: '0900000001', roomType: 'triangle',
      roomId: room.id, roomName: room.name, checkIn: '2026-09-10', checkOut: '2026-09-12',
      guestsCount: 2, status: 'checked_in', idNumber: null, nationality: null,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

`npx vitest run test/bookingIdentity.test.js`
Expected: FAIL — `functions/api/bookings/[id]/index.js` doesn't exist yet.

- [ ] **Step 3: Write the endpoint**

Create `v4/functions/api/bookings/[id]/index.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(
    `SELECT b.id, b.guest_name AS guestName, b.phone, b.email, b.room_type AS roomType, b.room_id AS roomId,
            r.name AS roomName, b.check_in AS checkIn, b.check_out AS checkOut, b.guests_count AS guestsCount,
            b.notes, b.status, b.id_number AS idNumber, b.nationality
     FROM bookings b LEFT JOIN rooms r ON r.id = b.room_id
     WHERE b.id = ?`
  ).bind(params.id).first();

  if (!row) return jsonError('Không tìm thấy đặt phòng', 404);

  return new Response(JSON.stringify(row), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

`npx vitest run test/bookingIdentity.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/bookings/[id]/index.js test/bookingIdentity.test.js
git commit -m "feat: add GET /api/bookings/:id for single-booking detail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `PATCH /api/bookings/:id/identity` + audit-log registration

**Files:**
- Create: `v4/functions/api/bookings/[id]/identity.js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Modify: `v4/functions/api/audit-log/index.js`
- Modify: `v4/test/bookingIdentity.test.js`

**Interfaces:**
- Consumes: `bookings.id_number`/`nationality` (Task 1).
- Produces: `PATCH /api/bookings/:id/identity` → `200 { ok: true }` — Task 4's print page calls this. New `audit_log.action_type` value `guest_identity_update`, registered everywhere the codebase enumerates action types.

- [ ] **Step 1: Write the failing tests**

Append to `v4/test/bookingIdentity.test.js`, after the `describe('GET /api/bookings/:id', ...)` block:

```js
describe('PATCH /api/bookings/:id/identity', () => {
  let bookingId;
  beforeEach(async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Identity Test Guest', '0900000002', 'circle', '2026-09-10', '2026-09-12', 'confirmed', 'website', '2026-09-04T00:00:00Z')`
    ).run();
    bookingId = created.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await setIdentity({ request: new Request(`https://x/api/bookings/${bookingId}/identity`, { method: 'PATCH' }), env, params: { id: String(bookingId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await setIdentity({ request: authedRequest(`https://x/api/bookings/${bookingId}/identity`, observerToken, 'PATCH', { idNumber: '079123456789' }), env, params: { id: String(bookingId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await setIdentity({ request: authedRequest('https://x/api/bookings/999999/identity', receptionToken, 'PATCH', { idNumber: '079123456789' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an id_number over 200 characters (400)', async () => {
    const response = await setIdentity({ request: authedRequest(`https://x/api/bookings/${bookingId}/identity`, receptionToken, 'PATCH', { idNumber: 'x'.repeat(201) }), env, params: { id: String(bookingId) } });
    expect(response.status).toBe(400);
  });

  it('lets reception save both fields and writes an audit_log row', async () => {
    const response = await setIdentity({ request: authedRequest(`https://x/api/bookings/${bookingId}/identity`, receptionToken, 'PATCH', { idNumber: '079123456789', nationality: 'Việt Nam' }), env, params: { id: String(bookingId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT id_number, nationality FROM bookings WHERE id = ?`).bind(bookingId).first();
    expect(row).toEqual({ id_number: '079123456789', nationality: 'Việt Nam' });

    const auditRow = await env.DB.prepare(`SELECT * FROM audit_log WHERE entity_type = 'booking' AND entity_id = ? AND action_type = 'guest_identity_update'`).bind(bookingId).first();
    expect(auditRow).not.toBeNull();
    expect(auditRow.actor).toBe('le_tan_id');
  });

  it('stores an empty string as null', async () => {
    await setIdentity({ request: authedRequest(`https://x/api/bookings/${bookingId}/identity`, receptionToken, 'PATCH', { idNumber: '079123456789', nationality: 'Việt Nam' }), env, params: { id: String(bookingId) } });
    const response = await setIdentity({ request: authedRequest(`https://x/api/bookings/${bookingId}/identity`, receptionToken, 'PATCH', { idNumber: '', nationality: '' }), env, params: { id: String(bookingId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT id_number, nationality FROM bookings WHERE id = ?`).bind(bookingId).first();
    expect(row).toEqual({ id_number: null, nationality: null });
  });

  it('does not touch other booking fields', async () => {
    await setIdentity({ request: authedRequest(`https://x/api/bookings/${bookingId}/identity`, receptionToken, 'PATCH', { idNumber: '079123456789' }), env, params: { id: String(bookingId) } });
    const row = await env.DB.prepare(`SELECT guest_name, phone, status FROM bookings WHERE id = ?`).bind(bookingId).first();
    expect(row).toEqual({ guest_name: 'Identity Test Guest', phone: '0900000002', status: 'confirmed' });
  });
});
```

Add the import at the top of `v4/test/bookingIdentity.test.js`, alongside the existing `getBooking` import:

```js
import { onRequestPatch as setIdentity } from '../functions/api/bookings/[id]/identity.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

`npx vitest run test/bookingIdentity.test.js`
Expected: FAIL — `functions/api/bookings/[id]/identity.js` doesn't exist yet.

- [ ] **Step 3: Write the endpoint**

Create `v4/functions/api/bookings/[id]/identity.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const booking = await env.DB.prepare(`SELECT id, guest_name, id_number, nationality FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) return jsonError('Không tìm thấy đặt phòng', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { idNumber, nationality } = body || {};

  if (idNumber !== undefined && idNumber !== null && (typeof idNumber !== 'string' || idNumber.length > 200)) {
    return jsonError('Số CCCD/hộ chiếu không hợp lệ', 400);
  }
  if (nationality !== undefined && nationality !== null && (typeof nationality !== 'string' || nationality.length > 200)) {
    return jsonError('Quốc tịch không hợp lệ', 400);
  }

  const newIdNumber = idNumber ? idNumber.trim() || null : null;
  const newNationality = nationality ? nationality.trim() || null : null;

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET id_number = ?, nationality = ? WHERE id = ?`).bind(newIdNumber, newNationality, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('guest_identity_update', 'booking', ?, ?, ?, ?, ?, ?)`
    ).bind(
      booking.id,
      booking.guest_name,
      `${booking.id_number || ''} / ${booking.nationality || ''}`,
      `${newIdNumber || ''} / ${newNationality || ''}`,
      auth.username,
      now
    ),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Register the new action type in all three audit-log enumerations**

In `v4/admin/audit-log.js`, add one entry to `ACTION_TYPE_LABELS`, right after the existing `finance_category_update: 'Sửa danh mục thu chi',` line:

```js
  guest_identity_update: 'Cập nhật giấy tờ khách',
```

In `v4/admin/audit-log.html`, add one `<option>` to the `#typeFilter` `<select>`, right after the existing `<option value="finance_category_update">Sửa danh mục thu chi</option>` line:

```html
        <option value="guest_identity_update">Cập nhật giấy tờ khách</option>
```

In `v4/functions/api/audit-log/index.js`, add the new string to the `VALID_ACTION_TYPES` array, appending it after `'finance_category_update'`:

```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update'];
```

- [ ] **Step 5: Run the tests to verify they pass**

`npx vitest run test/bookingIdentity.test.js`
Expected: PASS — all 10 tests (4 from Task 2, 6 new). Also run `npx vitest run test/auditLog.test.js` to confirm the registry change didn't break anything there — expect it to stay green (no existing test asserts an exhaustive list of action types).

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/bookings/[id]/identity.js admin/audit-log.js admin/audit-log.html functions/api/audit-log/index.js test/bookingIdentity.test.js
git commit -m "feat: add PATCH /api/bookings/:id/identity, register guest_identity_update audit type

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Client — "In phiếu" buttons + stay-registration print page

**Files:**
- Modify: `v4/admin/reception.js`
- Create: `v4/admin/stay-registration-print.html`
- Create: `v4/admin/stay-registration-print.js`

**Interfaces:**
- Consumes: `GET /api/bookings/:id`, `PATCH /api/bookings/:id/identity` (Task 2, Task 3).
- Produces: `window.open('/admin/stay-registration-print.html?bookingId={id}', '_blank')` — this is the only interface later tasks (Task 5) need to know.

- [ ] **Step 1: Add "In phiếu" buttons to `admin/reception.js`**

In `loadArrivals()`, insert a new button between the existing "Check-in" button and the "Hủy đặt phòng" button:

```js
async function loadArrivals() {
  const bookings = await fetchBookings(`status=confirmed&date=${todayISO()}&view=arrivals`);
  renderList('arrivalsList', bookings, 'Không có khách đến hôm nay.', (actions, b) => {
    if (currentRole === 'observer') return;
    const btn = document.createElement('button');
    btn.textContent = 'Check-in';
    btn.addEventListener('click', () => doBookingAction(b.id, 'check-in'));
    actions.appendChild(btn);

    const printBtn = document.createElement('button');
    printBtn.textContent = '🖨 In phiếu';
    printBtn.className = 'btn-secondary';
    printBtn.addEventListener('click', () => window.open(`/admin/stay-registration-print.html?bookingId=${b.id}`, '_blank'));
    actions.appendChild(printBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Hủy đặt phòng';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.addEventListener('click', () => cancelBooking(b.id));
    actions.appendChild(cancelBtn);
  });
}
```

Replace `loadInhouse()` (currently has no action buttons at all — the last argument to `renderList` is an empty `() => {}`) with:

```js
async function loadInhouse() {
  const bookings = await fetchBookings(`status=checked_in&date=${todayISO()}&view=inhouse`);
  renderList('inhouseList', bookings, 'Không có khách đang lưu trú nhiều đêm.', (actions, b) => {
    if (currentRole === 'observer') return;
    const printBtn = document.createElement('button');
    printBtn.textContent = '🖨 In phiếu';
    printBtn.className = 'btn-secondary';
    printBtn.addEventListener('click', () => window.open(`/admin/stay-registration-print.html?bookingId=${b.id}`, '_blank'));
    actions.appendChild(printBtn);
  });
}
```

- [ ] **Step 2: Create `admin/stay-registration-print.html`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Phiếu đăng ký lưu trú — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
  <style>
    .form-print { background: #fff; color: #111; padding: 32px; max-width: 700px; margin: 0 auto; font-family: 'Inter', sans-serif; }
    .form-print h2 { text-align: center; margin-bottom: 4px; }
    .form-print .subtitle { text-align: center; margin-top: 0; margin-bottom: 24px; opacity: 0.7; }
    .form-print dl { display: grid; grid-template-columns: 200px 1fr; gap: 8px 12px; margin: 0 0 24px; }
    .form-print dt { font-weight: 600; }
    .form-print dd { margin: 0; }
    .form-print .signatures { display: flex; justify-content: space-between; margin-top: 48px; text-align: center; }
    .form-print .signatures div { width: 45%; }
    .form-print .signatures p:first-child { font-weight: 600; }
    .form-print .signatures .sign-space { height: 64px; }
    @media print {
      .no-print { display: none !important; }
      .form-print { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="page page-wide no-print">
    <h1>In phiếu đăng ký lưu trú</h1>
    <p id="pageError" class="error"></p>

    <div id="identityForm">
      <h2>Thông tin định danh khách</h2>
      <label>Số CCCD/hộ chiếu <input type="text" id="idNumberInput" /></label>
      <label>Quốc tịch <input type="text" id="nationalityInput" /></label>
      <button type="button" id="saveIdentityBtn">Lưu</button>
      <p id="saveError" class="error"></p>
    </div>

    <button type="button" id="printBtn">🖨 In</button>
  </div>

  <div id="formPrint" class="form-print"></div>

  <script src="/admin/stay-registration-print.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `admin/stay-registration-print.js`**

```js
// v4/admin/stay-registration-print.js
let currentBooking = null;

function bookingIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('bookingId');
}

(async () => {
  let res;
  try {
    res = await fetch('/api/auth/me');
  } catch (err) {
    window.location.href = '/admin';
    return;
  }
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }

  const bookingId = bookingIdFromQuery();
  if (!bookingId) {
    document.getElementById('pageError').textContent = 'Thiếu mã đặt phòng';
    return;
  }

  await loadBooking(bookingId);
})();

async function loadBooking(bookingId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/bookings/${bookingId}`);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải thông tin đặt phòng';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải thông tin đặt phòng';
    return;
  }
  currentBooking = await response.json();
  document.getElementById('idNumberInput').value = currentBooking.idNumber || '';
  document.getElementById('nationalityInput').value = currentBooking.nationality || '';
  renderForm();
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('vi-VN');
}

function renderForm() {
  const el = document.getElementById('formPrint');
  const b = currentBooking;
  el.innerHTML = '';

  const h2 = document.createElement('h2');
  h2.textContent = 'PHIẾU ĐĂNG KÝ LƯU TRÚ';
  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'Hiền Lê Garden';

  const dl = document.createElement('dl');
  const rows = [
    ['Họ và tên khách', b.guestName],
    ['Số điện thoại', b.phone || ''],
    ['Quốc tịch', b.nationality || ''],
    ['Số CCCD/hộ chiếu', b.idNumber || ''],
    ['Phòng', b.roomName || ''],
    ['Số khách', b.guestsCount != null ? String(b.guestsCount) : ''],
    ['Ngày đến', formatDate(b.checkIn)],
    ['Ngày đi', formatDate(b.checkOut)],
  ];
  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  });

  const signatures = document.createElement('div');
  signatures.className = 'signatures';
  const guestSign = document.createElement('div');
  const guestP = document.createElement('p');
  guestP.textContent = 'Khách lưu trú';
  const guestSpace = document.createElement('div');
  guestSpace.className = 'sign-space';
  guestSign.append(guestP, guestSpace);
  const staffSign = document.createElement('div');
  const staffP = document.createElement('p');
  staffP.textContent = 'Lễ tân';
  const staffSpace = document.createElement('div');
  staffSpace.className = 'sign-space';
  staffSign.append(staffP, staffSpace);
  signatures.append(guestSign, staffSign);

  el.append(h2, subtitle, dl, signatures);
}

document.getElementById('saveIdentityBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('saveError');
  errorEl.textContent = '';
  const idNumber = document.getElementById('idNumberInput').value.trim();
  const nationality = document.getElementById('nationalityInput').value.trim();

  let response;
  try {
    response = await fetch(`/api/bookings/${currentBooking.id}/identity`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idNumber, nationality }),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi lưu thông tin';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu thông tin';
    return;
  }
  currentBooking.idNumber = idNumber || null;
  currentBooking.nationality = nationality || null;
  renderForm();
});

document.getElementById('printBtn').addEventListener('click', () => {
  window.print();
});
```

Note: this page deliberately does **not** include `<script src="/admin/nav-drawer.js"></script>` — a printable page has no reason to carry the app's navigation drawer (see spec §3).

- [ ] **Step 4: Manual sanity check**

From `v4/`: `npx http-server . -p 8899 -s -c-1` (background). Open `http://localhost:8899/admin/stay-registration-print.html?bookingId=1` — it will redirect to `/admin` since there's no real session on a static server (expected, confirms the auth-check code path runs cleanly without throwing). Also open `http://localhost:8899/admin/reception.html` and confirm no console errors on load (the new button-wiring code runs even before any bookings are fetched). Stop the server when done.

- [ ] **Step 5: Commit**

```bash
cd v4
git add admin/reception.js admin/stay-registration-print.html admin/stay-registration-print.js
git commit -m "feat: add stay-registration print page + In phiếu buttons in reception

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: E2e coverage for the print page

**Files:**
- Create: `LandingPage/tests/e2e/stay-registration-print.spec.js` (outer repo)

**Interfaces:**
- Consumes: `admin/stay-registration-print.html`/`.js` DOM contract (Task 4).

- [ ] **Step 1: Write the e2e tests**

Create `tests/e2e/stay-registration-print.spec.js` (outer repo):

```js
// tests/e2e/stay-registration-print.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_BOOKING = {
  id: 42, guestName: 'Nguyễn Văn A', phone: '0900000001', email: null,
  roomType: 'triangle', roomId: 3, roomName: 'Triangle House 2',
  checkIn: '2026-09-10', checkOut: '2026-09-12', guestsCount: 2,
  notes: null, status: 'checked_in', idNumber: null, nationality: null,
};

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role }) }));
}

test.describe('Stay registration print page', () => {
  test('loads booking details and renders the printable form', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/bookings/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BOOKING) }));

    await page.goto('/admin/stay-registration-print.html?bookingId=42');

    await expect(page.locator('#formPrint')).toContainText('Nguyễn Văn A');
    await expect(page.locator('#formPrint')).toContainText('Triangle House 2');
    await expect(page.locator('#formPrint')).toContainText('PHIẾU ĐĂNG KÝ LƯU TRÚ');
  });

  test('saving the identity form PATCHes the booking and updates the preview', async ({ page }) => {
    await mockAuth(page, 'reception');
    let patched = null;
    await page.route('**/api/bookings/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BOOKING) });
    });
    await page.route('**/api/bookings/42/identity', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/stay-registration-print.html?bookingId=42');
    await page.fill('#idNumberInput', '079123456789');
    await page.fill('#nationalityInput', 'Việt Nam');
    await page.click('#saveIdentityBtn');

    await expect.poll(() => patched).toMatchObject({ idNumber: '079123456789', nationality: 'Việt Nam' });
    await expect(page.locator('#formPrint')).toContainText('079123456789');
    await expect(page.locator('#formPrint')).toContainText('Việt Nam');
  });

  test('the print button calls window.print()', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/bookings/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BOOKING) }));

    await page.goto('/admin/stay-registration-print.html?bookingId=42');
    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printBtn');

    const called = await page.evaluate(() => window.__printCalled);
    expect(called).toBe(true);
  });

  test('a 404 from the booking fetch shows an error instead of a blank page', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/bookings/999', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Không tìm thấy đặt phòng' }) }));

    await page.goto('/admin/stay-registration-print.html?bookingId=999');

    await expect(page.locator('#pageError')).toContainText('Không tìm thấy đặt phòng');
  });
});
```

- [ ] **Step 2: Run the new spec**

From `LandingPage/` (outer repo root): `npx playwright test tests/e2e/stay-registration-print.spec.js --project=v4`
Expected: PASS — 4/4.

- [ ] **Step 3: Run the full v4 e2e project once more as a final sanity check**

`npx playwright test --project=v4`
Expected: PASS — every test in the v4 project, including the new spec and the pre-existing `reception-ops-board.spec.js`/`finance-dashboard.spec.js`/`finance-categories.spec.js` suites (this task doesn't touch any of them, but a full-project run confirms nothing else broke).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/stay-registration-print.spec.js
git commit -m "test: e2e coverage for the stay-registration print page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (after all tasks pass final review)

Every step below requires explicit user confirmation before running — standing rule for this project.

1. Apply migration 0020 to production D1: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (from `v4/`).
2. Push `v4` (branch `main`), verify Cloudflare Pages deployment.
3. Push the outer repo (e2e test addition).
4. Production smoke-test: as reception/manager, open "Bảng hôm nay", find a confirmed or checked-in booking, click "🖨 In phiếu", confirm the print page loads with the booking's details, save an ID number + nationality, confirm the preview updates, confirm the browser's print dialog opens on clicking "In".
