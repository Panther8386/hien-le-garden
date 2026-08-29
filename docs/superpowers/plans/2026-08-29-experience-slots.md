# Farm Experience Slots & Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admin define a recurring weekly time-slot schedule with capacity for scheduled catalog items; let reception register a guest into a specific date+slot with live remaining-capacity checking, server-side capacity enforcement with alternative-slot suggestions when full, and staff-mediated terms & conditions consent.

**Architecture:** One migration adds all new schema at once. Backend work splits into independently-testable endpoint groups (slot-template CRUD, slot-availability, capacity-enforced service registration, settings). Frontend work splits by page (`catalog.html` for admin configuration, `reception.js` for the registration flow). Playwright coverage lands last, exercising the full stack through the real static files.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS admin frontend, vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/specs/2026-08-29-experience-slots-design.md`

## Global Constraints

- No `CHECK` constraints on any `ALTER TABLE`-added column — validation lives in the API layer, matching this codebase's established convention.
- `days_of_week` is a CSV of integers 0-6 (Sunday=0 … Saturday=6, matching `Date.getUTCDay()`).
- `experience_booking_settings` follows the insert-a-new-row-on-update pattern already used by `reminder_settings`/`notification_settings` — never an in-place `UPDATE`.
- `booking_service_items.experience_slot_label`/`experience_start_time` are write-time snapshots from `service_slot_template`, never re-read live — matching the existing `name`/`unit_price` snapshot-pricing pattern. `slot_template_id` stays a live FK, used only for capacity aggregation.
- `service_slot_template` has no hard-delete endpoint — admin removes a slot from the future schedule via `PATCH .../isActive: false`.
- Read endpoints for this feature (`slot-templates` GET, `slot-availability`, `experience-booking-settings` GET) use `requireAuth(['reception','manager','admin','observer'])`. Write endpoints (`slot-templates` POST/PATCH, `experience-booking-settings` PATCH) use `requireAuth(['admin'])` — matching this codebase's established convention for admin-config writes (`catalog`, `cancellation-policy`, `reminder-settings`).
- `experience_booking_settings` upper bounds: `suggestionWindowDays` capped at `365`, `maxSuggestions` capped at `50` — same overflow-safety reasoning already applied to `reminder_settings`.
- `termsAccepted` is only ever required when the selected catalog item's `termsAndConditions` is a non-empty string — a scheduled item with no configured terms never requires it, on both the client and the server.
- `functions/api/catalog/[id].js` already exists as a **file** handling `PATCH`/`DELETE /api/catalog/:id`. This plan additionally creates `functions/api/catalog/[id]/` as a **directory** (containing `slot-templates/` and `slot-availability.js`) in the same parent folder. This is a legitimate, already-used-elsewhere pattern in Cloudflare Pages Functions' file-based router (different full URL paths never collide), but Task 1 includes an explicit local `wrangler pages dev` verification step to confirm it resolves correctly before relying on it further — vitest tests import handler functions directly and do not exercise the real router, so this is the only point in this plan that actually proves the routing works.

---

### Task 1: Migration + slot-template CRUD endpoints

**Files:**
- Create: `migrations/0014_experience_slots.sql`
- Create: `functions/api/catalog/[id]/slot-templates/index.js`
- Create: `functions/api/catalog/[id]/slot-templates/[templateId].js`
- Test: `test/experienceSlots.test.js`

**Interfaces:**
- Produces: full schema for this feature — `service_catalog.is_scheduled`, `service_catalog.terms_and_conditions`, `service_slot_template` table, `experience_booking_settings` table (seeded), `booking_service_items.experience_date`/`slot_template_id`/`experience_slot_label`/`experience_start_time`/`terms_accepted_at`. Every later task depends on this migration having run.
- Produces: `GET /api/catalog/:id/slot-templates` → `200` array of `{id, serviceCatalogId, label, daysOfWeek, startTime, capacity, isActive}`. `POST /api/catalog/:id/slot-templates` → `201 {id, ok: true}`. `PATCH /api/catalog/:id/slot-templates/:templateId` → `200 {ok: true}`. Task 4 (catalog.js slot-template UI) and Task 7 (capacity enforcement, reads `service_slot_template` directly) depend on this schema/shape.

- [ ] **Step 1: Write the migration**

```sql
-- v4/migrations/0014_experience_slots.sql
ALTER TABLE service_catalog ADD COLUMN is_scheduled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE service_catalog ADD COLUMN terms_and_conditions TEXT;

CREATE TABLE service_slot_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_catalog_id INTEGER NOT NULL REFERENCES service_catalog(id),
  label TEXT,
  days_of_week TEXT NOT NULL,
  start_time TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_service_slot_template_catalog ON service_slot_template(service_catalog_id, is_active);

CREATE TABLE experience_booking_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_window_days INTEGER NOT NULL DEFAULT 14,
  max_suggestions INTEGER NOT NULL DEFAULT 5,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO experience_booking_settings (suggestion_window_days, max_suggestions, updated_at)
VALUES (14, 5, '2026-08-29T00:00:00Z');

ALTER TABLE booking_service_items ADD COLUMN experience_date TEXT;
ALTER TABLE booking_service_items ADD COLUMN slot_template_id INTEGER REFERENCES service_slot_template(id);
ALTER TABLE booking_service_items ADD COLUMN experience_slot_label TEXT;
ALTER TABLE booking_service_items ADD COLUMN experience_start_time TEXT;
ALTER TABLE booking_service_items ADD COLUMN terms_accepted_at TEXT;
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx wrangler d1 migrations apply hien_le_garden_crm --local`
Expected: `0014_experience_slots.sql` listed with a ✅ status.

- [ ] **Step 3: Write the failing tests**

```js
// v4/test/experienceSlots.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listTemplates, onRequestPost as createTemplate } from '../functions/api/catalog/[id]/slot-templates/index.js';
import { onRequestPatch as patchTemplate } from '../functions/api/catalog/[id]/slot-templates/[templateId].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;
let scheduledCatalogId, plainCatalogId;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM service_catalog');
  await env.DB.exec('DELETE FROM service_slot_template');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_es', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'le_tan_es', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  receptionToken = await createSession(env.DB, 2);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'admin_es', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 3);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (4, 'quan_sat_es', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  observerToken = await createSession(env.DB, 4);

  const scheduled = await env.DB.prepare(
    `INSERT INTO service_catalog (category, name, price_type, price_min, display_order, is_active, is_scheduled, updated_at) VALUES ('fnb_hoat_dong', 'Đốt lửa trại', 'fixed', 500000, 1, 1, 1, '2026-08-01T00:00:00Z')`
  ).run();
  scheduledCatalogId = scheduled.meta.last_row_id;

  const plain = await env.DB.prepare(
    `INSERT INTO service_catalog (category, name, price_type, price_min, display_order, is_active, is_scheduled, updated_at) VALUES ('fnb_hoat_dong', 'Cà phê', 'fixed', 30000, 2, 1, 0, '2026-08-01T00:00:00Z')`
  ).run();
  plainCatalogId = plain.meta.last_row_id;
});

function authedRequest(url, token, method = 'GET', body) {
  const headers = token ? { Cookie: `session=${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/catalog/:id/slot-templates', () => {
  it('returns all templates for a catalog item, active and inactive', async () => {
    await env.DB.prepare(`INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất tối', '5,6,0', '19:00', 30, 1, '2026-08-01T00:00:00Z')`).bind(scheduledCatalogId).run();
    await env.DB.prepare(`INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất cũ', '1', '10:00', 10, 0, '2026-08-01T00:00:00Z')`).bind(scheduledCatalogId).run();

    const response = await listTemplates({ request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, receptionToken), env, params: { id: String(scheduledCatalogId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.length).toBe(2);
    expect(body[0].label).toBe('Suất cũ');
    expect(body[0].isActive).toBe(false);
    expect(body[1].daysOfWeek).toBe('5,6,0');
    expect(body[1].isActive).toBe(true);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await listTemplates({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`), env, params: { id: String(scheduledCatalogId) } });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/catalog/:id/slot-templates', () => {
  it('lets an admin create a slot template', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, adminToken, 'POST', { label: 'Suất tối', daysOfWeek: [5, 6, 0], startTime: '19:00', capacity: 30 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM service_slot_template WHERE service_catalog_id = ?`).bind(scheduledCatalogId).first();
    expect(row.label).toBe('Suất tối');
    expect(row.days_of_week).toBe('5,6,0');
    expect(row.start_time).toBe('19:00');
    expect(row.capacity).toBe(30);
    expect(row.created_by).toBe('admin_es');
  });

  it('rejects a manager (403) -- admin-only', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, managerToken, 'POST', { label: 'x', daysOfWeek: [5], startTime: '19:00', capacity: 10 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(403);
  });

  it('rejects an empty daysOfWeek (400)', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, adminToken, 'POST', { daysOfWeek: [], startTime: '19:00', capacity: 10 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects an out-of-range day (400)', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, adminToken, 'POST', { daysOfWeek: [7], startTime: '19:00', capacity: 10 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a duplicated day (400)', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, adminToken, 'POST', { daysOfWeek: [5, 5], startTime: '19:00', capacity: 10 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed startTime (400)', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, adminToken, 'POST', { daysOfWeek: [5], startTime: '25:99', capacity: 10 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a non-positive capacity (400)', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates`, adminToken, 'POST', { daysOfWeek: [5], startTime: '19:00', capacity: 0 }),
      env,
      params: { id: String(scheduledCatalogId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects creating a template for a non-scheduled catalog item (400)', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/${plainCatalogId}/slot-templates`, adminToken, 'POST', { daysOfWeek: [5], startTime: '19:00', capacity: 10 }),
      env,
      params: { id: String(plainCatalogId) },
    });
    expect(response.status).toBe(400);
  });

  it('returns 400 for a nonexistent catalog item', async () => {
    const response = await createTemplate({
      request: authedRequest(`https://x/api/catalog/999999/slot-templates`, adminToken, 'POST', { daysOfWeek: [5], startTime: '19:00', capacity: 10 }),
      env,
      params: { id: '999999' },
    });
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/catalog/:id/slot-templates/:templateId', () => {
  async function createExistingTemplate() {
    const result = await env.DB.prepare(
      `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất tối', '5,6,0', '19:00', 30, 1, '2026-08-01T00:00:00Z')`
    ).bind(scheduledCatalogId).run();
    return result.meta.last_row_id;
  }

  it('lets an admin edit a template', async () => {
    const templateId = await createExistingTemplate();
    const response = await patchTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates/${templateId}`, adminToken, 'PATCH', { label: 'Suất tối mới', daysOfWeek: [6, 0], startTime: '20:00', capacity: 25 }),
      env,
      params: { id: String(scheduledCatalogId), templateId: String(templateId) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT * FROM service_slot_template WHERE id = ?`).bind(templateId).first();
    expect(row.label).toBe('Suất tối mới');
    expect(row.days_of_week).toBe('6,0');
    expect(row.start_time).toBe('20:00');
    expect(row.capacity).toBe(25);
  });

  it('lets an admin deactivate a template', async () => {
    const templateId = await createExistingTemplate();
    const response = await patchTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates/${templateId}`, adminToken, 'PATCH', { isActive: false }),
      env,
      params: { id: String(scheduledCatalogId), templateId: String(templateId) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_active FROM service_slot_template WHERE id = ?`).bind(templateId).first();
    expect(row.is_active).toBe(0);
  });

  it('rejects a manager (403)', async () => {
    const templateId = await createExistingTemplate();
    const response = await patchTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates/${templateId}`, managerToken, 'PATCH', { isActive: false }),
      env,
      params: { id: String(scheduledCatalogId), templateId: String(templateId) },
    });
    expect(response.status).toBe(403);
  });

  it('404s for a nonexistent template id', async () => {
    const response = await patchTemplate({
      request: authedRequest(`https://x/api/catalog/${scheduledCatalogId}/slot-templates/999999`, adminToken, 'PATCH', { isActive: false }),
      env,
      params: { id: String(scheduledCatalogId), templateId: '999999' },
    });
    expect(response.status).toBe(404);
  });

  it('404s when the template belongs to a different catalog item', async () => {
    const templateId = await createExistingTemplate();
    const response = await patchTemplate({
      request: authedRequest(`https://x/api/catalog/${plainCatalogId}/slot-templates/${templateId}`, adminToken, 'PATCH', { isActive: false }),
      env,
      params: { id: String(plainCatalogId), templateId: String(templateId) },
    });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/experienceSlots.test.js`
Expected: FAIL — `Cannot find module '../functions/api/catalog/[id]/slot-templates/index.js'`

- [ ] **Step 5: Implement the endpoints**

```js
// v4/functions/api/catalog/[id]/slot-templates/index.js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateSlotTemplateFields(body) {
  const { daysOfWeek, startTime, capacity } = body;

  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
    return 'Vui lòng chọn ít nhất một ngày trong tuần';
  }
  const uniqueDays = new Set(daysOfWeek);
  if (uniqueDays.size !== daysOfWeek.length || daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return 'Ngày trong tuần không hợp lệ';
  }
  if (typeof startTime !== 'string' || !TIME_FORMAT.test(startTime)) {
    return 'Giờ bắt đầu không hợp lệ';
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return 'Sức chứa phải là số nguyên dương';
  }
  return null;
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT id, service_catalog_id AS serviceCatalogId, label, days_of_week AS daysOfWeek,
            start_time AS startTime, capacity, is_active AS isActive
     FROM service_slot_template WHERE service_catalog_id = ? ORDER BY start_time`
  ).bind(params.id).all();

  const coerced = results.map((row) => ({ ...row, isActive: !!row.isActive }));
  return new Response(JSON.stringify(coerced), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};

  const validationError = validateSlotTemplateFields(body);
  if (validationError) return jsonError(validationError, 400);

  const catalogItem = await env.DB.prepare(`SELECT id, is_scheduled FROM service_catalog WHERE id = ?`).bind(params.id).first();
  if (!catalogItem || !catalogItem.is_scheduled) {
    return jsonError('Dịch vụ này chưa bật chế độ khung giờ', 400);
  }

  const { label, daysOfWeek, startTime, capacity } = body;
  const now = new Date().toISOString();

  const result = await env.DB.prepare(
    `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
  )
    .bind(params.id, label || null, daysOfWeek.join(','), startTime, capacity, auth.username, now)
    .run();

  return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

