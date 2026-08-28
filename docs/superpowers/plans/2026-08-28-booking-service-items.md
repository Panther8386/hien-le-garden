# Booking Service Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let reception attach priced, catalog-sourced service charges to a confirmed or checked-in booking, and see a running total per booking — closing the "dịch vụ phát sinh" gap the roadmap names as this system's single biggest revenue-loss risk.

**Architecture:** One new D1 table (`booking_service_items`, snapshot-priced, soft-voidable) behind two new booking-scoped endpoints (add, void), plus one additive change to the existing `GET /api/bookings` endpoint so every screen on the reception ops board picks up a `services` array for free through the request path it already uses. The UI change is entirely inside `admin/reception.js`'s single shared card renderer.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS (no build step), Vitest + `@cloudflare/vitest-pool-workers`, Playwright.

**Spec:** docs/specs/2026-08-28-booking-service-items-design.md

## Global Constraints

- `booking_service_items.status` is exactly `'posted'` or `'voided'` — voiding is a soft delete (`UPDATE ... SET status = 'voided'`), never a physical `DELETE`.
- `name` and `unit_price` are captured once at add time from the referenced `service_catalog` row and never re-read from it afterward — a later catalog edit or deletion must not change a booking's historical charges.
- Addable only when the target booking's `status` is `'confirmed'` or `'checked_in'` — reject `'pending'`, `'checked_out'`, `'cancelled'`, and a nonexistent booking.
- The referenced `service_catalog` row must exist and have `is_active = 1` at add time — `name` comes from that row, never from the client's request body.
- `unitPrice` is always client-supplied and editable, regardless of the catalog row's own `price_type` — this endpoint has no concept of range/fixed/label, only a plain integer price the admin/reception actually agreed with the guest.
- Write access (`POST` add, `PATCH` void) is `['reception', 'manager', 'admin']` — the same convention as every other booking-mutating action in this app (confirm, check-in, check-out, cancel, deposit). `observer` may read but not write.
- `GET /api/bookings`'s existing behavior (fields, filtering, ordering, observer phone/email redaction) is unchanged — the `services` array is a strictly additive field on each returned booking object, always present (`[]` when there are no lines, never omitted or `null`).
- All VND amounts are plain integers; `amount = unitPrice * quantity`, computed server-side, never trusted from the client.

---

### Task 1: Migration — booking_service_items

**Files:**
- Create: `v4/migrations/0010_booking_service_items.sql`
- Test: `v4/test/bookingServiceItemsSchema.test.js`

**Interfaces:**
- Produces: table `booking_service_items` (columns: `id, booking_id, service_catalog_id, name, unit_price, quantity, amount, status, created_by, created_at, voided_by, voided_at`). All later tasks read/write these exact column names.

- [ ] **Step 1: Confirm this is the next migration number**

Run: `ls v4/migrations` — confirm `0001` through `0009` exist and `0010` does not. If a different next number is already taken, use that number instead and adjust every reference to `0010` in this plan's remaining tasks accordingly.

- [ ] **Step 2: Write the migration**

```sql
-- v4/migrations/0010_booking_service_items.sql

CREATE TABLE booking_service_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  service_catalog_id INTEGER REFERENCES service_catalog(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted', 'voided')) DEFAULT 'posted',
  created_by TEXT,
  created_at TEXT NOT NULL,
  voided_by TEXT,
  voided_at TEXT
);

CREATE INDEX idx_booking_service_items_booking ON booking_service_items(booking_id, status);
```

- [ ] **Step 3: Apply the migration locally**

Run: `cd v4 && npx wrangler d1 migrations apply hien_le_garden_crm --local`
Expected: `0010_booking_service_items.sql` listed as applied, no errors.

- [ ] **Step 4: Write the failing schema test**