```js
// v4/functions/api/catalog/[id]/slot-templates/[templateId].js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM service_slot_template WHERE id = ? AND service_catalog_id = ?`).bind(params.templateId, params.id).first();
  if (!existing) return jsonError('Không tìm thấy khung giờ', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};

  const label = body.label !== undefined ? body.label : existing.label;
  const daysOfWeek = body.daysOfWeek !== undefined ? body.daysOfWeek : existing.days_of_week.split(',').map(Number);
  const startTime = body.startTime !== undefined ? body.startTime : existing.start_time;
  const capacity = body.capacity !== undefined ? body.capacity : existing.capacity;
  const isActive = body.isActive !== undefined ? body.isActive : !!existing.is_active;

  if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
    return jsonError('Vui lòng chọn ít nhất một ngày trong tuần', 400);
  }
  const uniqueDays = new Set(daysOfWeek);
  if (uniqueDays.size !== daysOfWeek.length || daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return jsonError('Ngày trong tuần không hợp lệ', 400);
  }
  if (typeof startTime !== 'string' || !TIME_FORMAT.test(startTime)) {
    return jsonError('Giờ bắt đầu không hợp lệ', 400);
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return jsonError('Sức chứa phải là số nguyên dương', 400);
  }

  await env.DB.prepare(
    `UPDATE service_slot_template SET label = ?, days_of_week = ?, start_time = ?, capacity = ?, is_active = ? WHERE id = ?`
  )
    .bind(label || null, daysOfWeek.join(','), startTime, capacity, isActive ? 1 : 0, params.templateId)
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/experienceSlots.test.js`
Expected: PASS (16 tests). If it fails with an "Isolated storage failed" / AssertionError teardown-only error after otherwise-passing test lines, retry the exact same single-file command up to 2 more times — this is a known Windows Miniflare teardown flake, not a code defect.

- [ ] **Step 7: Verify the file-based routing (real Cloudflare Functions, not vitest)**

This step exists specifically to confirm `functions/api/catalog/[id].js` (existing file) and `functions/api/catalog/[id]/slot-templates/` (new directory) coexist and route correctly — vitest imports handler functions directly and never exercises Cloudflare's actual router, so this is the only check in this plan that proves it.

Run: `npm run dev` (i.e. `wrangler pages dev . --d1=DB`) in the background from the `v4` repo root. Wait for it to report ready (watch for "Ready on http://..." in its output, typically `http://localhost:8788`). Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8788/api/catalog/1
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8788/api/catalog/1/slot-templates
```

Expected: both return `401` (unauthenticated — no session cookie sent), NOT `404`. A `404` on the second call would mean the directory route isn't being picked up and the whole plan's endpoint structure needs to change before continuing. Stop the `wrangler pages dev` process afterward.

- [ ] **Step 8: Commit**

```bash
git add migrations/0014_experience_slots.sql "functions/api/catalog/[id]/slot-templates/index.js" "functions/api/catalog/[id]/slot-templates/[templateId].js" test/experienceSlots.test.js
git commit -m "feat: add experience-slots schema and slot-template CRUD endpoints"
```

---

### Task 2: Slot-availability endpoint

**Files:**
- Create: `functions/api/catalog/[id]/slot-availability.js`
- Test: `test/experienceSlots.test.js` (append to the file created in Task 1)

**Interfaces:**
- Consumes: `service_slot_template`, `booking_service_items` (both from Task 1's migration).
- Produces: `GET /api/catalog/:id/slot-availability?date=YYYY-MM-DD` → `200` array of `{id, label, startTime, capacity, booked, remaining}`, filtered to active templates whose `daysOfWeek` includes that date's weekday. Task 6 (reception.js picker) and Task 7 (capacity-enforcement reuse of the same weekday logic) depend on this response shape and the `weekdayOf` helper's exact behavior.

- [ ] **Step 1: Write the failing test**

Append to `test/experienceSlots.test.js`:

```js
import { onRequestGet as getAvailability } from '../functions/api/catalog/[id]/slot-availability.js';

describe('GET /api/catalog/:id/slot-availability', () => {
  async function createTemplate({ label, daysOfWeek, startTime, capacity }) {
    const result = await env.DB.prepare(
      `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, '2026-08-01T00:00:00Z')`
    ).bind(scheduledCatalogId, label, daysOfWeek, startTime, capacity).run();
    return result.meta.last_row_id;
  }

  it('returns only templates matching the requested date\'s weekday', async () => {
    // 2026-08-29 is a Saturday (weekday 6)
    await createTemplate({ label: 'Suất tối T7', daysOfWeek: '6', startTime: '19:00', capacity: 30 });
    await createTemplate({ label: 'Suất sáng T2', daysOfWeek: '1', startTime: '08:00', capacity: 10 });

    const response = await getAvailability({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-availability?date=2026-08-29`, { headers: { Cookie: `session=${receptionToken}` } }), env, params: { id: String(scheduledCatalogId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.length).toBe(1);
    expect(body[0].label).toBe('Suất tối T7');
    expect(body[0].remaining).toBe(30);
  });

  it('subtracts posted bookings for that exact (template, date) pair', async () => {
    const templateId = await createTemplate({ label: 'Suất tối', daysOfWeek: '6', startTime: '19:00', capacity: 30 });
    await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, service_catalog_id, name, unit_price, quantity, amount, status, slot_template_id, experience_date, created_by, created_at)
       VALUES (1, ?, 'Đốt lửa trại', 500000, 12, 6000000, 'posted', ?, '2026-08-29', 'le_tan_es', '2026-08-01T00:00:00Z')`
    ).bind(scheduledCatalogId, templateId).run();

    const response = await getAvailability({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-availability?date=2026-08-29`, { headers: { Cookie: `session=${receptionToken}` } }), env, params: { id: String(scheduledCatalogId) } });
    const body = await response.json();
    expect(body[0].booked).toBe(12);
    expect(body[0].remaining).toBe(18);
  });

  it('does not let a booking on a different date affect remaining', async () => {
    const templateId = await createTemplate({ label: 'Suất tối', daysOfWeek: '6', startTime: '19:00', capacity: 30 });
    await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, service_catalog_id, name, unit_price, quantity, amount, status, slot_template_id, experience_date, created_by, created_at)
       VALUES (1, ?, 'Đốt lửa trại', 500000, 12, 6000000, 'posted', ?, '2026-09-05', 'le_tan_es', '2026-08-01T00:00:00Z')`
    ).bind(scheduledCatalogId, templateId).run();

    const response = await getAvailability({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-availability?date=2026-08-29`, { headers: { Cookie: `session=${receptionToken}` } }), env, params: { id: String(scheduledCatalogId) } });
    const body = await response.json();
    expect(body[0].booked).toBe(0);
    expect(body[0].remaining).toBe(30);
  });

  it('excludes an inactive template', async () => {
    await env.DB.prepare(
      `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Cũ', '6', '19:00', 30, 0, '2026-08-01T00:00:00Z')`
    ).bind(scheduledCatalogId).run();

    const response = await getAvailability({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-availability?date=2026-08-29`, { headers: { Cookie: `session=${receptionToken}` } }), env, params: { id: String(scheduledCatalogId) } });
    const body = await response.json();
    expect(body).toEqual([]);
  });

  it('rejects a malformed date (400)', async () => {
    const response = await getAvailability({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-availability?date=29-08-2026`, { headers: { Cookie: `session=${receptionToken}` } }), env, params: { id: String(scheduledCatalogId) } });
    expect(response.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await getAvailability({ request: new Request(`https://x/api/catalog/${scheduledCatalogId}/slot-availability?date=2026-08-29`), env, params: { id: String(scheduledCatalogId) } });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/experienceSlots.test.js`
Expected: FAIL — `Cannot find module '../functions/api/catalog/[id]/slot-availability.js'`

- [ ] **Step 3: Implement the endpoint**

```js
// v4/functions/api/catalog/[id]/slot-availability.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  if (!date || !DATE_FORMAT.test(date)) {
    return jsonError('Ngày không hợp lệ', 400);
  }

  const { results } = await env.DB.prepare(
    `SELECT st.id, st.label, st.start_time AS startTime, st.capacity, st.days_of_week AS daysOfWeek,
            COALESCE(SUM(bsi.quantity), 0) AS booked
     FROM service_slot_template st
     LEFT JOIN booking_service_items bsi
       ON bsi.slot_template_id = st.id AND bsi.experience_date = ? AND bsi.status = 'posted'
     WHERE st.service_catalog_id = ? AND st.is_active = 1
     GROUP BY st.id
     ORDER BY st.start_time`
  ).bind(date, params.id).all();

  const weekday = weekdayOf(date);
  const matching = results
    .filter((row) => row.daysOfWeek.split(',').map(Number).includes(weekday))
    .map(({ daysOfWeek, ...rest }) => ({ ...rest, remaining: rest.capacity - rest.booked }));

  return new Response(JSON.stringify(matching), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/experienceSlots.test.js`
Expected: PASS (22 tests). Retry once or twice on the known Windows teardown-only flake before treating a failure as real.

- [ ] **Step 5: Commit**

```bash
git add "functions/api/catalog/[id]/slot-availability.js" test/experienceSlots.test.js
git commit -m "feat: add GET /api/catalog/:id/slot-availability"
```

---

### Task 3: Catalog admin — `isScheduled`/`termsAndConditions` on the catalog item itself

**Files:**
- Modify: `admin/catalog.html`
- Modify: `admin/catalog.js`
- Modify: `functions/api/catalog/index.js`
- Modify: `functions/api/catalog/[id].js`
- Test: `test/serviceCatalogEndpoints.test.js` (existing file — imports `onRequestGet as getCatalog, onRequestPost as postCatalog` from `functions/api/catalog/index.js`; uses `managerToken`/`receptionToken`/`adminToken`/`observerToken` and a local `authedRequest(url, token, method, body)` helper, already declared in its `beforeEach`)

**Interfaces:**
- Produces: `service_catalog` rows now include `isScheduled`/`termsAndConditions` in every `GET /api/catalog` response, and both are settable via `POST`/`PATCH`. Task 4 (slot-template UI), Task 6 (reception.js), and Task 7 (capacity enforcement) all depend on `catalogItem.isScheduled`/`catalogItem.termsAndConditions` being present wherever a catalog item is read.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `test/serviceCatalogEndpoints.test.js`, inside its existing `describe('GET /api/catalog', ...)` and a new block for the round-trip (append both anywhere after the existing `describe` blocks, before the file's final closing — the file already imports `getCatalog`/`postCatalog` and declares `adminToken`/`authedRequest` in scope):

```js
describe('isScheduled / termsAndConditions', () => {
  it('round-trips isScheduled and termsAndConditions through POST and GET', async () => {
    const createResponse = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', {
        category: 'fnb_hoat_dong', name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000,
        isScheduled: true, termsAndConditions: 'Trẻ em dưới 12 tuổi cần người lớn đi kèm.',
      }),
      env,
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await getCatalog({ request: authedRequest('https://x/api/catalog?all=1', adminToken, 'GET'), env });
    const items = await listResponse.json();
    const created = items.find((i) => i.name === 'Đốt lửa trại');
    expect(created.isScheduled).toBe(true);
    expect(created.termsAndConditions).toBe('Trẻ em dưới 12 tuổi cần người lớn đi kèm.');
  });

  it('defaults isScheduled to false and termsAndConditions to null when omitted', async () => {
    const createResponse = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', { category: 'fnb_hoat_dong', name: 'Cà phê', priceType: 'fixed', priceMin: 30000 }),
      env,
    });
    expect(createResponse.status).toBe(201);

    const listResponse = await getCatalog({ request: authedRequest('https://x/api/catalog?all=1', adminToken, 'GET'), env });
    const items = await listResponse.json();
    const created = items.find((i) => i.name === 'Cà phê');
    expect(created.isScheduled).toBe(false);
    expect(created.termsAndConditions).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/serviceCatalogEndpoints.test.js`
Expected: FAIL — `created.isScheduled` is `undefined`, not `false`.

- [ ] **Step 3: Implement the backend changes**

In `functions/api/catalog/index.js`, change the `baseSelect` inside `onRequestGet`:

```js
  const baseSelect = `SELECT id, category, subgroup, name, price_type AS priceType, price_min AS priceMin, price_max AS priceMax,
              price_label AS priceLabel, unit_capacity AS unitCapacity, note, room_type_key AS roomTypeKey,
              display_order AS displayOrder, is_active AS isActive, is_scheduled AS isScheduled, terms_and_conditions AS termsAndConditions
       FROM service_catalog`;
```

and change the `coerced` mapping to also coerce `isScheduled` to a boolean:

```js
  const coerced = results.map((row) => ({ ...row, isActive: !!row.isActive, isScheduled: !!row.isScheduled }));
```

In `validateCatalogFields`, add `termsAndConditions` to the destructure and its check:

```js
function validateCatalogFields(body) {
  const { category, name, priceType, priceMin, priceMax, priceLabel, roomTypeKey, subgroup, unitCapacity, note, termsAndConditions } = body;

  if (!VALID_CATEGORIES.includes(category)) return 'Hạng mục không hợp lệ';
  if (typeof name !== 'string' || name.trim() === '') return 'Tên dịch vụ không được để trống';
  if (!VALID_PRICE_TYPES.includes(priceType)) return 'Kiểu giá không hợp lệ';

  if (priceType === 'range') {
    if (!Number.isInteger(priceMin) || priceMin < 0 || !Number.isInteger(priceMax) || priceMax < priceMin) {
      return 'Khoảng giá không hợp lệ: cần Giá A và Giá B là số nguyên không âm, Giá B >= Giá A';
    }
  } else if (priceType === 'fixed') {
    if (!Number.isInteger(priceMin) || priceMin < 0) return 'Giá cố định phải là số nguyên không âm';
  } else if (priceType === 'label') {
    if (typeof priceLabel !== 'string' || priceLabel.trim() === '') return 'Nhãn giá không được để trống';
  }

  if (roomTypeKey != null && !VALID_ROOM_TYPE_KEYS.includes(roomTypeKey)) return 'Loại phòng liên kết không hợp lệ';
  if (subgroup != null && typeof subgroup !== 'string') return 'Nhóm phụ không hợp lệ';
  if (unitCapacity != null && typeof unitCapacity !== 'string') return 'Đơn vị/Sức chứa không hợp lệ';
  if (note != null && typeof note !== 'string') return 'Ghi chú không hợp lệ';
  if (termsAndConditions != null && typeof termsAndConditions !== 'string') return 'Điều khoản & điều kiện không hợp lệ';
  return null;
}
```

In `onRequestPost`, add `isScheduled`/`termsAndConditions` to the destructure and the `INSERT`:

```js
  const { category, subgroup, name, priceType, priceMin, priceMax, priceLabel, unitCapacity, note, roomTypeKey, displayOrder, isScheduled, termsAndConditions } = body;

  if (roomTypeKey) {
    const conflict = await env.DB.prepare(`SELECT id FROM service_catalog WHERE room_type_key = ? AND is_active = 1`).bind(roomTypeKey).first();
    if (conflict) return jsonError('Loại phòng này đã được liên kết với 1 dòng khác', 400);
  }

  const finalPriceMin = priceType === 'label' ? null : priceMin;
  const finalPriceMax = priceType === 'range' ? priceMax : null;
  const finalPriceLabel = priceType === 'label' ? priceLabel : null;

  await env.DB.prepare(
    `INSERT INTO service_catalog (category, subgroup, name, price_type, price_min, price_max, price_label, unit_capacity, note, room_type_key, display_order, is_active, is_scheduled, terms_and_conditions, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  )
    .bind(
      category,
      subgroup || null,
      name.trim(),
      priceType,
      finalPriceMin,
      finalPriceMax,
      finalPriceLabel,
      unitCapacity || null,
      note || null,
      roomTypeKey || null,
      Number.isInteger(displayOrder) ? displayOrder : 0,
      isScheduled ? 1 : 0,
      termsAndConditions || null,
      auth.username,
      new Date().toISOString()
    )
    .run();
```

In `functions/api/catalog/[id].js`'s `onRequestPatch`, add fallback reads and validation for the two new fields, and add them to the `UPDATE`:

```js
  const category = body.category !== undefined ? body.category : existing.category;
  const subgroup = body.subgroup !== undefined ? body.subgroup : existing.subgroup;
  const name = body.name !== undefined ? body.name : existing.name;
  const priceType = body.priceType !== undefined ? body.priceType : existing.price_type;
  const priceMin = body.priceMin !== undefined ? body.priceMin : existing.price_min;
  const priceMax = body.priceMax !== undefined ? body.priceMax : existing.price_max;
  const priceLabel = body.priceLabel !== undefined ? body.priceLabel : existing.price_label;
  const unitCapacity = body.unitCapacity !== undefined ? body.unitCapacity : existing.unit_capacity;
  const note = body.note !== undefined ? body.note : existing.note;
  const roomTypeKey = body.roomTypeKey !== undefined ? body.roomTypeKey : existing.room_type_key;
  const displayOrder = body.displayOrder !== undefined ? body.displayOrder : existing.display_order;
  const isActive = body.isActive !== undefined ? body.isActive : !!existing.is_active;
  const isScheduled = body.isScheduled !== undefined ? body.isScheduled : !!existing.is_scheduled;
  const termsAndConditions = body.termsAndConditions !== undefined ? body.termsAndConditions : existing.terms_and_conditions;

  if (!VALID_CATEGORIES.includes(category)) return jsonError('Hạng mục không hợp lệ', 400);
  if (typeof name !== 'string' || name.trim() === '') return jsonError('Tên dịch vụ không được để trống', 400);
  if (!VALID_PRICE_TYPES.includes(priceType)) return jsonError('Kiểu giá không hợp lệ', 400);
  if (priceType === 'range' && (!Number.isInteger(priceMin) || priceMin < 0 || !Number.isInteger(priceMax) || priceMax < priceMin)) {
    return jsonError('Khoảng giá không hợp lệ: cần Giá A và Giá B là số nguyên không âm, Giá B >= Giá A', 400);
  }
  if (priceType === 'fixed' && (!Number.isInteger(priceMin) || priceMin < 0)) {
    return jsonError('Giá cố định phải là số nguyên không âm', 400);
  }
  if (priceType === 'label' && (typeof priceLabel !== 'string' || priceLabel.trim() === '')) {
    return jsonError('Nhãn giá không được để trống', 400);
  }
  if (roomTypeKey != null && !VALID_ROOM_TYPE_KEYS.includes(roomTypeKey)) return jsonError('Loại phòng liên kết không hợp lệ', 400);
  if (termsAndConditions != null && typeof termsAndConditions !== 'string') return jsonError('Điều khoản & điều kiện không hợp lệ', 400);

  if (roomTypeKey && isActive) {
    const conflict = await env.DB.prepare(`SELECT id FROM service_catalog WHERE room_type_key = ? AND is_active = 1 AND id != ?`).bind(roomTypeKey, params.id).first();
    if (conflict) return jsonError('Loại phòng này đã được liên kết với 1 dòng khác', 400);
  }

  const finalPriceMin = priceType === 'label' ? null : priceMin;
  const finalPriceMax = priceType === 'range' ? priceMax : null;
  const finalPriceLabel = priceType === 'label' ? priceLabel : null;

  await env.DB.prepare(
    `UPDATE service_catalog SET category = ?, subgroup = ?, name = ?, price_type = ?, price_min = ?, price_max = ?,
       price_label = ?, unit_capacity = ?, note = ?, room_type_key = ?, display_order = ?, is_active = ?, is_scheduled = ?, terms_and_conditions = ?,
       updated_by = ?, updated_at = ? WHERE id = ?`
  )
    .bind(
      category,
      subgroup || null,
      typeof name === 'string' ? name.trim() : name,
      priceType,
      finalPriceMin,
      finalPriceMax,
      finalPriceLabel,
      unitCapacity || null,
      note || null,
      roomTypeKey || null,
      Number.isInteger(displayOrder) ? displayOrder : 0,
      isActive ? 1 : 0,
      isScheduled ? 1 : 0,
      termsAndConditions || null,
      auth.username,
      new Date().toISOString(),
      params.id
    )
    .run();
```

- [ ] **Step 4: Update the catalog form HTML**

In `admin/catalog.html`, add the checkbox and terms textarea right after the existing "Dùng nhãn tự do" checkbox and before `<div class="form-row" id="priceRangeFields">`:

```html
      <label class="checkbox"><input type="checkbox" name="isScheduled" /> Có khung giờ + sức chứa (trải nghiệm)</label>
      <label id="termsField" class="hidden">Điều khoản &amp; điều kiện sử dụng dịch vụ (hiển thị cho lễ tân khi đăng ký)
        <textarea name="termsAndConditions" rows="4" placeholder="VD: Trẻ em dưới 12 tuổi cần người lớn đi kèm. Không hoàn phí nếu huỷ trong ngày..."></textarea>
      </label>
```

- [ ] **Step 5: Update `admin/catalog.js`**

Add a toggle function and wire it up, next to `updatePriceTypeFields`:

```js
function updateScheduledFields() {
  const isScheduled = document.querySelector('#catalogForm input[name="isScheduled"]').checked;
  document.getElementById('termsField').classList.toggle('hidden', !isScheduled);
}

document.querySelector('#catalogForm input[name="isScheduled"]').addEventListener('change', updateScheduledFields);
```

In `resetForm()`, add a call to `updateScheduledFields()` alongside the existing `updatePriceTypeFields()` call:

```js
function resetForm() {
  const form = document.getElementById('catalogForm');
  form.reset();
  form.querySelector('input[name="id"]').value = '';
  form.querySelector('input[name="category"]').value = activeCategory;
  document.getElementById('roomTypeField').classList.toggle('hidden', activeCategory !== 'luu_tru');
  document.getElementById('catalogSubmitBtn').textContent = 'Thêm dịch vụ';
  updatePriceTypeFields();
  updateScheduledFields();
}
```

In `openEditForm(item)`, populate the two new fields and call the toggle:

```js
function openEditForm(item) {
  const form = document.getElementById('catalogForm');
  form.classList.remove('hidden');
  form.querySelector('input[name="id"]').value = item.id;
  form.querySelector('input[name="category"]').value = item.category;
  form.querySelector('input[name="subgroup"]').value = item.subgroup || '';
  form.querySelector('input[name="name"]').value = item.name;
  const isLabel = item.priceType === 'label';
  form.querySelector('input[name="isLabelPrice"]').checked = isLabel;
  form.querySelector('input[name="priceMin"]').value = !isLabel ? item.priceMin : '';
  form.querySelector('input[name="priceMax"]').value = item.priceType === 'range' ? item.priceMax : '';
  form.querySelector('input[name="priceLabel"]').value = isLabel ? item.priceLabel : '';
  form.querySelector('input[name="unitCapacity"]').value = item.unitCapacity || '';
  form.querySelector('input[name="note"]').value = item.note || '';
  form.querySelector('input[name="isScheduled"]').checked = item.isScheduled;
  form.querySelector('textarea[name="termsAndConditions"]').value = item.termsAndConditions || '';
  const roomTypeSelect = form.querySelector('select[name="roomTypeKey"]');
  if (roomTypeSelect) roomTypeSelect.value = item.roomTypeKey || '';
  document.getElementById('roomTypeField').classList.toggle('hidden', item.category !== 'luu_tru');
  document.getElementById('catalogSubmitBtn').textContent = 'Lưu thay đổi';
  updatePriceTypeFields();
  updateScheduledFields();
}
```

In the form's `submit` handler, add the two fields to `payload`:

```js
  const payload = {
    category: data.get('category'),
    subgroup: data.get('subgroup') || null,
    name: data.get('name'),
    unitCapacity: data.get('unitCapacity') || null,
    note: data.get('note') || null,
    roomTypeKey: data.get('roomTypeKey') || null,
    isScheduled: form.querySelector('input[name="isScheduled"]').checked,
    termsAndConditions: data.get('termsAndConditions') || null,
  };
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/serviceCatalogEndpoints.test.js`
Expected: PASS (all tests including the 2 new ones). Retry once or twice on the known Windows teardown-only flake before treating a failure as real.

- [ ] **Step 7: Manual verification**

Run: `node --check admin/catalog.js` (confirms no syntax errors). Start `npx http-server . -p 4174 -s -c-1` in the background from the `v4` repo root, poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/admin/catalog.html` until `200`, then `curl -s http://localhost:4174/admin/catalog.html | grep "termsField"` to confirm the new markup is present. Stop the server and free port 4174 afterward (`netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>`).

- [ ] **Step 8: Commit**

```bash
git add admin/catalog.html admin/catalog.js functions/api/catalog/index.js "functions/api/catalog/[id].js" test/serviceCatalogEndpoints.test.js
git commit -m "feat: add isScheduled/termsAndConditions to the catalog item form and API"
```

---

### Task 4: Catalog admin — slot-templates management UI

**Files:**
- Modify: `admin/catalog.html`
- Modify: `admin/catalog.js`

**Interfaces:**
- Consumes: `GET`/`POST /api/catalog/:id/slot-templates`, `PATCH /api/catalog/:id/slot-templates/:templateId` (Task 1), `item.isScheduled` (Task 3).

- [ ] **Step 1: Add the HTML section**

In `admin/catalog.html`, add right after the closing `</form>` of `catalogForm` and before `<button type="button" id="addServiceBtn" class="hidden">+ Thêm dịch vụ</button>`:

```html
    <div id="slotTemplatesSection" class="hidden">
      <h3>Khung giờ &amp; sức chứa</h3>
      <p id="slotTemplatesError" class="error"></p>
      <div class="table-scroll">
        <table id="slotTemplatesTable">
          <thead><tr><th>Nhãn</th><th>Ngày trong tuần</th><th>Giờ bắt đầu</th><th>Sức chứa</th><th>Trạng thái</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <form id="slotTemplateForm">
        <input type="hidden" name="id" />
        <label>Nhãn (tuỳ chọn) <input type="text" name="label" placeholder="VD: Suất tối" /></label>
        <fieldset>
          <legend>Ngày trong tuần</legend>
          <label class="checkbox"><input type="checkbox" name="dow" value="1" /> T2</label>
          <label class="checkbox"><input type="checkbox" name="dow" value="2" /> T3</label>
          <label class="checkbox"><input type="checkbox" name="dow" value="3" /> T4</label>
          <label class="checkbox"><input type="checkbox" name="dow" value="4" /> T5</label>
          <label class="checkbox"><input type="checkbox" name="dow" value="5" /> T6</label>
          <label class="checkbox"><input type="checkbox" name="dow" value="6" /> T7</label>
          <label class="checkbox"><input type="checkbox" name="dow" value="0" /> CN</label>
        </fieldset>
        <label>Giờ bắt đầu <input type="time" name="startTime" required /></label>
        <label>Sức chứa (số khách) <input type="number" name="capacity" min="1" required /></label>
        <button type="submit" id="slotTemplateSubmitBtn">Thêm khung giờ</button>
        <button type="button" id="slotTemplateCancelBtn" class="btn-secondary">Huỷ</button>
      </form>
      <button type="button" id="addSlotTemplateBtn">+ Thêm khung giờ</button>
    </div>
```

- [ ] **Step 2: Add the JS**

The day-of-week checkboxes need a display label map and a slot-templates load/render/CRUD set. Add near the top of `admin/catalog.js`, after `let activeCategory = 'luu_tru';`:

```js
let editingCatalogItem = null;
const DOW_LABELS = { 0: 'CN', 1: 'T2', 2: 'T3', 3: 'T4', 4: 'T5', 5: 'T6', 6: 'T7' };
```

Add these functions anywhere alongside the other top-level functions (e.g. after `deleteItem`):

```js
async function loadSlotTemplates(catalogId) {
  const errorEl = document.getElementById('slotTemplatesError');
  errorEl.textContent = '';
  const response = await fetch(`/api/catalog/${catalogId}/slot-templates`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải khung giờ';
    return;
  }
  const templates = await response.json();
  renderSlotTemplatesTable(templates);
}

function renderSlotTemplatesTable(templates) {
  const tbody = document.querySelector('#slotTemplatesTable tbody');
  tbody.innerHTML = '';
  templates.forEach((t) => {
    const tr = document.createElement('tr');
    if (!t.isActive) tr.style.opacity = '0.5';

    const tdLabel = document.createElement('td');
    tdLabel.textContent = t.label || '';
    const tdDays = document.createElement('td');
    tdDays.textContent = t.daysOfWeek.split(',').map(Number).sort().map((d) => DOW_LABELS[d]).join(', ');
    const tdTime = document.createElement('td');
    tdTime.textContent = t.startTime;
    const tdCapacity = document.createElement('td');
    tdCapacity.textContent = t.capacity;
    const tdStatus = document.createElement('td');
    tdStatus.textContent = t.isActive ? 'Đang áp dụng' : 'Đã tắt';

    const tdActions = document.createElement('td');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = 'Sửa';
    editBtn.addEventListener('click', () => openSlotTemplateEditForm(t));
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn-secondary';
    toggleBtn.textContent = t.isActive ? 'Tắt' : 'Bật lại';
    toggleBtn.addEventListener('click', () => toggleSlotTemplateActive(t));
    tdActions.append(editBtn, toggleBtn);

    tr.append(tdLabel, tdDays, tdTime, tdCapacity, tdStatus, tdActions);
    tbody.appendChild(tr);
  });
}

async function toggleSlotTemplateActive(template) {
  const errorEl = document.getElementById('slotTemplatesError');
  errorEl.textContent = '';
  const response = await fetch(`/api/catalog/${editingCatalogItem.id}/slot-templates/${template.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !template.isActive }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi cập nhật khung giờ';
    return;
  }
  await loadSlotTemplates(editingCatalogItem.id);
}

function resetSlotTemplateForm() {
  const form = document.getElementById('slotTemplateForm');
  form.reset();
  form.querySelector('input[name="id"]').value = '';
  document.getElementById('slotTemplateSubmitBtn').textContent = 'Thêm khung giờ';
}

function openSlotTemplateEditForm(template) {
  const form = document.getElementById('slotTemplateForm');
  form.querySelector('input[name="id"]').value = template.id;
  form.querySelector('input[name="label"]').value = template.label || '';
  const days = new Set(template.daysOfWeek.split(',').map(Number));
  form.querySelectorAll('input[name="dow"]').forEach((cb) => {
    cb.checked = days.has(Number(cb.value));
  });
  form.querySelector('input[name="startTime"]').value = template.startTime;
  form.querySelector('input[name="capacity"]').value = template.capacity;
  document.getElementById('slotTemplateSubmitBtn').textContent = 'Lưu thay đổi';
}

document.getElementById('addSlotTemplateBtn').addEventListener('click', () => {
  resetSlotTemplateForm();
});

document.getElementById('slotTemplateCancelBtn').addEventListener('click', (event) => {
  event.preventDefault();
  resetSlotTemplateForm();
});

document.getElementById('slotTemplateForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = document.getElementById('slotTemplatesError');
  errorEl.textContent = '';

  const id = data.get('id');
  const daysOfWeek = data.getAll('dow').map(Number);
  const payload = {
    label: data.get('label') || null,
    daysOfWeek,
    startTime: data.get('startTime'),
    capacity: Number(data.get('capacity')),
  };

  const response = await fetch(
    id ? `/api/catalog/${editingCatalogItem.id}/slot-templates/${id}` : `/api/catalog/${editingCatalogItem.id}/slot-templates`,
    {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu khung giờ';
    return;
  }

  resetSlotTemplateForm();
  await loadSlotTemplates(editingCatalogItem.id);
});
```

- [ ] **Step 3: Wire `slotTemplatesSection` visibility into `openEditForm`**

Modify `openEditForm` (already touched in Task 3) to also track the item being edited and show/load the slot-templates section:

```js
function openEditForm(item) {
  editingCatalogItem = item;
  const form = document.getElementById('catalogForm');
  form.classList.remove('hidden');
  form.querySelector('input[name="id"]').value = item.id;
  form.querySelector('input[name="category"]').value = item.category;
  form.querySelector('input[name="subgroup"]').value = item.subgroup || '';
  form.querySelector('input[name="name"]').value = item.name;
  const isLabel = item.priceType === 'label';
  form.querySelector('input[name="isLabelPrice"]').checked = isLabel;
  form.querySelector('input[name="priceMin"]').value = !isLabel ? item.priceMin : '';
  form.querySelector('input[name="priceMax"]').value = item.priceType === 'range' ? item.priceMax : '';
  form.querySelector('input[name="priceLabel"]').value = isLabel ? item.priceLabel : '';
  form.querySelector('input[name="unitCapacity"]').value = item.unitCapacity || '';
  form.querySelector('input[name="note"]').value = item.note || '';
  form.querySelector('input[name="isScheduled"]').checked = item.isScheduled;
  form.querySelector('textarea[name="termsAndConditions"]').value = item.termsAndConditions || '';
  const roomTypeSelect = form.querySelector('select[name="roomTypeKey"]');
  if (roomTypeSelect) roomTypeSelect.value = item.roomTypeKey || '';
  document.getElementById('roomTypeField').classList.toggle('hidden', item.category !== 'luu_tru');
  document.getElementById('catalogSubmitBtn').textContent = 'Lưu thay đổi';
  updatePriceTypeFields();
  updateScheduledFields();

  const slotSection = document.getElementById('slotTemplatesSection');
  if (currentRole === 'admin' && item.isScheduled) {
    slotSection.classList.remove('hidden');
    resetSlotTemplateForm();
    loadSlotTemplates(item.id);
  } else {
    slotSection.classList.add('hidden');
  }
}
```

Also hide `slotTemplatesSection` whenever the "+ Thêm dịch vụ" (create-new) flow starts, since a not-yet-created item has no id to attach templates to — modify the `addServiceBtn` click handler:

```js
document.getElementById('addServiceBtn').addEventListener('click', () => {
  editingCatalogItem = null;
  document.getElementById('slotTemplatesSection').classList.add('hidden');
  resetForm();
  document.getElementById('catalogForm').classList.remove('hidden');
});
```

- [ ] **Step 4: Manual verification**

Run: `node --check admin/catalog.js`. Start the local server as in Task 3 Step 8, confirm `curl -s http://localhost:4174/admin/catalog.html | grep "slotTemplatesSection"` finds the new markup. Stop the server and free the port afterward.

- [ ] **Step 5: Commit**

```bash
git add admin/catalog.html admin/catalog.js
git commit -m "feat: add slot-template management UI to the catalog admin page"
```

---

### Task 5: `GET`/`PATCH /api/experience-booking-settings`

**Files:**
- Create: `functions/api/experience-booking-settings.js`
- Test: `test/experienceBookingSettings.test.js`

**Interfaces:**
- Consumes: `experience_booking_settings` table (Task 1).
- Produces: `GET /api/experience-booking-settings` → `200 {suggestionWindowDays, maxSuggestions, updatedAt}`. `PATCH /api/experience-booking-settings` → `200 {ok: true}`. Task 6 (catalog.js admin form) and Task 7 (`findAlternativeSlots`) both depend on this exact shape.

- [ ] **Step 1: Write the failing test**

```js
// v4/test/experienceBookingSettings.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getSettings, onRequestPatch as patchSettings } from '../functions/api/experience-booking-settings.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM experience_booking_settings');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_eb', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'le_tan_eb', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  receptionToken = await createSession(env.DB, 2);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'admin_eb', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 3);
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (4, 'quan_sat_eb', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  observerToken = await createSession(env.DB, 4);
});

function authedRequest(url, token, method = 'GET', body) {
  const headers = token ? { Cookie: `session=${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/experience-booking-settings', () => {
  it('returns the default 14/5 when the table is empty', async () => {
    const response = await getSettings({ request: authedRequest('https://x/api/experience-booking-settings', managerToken), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ suggestionWindowDays: 14, maxSuggestions: 5, updatedAt: null });
  });

  it('returns the seeded values when a row exists', async () => {
    await env.DB.prepare(`INSERT INTO experience_booking_settings (suggestion_window_days, max_suggestions, updated_at) VALUES (21, 3, '2026-08-27T00:00:00Z')`).run();
    const response = await getSettings({ request: authedRequest('https://x/api/experience-booking-settings', receptionToken), env });
    const body = await response.json();
    expect(body.suggestionWindowDays).toBe(21);
    expect(body.maxSuggestions).toBe(3);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await getSettings({ request: new Request('https://x/api/experience-booking-settings'), env });
    expect(response.status).toBe(401);
  });
});

describe('PATCH /api/experience-booking-settings', () => {
  it('lets an admin update the values', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', adminToken, 'PATCH', { suggestionWindowDays: 10, maxSuggestions: 3 }), env });
    expect(response.status).toBe(200);

    const getResponse = await getSettings({ request: authedRequest('https://x/api/experience-booking-settings', adminToken), env });
    const body = await getResponse.json();
    expect(body.suggestionWindowDays).toBe(10);
    expect(body.maxSuggestions).toBe(3);
  });

  it('inserts a new row rather than mutating the existing one', async () => {
    await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', adminToken, 'PATCH', { suggestionWindowDays: 10, maxSuggestions: 3 }), env });
    const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM experience_booking_settings`).first();
    expect(countRow.n).toBe(1);

    await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', adminToken, 'PATCH', { suggestionWindowDays: 7, maxSuggestions: 5 }), env });
    const countRow2 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM experience_booking_settings`).first();
    expect(countRow2.n).toBe(2);
  });

  it('rejects a manager (403) -- admin-only', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', managerToken, 'PATCH', { suggestionWindowDays: 10, maxSuggestions: 3 }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a reception account (403)', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', receptionToken, 'PATCH', { suggestionWindowDays: 10, maxSuggestions: 3 }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a zero value (400)', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', adminToken, 'PATCH', { suggestionWindowDays: 0, maxSuggestions: 3 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a value above the upper bound (400)', async () => {
    const response = await patchSettings({ request: authedRequest('https://x/api/experience-booking-settings', adminToken, 'PATCH', { suggestionWindowDays: 400, maxSuggestions: 3 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await patchSettings({ request: new Request('https://x/api/experience-booking-settings', { method: 'PATCH' }), env });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/experienceBookingSettings.test.js`
Expected: FAIL — `Cannot find module '../functions/api/experience-booking-settings.js'`

- [ ] **Step 3: Implement the endpoint**

```js
// v4/functions/api/experience-booking-settings.js
import { requireAuth } from '../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(
    `SELECT suggestion_window_days AS suggestionWindowDays, max_suggestions AS maxSuggestions, updated_at AS updatedAt FROM experience_booking_settings ORDER BY id DESC LIMIT 1`
  ).first();

  const result = row || { suggestionWindowDays: 14, maxSuggestions: 5, updatedAt: null };
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
  const { suggestionWindowDays, maxSuggestions } = body || {};

  if (!Number.isInteger(suggestionWindowDays) || suggestionWindowDays <= 0 || suggestionWindowDays > 365 || !Number.isInteger(maxSuggestions) || maxSuggestions <= 0 || maxSuggestions > 50) {
    return jsonError('Số ngày/số gợi ý phải là số nguyên dương và trong giới hạn cho phép', 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO experience_booking_settings (suggestion_window_days, max_suggestions, updated_by, updated_at) VALUES (?, ?, ?, ?)`
  ).bind(suggestionWindowDays, maxSuggestions, auth.username, now).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/experienceBookingSettings.test.js`
Expected: PASS (10 tests). Retry once or twice on the known Windows teardown-only flake before treating a failure as real.

- [ ] **Step 5: Commit**

```bash
git add functions/api/experience-booking-settings.js test/experienceBookingSettings.test.js
git commit -m "feat: add GET/PATCH /api/experience-booking-settings"
```

---

### Task 6: Catalog admin — experience-settings form

**Files:**
- Modify: `admin/catalog.html`
- Modify: `admin/catalog.js`

**Interfaces:**
- Consumes: `GET`/`PATCH /api/experience-booking-settings` (Task 5).

- [ ] **Step 1: Add the HTML section**

In `admin/catalog.html`, add right after `<h1>Bảng giá dịch vụ</h1>` and before `<div class="filters" id="catalogTabs">`:

```html
    <div id="experienceSettingsSection" class="hidden">
      <h2>Cấu hình gợi ý khung giờ</h2>
      <form id="experienceSettingsForm">
        <label>Số ngày tìm gợi ý (khi hết chỗ) <input type="number" name="suggestionWindowDays" min="1" max="365" required /></label>
        <label>Số gợi ý tối đa hiển thị <input type="number" name="maxSuggestions" min="1" max="50" required /></label>
        <button type="submit">Lưu cấu hình</button>
        <p id="experienceSettingsError" class="error"></p>
      </form>
    </div>
```

- [ ] **Step 2: Add the JS**

Add near the other `load*` functions:

```js
async function loadExperienceSettings() {
  const errorEl = document.getElementById('experienceSettingsError');
  let response;
  try {
    response = await fetch('/api/experience-booking-settings');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải cấu hình gợi ý khung giờ';
    return;
  }
  if (!response.ok) {
    errorEl.textContent = 'Có lỗi khi tải cấu hình gợi ý khung giờ';
    return;
  }
  const data = await response.json();
  const form = document.getElementById('experienceSettingsForm');
  form.querySelector('input[name="suggestionWindowDays"]').value = data.suggestionWindowDays;
  form.querySelector('input[name="maxSuggestions"]').value = data.maxSuggestions;
}

document.getElementById('experienceSettingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const errorEl = document.getElementById('experienceSettingsError');
  errorEl.textContent = '';

  const response = await fetch('/api/experience-booking-settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      suggestionWindowDays: Number(data.get('suggestionWindowDays')),
      maxSuggestions: Number(data.get('maxSuggestions')),
    }),
  });

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi khi lưu cấu hình';
    return;
  }

  await loadExperienceSettings();
});
```

- [ ] **Step 3: Show the section for admin at page load**

In the existing page-init IIFE at the top of `admin/catalog.js`:

```js
(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;
  if (currentRole === 'admin') {
    document.getElementById('addServiceBtn').classList.remove('hidden');
    document.getElementById('experienceSettingsSection').classList.remove('hidden');
    loadExperienceSettings();
  }
  await loadCatalog();
})();
```

- [ ] **Step 4: Manual verification**

Run: `node --check admin/catalog.js`. Start the local server as in prior tasks, confirm `curl -s http://localhost:4174/admin/catalog.html | grep "experienceSettingsSection"` finds the new markup. Stop the server and free the port afterward.

- [ ] **Step 5: Commit**

```bash
git add admin/catalog.html admin/catalog.js
git commit -m "feat: add experience-settings admin form to catalog.html"
```

---

### Task 7: Capacity enforcement + terms enforcement on `POST /api/bookings/:id/services`

**Files:**
- Modify: `functions/api/bookings/[id]/services/index.js`
- Test: `test/bookingServiceItems.test.js`

**Interfaces:**
- Consumes: `service_slot_template`, `experience_booking_settings` (Task 1/5 schema), `catalogItem.isScheduled`/`termsAndConditions` (Task 3).
- Produces: `POST /api/bookings/:id/services` now accepts `experienceDate`/`slotTemplateId`/`termsAccepted` and enforces capacity + terms; on capacity failure returns `409 {error, alternatives: [{date, slotTemplateId, label, startTime, remaining}]}`. Task 8 (reception.js) depends on this exact request/response shape.

- [ ] **Step 1: Write the failing tests**

Add a new fixture setup and tests inside `test/bookingServiceItems.test.js`. First, extend the `beforeEach` to also clear/seed `service_slot_template` and `experience_booking_settings`, and add a scheduled catalog item + one slot template as fixtures. Add these lines inside the existing `beforeEach`, right after the `inactiveCatalogId` block:

```js
  await env.DB.exec('DELETE FROM service_slot_template');
  await env.DB.exec('DELETE FROM experience_booking_settings');
  await env.DB.prepare(`INSERT INTO experience_booking_settings (suggestion_window_days, max_suggestions, updated_at) VALUES (14, 5, '2026-08-01T00:00:00Z')`).run();

  const scheduledCatalog = await env.DB.prepare(
    `INSERT INTO service_catalog (category, name, price_type, price_min, display_order, is_active, is_scheduled, updated_at) VALUES ('fnb_hoat_dong', 'Đốt lửa trại', 'fixed', 500000, 3, 1, 1, '2026-08-01T00:00:00Z')`
  ).run();
  scheduledCatalogId = scheduledCatalog.meta.last_row_id;

  const scheduledWithTermsCatalog = await env.DB.prepare(
    `INSERT INTO service_catalog (category, name, price_type, price_min, display_order, is_active, is_scheduled, terms_and_conditions, updated_at) VALUES ('fnb_hoat_dong', 'Cắm trại qua đêm', 'fixed', 300000, 4, 1, 1, 'Trẻ em dưới 12 tuổi cần người lớn đi kèm.', '2026-08-01T00:00:00Z')`
  ).run();
  scheduledWithTermsCatalogId = scheduledWithTermsCatalog.meta.last_row_id;

  // Saturday-only slot, capacity 30
  const templateResult = await env.DB.prepare(
    `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất tối', '6', '19:00', 30, 1, '2026-08-01T00:00:00Z')`
  ).bind(scheduledCatalogId).run();
  slotTemplateId = templateResult.meta.last_row_id;
```

Add the corresponding `let` declarations at the top of the file:

```js
let scheduledCatalogId, scheduledWithTermsCatalogId, slotTemplateId;
```

Then add these tests at the end of the existing `describe('POST /api/bookings/:id/services', ...)` block, right before its closing `});`:

```js
  it('rejects a scheduled item without experienceDate/slotTemplateId (400)', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 5 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a date whose weekday does not match the slot template (400)', async () => {
    // 2026-08-31 is a Monday, the template only applies on Saturday
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 5, experienceDate: '2026-08-31', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('registers a scheduled item within capacity and snapshots the slot label/time', async () => {
    // 2026-08-29 is a Saturday
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 10, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM booking_service_items WHERE booking_id = ?`).bind(confirmedBookingId).first();
    expect(row.experience_date).toBe('2026-08-29');
    expect(row.slot_template_id).toBe(slotTemplateId);
    expect(row.experience_slot_label).toBe('Suất tối');
    expect(row.experience_start_time).toBe('19:00');
  });

  it('rejects a request exceeding remaining capacity (409) with alternatives', async () => {
    // fill 25 of 30 capacity first
    await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 25, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    // add another Saturday template a week later with room, so a valid alternative exists
    await env.DB.prepare(
      `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất tối', '6', '19:00', 30, 1, '2026-08-01T00:00:00Z')`
    ).bind(scheduledCatalogId).run();

    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 10, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.alternatives.length).toBeGreaterThan(0);
    expect(body.alternatives.every((a) => a.remaining >= 10)).toBe(true);
  });

  it('frees capacity when the registration is voided, allowing a subsequent request to succeed', async () => {
    const first = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 30, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();

    const blocked = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 5, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(blocked.status).toBe(409);

    await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${firstBody.id}`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(firstBody.id) },
    });

    const afterVoid = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 5, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(afterVoid.status).toBe(201);
  });

  it('rejects a scheduled item with configured terms when termsAccepted is missing (400)', async () => {
    const template = await env.DB.prepare(
      `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất đêm', '6', '20:00', 10, 1, '2026-08-01T00:00:00Z')`
    ).bind(scheduledWithTermsCatalogId).run();

    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledWithTermsCatalogId, unitPrice: 300000, quantity: 2, experienceDate: '2026-08-29', slotTemplateId: template.meta.last_row_id }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('accepts a scheduled item with configured terms when termsAccepted is true, stamping terms_accepted_at', async () => {
    const template = await env.DB.prepare(
      `INSERT INTO service_slot_template (service_catalog_id, label, days_of_week, start_time, capacity, is_active, created_at) VALUES (?, 'Suất đêm', '6', '20:00', 10, 1, '2026-08-01T00:00:00Z')`
    ).bind(scheduledWithTermsCatalogId).run();

    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledWithTermsCatalogId, unitPrice: 300000, quantity: 2, experienceDate: '2026-08-29', slotTemplateId: template.meta.last_row_id, termsAccepted: true }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT terms_accepted_at FROM booking_service_items WHERE booking_id = ? AND service_catalog_id = ?`).bind(confirmedBookingId, scheduledWithTermsCatalogId).first();
    expect(row.terms_accepted_at).not.toBeNull();
  });

  it('succeeds without termsAccepted for a scheduled item with no configured terms, leaving terms_accepted_at NULL', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: scheduledCatalogId, unitPrice: 500000, quantity: 2, experienceDate: '2026-08-29', slotTemplateId }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT terms_accepted_at FROM booking_service_items WHERE booking_id = ? AND service_catalog_id = ?`).bind(confirmedBookingId, scheduledCatalogId).first();
    expect(row.terms_accepted_at).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/bookingServiceItems.test.js`
Expected: FAIL — the scheduled-item requests currently succeed unconditionally (no capacity/weekday/terms checks exist yet), so several new assertions fail (e.g. expecting `400`/`409` but getting `201`, and `row.experience_date` is `undefined`).

- [ ] **Step 3: Implement the endpoint changes**

Replace the full contents of `functions/api/bookings/[id]/services/index.js`:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

async function computeRemaining(env, slotTemplateId, experienceDate, capacity) {
  const bookedRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS booked FROM booking_service_items
     WHERE slot_template_id = ? AND experience_date = ? AND status = 'posted'`
  ).bind(slotTemplateId, experienceDate).first();
  return capacity - bookedRow.booked;
}

async function findAlternativeSlots(env, catalogId, fromDate, requiredQuantity) {
  const settingsRow = await env.DB.prepare(
    `SELECT suggestion_window_days AS suggestionWindowDays, max_suggestions AS maxSuggestions FROM experience_booking_settings ORDER BY id DESC LIMIT 1`
  ).first();
  const { suggestionWindowDays, maxSuggestions } = settingsRow || { suggestionWindowDays: 14, maxSuggestions: 5 };

  const { results: templates } = await env.DB.prepare(
    `SELECT id, label, start_time AS startTime, capacity, days_of_week AS daysOfWeek FROM service_slot_template WHERE service_catalog_id = ? AND is_active = 1`
  ).bind(catalogId).all();

  const candidates = [];
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const startDate = new Date(Date.UTC(fy, fm - 1, fd));

  for (let offset = 0; offset <= suggestionWindowDays; offset++) {
    const candidateDate = new Date(startDate.getTime() + offset * 86400000);
    const dateStr = candidateDate.toISOString().slice(0, 10);
    const weekday = candidateDate.getUTCDay();

    for (const template of templates) {
      if (!template.daysOfWeek.split(',').map(Number).includes(weekday)) continue;
      const remaining = await computeRemaining(env, template.id, dateStr, template.capacity);
      if (remaining >= requiredQuantity) {
        candidates.push({ date: dateStr, slotTemplateId: template.id, label: template.label, startTime: template.startTime, remaining });
      }
    }
  }

  candidates.sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
  return candidates.slice(0, maxSuggestions);
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
  const { serviceCatalogId, unitPrice, quantity, paid, paymentMethod, experienceDate, slotTemplateId, termsAccepted } = body || {};

  if (!Number.isInteger(serviceCatalogId)) {
    return jsonError('Vui lòng chọn dịch vụ', 400);
  }
  if (!Number.isInteger(unitPrice) || unitPrice < 0) {
    return jsonError('Giá phải là số nguyên không âm', 400);
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return jsonError('Số lượng phải là số nguyên lớn hơn 0', 400);
  }
  if (paid === true && paymentMethod !== 'cash' && paymentMethod !== 'transfer') {
    return jsonError('Vui lòng chọn hình thức thanh toán', 400);
  }

  const catalogItem = await env.DB.prepare(
    `SELECT id, name, is_scheduled AS isScheduled, terms_and_conditions AS termsAndConditions FROM service_catalog WHERE id = ? AND is_active = 1`
  ).bind(serviceCatalogId).first();
  if (!catalogItem) {
    return jsonError('Dịch vụ không tồn tại hoặc đã ngừng bán', 400);
  }

  let template = null;
  if (catalogItem.isScheduled) {
    if (typeof experienceDate !== 'string' || !DATE_FORMAT.test(experienceDate)) {
      return jsonError('Vui lòng chọn ngày hợp lệ', 400);
    }
    if (!Number.isInteger(slotTemplateId)) {
      return jsonError('Vui lòng chọn khung giờ', 400);
    }

    template = await env.DB.prepare(
      `SELECT id, label, start_time, capacity, days_of_week FROM service_slot_template WHERE id = ? AND service_catalog_id = ? AND is_active = 1`
    ).bind(slotTemplateId, catalogItem.id).first();
    if (!template) {
      return jsonError('Khung giờ không hợp lệ hoặc đã ngừng áp dụng', 400);
    }

    const weekday = weekdayOf(experienceDate);
    if (!template.days_of_week.split(',').map(Number).includes(weekday)) {
      return jsonError('Khung giờ này không áp dụng cho ngày đã chọn', 400);
    }

    const remaining = await computeRemaining(env, slotTemplateId, experienceDate, template.capacity);
    if (quantity > remaining) {
      const alternatives = await findAlternativeSlots(env, catalogItem.id, experienceDate, quantity);
      return new Response(
        JSON.stringify({ error: `Suất này chỉ còn ${remaining} chỗ, không đủ cho ${quantity} khách`, alternatives }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (catalogItem.termsAndConditions && termsAccepted !== true) {
      return jsonError('Vui lòng xác nhận đã thông báo điều khoản dịch vụ cho khách', 400);
    }
  }

  const amount = unitPrice * quantity;
  const now = new Date().toISOString();
  const paymentStatus = paid === true ? 'paid' : 'pending';
  const resolvedPaymentMethod = paid === true ? paymentMethod : null;
  const resolvedTermsAcceptedAt = template && catalogItem.termsAndConditions && termsAccepted === true ? now : null;

  const result = await env.DB.prepare(
    `INSERT INTO booking_service_items (booking_id, service_catalog_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status, payment_method, experience_date, slot_template_id, experience_slot_label, experience_start_time, terms_accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      params.id,
      catalogItem.id,
      catalogItem.name,
      unitPrice,
      quantity,
      amount,
      auth.username,
      now,
      paymentStatus,
      resolvedPaymentMethod,
      template ? experienceDate : null,
      template ? slotTemplateId : null,
      template ? template.label : null,
      template ? template.start_time : null,
      resolvedTermsAcceptedAt
    )
    .run();

  return new Response(JSON.stringify({ id: result.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/bookingServiceItems.test.js`
Expected: PASS (all tests, including the new ones). Retry once or twice on the known Windows teardown-only flake before treating a failure as real.

- [ ] **Step 5: Commit**

```bash
git add "functions/api/bookings/[id]/services/index.js" test/bookingServiceItems.test.js
git commit -m "feat: enforce experience-slot capacity and terms consent on POST /api/bookings/:id/services"
```

---

### Task 8: Reception — date/slot picker, terms consent, and alternatives-on-409

**Files:**
- Modify: `admin/reception.js`

**Interfaces:**
- Consumes: `GET /api/catalog/:id/slot-availability` (Task 2), `item.isScheduled`/`item.termsAndConditions` (Task 3, already present on `catalogItems` loaded at page init), `POST /api/bookings/:id/services`'s extended request/response shape (Task 7).

- [ ] **Step 1: Extend `openAddServiceForm`**

Replace the full contents of the `openAddServiceForm` function in `admin/reception.js` with:

```js
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
    opt.dataset.isScheduled = item.isScheduled ? '1' : '';
    opt.dataset.termsAndConditions = item.termsAndConditions || '';
    select.appendChild(opt);
  });

  const priceInput = document.createElement('input');
  priceInput.type = 'number';
  priceInput.min = '0';
  priceInput.step = '1000';
  priceInput.placeholder = 'Giá';

  const qtyLabel = document.createElement('span');
  qtyLabel.textContent = 'Số lượng:';
  const qtyInput = document.createElement('input');
  qtyInput.type = 'number';
  qtyInput.min = '1';
  qtyInput.step = '1';
  qtyInput.value = '1';

  const experienceDateInput = document.createElement('input');
  experienceDateInput.type = 'date';
  experienceDateInput.style.display = 'none';

  const slotTemplateSelect = document.createElement('select');
  slotTemplateSelect.style.display = 'none';
  const slotPlaceholderOpt = document.createElement('option');
  slotPlaceholderOpt.value = '';
  slotPlaceholderOpt.textContent = '-- Chọn ngày trước --';
  slotTemplateSelect.appendChild(slotPlaceholderOpt);

  const termsDisplay = document.createElement('blockquote');
  termsDisplay.style.display = 'none';

  const termsLabel = document.createElement('label');
  termsLabel.className = 'checkbox-label';
  termsLabel.style.display = 'none';
  const termsAcceptedCheckbox = document.createElement('input');
  termsAcceptedCheckbox.type = 'checkbox';
  termsLabel.append(termsAcceptedCheckbox, ' Đã giải thích & khách đồng ý điều khoản trên');

  async function refreshSlotAvailability() {
    const catalogId = select.value;
    const date = experienceDateInput.value;
    slotTemplateSelect.innerHTML = '';
    if (!catalogId || !date) {
      slotTemplateSelect.appendChild(slotPlaceholderOpt.cloneNode(true));
      return;
    }
    let response;
    try {
      response = await fetch(`/api/catalog/${catalogId}/slot-availability?date=${encodeURIComponent(date)}`);
    } catch (err) {
      return;
    }
    if (!response.ok) return;
    const slots = await response.json();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '-- Chọn khung giờ --';
    slotTemplateSelect.appendChild(placeholder);
    slots.forEach((slot) => {
      const opt = document.createElement('option');
      opt.value = slot.id;
      if (slot.remaining <= 0) {
        opt.textContent = `${slot.startTime} — Hết chỗ`;
        opt.disabled = true;
      } else {
        opt.textContent = `${slot.startTime} — còn ${slot.remaining}/${slot.capacity} chỗ`;
      }
      slotTemplateSelect.appendChild(opt);
    });
  }

  select.addEventListener('change', () => {
    const selectedOpt = select.options[select.selectedIndex];
    priceInput.value = selectedOpt.dataset.priceMin || '';
    const isScheduled = selectedOpt.dataset.isScheduled === '1';
    experienceDateInput.style.display = isScheduled ? '' : 'none';
    slotTemplateSelect.style.display = isScheduled ? '' : 'none';
    qtyLabel.textContent = isScheduled ? 'Số khách:' : 'Số lượng:';
    if (isScheduled) {
      refreshSlotAvailability();
    } else {
      termsDisplay.style.display = 'none';
      termsLabel.style.display = 'none';
      termsAcceptedCheckbox.checked = false;
    }
  });

  experienceDateInput.addEventListener('change', refreshSlotAvailability);

  slotTemplateSelect.addEventListener('change', () => {
    const selectedOpt = select.options[select.selectedIndex];
    const terms = selectedOpt.dataset.termsAndConditions;
    if (slotTemplateSelect.value && terms) {
      termsDisplay.textContent = terms;
      termsDisplay.style.display = '';
      termsLabel.style.display = '';
    } else {
      termsDisplay.style.display = 'none';
      termsLabel.style.display = 'none';
      termsAcceptedCheckbox.checked = false;
    }
  });

  const paidLabel = document.createElement('label');
  paidLabel.className = 'checkbox-label';
  const paidCheckbox = document.createElement('input');
  paidCheckbox.type = 'checkbox';
  paidLabel.append(paidCheckbox, ' Đã thanh toán');

  const methodLabel = document.createElement('label');
  methodLabel.className = 'checkbox-label';
  const methodCheckbox = document.createElement('input');
  methodCheckbox.type = 'checkbox';
  methodCheckbox.checked = true;
  methodLabel.append(methodCheckbox, ' Tiền mặt');
  methodLabel.style.display = 'none';

  paidCheckbox.addEventListener('change', () => {
    methodLabel.style.display = paidCheckbox.checked ? '' : 'none';
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Thêm';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Huỷ';

  const errorEl = document.createElement('p');
  errorEl.className = 'error';

  const alternativesEl = document.createElement('div');

  function renderAlternatives(alternatives) {
    alternativesEl.innerHTML = '';
    if (!Array.isArray(alternatives) || alternatives.length === 0) return;
    const heading = document.createElement('p');
    heading.textContent = 'Gợi ý khung giờ khác:';
    alternativesEl.appendChild(heading);
    alternatives.forEach((alt) => {
      const line = document.createElement('p');
      const [y, m, d] = alt.date.split('-');
      line.textContent = `· ${d}/${m} — ${alt.startTime} (còn ${alt.remaining} chỗ) `;
      const chooseBtn = document.createElement('button');
      chooseBtn.type = 'button';
      chooseBtn.className = 'btn-secondary';
      chooseBtn.textContent = 'chọn';
      chooseBtn.addEventListener('click', async () => {
        experienceDateInput.value = alt.date;
        await refreshSlotAvailability();
        slotTemplateSelect.value = String(alt.slotTemplateId);
        slotTemplateSelect.dispatchEvent(new Event('change'));
        alternativesEl.innerHTML = '';
      });
      line.appendChild(chooseBtn);
      alternativesEl.appendChild(line);
    });
  }

  confirmBtn.addEventListener('click', async () => {
    errorEl.textContent = '';
    alternativesEl.innerHTML = '';
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

    const selectedOpt = select.options[select.selectedIndex];
    const isScheduled = selectedOpt.dataset.isScheduled === '1';
    let experienceDate, slotTemplateId, termsAccepted;
    if (isScheduled) {
      if (!experienceDateInput.value || !slotTemplateSelect.value) {
        errorEl.textContent = 'Vui lòng chọn ngày và khung giờ';
        return;
      }
      experienceDate = experienceDateInput.value;
      slotTemplateId = Number(slotTemplateSelect.value);
      if (termsLabel.style.display !== 'none') {
        if (!termsAcceptedCheckbox.checked) {
          errorEl.textContent = 'Vui lòng xác nhận đã thông báo điều khoản dịch vụ cho khách';
          return;
        }
        termsAccepted = true;
      }
    }

    const paid = paidCheckbox.checked;
    const paymentMethod = paid ? (methodCheckbox.checked ? 'cash' : 'transfer') : undefined;
    let response;
    try {
      response = await fetch(`/api/bookings/${bookingId}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceCatalogId, unitPrice, quantity, paid, paymentMethod, experienceDate, slotTemplateId, termsAccepted }),
      });
    } catch (err) {
      errorEl.textContent = 'Có lỗi khi thêm dịch vụ';
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi thêm dịch vụ';
      renderAlternatives(body.alternatives);
      return;
    }
    await refreshAll();
  });
  cancelBtn.addEventListener('click', () => form.remove());

  form.append(select, priceInput, qtyLabel, qtyInput, experienceDateInput, slotTemplateSelect, termsDisplay, termsLabel, paidLabel, methodLabel, confirmBtn, cancelBtn, errorEl, alternativesEl);
  section.appendChild(form);
}
```

- [ ] **Step 2: Manual verification**

Run: `node --check admin/reception.js` to confirm no syntax errors. Full behavioral verification (real availability data, the 409-with-suggestions path, terms consent gating) happens via the Playwright spec in Task 9 — this function has no unit-level test of its own since it's pure DOM wiring, matching this codebase's established convention for `openAddServiceForm`'s prior iterations (payment checkboxes, etc.), which were also Playwright-only.

- [ ] **Step 3: Commit**

```bash
git add admin/reception.js
git commit -m "feat: add experience date/slot picker, terms consent, and alternative-slot suggestions to the add-service form"
```

---

### Task 9: Playwright coverage

**Files:**
- Modify: `tests/e2e/reception-ops-board.spec.js` (outer repo — `hien-le-garden`, not `hien-le-garden-v4`)
- Create: `tests/e2e/experience-settings.spec.js` (outer repo)

**Interfaces:**
- Consumes: `admin/reception.js` (Task 8), `admin/catalog.html`/`.js` (Task 6), and mocked API responses matching Tasks 1/2/5/7's exact shapes.

- [ ] **Step 1: Fix the two pre-existing tests broken by the form now always containing a second `<select>`**

Task 8's `openAddServiceForm` always creates `slotTemplateSelect` (hidden via `style.display = 'none'` for a non-scheduled item, not removed from the DOM). This means `.add-service-form select` now matches 2 elements instead of 1, and Playwright's strict mode throws on an ambiguous locator. Two existing tests in `tests/e2e/reception-ops-board.spec.js` use the bare (non-disambiguated) selector and will break: `'adding a service line updates the card total and item list'` and `'the paid checkbox toggles the payment-method checkbox and is sent on submit'`. In both, change:

```js
    await page.locator('.add-service-form select').selectOption('5');
```

to:

```js
    await page.locator('.add-service-form select').first().selectOption('5');
```

Run: `grep -n "add-service-form select" tests/e2e/reception-ops-board.spec.js` from the outer repo root to find both occurrences precisely before editing — do not rely on line numbers, since Task 8's changes to `reception.js` don't touch this file's line numbers, but confirm you're editing exactly these two lines and no others matching that pattern.

- [ ] **Step 2: Add scheduled-item tests to `reception-ops-board.spec.js`**

Add these tests inside the existing `test.describe('Reception daily ops board', ...)` block, after the existing `'the paid checkbox toggles the payment-method checkbox and is sent on submit'` test:

```js
  test('selecting a scheduled catalog item reveals the date/slot picker populated from live availability', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 9, category: 'fnb_hoat_dong', subgroup: null, name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000, priceMax: null, priceLabel: null, unitCapacity: '/ buổi', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 20, guestName: 'Trải Nghiệm A', phone: '0900000020', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/9/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 18, remaining: 12 }]),
    }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trải Nghiệm A');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('9');

    const dateInput = page.locator('.add-service-form input[type="date"]');
    await expect(dateInput).toBeVisible();
    await dateInput.fill('2099-03-15');

    const slotSelect = page.locator('.add-service-form select').nth(1);
    await expect(slotSelect).toContainText('19:00 — còn 12/30 chỗ');
  });

  test('shows alternative slots when a registration exceeds remaining capacity', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 9, category: 'fnb_hoat_dong', subgroup: null, name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000, priceMax: null, priceLabel: null, unitCapacity: '/ buổi', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 21, guestName: 'Trải Nghiệm B', phone: '0900000021', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/9/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 25, remaining: 5 }]),
    }));
    await page.route('**/api/bookings/21/services', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Suất này chỉ còn 5 chỗ, không đủ cho 10 khách',
        alternatives: [{ date: '2099-03-16', slotTemplateId: 8, label: 'Suất tối', startTime: '19:00', remaining: 25 }],
      }),
    }));

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('9');
    await page.locator('.add-service-form input[type="date"]').fill('2099-03-15');
    await page.locator('.add-service-form select').nth(1).selectOption('7');
    await page.locator('.add-service-form input[type="number"]').nth(1).fill('10');
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    await expect(page.locator('.add-service-form')).toContainText('Suất này chỉ còn 5 chỗ');
    await expect(page.locator('.add-service-form')).toContainText('16/03 — 19:00 (còn 25 chỗ)');
  });

  test('requires terms acceptance for a scheduled item with configured terms before submit', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 10, category: 'fnb_hoat_dong', subgroup: null, name: 'Cắm trại qua đêm', priceType: 'fixed', priceMin: 300000, priceMax: null, priceLabel: null, unitCapacity: '/ đêm', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: 'Trẻ em dưới 12 tuổi cần người lớn đi kèm.' }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 22, guestName: 'Trải Nghiệm C', phone: '0900000022', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/10/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 12, label: 'Suất đêm', startTime: '18:00', capacity: 10, booked: 2, remaining: 8 }]),
    }));

    let posted = null;
    await page.route('**/api/bookings/22/services', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 5, ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('10');
    await page.locator('.add-service-form input[type="date"]').fill('2099-03-15');
    await page.locator('.add-service-form select').nth(1).selectOption('12');

    await expect(page.locator('.add-service-form blockquote')).toContainText('Trẻ em dưới 12 tuổi cần người lớn đi kèm.');

    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();
    await expect(page.locator('.add-service-form')).toContainText('Vui lòng xác nhận đã thông báo điều khoản dịch vụ cho khách');
    expect(posted).toBeNull();

    await page.locator('.add-service-form .checkbox-label', { hasText: 'Đã giải thích' }).locator('input[type="checkbox"]').check();
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    expect(posted).toMatchObject({ serviceCatalogId: 10, experienceDate: '2099-03-15', slotTemplateId: 12, termsAccepted: true });
  });

  test('never shows the terms block for a scheduled item with no configured terms', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 9, category: 'fnb_hoat_dong', subgroup: null, name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000, priceMax: null, priceLabel: null, unitCapacity: '/ buổi', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 23, guestName: 'Trải Nghiệm D', phone: '0900000023', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/9/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 0, remaining: 30 }]),
    }));
    await page.route('**/api/bookings/23/services', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 6, ok: true }) }));

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('9');
    await page.locator('.add-service-form input[type="date"]').fill('2099-03-15');
    await page.locator('.add-service-form select').nth(1).selectOption('7');

    await expect(page.locator('.add-service-form blockquote')).toBeHidden();
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trải Nghiệm D');
  });