```javascript
// v4/test/bookingServiceItemsSchema.test.js
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('booking_service_items schema', () => {
  it('creates a posted row with the expected columns', async () => {
    await env.DB.exec('DELETE FROM bookings');
    const booking = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Schema Test', '0900000000', 'triangle', '2026-09-01', '2026-09-02', 'confirmed', 'website', '2026-08-28T00:00:00Z')`
    ).run();
    const bookingId = booking.meta.last_row_id;

    await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Cà phê', 30000, 2, 60000, 'posted', 'le_tan_a', '2026-08-28T00:00:00Z')`
    ).bind(bookingId).run();

    const row = await env.DB.prepare(`SELECT * FROM booking_service_items WHERE booking_id = ?`).bind(bookingId).first();
    expect(row.name).toBe('Cà phê');
    expect(row.unit_price).toBe(30000);
    expect(row.quantity).toBe(2);
    expect(row.amount).toBe(60000);
    expect(row.status).toBe('posted');
    expect(row.voided_by).toBeNull();
  });

  it('rejects an invalid status value', async () => {
    await env.DB.exec('DELETE FROM bookings');
    const booking = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Schema Test 2', '0900000000', 'triangle', '2026-09-01', '2026-09-02', 'confirmed', 'website', '2026-08-28T00:00:00Z')`
    ).run();
    const bookingId = booking.meta.last_row_id;

    await expect(
      env.DB.prepare(
        `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_at) VALUES (?, 'Bad', 1000, 1, 1000, 'bogus', '2026-08-28T00:00:00Z')`
      ).bind(bookingId).run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd v4 && npx vitest run test/bookingServiceItemsSchema.test.js`
Expected: 2 tests pass. If Windows Miniflare's known "Isolated storage failed" teardown flake appears (an unrelated assertion inside `vitest-pool-workers`' own teardown, not one of the 2 tests above), re-run the same single-file command — never run this alongside another test file in the same command.

- [ ] **Step 6: Commit**

```bash
cd v4
git add migrations/0010_booking_service_items.sql test/bookingServiceItemsSchema.test.js
git commit -m "feat: add booking_service_items table"
```

---

### Task 2: POST /api/bookings/:id/services

**Files:**
- Create: `v4/functions/api/bookings/[id]/services/index.js`
- Test: `v4/test/bookingServiceItems.test.js`

**Interfaces:**
- Consumes: `requireAuth(request, env, allowedRoles)` from `v4/lib/requireAuth.js`; `bookings` table (`status` column); `service_catalog` table (`id`, `name`, `is_active`).
- Produces: `onRequestPost`, response `{ id, ok: true }` on success (201). Task 3's tests reuse this task's fixtures and helper by importing the same test file. Task 5's UI posts to this exact route with body `{ serviceCatalogId, unitPrice, quantity }`.

- [ ] **Step 1: Write the failing tests**

```javascript
// v4/test/bookingServiceItems.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as addServiceItem } from '../functions/api/bookings/[id]/services/index.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, observerToken;
let confirmedBookingId, pendingBookingId, checkedOutBookingId;
let activeCatalogId, inactiveCatalogId;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM bookings');
  await env.DB.exec('DELETE FROM booking_service_items');
  await env.DB.exec('DELETE FROM service_catalog');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_svc', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'le_tan_svc', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  receptionToken = await createSession(env.DB, 2);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'quan_sat_svc', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  observerToken = await createSession(env.DB, 3);

  const confirmed = await env.DB.prepare(
    `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Confirmed Guest', '0900000001', 'triangle', '2099-01-01', '2099-01-03', 'confirmed', 'website', '2026-08-01T00:00:00Z')`
  ).run();
  confirmedBookingId = confirmed.meta.last_row_id;

  const pending = await env.DB.prepare(
    `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Pending Guest', '0900000002', 'triangle', '2099-01-01', '2099-01-03', 'pending', 'website', '2026-08-01T00:00:00Z')`
  ).run();
  pendingBookingId = pending.meta.last_row_id;

  const checkedOut = await env.DB.prepare(
    `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Checked Out Guest', '0900000003', 'triangle', '2099-01-01', '2099-01-03', 'checked_out', 'website', '2026-08-01T00:00:00Z')`
  ).run();
  checkedOutBookingId = checkedOut.meta.last_row_id;

  const activeCatalog = await env.DB.prepare(
    `INSERT INTO service_catalog (category, name, price_type, price_min, display_order, is_active, updated_at) VALUES ('fnb_hoat_dong', 'Cà phê', 'fixed', 30000, 1, 1, '2026-08-01T00:00:00Z')`
  ).run();
  activeCatalogId = activeCatalog.meta.last_row_id;

  const inactiveCatalog = await env.DB.prepare(
    `INSERT INTO service_catalog (category, name, price_type, price_min, display_order, is_active, updated_at) VALUES ('fnb_hoat_dong', 'Món ngừng bán', 'fixed', 10000, 2, 0, '2026-08-01T00:00:00Z')`
  ).run();
  inactiveCatalogId = inactiveCatalog.meta.last_row_id;
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('POST /api/bookings/:id/services', () => {
  it('lets reception add a service line with a server-derived name', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 35000, quantity: 2 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM booking_service_items WHERE booking_id = ?`).bind(confirmedBookingId).first();
    expect(row.name).toBe('Cà phê');
    expect(row.unit_price).toBe(35000);
    expect(row.quantity).toBe(2);
    expect(row.amount).toBe(70000);
    expect(row.status).toBe('posted');
    expect(row.created_by).toBe('le_tan_svc');
  });

  it('rejects a pending booking (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${pendingBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 1 }),
      env,
      params: { id: String(pendingBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a checked_out booking (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${checkedOutBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 1 }),
      env,
      params: { id: String(checkedOutBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a nonexistent booking (404)', async () => {
    const response = await addServiceItem({
      request: authedRequest('https://x/api/bookings/999999/services', receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 1 }),
      env,
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
  });

  it('rejects an inactive serviceCatalogId (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: inactiveCatalogId, unitPrice: 10000, quantity: 1 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a nonexistent serviceCatalogId (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: 999999, unitPrice: 10000, quantity: 1 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a negative unitPrice (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: -1000, quantity: 1 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a zero quantity (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 10000, quantity: 0 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('lets a manager add a service line', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, managerToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 1 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);
  });

  it('rejects an observer (403)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, observerToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 1 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v4 && npx vitest run test/bookingServiceItems.test.js`
Expected: FAIL — `functions/api/bookings/[id]/services/index.js` does not exist yet.

- [ ] **Step 3: Implement**

```javascript
// v4/functions/api/bookings/[id]/services/index.js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const booking = await env.DB.prepare(`SELECT id, status FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }
  if (booking.status !== 'confirmed' && booking.status !== 'checked_in') {
    return jsonError('Chỉ có thể thêm dịch vụ cho đặt phòng đã xác nhận hoặc đang lưu trú', 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { serviceCatalogId, unitPrice, quantity } = body || {};

  if (!Number.isInteger(serviceCatalogId)) {
    return jsonError('Vui lòng chọn dịch vụ', 400);
  }
  if (!Number.isInteger(unitPrice) || unitPrice < 0) {
    return jsonError('Giá phải là số nguyên không âm', 400);
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return jsonError('Số lượng phải là số nguyên lớn hơn 0', 400);
  }

  const catalogItem = await env.DB.prepare(`SELECT id, name FROM service_catalog WHERE id = ? AND is_active = 1`).bind(serviceCatalogId).first();
  if (!catalogItem) {
    return jsonError('Dịch vụ không tồn tại hoặc đã ngừng bán', 400);
  }

  const amount = unitPrice * quantity;
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO booking_service_items (booking_id, service_catalog_id, name, unit_price, quantity, amount, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?)`
  )
    .bind(params.id, catalogItem.id, catalogItem.name, unitPrice, quantity, amount, auth.username, now)
    .run();

  return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v4 && npx vitest run test/bookingServiceItems.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd v4
git add "functions/api/bookings/[id]/services/index.js" test/bookingServiceItems.test.js
git commit -m "feat: add POST /api/bookings/:id/services"
```

---

### Task 3: PATCH /api/bookings/:id/services/:itemId (void)

**Files:**
- Create: `v4/functions/api/bookings/[id]/services/[itemId].js`
- Modify: `v4/test/bookingServiceItems.test.js`

**Interfaces:**
- Consumes: same fixtures and `authedRequest` helper already defined in Task 2's test file (`confirmedBookingId`, `pendingBookingId`, `activeCatalogId`, `receptionToken`, `managerToken`, `observerToken`).
- Produces: `onRequestPatch`, response `{ ok: true }` on success. Task 5's UI calls `PATCH /api/bookings/:id/services/:itemId` with an empty JSON body to void a line.

- [ ] **Step 1: Add the failing tests**

Append to `v4/test/bookingServiceItems.test.js` (add the import at the top alongside the existing one):

```javascript
import { onRequestPatch as voidServiceItem } from '../functions/api/bookings/[id]/services/[itemId].js';
```

```javascript
describe('PATCH /api/bookings/:id/services/:itemId', () => {
  async function addPostedItem(bookingId = confirmedBookingId) {
    const result = await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, service_catalog_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, ?, 'Cà phê', 30000, 1, 30000, 'posted', 'le_tan_svc', '2026-08-01T00:00:00Z')`
    ).bind(bookingId, activeCatalogId).run();
    return result.meta.last_row_id;
  }

  it('lets reception void a posted item', async () => {
    const itemId = await addPostedItem();
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status, voided_by FROM booking_service_items WHERE id = ?`).bind(itemId).first();
    expect(row.status).toBe('voided');
    expect(row.voided_by).toBe('le_tan_svc');
  });

  it('404s when the item does not belong to the booking in the URL', async () => {
    const itemId = await addPostedItem(confirmedBookingId);
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${pendingBookingId}/services/${itemId}`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(pendingBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(404);
  });

  it('rejects double-voiding (400)', async () => {
    const itemId = await addPostedItem();
    await voidServiceItem({ request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, receptionToken, 'PATCH', {}), env, params: { id: String(confirmedBookingId), itemId: String(itemId) } });
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects an observer (403)', async () => {
    const itemId = await addPostedItem();
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, observerToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(403);
  });

  it('404s for a nonexistent item id', async () => {
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/999999`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: '999999' },
    });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd v4 && npx vitest run test/bookingServiceItems.test.js`
Expected: FAIL — `functions/api/bookings/[id]/services/[itemId].js` does not exist.

- [ ] **Step 3: Implement**

```javascript
// v4/functions/api/bookings/[id]/services/[itemId].js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const item = await env.DB.prepare(`SELECT id, booking_id, status FROM booking_service_items WHERE id = ?`).bind(params.itemId).first();
  if (!item || String(item.booking_id) !== String(params.id)) {
    return jsonError('Không tìm thấy dòng dịch vụ', 404);
  }
  if (item.status === 'voided') {
    return jsonError('Dòng dịch vụ này đã được huỷ trước đó', 400);
  }

  await env.DB.prepare(
    `UPDATE booking_service_items SET status = 'voided', voided_by = ?, voided_at = ? WHERE id = ?`
  ).bind(auth.username, new Date().toISOString(), params.itemId).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd v4 && npx vitest run test/bookingServiceItems.test.js`
Expected: PASS (14 tests total: 9 from Task 2 + 5 new).

- [ ] **Step 5: Commit**

```bash
cd v4
git add "functions/api/bookings/[id]/services/[itemId].js" test/bookingServiceItems.test.js
git commit -m "feat: add PATCH /api/bookings/:id/services/:itemId (void)"
```

---

### Task 4: Attach `services` to GET /api/bookings

**Files:**
- Modify: `v4/functions/api/bookings/index.js`
- Modify: `v4/test/bookingsEndpoints.test.js`

**Interfaces:**
- Consumes: `booking_service_items` table from Task 1.
- Produces: every booking object returned by `GET /api/bookings` gains `services: [...]` (camelCase fields: `id, bookingId, name, unitPrice, quantity, amount, status, createdBy, createdAt, voidedBy, voidedAt`), always an array, never omitted. Task 5's UI reads `b.services` directly off each booking object already returned by this endpoint — no separate fetch.

- [ ] **Step 1: Read the current file**

Run: `cat v4/functions/api/bookings/index.js` and locate `onRequestGet` — confirm it still ends with `return new Response(JSON.stringify(results), ...)` after the observer redaction block. If the shape has diverged from that, adapt Step 3 below to the current structure rather than blindly overwriting.

- [ ] **Step 2: Add the failing test**

Add to the existing `describe('GET /api/bookings', ...)` block in `v4/test/bookingsEndpoints.test.js` (this file already has `managerToken`/`authedRequest` in scope from its top-level `beforeEach` — reuse them; do not add new fixtures):

```javascript
  it('attaches services grouped per booking, empty array when none exist', async () => {
    await env.DB.exec('DELETE FROM booking_service_items');
    const pendingRow = await env.DB.prepare(`SELECT id FROM bookings WHERE guest_name = 'Pending Guest'`).first();
    const arrivingRow = await env.DB.prepare(`SELECT id FROM bookings WHERE guest_name = 'Arriving Today'`).first();

    await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Cà phê', 30000, 1, 30000, 'posted', 'quan_ly_a', '2026-08-01T00:00:00Z')`
    ).bind(arrivingRow.id).run();

    const response = await listBookings({ request: authedRequest('https://x/api/bookings', managerToken), env });
    const body = await response.json();

    const pendingResult = body.find((b) => b.id === pendingRow.id);
    expect(pendingResult.services).toEqual([]);

    const arrivingResult = body.find((b) => b.id === arrivingRow.id);
    expect(arrivingResult.services).toHaveLength(1);
    expect(arrivingResult.services[0]).toMatchObject({ name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: 'posted' });
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: FAIL — `pendingResult.services` is `undefined`.

- [ ] **Step 4: Implement**

In `v4/functions/api/bookings/index.js`'s `onRequestGet`, insert this block after the existing observer-redaction `if (auth.role === 'observer') { ... }` block and before the final `return new Response(...)`:

```javascript
  results.forEach((r) => {
    r.services = [];
  });
  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(', ');
    const { results: serviceRows } = await env.DB.prepare(
      `SELECT id, booking_id AS bookingId, name, unit_price AS unitPrice, quantity, amount, status,
              created_by AS createdBy, created_at AS createdAt, voided_by AS voidedBy, voided_at AS voidedAt
       FROM booking_service_items WHERE booking_id IN (${placeholders}) ORDER BY created_at ASC`
    ).bind(...ids).all();

    const byBooking = {};
    serviceRows.forEach((row) => {
      if (!byBooking[row.bookingId]) byBooking[row.bookingId] = [];
      byBooking[row.bookingId].push(row);
    });
    results.forEach((r) => {
      r.services = byBooking[r.id] || [];
    });
  }
```

- [ ] **Step 5: Run to verify passing**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: PASS — every pre-existing test in this file still passes (the response only gained a field, nothing removed or renamed) plus the new one.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/bookings/index.js test/bookingsEndpoints.test.js
git commit -m "feat: attach service line items to GET /api/bookings"
```

---

### Task 5: Reception UI — add/void service lines on the booking card

**Files:**
- Modify: `v4/admin/reception.js`
- Modify: `v4/admin/admin.css`
- Modify: `tests/e2e/reception-ops-board.spec.js` (outer repo)

**Interfaces:**
- Consumes: `b.services` (from Task 4) on every booking object already returned by `fetchBookings()`; `POST /api/bookings/:id/services` (Task 2); `PATCH /api/bookings/:id/services/:itemId` (Task 3); `GET /api/catalog` (already public, no auth, active-only — built earlier today).
- Produces: nothing later tasks in this plan consume — this is the final task.

- [ ] **Step 1: Read the current file**

Run: `cat v4/admin/reception.js` and locate `renderBookingCard(b)` and the top-level init IIFE — confirm they still match the shape described below. This file has been touched by several prior plans this session; if the deposit block or init IIFE has diverged meaningfully from what's shown, adapt rather than blindly overwriting.

- [ ] **Step 2: Add CSS for the new section**

In `v4/admin/admin.css`, after the existing `.room-card button { margin-top: 8px; width: auto; padding: 6px 10px; font-size: 0.8rem; }` rule, add:

```css
.services-section { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(245, 240, 230, 0.15); }
.service-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.add-service-form { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.add-service-form select, .add-service-form input { width: auto; margin-top: 0; }
```

- [ ] **Step 3: Add a module-level `catalogItems` variable and fetch it at init**

Add near the top of `v4/admin/reception.js`, alongside the existing `let canManageRoomLayout = false;`:

```javascript
let catalogItems = [];
```

Inside the existing init IIFE, add a line to populate it — insert it right after `canManageRoomLayout = !!layoutFlag;` and before the `if (currentRole === 'observer') { ... }` block:

```javascript
  catalogItems = await fetch('/api/catalog').then((r) => (r.ok ? r.json() : [])).catch(() => []);
```

- [ ] **Step 4: Add a VND formatting helper and the services-section renderer**

Add these two new functions anywhere above `renderBookingCard` in the same file:

```javascript
function formatVnd(n) {
  return `${Number(n).toLocaleString('vi-VN')} đ`;
}

function renderServicesSection(b, card) {
  const services = b.services || [];
  if (services.length === 0 && b.status !== 'confirmed' && b.status !== 'checked_in') return;

  const section = document.createElement('div');
  section.className = 'services-section';

  services.forEach((item) => {
    const line = document.createElement('p');
    line.className = 'service-line';
    const text = document.createElement('span');
    text.textContent = `${item.name} ×${item.quantity} — ${formatVnd(item.amount)}`;
    if (item.status === 'voided') {
      text.style.textDecoration = 'line-through';
      text.style.opacity = '0.5';
    }
    line.appendChild(text);
    if (item.status === 'posted' && currentRole !== 'observer') {
      const voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'btn-secondary';
      voidBtn.textContent = 'Huỷ';
      voidBtn.addEventListener('click', async () => {
        let response;
        try {
          response = await fetch(`/api/bookings/${b.id}/services/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        } catch (err) {
          showOpsError('Có lỗi khi huỷ dịch vụ');
          return;
        }
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({}));
          showOpsError(errBody.error || 'Có lỗi khi huỷ dịch vụ');
          return;
        }
        showOpsError('');
        await refreshAll();
      });
      line.appendChild(voidBtn);
    }
    section.appendChild(line);
  });

  if (services.length > 0) {
    const postedTotal = services.filter((s) => s.status === 'posted').reduce((sum, s) => sum + s.amount, 0);
    const totalLine = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = `Tổng dịch vụ: ${formatVnd(postedTotal)}`;
    totalLine.appendChild(strong);
    section.appendChild(totalLine);
  }

  if ((b.status === 'confirmed' || b.status === 'checked_in') && currentRole !== 'observer') {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn-secondary';
    addBtn.textContent = '+ Thêm dịch vụ';
    addBtn.addEventListener('click', () => openAddServiceForm(b.id, section));
    section.appendChild(addBtn);
  }

  card.appendChild(section);
}

function openAddServiceForm(bookingId, section) {
  document.querySelectorAll('.add-service-form').forEach((el) => el.remove());

  const form = document.createElement('div');
  form.className = 'add-service-form';

  const select = document.createElement('select');
  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = '-- Chọn dịch vụ --';
  select.appendChild(placeholderOpt);
  catalogItems.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name;
    opt.dataset.priceMin = item.priceMin != null ? item.priceMin : '';
    select.appendChild(opt);
  });

  const priceInput = document.createElement('input');
  priceInput.type = 'number';
  priceInput.min = '0';
  priceInput.step = '1000';
  priceInput.placeholder = 'Giá';

  select.addEventListener('change', () => {
    const selectedOpt = select.options[select.selectedIndex];
    priceInput.value = selectedOpt.dataset.priceMin || '';
  });

  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.min = '1';
  qtyInput.step = '1';
  qtyInput.value = '1';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Thêm';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Huỷ';

  const errorEl = document.createElement('p');
  errorEl.className = 'error';

  confirmBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    const serviceCatalogId = Number(select.value);
    if (!serviceCatalogId) {
      errorEl.textContent = 'Vui lòng chọn dịch vụ';
      return;
    }
    const unitPrice = Number(priceInput.value);
    if (priceInput.value.trim() === '' || !Number.isInteger(unitPrice) || unitPrice < 0) {
      errorEl.textContent = 'Vui lòng nhập giá hợp lệ';
      return;
    }
    const quantity = Number(qtyInput.value);
    if (!Number.isInteger(quantity) || quantity < 1) {
      errorEl.textContent = 'Số lượng phải là số nguyên lớn hơn 0';
      return;
    }
    let response;
    try {
      response = await fetch(`/api/bookings/${bookingId}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceCatalogId, unitPrice, quantity }),
      });
    } catch (err) {
      errorEl.textContent = 'Có lỗi khi thêm dịch vụ';
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi thêm dịch vụ';
      return;
    }
    await refreshAll();
  });
  cancelBtn.addEventListener('click', () => form.remove());

  form.append(select, priceInput, qtyInput, confirmBtn, cancelBtn, errorEl);
  section.appendChild(form);
}
```

- [ ] **Step 5: Call the new renderer from `renderBookingCard`**

In `renderBookingCard(b)`, find the closing `}` of the existing deposit block (`if ((b.status === 'pending' || b.status === 'confirmed') && currentRole !== 'observer') { ... }`) and insert a call right after it, before the `const actions = document.createElement('div');` line:

```javascript
  renderServicesSection(b, card);
```

- [ ] **Step 6: Write the Playwright tests**

Append to `tests/e2e/reception-ops-board.spec.js` (outer repo), following this file's existing route-mocking conventions (camelCase booking fields, one route per `status=` value, the documented reverse-registration-order rule — register a catch-all `**/api/bookings?**` before a more specific pattern when both are needed in the same test):

```javascript
  test('adding a service line updates the card total and item list', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 5, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê', priceType: 'fixed', priceMin: 30000, priceMax: null, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true }]) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let serviceAdded = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 11, guestName: 'Lê Thị C', phone: '0900000011', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          services: serviceAdded ? [{ id: 1, bookingId: 11, name: 'Cà phê', unitPrice: 30000, quantity: 2, amount: 60000, status: 'posted', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }] : [],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/11/services', (route) => {
      serviceAdded = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 1, ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Lê Thị C');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').selectOption('5');
    await page.locator('.add-service-form input[type="number"]').nth(1).fill('2');
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cà phê ×2');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 60.000 đ');
  });

  test('voiding a service line strikes it through and drops it from the total', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let voided = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 12, guestName: 'Phạm Văn D', phone: '0900000012', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          services: [{ id: 7, bookingId: 12, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: voided ? 'voided' : 'posted', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: voided ? 'hienle' : null, voidedAt: voided ? '2026-08-28T01:00:00Z' : null }],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/12/services/7', (route) => {
      voided = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 30.000 đ');
    await page.locator('#upcomingConfirmedList .service-line button', { hasText: 'Huỷ' }).click();

    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 0 đ');
  });

  test('a pending booking never shows the add-service control', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 13, guestName: 'Khách Chờ', phone: '0900000013', roomType: 'circle', checkIn: '2099-04-01', checkOut: '2099-04-03', status: 'pending', services: [] }]) })
    );
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#pendingList')).toContainText('Khách Chờ');
    await expect(page.locator('#pendingList button', { hasText: '+ Thêm dịch vụ' })).toHaveCount(0);
  });

  test('observer sees the service list and total but no add/void controls', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer' }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 14, guestName: 'Khách E', phone: '0900000014', roomType: 'circle', checkIn: '2099-05-01', checkOut: '2099-05-03', status: 'confirmed',
          services: [{ id: 9, bookingId: 14, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: 'posted', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }],
        }]),
      })
    );
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 30.000 đ');
    await expect(page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' })).toHaveCount(0);
    await expect(page.locator('#upcomingConfirmedList button', { hasText: 'Huỷ' })).toHaveCount(0);
  });