```

- [ ] **Step 3: Write `experience-settings.spec.js`**

```js
// tests/e2e/experience-settings.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Experience-settings config on catalog.html', () => {
  test('an admin can view and save the suggestion-window settings', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/catalog?all=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let saved = null;
    await page.route('**/api/experience-booking-settings', (route) => {
      if (route.request().method() === 'PATCH') {
        saved = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suggestionWindowDays: 14, maxSuggestions: 5, updatedAt: '2026-08-29T00:00:00Z' }) });
    });

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#experienceSettingsSection')).toBeVisible();
    await expect(page.locator('input[name="suggestionWindowDays"]')).toHaveValue('14');
    await expect(page.locator('input[name="maxSuggestions"]')).toHaveValue('5');

    await page.fill('input[name="suggestionWindowDays"]', '10');
    await page.fill('input[name="maxSuggestions"]', '3');
    await page.click('#experienceSettingsForm button[type="submit"]');

    await expect.poll(() => saved).toEqual({ suggestionWindowDays: 10, maxSuggestions: 3 });
  });

  test('a reception account never sees the experience-settings section', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/catalog?all=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#experienceSettingsSection')).toBeHidden();
  });
});
```

- [ ] **Step 4: Run both specs to verify they pass**

Start the v4 static server first (from the `v4` repo directory): `npx http-server . -p 4174 -s -c-1` in the background, poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/admin/reception.html` until it returns `200`.