```

- [ ] **Step 7: Run the tests**

Run these commands from `D:\VDX\HienLeGarden\LandingPage` (the outer repo), in order, cleaning up afterward even if a step fails:
1. `cd v4 && (npx http-server . -p 4174 -s -c-1 &)` then poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/` until it returns `200`.
2. `npx playwright test reception-ops-board --project=v4`
3. `netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>` for whatever PID owns port 4174.

Expected: all tests in this file pass, including the 4 new ones and every pre-existing test (this task modifies the file's single shared card renderer, so a regression here would show up as a failure in an unrelated existing test — investigate and fix rather than ignore if that happens).

- [ ] **Step 8: Run the full local Playwright suite**

Run: `npx playwright test --project=v4` (server still up from Step 7).
Expected: all tests pass — this task touches a widely-shared file (`admin/reception.js`), so this is the point to catch any knock-on effect beyond `reception-ops-board.spec.js` itself.
Then tear down the local server per the established convention (`netstat -ano | grep ":4174"` → `taskkill //F //PID <pid>`).

- [ ] **Step 9: Commit**

```bash
cd v4
git add admin/reception.js admin/admin.css
git commit -m "feat: add service-item add/void UI to the reception ops board"
cd ..
git add tests/e2e/reception-ops-board.spec.js
git commit -m "test: cover booking service item add/void on the reception ops board"
```