Run (from the outer `hien-le-garden` repo): `npx playwright test reception-ops-board experience-settings --project=v4`
Expected: PASS (all tests in both files, including the 4 new ones in `reception-ops-board.spec.js` and the 2 new ones in `experience-settings.spec.js`).

- [ ] **Step 5: Run the full v4 Playwright suite for regressions**

Run: `npx playwright test --project=v4`
Expected: PASS (all tests, previous count + 6). Stop the http-server afterward and free port 4174 (`netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>`).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/reception-ops-board.spec.js tests/e2e/experience-settings.spec.js
git commit -m "test: cover experience-slot picker, capacity suggestions, and terms consent"
```

(This commit is in the outer `hien-le-garden` repo, not `hien-le-garden-v4`.)

---

## After all tasks: deploy checklist (not a task — for the controller after the final review)

1. Apply `migrations/0014_experience_slots.sql` to production D1 (`npx wrangler d1 migrations apply hien_le_garden_crm --remote`) **before** pushing/deploying the dependent code — same ordering rule flagged as critical by every prior plan's final review this session.
2. Push the `v4` repo, then the outer repo.
3. Verify the Cloudflare Pages deployment picked up the new commit (`wrangler pages deployment list`).
4. Smoke-test production: log in as admin, open `catalog.html`, mark a real item "Có khung giờ + sức chứa", add a slot template with a real near-future day-of-week, then log in as reception, open the ops board, add that service to a confirmed booking, and confirm the date/slot picker shows live availability end to end.
