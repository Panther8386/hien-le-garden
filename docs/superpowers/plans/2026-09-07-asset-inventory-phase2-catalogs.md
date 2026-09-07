# Asset & Inventory Phase 2 — Catalogs, Locations, A/B Source, Source Records Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational catalog/location/source-record layer for the Hiền Lê Garden Asset & Inventory subsystem — Phase 2 of 6.

**Architecture:** 4 new tables (`asset_categories`, `asset_locations`, `asset_source_documents`, `asset_source_rows`) added via one migration, following this codebase's exact established patterns (`requireAuth`, `jsonError`, `coerceRow`, `audit_log` batch writes, `.confirm-overlay`/`.confirm-box` popups). `asset_locations` references the existing `rooms` table by FK rather than duplicating it — `rooms` itself is never modified. The 64-line handover asset list (Phụ lục II) is imported verbatim into `asset_source_rows` as an immutable reference layer via a re-runnable script, following the project's existing `scripts/seed-manager.js` convention (print SQL for the operator to apply explicitly, never auto-execute).

**Tech Stack:** Cloudflare Pages Functions + D1 (v4 repo), vanilla JS admin frontend (no build step), Playwright e2e (outer repo).

**Spec:** `docs/superpowers/specs/2026-09-07-asset-inventory-phase2-catalogs-design.md`

## Global Constraints

- Reuse the 4 existing staff roles (`admin`, `manager`, `reception`, `observer`) exactly — never introduce a 5th role. "Nhân viên" (lễ tân + buồng phòng, per the business brief) maps to the existing `reception` role.
- Every new list endpoint (`GET /api/asset-categories`, `GET /api/asset-locations`, `GET /api/asset-source-documents`, `GET /api/asset-source-rows`) is readable by all 4 roles — none of this data is revenue-sensitive like finance.
- Every write endpoint (`POST`/`PATCH` on categories and locations) is `admin`-only — matching the established precedent of `functions/api/finance/categories/index.js`'s `onRequestPost`.
- **Never modify the `rooms` table** (no new column, no CHECK-constraint change) — it is a core table multiple other subsystems (bookings, Giờ Xanh, dine-in orders) depend on directly. `asset_locations.room_id` is a plain FK reference to the existing `rooms.id`; nothing about `rooms` itself changes.
- `asset_categories.management_type` and `asset_locations.location_type` can never be changed via `PATCH` once a row is created (reject with `400` if the request body contains `managementType`/`locationType`/`roomId`) — these are structural fields later phases will build on; letting them change after creation risks silently breaking that dependency.
- `asset_source_rows` is immutable — no `PATCH`/`DELETE` endpoint exists for it in this plan, ever. `raw_quantity` is stored as `TEXT`, not a number — the source document has entries like `"01"` (leading zero) that must be preserved verbatim, and blank entries become `NULL`, never `0`.
- The data-import script (`v4/scripts/import-asset-source-data.js`) must be safe to run multiple times — every `INSERT` is guarded (`WHERE NOT EXISTS (...)`) so re-running it never creates a duplicate row in any of the 4 tables.
- Next migration number is `0027` (latest existing: `0026_finance_hide_from_history.sql`). Production D1 database name for `wrangler d1 migrations apply <name> --remote` is `hien_le_garden_crm`.
- Reuse the existing `audit_log` table and its 3-registry pattern (`admin/audit-log.js`, `admin/audit-log.html`, `functions/api/audit-log/index.js`'s `VALID_ACTION_TYPES`) for the 4 new action types this plan introduces — never invent a parallel logging mechanism.
- Popups reuse the exact existing `.confirm-overlay`/`.confirm-box` CSS classes — never introduce a new modal class family. Action buttons reuse `.table-actions-btn`/`.btn-secondary`.

---

### Task 1: Migration — 4 new tables

**Files:**
- Create: `v4/migrations/0027_asset_inventory_phase2_catalogs.sql`
- Test: `v4/test/migrations.test.js`

**Interfaces:**
- Produces: `asset_categories` (columns: `id, management_type, name, default_unit, is_active, display_order, note, created_by, created_at, updated_by, updated_at`), `asset_locations` (columns: `id, location_type, room_id, code, name, is_active, display_order, note, created_by, created_at, updated_by, updated_at`), `asset_source_documents` (columns: `id, title, contract_ref, document_date, note, created_by, created_at`), `asset_source_rows` (columns: `id, source_document_id, source_group_label, stt, raw_name, raw_unit, raw_quantity, raw_condition, raw_note, created_at`) — Tasks 2 and 3 consume these exact column names.

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/migrations.test.js`, after the last existing `describe('migration 0026', ...)` block (confirm the file's current test count first with `grep -c "  it(" v4/test/migrations.test.js` — expect 33 before this task):

```js
describe('migration 0027', () => {
  it('creates asset_categories with is_active defaulting to 1', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('individual_device', 'Điều hoà', 'bộ', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT is_active FROM asset_categories WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.is_active).toBe(1);
  });

  it('rejects an invalid management_type via the CHECK constraint', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('invalid_type', 'X', 'cái', 'system', '2026-09-07T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });

  it('creates an asset_locations row of type room referencing an existing room', async () => {
    const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();
    const insert = await env.DB.prepare(
      `INSERT INTO asset_locations (location_type, room_id, name, created_by, created_at) VALUES ('room', ?, 'Test Room Location', 'system', '2026-09-07T00:00:00Z')`
    ).bind(roomRow.id).run();
    const row = await env.DB.prepare(`SELECT location_type, room_id FROM asset_locations WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ location_type: 'room', room_id: roomRow.id });
  });

  it('rejects a room-type location with no room_id via the CHECK constraint', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('room', 'X', 'system', '2026-09-07T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });

  it('rejects a non-room location that has a room_id via the CHECK constraint', async () => {
    const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();
    await expect(
      env.DB.prepare(
        `INSERT INTO asset_locations (location_type, room_id, name, created_by, created_at) VALUES ('warehouse', ?, 'X', 'system', '2026-09-07T00:00:00Z')`
      ).bind(roomRow.id).run()
    ).rejects.toThrow();
  });

  it('enforces at most one asset_locations row per room via a partial unique index', async () => {
    const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();
    await env.DB.prepare(
      `INSERT INTO asset_locations (location_type, room_id, name, created_by, created_at) VALUES ('room', ?, 'First', 'system', '2026-09-07T00:00:00Z')`
    ).bind(roomRow.id).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO asset_locations (location_type, room_id, name, created_by, created_at) VALUES ('room', ?, 'Second', 'system', '2026-09-07T00:00:00Z')`
      ).bind(roomRow.id).run()
    ).rejects.toThrow();
  });

  it('allows multiple warehouse locations with no room_id', async () => {
    await env.DB.prepare(
      `INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('warehouse', 'Kho 1', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    const insert2 = await env.DB.prepare(
      `INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('warehouse', 'Kho 2', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT room_id FROM asset_locations WHERE id = ?`).bind(insert2.meta.last_row_id).first();
    expect(row.room_id).toBeNull();
  });

  it('creates an asset_source_document and a linked asset_source_row, preserving raw_quantity as text', async () => {
    const docInsert = await env.DB.prepare(
      `INSERT INTO asset_source_documents (title, contract_ref, created_by, created_at) VALUES ('Test Doc', '001/TEST', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    const docId = docInsert.meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_unit, raw_quantity, raw_condition, raw_note, created_at)
       VALUES (?, 'A. TEST GROUP', 1, 'Test Item', 'cái', '01', 'Tốt', NULL, '2026-09-07T00:00:00Z')`
    ).bind(docId).run();
    const row = await env.DB.prepare(`SELECT raw_quantity FROM asset_source_rows WHERE source_document_id = ? AND stt = 1`).bind(docId).first();
    expect(row.raw_quantity).toBe('01');
  });

  it('stores a NULL raw_quantity for a source row with no known quantity, never 0', async () => {
    const docInsert = await env.DB.prepare(
      `INSERT INTO asset_source_documents (title, created_by, created_at) VALUES ('Test Doc 2', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_condition, created_at)
       VALUES (?, 'A. TEST GROUP', 1, 'Unknown Qty Item', 'Tốt', '2026-09-07T00:00:00Z')`
    ).bind(docInsert.meta.last_row_id).run();
    const row = await env.DB.prepare(`SELECT raw_quantity FROM asset_source_rows WHERE source_document_id = ? AND stt = 1`).bind(docInsert.meta.last_row_id).first();
    expect(row.raw_quantity).toBeNull();
  });

  it('rejects a duplicate (source_document_id, stt) pair via the unique constraint', async () => {
    const docInsert = await env.DB.prepare(
      `INSERT INTO asset_source_documents (title, created_by, created_at) VALUES ('Test Doc 3', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, created_at) VALUES (?, 'A', 1, 'X', '2026-09-07T00:00:00Z')`
    ).bind(docInsert.meta.last_row_id).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, created_at) VALUES (?, 'A', 1, 'Y', '2026-09-07T00:00:00Z')`
      ).bind(docInsert.meta.last_row_id).run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/migrations.test.js`
Expected: FAIL — `no such table: asset_categories` (and similarly for the other 3 tables).

- [ ] **Step 3: Write the migration**

```sql
-- v4/migrations/0027_asset_inventory_phase2_catalogs.sql

CREATE TABLE asset_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  management_type TEXT NOT NULL CHECK (management_type IN (
    'infrastructure', 'individual_device', 'device_set', 'durable_goods',
    'linen', 'consumable', 'spare_part', 'food_beverage'
  )),
  name TEXT NOT NULL,
  default_unit TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

CREATE TABLE asset_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_type TEXT NOT NULL CHECK (location_type IN ('room', 'warehouse', 'common_area')),
  room_id INTEGER REFERENCES rooms(id),
  code TEXT,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  CHECK (
    (location_type = 'room' AND room_id IS NOT NULL) OR
    (location_type != 'room' AND room_id IS NULL)
  )
);
CREATE UNIQUE INDEX idx_asset_locations_room_id ON asset_locations(room_id) WHERE room_id IS NOT NULL;

CREATE TABLE asset_source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  contract_ref TEXT,
  document_date TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE asset_source_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER NOT NULL REFERENCES asset_source_documents(id),
  source_group_label TEXT NOT NULL,
  stt INTEGER NOT NULL,
  raw_name TEXT NOT NULL,
  raw_unit TEXT,
  raw_quantity TEXT,
  raw_condition TEXT,
  raw_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source_document_id, stt)
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/migrations.test.js`
Expected: PASS, 43/43 (33 existing + 10 new). If you hit the documented Windows Miniflare teardown flake (`AssertionError: Isolated storage failed`, EBUSY on `.sqlite-wal` — not a real assertion failure), retry up to ~6 times.

- [ ] **Step 5: Commit**

```bash
cd v4
git add migrations/0027_asset_inventory_phase2_catalogs.sql test/migrations.test.js
git commit -m "feat: add asset_categories, asset_locations, asset_source_documents, asset_source_rows tables

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — Danh mục (`asset-categories`) + Vị trí (`asset-locations`)

**Files:**
- Create: `v4/functions/api/asset-categories/index.js`
- Create: `v4/functions/api/asset-categories/[id].js`
- Create: `v4/functions/api/asset-locations/index.js`
- Create: `v4/functions/api/asset-locations/[id].js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Modify: `v4/functions/api/audit-log/index.js`
- Test: `v4/test/assetCategories.test.js` (new)
- Test: `v4/test/assetLocations.test.js` (new)

**Interfaces:**
- Consumes: `requireAuth(request, env, roles)` from `../../../lib/requireAuth.js`, `asset_categories`/`asset_locations` schema from Task 1, `rooms` table (read-only, for validating `roomId`).
- Produces: `GET /api/asset-categories` → `[{id, managementType, name, defaultUnit, isActive, displayOrder, note, createdBy, createdAt, updatedBy, updatedAt}]`; `POST /api/asset-categories` body `{managementType, name, defaultUnit, note}`; `PATCH /api/asset-categories/:id` body `{name?, defaultUnit?, note?, isActive?}`. `GET /api/asset-locations` → `[{id, locationType, roomId, code, name, isActive, displayOrder, note, createdBy, createdAt, updatedBy, updatedAt}]`; `POST /api/asset-locations` body `{locationType, roomId?, code?, name, note?}`; `PATCH /api/asset-locations/:id` body `{code?, name?, note?, isActive?}`. Tasks 4 and 5 consume these exact field names.

- [ ] **Step 1: Write the failing tests for `asset-categories`**

Create `v4/test/assetCategories.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listCategories, onRequestPost as createCategory } from '../functions/api/asset-categories/index.js';
import { onRequestPatch as patchCategory } from '../functions/api/asset-categories/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM asset_categories');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_ac', 'x', 'manager', '2026-09-07T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_ac', 'x', 'reception', '2026-09-07T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_ac', 'x', 'admin', '2026-09-07T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_ac', 'x', 'observer', '2026-09-07T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/asset-categories', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listCategories({ request: new Request('https://x/api/asset-categories'), env });
    expect(response.status).toBe(401);
  });

  it('lets all 4 roles read', async () => {
    for (const token of [managerToken, receptionToken, adminToken, observerToken]) {
      const response = await listCategories({ request: authedRequest('https://x/api/asset-categories', token, 'GET'), env });
      expect(response.status).toBe(200);
    }
  });

  it('excludes inactive categories by default', async () => {
    await env.DB.prepare(
      `INSERT INTO asset_categories (management_type, name, default_unit, is_active, created_by, created_at) VALUES ('linen', 'Khăn cũ', 'cái', 0, 'admin_ac', '2026-09-07T00:00:00Z')`
    ).run();
    const response = await listCategories({ request: authedRequest('https://x/api/asset-categories', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body).toHaveLength(0);
  });

  it('includes inactive categories with includeInactive=1', async () => {
    await env.DB.prepare(
      `INSERT INTO asset_categories (management_type, name, default_unit, is_active, created_by, created_at) VALUES ('linen', 'Khăn cũ', 'cái', 0, 'admin_ac', '2026-09-07T00:00:00Z')`
    ).run();
    const response = await listCategories({ request: authedRequest('https://x/api/asset-categories?includeInactive=1', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].isActive).toBe(false);
  });
});

describe('POST /api/asset-categories', () => {
  it('rejects manager (403) — write is admin-only', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/asset-categories', managerToken, 'POST', { managementType: 'linen', name: 'X', defaultUnit: 'cái' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects reception (403)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/asset-categories', receptionToken, 'POST', { managementType: 'linen', name: 'X', defaultUnit: 'cái' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects an invalid managementType (400)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/asset-categories', adminToken, 'POST', { managementType: 'not_real', name: 'X', defaultUnit: 'cái' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a missing name (400)', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/asset-categories', adminToken, 'POST', { managementType: 'linen', name: '', defaultUnit: 'cái' }), env });
    expect(response.status).toBe(400);
  });

  it('creates a category as admin and writes an audit_log row', async () => {
    const response = await createCategory({ request: authedRequest('https://x/api/asset-categories', adminToken, 'POST', { managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', note: 'Ghi chú' }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT * FROM asset_categories WHERE id = ?`).bind(body.id).first();
    expect(row.management_type).toBe('individual_device');
    expect(row.name).toBe('Điều hoà');
    expect(row.is_active).toBe(1);
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_category_create' AND entity_id = ?`).bind(body.id).first();
    expect(audit.entity_type).toBe('asset_category');
    expect(audit.entity_label).toBe('Điều hoà');
  });
});

describe('PATCH /api/asset-categories/:id', () => {
  let categoryId;

  beforeEach(async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('linen', 'Khăn', 'cái', 'admin_ac', '2026-09-07T00:00:00Z')`
    ).run();
    categoryId = insert.meta.last_row_id;
  });

  it('rejects manager (403)', async () => {
    const response = await patchCategory({ request: authedRequest(`https://x/api/asset-categories/${categoryId}`, managerToken, 'PATCH', { name: 'Khăn mới' }), env, params: { id: String(categoryId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await patchCategory({ request: authedRequest('https://x/api/asset-categories/999999', adminToken, 'PATCH', { name: 'X' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an attempt to change managementType (400)', async () => {
    const response = await patchCategory({ request: authedRequest(`https://x/api/asset-categories/${categoryId}`, adminToken, 'PATCH', { managementType: 'consumable' }), env, params: { id: String(categoryId) } });
    expect(response.status).toBe(400);
  });

  it('updates name/defaultUnit/note and writes an audit_log row', async () => {
    const response = await patchCategory({ request: authedRequest(`https://x/api/asset-categories/${categoryId}`, adminToken, 'PATCH', { name: 'Khăn tắm', defaultUnit: 'chiếc', note: 'Đổi tên' }), env, params: { id: String(categoryId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT name, default_unit, note FROM asset_categories WHERE id = ?`).bind(categoryId).first();
    expect(row).toEqual({ name: 'Khăn tắm', default_unit: 'chiếc', note: 'Đổi tên' });
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_category_update' AND entity_id = ?`).bind(categoryId).first();
    expect(audit.old_value).toBe('Khăn');
    expect(audit.new_value).toBe('Khăn tắm');
  });

  it('toggles isActive to false and back to true', async () => {
    await patchCategory({ request: authedRequest(`https://x/api/asset-categories/${categoryId}`, adminToken, 'PATCH', { isActive: false }), env, params: { id: String(categoryId) } });
    let row = await env.DB.prepare(`SELECT is_active FROM asset_categories WHERE id = ?`).bind(categoryId).first();
    expect(row.is_active).toBe(0);
    await patchCategory({ request: authedRequest(`https://x/api/asset-categories/${categoryId}`, adminToken, 'PATCH', { isActive: true }), env, params: { id: String(categoryId) } });
    row = await env.DB.prepare(`SELECT is_active FROM asset_categories WHERE id = ?`).bind(categoryId).first();
    expect(row.is_active).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/assetCategories.test.js`
Expected: FAIL — import errors (the endpoint files don't exist yet).

- [ ] **Step 3: Create `v4/functions/api/asset-categories/index.js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_MANAGEMENT_TYPES = ['infrastructure', 'individual_device', 'device_set', 'durable_goods', 'linen', 'consumable', 'spare_part', 'food_beverage'];

function coerceRow(r) {
  return {
    id: r.id,
    managementType: r.management_type,
    name: r.name,
    defaultUnit: r.default_unit,
    isActive: !!r.is_active,
    displayOrder: r.display_order,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('includeInactive') === '1';
  const where = includeInactive ? '' : 'WHERE is_active = 1';

  const { results } = await env.DB.prepare(
    `SELECT * FROM asset_categories ${where} ORDER BY management_type, display_order, id`
  ).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  const { managementType, name, defaultUnit, note } = body || {};

  if (!VALID_MANAGEMENT_TYPES.includes(managementType)) return jsonError('Cách quản lý không hợp lệ', 400);
  if (typeof name !== 'string' || name.trim() === '') return jsonError('Vui lòng nhập tên danh mục', 400);
  if (typeof defaultUnit !== 'string' || defaultUnit.trim() === '') return jsonError('Vui lòng nhập đơn vị tính', 400);

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO asset_categories (management_type, name, default_unit, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(managementType, name.trim(), defaultUnit.trim(), note || null, auth.username, now).run();
  const newId = insert.meta.last_row_id;

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('asset_category_create', 'asset_category', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, name.trim(), name.trim(), auth.username, now).run();

  return new Response(JSON.stringify({ id: newId, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Create `v4/functions/api/asset-categories/[id].js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM asset_categories WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy danh mục', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};
  if ('managementType' in body) return jsonError('Không thể đổi cách quản lý của danh mục đã tạo', 400);

  const name = 'name' in body ? body.name : existing.name;
  const defaultUnit = 'defaultUnit' in body ? body.defaultUnit : existing.default_unit;
  const note = 'note' in body ? body.note : existing.note;
  const isActive = 'isActive' in body ? body.isActive : !!existing.is_active;

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Vui lòng nhập tên danh mục', 400);
  if (typeof defaultUnit !== 'string' || defaultUnit.trim() === '') return jsonError('Vui lòng nhập đơn vị tính', 400);
  if (typeof isActive !== 'boolean') return jsonError('Trạng thái không hợp lệ', 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE asset_categories SET name = ?, default_unit = ?, note = ?, is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).bind(name.trim(), defaultUnit.trim(), note || null, isActive ? 1 : 0, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('asset_category_update', 'asset_category', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, name.trim(), existing.name, name.trim(), auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Register `asset_category_create`/`asset_category_update` and `asset_location_create`/`asset_location_update` in the 3-registry audit-log pattern**

(Registering all 4 new action types now, even though `asset-locations`' endpoints come in Step 7-8, avoids a second registry-editing pass later in this same task.)

In `v4/functions/api/audit-log/index.js`, find:
```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void', 'gio_xanh_session_void', 'record_hide'];
```
Replace with:
```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void', 'gio_xanh_session_void', 'record_hide', 'asset_category_create', 'asset_category_update', 'asset_location_create', 'asset_location_update'];
```

In `v4/admin/audit-log.js`, find:
```js
  gio_xanh_session_void: 'Huỷ phiên Giờ Xanh',
  record_hide: 'Ẩn/hiện bản ghi',
};
```
Replace with:
```js
  gio_xanh_session_void: 'Huỷ phiên Giờ Xanh',
  record_hide: 'Ẩn/hiện bản ghi',
  asset_category_create: 'Tạo danh mục tài sản',
  asset_category_update: 'Sửa danh mục tài sản',
  asset_location_create: 'Tạo vị trí tài sản',
  asset_location_update: 'Sửa vị trí tài sản',
};
```

In `v4/admin/audit-log.html`, find:
```html
        <option value="gio_xanh_session_void">Huỷ phiên Giờ Xanh</option>
        <option value="record_hide">Ẩn/hiện bản ghi</option>
```
Replace with:
```html
        <option value="gio_xanh_session_void">Huỷ phiên Giờ Xanh</option>
        <option value="record_hide">Ẩn/hiện bản ghi</option>
        <option value="asset_category_create">Tạo danh mục tài sản</option>
        <option value="asset_category_update">Sửa danh mục tài sản</option>
        <option value="asset_location_create">Tạo vị trí tài sản</option>
        <option value="asset_location_update">Sửa vị trí tài sản</option>
```

- [ ] **Step 6: Run `asset-categories` tests to verify they pass**

Run: `npx vitest run test/assetCategories.test.js`
Expected: PASS, 14/14. Retry up to ~6 times if you hit the Windows Miniflare teardown flake.

- [ ] **Step 7: Write the failing tests for `asset-locations`**

Create `v4/test/assetLocations.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listLocations, onRequestPost as createLocation } from '../functions/api/asset-locations/index.js';
import { onRequestPatch as patchLocation } from '../functions/api/asset-locations/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken, roomId;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM asset_locations');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_al', 'x', 'manager', '2026-09-07T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_al', 'x', 'reception', '2026-09-07T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_al', 'x', 'admin', '2026-09-07T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_al', 'x', 'observer', '2026-09-07T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();
  roomId = roomRow.id;
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/asset-locations', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listLocations({ request: new Request('https://x/api/asset-locations'), env });
    expect(response.status).toBe(401);
  });

  it('lets all 4 roles read', async () => {
    for (const token of [managerToken, receptionToken, adminToken, observerToken]) {
      const response = await listLocations({ request: authedRequest('https://x/api/asset-locations', token, 'GET'), env });
      expect(response.status).toBe(200);
    }
  });

  it('rejects an invalid type filter (400)', async () => {
    const response = await listLocations({ request: authedRequest('https://x/api/asset-locations?type=not_real', managerToken, 'GET'), env });
    expect(response.status).toBe(400);
  });

  it('filters by type', async () => {
    await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('warehouse', 'Kho BP', 'admin_al', '2026-09-07T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('common_area', 'Sân vườn', 'admin_al', '2026-09-07T00:00:00Z')`).run();
    const response = await listLocations({ request: authedRequest('https://x/api/asset-locations?type=warehouse', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((l) => l.name)).toEqual(['Kho BP']);
  });

  it('excludes inactive locations by default, includes them with includeInactive=1', async () => {
    await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, is_active, created_by, created_at) VALUES ('warehouse', 'Kho cũ', 0, 'admin_al', '2026-09-07T00:00:00Z')`).run();
    const defaultResponse = await listLocations({ request: authedRequest('https://x/api/asset-locations', managerToken, 'GET'), env });
    expect(await defaultResponse.json()).toHaveLength(0);
    const includeResponse = await listLocations({ request: authedRequest('https://x/api/asset-locations?includeInactive=1', managerToken, 'GET'), env });
    expect(await includeResponse.json()).toHaveLength(1);
  });
});

describe('POST /api/asset-locations', () => {
  it('rejects manager (403)', async () => {
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', managerToken, 'POST', { locationType: 'warehouse', name: 'X' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects an invalid locationType (400)', async () => {
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'not_real', name: 'X' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a room location with no roomId (400)', async () => {
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'room', name: 'X' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a non-room location that includes a roomId (400)', async () => {
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'warehouse', roomId, name: 'X' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a roomId that already has an asset_locations row (400)', async () => {
    await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'room', roomId, name: 'Phòng 1' }), env });
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'room', roomId, name: 'Phòng 1 lần 2' }), env });
    expect(response.status).toBe(400);
  });

  it('creates a room-type location as admin and writes an audit_log row', async () => {
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'room', roomId, code: 'P01', name: 'Phòng 1' }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT location_type, room_id, code FROM asset_locations WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ location_type: 'room', room_id: roomId, code: 'P01' });
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_location_create' AND entity_id = ?`).bind(body.id).first();
    expect(audit.entity_type).toBe('asset_location');
  });

  it('creates a warehouse location with no roomId', async () => {
    const response = await createLocation({ request: authedRequest('https://x/api/asset-locations', adminToken, 'POST', { locationType: 'warehouse', code: 'BP', name: 'Buồng phòng' }), env });
    expect(response.status).toBe(201);
  });
});

describe('PATCH /api/asset-locations/:id', () => {
  let locationId;

  beforeEach(async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO asset_locations (location_type, room_id, code, name, created_by, created_at) VALUES ('room', ?, 'P01', 'Phòng 1', 'admin_al', '2026-09-07T00:00:00Z')`
    ).bind(roomId).run();
    locationId = insert.meta.last_row_id;
  });

  it('rejects manager (403)', async () => {
    const response = await patchLocation({ request: authedRequest(`https://x/api/asset-locations/${locationId}`, managerToken, 'PATCH', { name: 'X' }), env, params: { id: String(locationId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await patchLocation({ request: authedRequest('https://x/api/asset-locations/999999', adminToken, 'PATCH', { name: 'X' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an attempt to change locationType (400)', async () => {
    const response = await patchLocation({ request: authedRequest(`https://x/api/asset-locations/${locationId}`, adminToken, 'PATCH', { locationType: 'warehouse' }), env, params: { id: String(locationId) } });
    expect(response.status).toBe(400);
  });

  it('rejects an attempt to change roomId (400)', async () => {
    const response = await patchLocation({ request: authedRequest(`https://x/api/asset-locations/${locationId}`, adminToken, 'PATCH', { roomId: 999 }), env, params: { id: String(locationId) } });
    expect(response.status).toBe(400);
  });

  it('updates name/code/note and writes an audit_log row, without touching room_id', async () => {
    const response = await patchLocation({ request: authedRequest(`https://x/api/asset-locations/${locationId}`, adminToken, 'PATCH', { name: 'Phòng số 1', code: 'P001', note: 'Đổi tên hiển thị' }), env, params: { id: String(locationId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT name, code, note, room_id FROM asset_locations WHERE id = ?`).bind(locationId).first();
    expect(row).toEqual({ name: 'Phòng số 1', code: 'P001', note: 'Đổi tên hiển thị', room_id: roomId });
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_location_update' AND entity_id = ?`).bind(locationId).first();
    expect(audit.old_value).toBe('Phòng 1');
    expect(audit.new_value).toBe('Phòng số 1');
  });

  it('toggles isActive', async () => {
    await patchLocation({ request: authedRequest(`https://x/api/asset-locations/${locationId}`, adminToken, 'PATCH', { isActive: false }), env, params: { id: String(locationId) } });
    const row = await env.DB.prepare(`SELECT is_active FROM asset_locations WHERE id = ?`).bind(locationId).first();
    expect(row.is_active).toBe(0);
  });
});
```

- [ ] **Step 8: Create `v4/functions/api/asset-locations/index.js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_LOCATION_TYPES = ['room', 'warehouse', 'common_area'];

function coerceRow(r) {
  return {
    id: r.id,
    locationType: r.location_type,
    roomId: r.room_id,
    code: r.code,
    name: r.name,
    isActive: !!r.is_active,
    displayOrder: r.display_order,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const includeInactive = url.searchParams.get('includeInactive') === '1';
  const type = url.searchParams.get('type');
  if (type && !VALID_LOCATION_TYPES.includes(type)) return jsonError('Loại vị trí không hợp lệ', 400);

  const clauses = [];
  const params = [];
  if (!includeInactive) clauses.push('is_active = 1');
  if (type) { clauses.push('location_type = ?'); params.push(type); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT * FROM asset_locations ${where} ORDER BY location_type, display_order, id`
  ).bind(...params).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
  const { locationType, roomId, code, name, note } = body || {};

  if (!VALID_LOCATION_TYPES.includes(locationType)) return jsonError('Loại vị trí không hợp lệ', 400);
  if (typeof name !== 'string' || name.trim() === '') return jsonError('Vui lòng nhập tên vị trí', 400);

  if (locationType === 'room') {
    if (!Number.isInteger(roomId)) return jsonError('Vui lòng chọn phòng', 400);
    const room = await env.DB.prepare(`SELECT id FROM rooms WHERE id = ?`).bind(roomId).first();
    if (!room) return jsonError('Không tìm thấy phòng', 400);
    const existing = await env.DB.prepare(`SELECT id FROM asset_locations WHERE room_id = ?`).bind(roomId).first();
    if (existing) return jsonError('Phòng này đã có vị trí tài sản tương ứng', 400);
  } else if (roomId !== undefined && roomId !== null) {
    return jsonError('Vị trí không phải phòng thì không được gán roomId', 400);
  }

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO asset_locations (location_type, room_id, code, name, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(locationType, locationType === 'room' ? roomId : null, code || null, name.trim(), note || null, auth.username, now).run();
  const newId = insert.meta.last_row_id;

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('asset_location_create', 'asset_location', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, name.trim(), name.trim(), auth.username, now).run();

  return new Response(JSON.stringify({ id: newId, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 9: Create `v4/functions/api/asset-locations/[id].js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM asset_locations WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy vị trí', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};
  if ('locationType' in body) return jsonError('Không thể đổi loại vị trí sau khi tạo', 400);
  if ('roomId' in body) return jsonError('Không thể đổi phòng gắn với vị trí sau khi tạo', 400);

  const code = 'code' in body ? body.code : existing.code;
  const name = 'name' in body ? body.name : existing.name;
  const note = 'note' in body ? body.note : existing.note;
  const isActive = 'isActive' in body ? body.isActive : !!existing.is_active;

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Vui lòng nhập tên vị trí', 400);
  if (typeof isActive !== 'boolean') return jsonError('Trạng thái không hợp lệ', 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE asset_locations SET code = ?, name = ?, note = ?, is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).bind(code || null, name.trim(), note || null, isActive ? 1 : 0, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('asset_location_update', 'asset_location', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, name.trim(), existing.name, name.trim(), auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 10: Run `asset-locations` tests to verify they pass**

Run: `npx vitest run test/assetLocations.test.js`
Expected: PASS, 17/17. Retry up to ~6 times if you hit the Windows Miniflare teardown flake.

- [ ] **Step 11: Commit**

```bash
cd v4
git add functions/api/asset-categories functions/api/asset-locations admin/audit-log.js admin/audit-log.html functions/api/audit-log/index.js test/assetCategories.test.js test/assetLocations.test.js
git commit -m "feat: add asset-categories and asset-locations CRUD endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend — Hồ sơ nguồn (`asset-source-documents`/`asset-source-rows`) + script nhập liệu

**Files:**
- Create: `v4/functions/api/asset-source-documents/index.js`
- Create: `v4/functions/api/asset-source-rows/index.js`
- Create: `v4/scripts/import-asset-source-data.js`
- Test: `v4/test/assetSourceData.test.js` (new)

**Interfaces:**
- Consumes: `asset_source_documents`/`asset_source_rows` schema from Task 1.
- Produces: `GET /api/asset-source-documents` → `[{id, title, contractRef, documentDate, note, createdBy, createdAt}]`; `GET /api/asset-source-rows?documentId=X` → `[{id, sourceDocumentId, sourceGroupLabel, stt, rawName, rawUnit, rawQuantity, rawCondition, rawNote, createdAt}]`, sorted by `stt`. Task 5 consumes these exact field names.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/assetSourceData.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listDocuments } from '../functions/api/asset-source-documents/index.js';
import { onRequestGet as listSourceRows } from '../functions/api/asset-source-rows/index.js';
import { createSession } from '../lib/auth.js';

let managerToken, adminToken, documentId;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM asset_source_rows');
  await env.DB.exec('DELETE FROM asset_source_documents');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_sd', 'x', 'manager', '2026-09-07T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_sd', 'x', 'admin', '2026-09-07T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);

  const docInsert = await env.DB.prepare(
    `INSERT INTO asset_source_documents (title, contract_ref, created_by, created_at) VALUES ('Phụ lục II — Test', '001/TEST', 'admin_sd', '2026-09-07T00:00:00Z')`
  ).run();
  documentId = docInsert.meta.last_row_id;
  await env.DB.prepare(
    `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_unit, raw_quantity, raw_condition, raw_note, created_at)
     VALUES (?, 'A. TEST', 2, 'Second Item', 'cái', NULL, 'Tốt', NULL, '2026-09-07T00:00:00Z')`
  ).bind(documentId).run();
  await env.DB.prepare(
    `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_unit, raw_quantity, raw_condition, raw_note, created_at)
     VALUES (?, 'A. TEST', 1, 'First Item', 'phòng', '15', 'Tốt', 'Vip1', '2026-09-07T00:00:00Z')`
  ).bind(documentId).run();
});

function authedRequest(url, token) {
  return new Request(url, { headers: token ? { Cookie: `session=${token}` } : {} });
}

describe('GET /api/asset-source-documents', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listDocuments({ request: new Request('https://x/api/asset-source-documents'), env });
    expect(response.status).toBe(401);
  });

  it('lets manager and admin read', async () => {
    for (const token of [managerToken, adminToken]) {
      const response = await listDocuments({ request: authedRequest('https://x/api/asset-source-documents', token), env });
      expect(response.status).toBe(200);
    }
  });

  it('returns the seeded document with the correct fields', async () => {
    const response = await listDocuments({ request: authedRequest('https://x/api/asset-source-documents', managerToken), env });
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ title: 'Phụ lục II — Test', contractRef: '001/TEST' });
  });
});

describe('GET /api/asset-source-rows', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listSourceRows({ request: new Request(`https://x/api/asset-source-rows?documentId=${documentId}`), env });
    expect(response.status).toBe(401);
  });

  it('rejects a missing documentId (400)', async () => {
    const response = await listSourceRows({ request: authedRequest('https://x/api/asset-source-rows', managerToken), env });
    expect(response.status).toBe(400);
  });

  it('returns rows sorted by stt regardless of insertion order', async () => {
    const response = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, managerToken), env });
    const body = await response.json();
    expect(body.map((r) => r.stt)).toEqual([1, 2]);
    expect(body[0].rawName).toBe('First Item');
  });

  it('preserves a NULL rawQuantity as null, not 0 or a string "0"', async () => {
    const response = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, managerToken), env });
    const body = await response.json();
    const row2 = body.find((r) => r.stt === 2);
    expect(row2.rawQuantity).toBeNull();
  });

  it('preserves rawQuantity text formatting like a leading zero', async () => {
    const response = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, managerToken), env });
    const body = await response.json();
    const row1 = body.find((r) => r.stt === 1);
    expect(row1.rawQuantity).toBe('15');
    expect(row1.rawNote).toBe('Vip1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/assetSourceData.test.js`
Expected: FAIL — import errors.

- [ ] **Step 3: Create `v4/functions/api/asset-source-documents/index.js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function coerceRow(r) {
  return {
    id: r.id,
    title: r.title,
    contractRef: r.contract_ref,
    documentDate: r.document_date,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(`SELECT * FROM asset_source_documents ORDER BY id`).all();
  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Create `v4/functions/api/asset-source-rows/index.js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function coerceRow(r) {
  return {
    id: r.id,
    sourceDocumentId: r.source_document_id,
    sourceGroupLabel: r.source_group_label,
    stt: r.stt,
    rawName: r.raw_name,
    rawUnit: r.raw_unit,
    rawQuantity: r.raw_quantity,
    rawCondition: r.raw_condition,
    rawNote: r.raw_note,
    createdAt: r.created_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const documentIdParam = url.searchParams.get('documentId');
  if (!documentIdParam) return jsonError('Thiếu documentId', 400);
  const documentId = Number(documentIdParam);
  if (!Number.isInteger(documentId)) return jsonError('documentId không hợp lệ', 400);

  const { results } = await env.DB.prepare(
    `SELECT * FROM asset_source_rows WHERE source_document_id = ? ORDER BY stt`
  ).bind(documentId).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run the endpoint tests to verify they pass**

Run: `npx vitest run test/assetSourceData.test.js`
Expected: PASS, 9/9. Retry up to ~6 times if you hit the Windows Miniflare teardown flake.

- [ ] **Step 6: Create `v4/scripts/import-asset-source-data.js`**

```js
// Generates the SQL to bootstrap Phase-2 catalog/location/source data.
// Usage:
//   node scripts/import-asset-source-data.js > asset-import.sql
//   wrangler d1 execute hien_le_garden_crm --local --file=./asset-import.sql
//   (use --remote instead of --local to apply to production)
//
// Safe to generate and apply more than once — every statement below is guarded
// with a WHERE NOT EXISTS / duplicate check, so re-running never creates a
// second copy of any row in any of the 4 tables it touches.

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const now = new Date().toISOString();

const WAREHOUSES = [
  { code: 'BP', name: 'Buồng phòng' },
  { code: 'TB', name: 'Thiết bị & vật tư phụ' },
  { code: 'DK', name: 'Đồ khô & thức uống' },
  { code: 'TP', name: 'Thực phẩm tươi sống' },
  { code: 'NB', name: 'Đồ dùng nhà bếp & phục vụ' },
];

const COMMON_AREAS = [
  { code: 'KDLT', name: 'Khu đốt lửa trại' },
  { code: 'QCF', name: 'Quán cà phê' },
  { code: 'SVAT', name: 'Sân vườn ăn trái' },
  { code: 'KTC', name: 'Khu tiểu cảnh' },
  { code: 'HTKT', name: 'Hạ tầng kỹ thuật' },
];

const SEED_CATEGORIES = [
  { managementType: 'infrastructure', name: 'Công trình / hạng mục xây dựng', defaultUnit: 'hạng mục' },
  { managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ' },
  { managementType: 'device_set', name: 'Bộ dàn âm thanh', defaultUnit: 'bộ' },
  { managementType: 'durable_goods', name: 'Ghế', defaultUnit: 'cái' },
  { managementType: 'linen', name: 'Khăn', defaultUnit: 'cái' },
  { managementType: 'consumable', name: 'Đồ dùng cá nhân dùng 1 lần', defaultUnit: 'cái' },
  { managementType: 'spare_part', name: 'Vỏ bình gas', defaultUnit: 'bình' },
  { managementType: 'food_beverage', name: 'Nước uống', defaultUnit: 'chai' },
];

const SOURCE_DOCUMENT = {
  title: 'Phụ lục II — Danh mục tài sản hiện tại của Bên A',
  contractRef: '0107/HĐHTKD-HLG/2026',
};

// Trích nguyên văn từ Phụ lục II (D:/VDX/HienLeGarden/Phu_Luc_I_II_V_Hien_Le_garden.docx,
// bảng "DANH MỤC TÀI SẢN HIỆN TẠI CỦA BÊN A", 64 dòng). raw_quantity giữ dạng chuỗi gốc
// (kể cả "01" có số 0 đầu); ô trống trong văn bản gốc -> null, không phải 0.
const SOURCE_ROWS = [
  { group: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 1, name: 'Phòng lưu trú gia đình', unit: 'phòng', qty: '15', condition: 'Tốt', note: null },
  { group: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 2, name: 'Phòng tập thể (dormitory)', unit: 'phòng', qty: '01', condition: 'Tốt', note: null },
  { group: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 3, name: 'Quán cà phê', unit: 'hạng mục', qty: '01', condition: 'Tốt', note: null },
  { group: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 4, name: 'Khu sinh hoạt tập thể / nhà chung', unit: 'hạng mục', qty: null, condition: 'Tốt', note: null },
  { group: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 5, name: 'Nhà vệ sinh – nhà tắm chung (nếu có)', unit: 'hạng mục', qty: null, condition: 'Tốt', note: null },
  { group: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 6, name: 'Cổng, tường rào, đường nội bộ', unit: 'hệ thống', qty: null, condition: 'Tốt', note: null },

  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 7, name: 'Giường 1.4m', unit: 'cái', qty: '2', condition: 'Tốt', note: null },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 8, name: 'Giường 1.6m', unit: 'Cái', qty: '11', condition: 'Tốt', note: null },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 9, name: 'Giường 1.8m', unit: 'Cái', qty: '1', condition: 'Tốt', note: null },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 10, name: 'Nệm', unit: 'cái', qty: '14', condition: 'Tốt', note: null },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 11, name: 'Điều hoà Daikin 2.5HP', unit: 'bộ', qty: '1', condition: 'Tốt', note: 'Vip1' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 12, name: 'Điều hoà Daikin 2.0HP', unit: 'bộ', qty: '1', condition: 'Tốt', note: 'Sảnh 1' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 13, name: 'Điều hoà Daikin 1.5HP', unit: 'bộ', qty: '8', condition: 'Tốt', note: '5 nhà tròn + 2 Êđê Cozy + Sảnh 3' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 14, name: 'Điều hoà LG 2.0HP', unit: 'bộ', qty: '1', condition: 'Tốt', note: 'Vip2' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 15, name: 'Điều hoà Daikin 1.0HP', unit: 'bộ', qty: '4', condition: 'Tốt', note: '3 nhà tam giác + Sảnh 2' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 16, name: 'Điều hoà Daikin 4.0HP (âm trần)', unit: 'bộ', qty: '1', condition: 'Tốt', note: 'Sảnh 4 (phòng tập thể)' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 17, name: 'Tủ lạnh Funiki 130L', unit: 'cái', qty: '1', condition: 'Tốt', note: 'Sảnh 4' },
  { group: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 18, name: 'Tủ lạnh mini', unit: 'Cái', qty: '12', condition: 'Tốt', note: null },

  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 19, name: 'Bộ dàn loa di động gồm: 4 loa + Ampli + 2 micro.', unit: null, qty: null, condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 20, name: 'Tủ lạnh Electrolux 394L', unit: 'Cái', qty: '1', condition: 'Tốt', note: 'Sảnh lễ tân' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 21, name: 'Quạt hơi nước', unit: 'Cái', qty: '3', condition: 'Tốt', note: 'Sảnh lễ tân' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 22, name: 'Quạt gió (đứng)', unit: 'Cái', qty: '7', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 23, name: 'Máy giặt Toshiba 14kg', unit: 'Cái', qty: '2', condition: 'Tốt', note: 'Khu giặt là' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 24, name: 'Nệm dự phòng', unit: 'Cái', qty: '8', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 25, name: 'Mềm dự phòng', unit: 'Cái', qty: '20', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 26, name: 'Dra bảo vệ nệm', unit: 'Cái', qty: '18', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 27, name: 'Khăn dự phòng', unit: 'Cái', qty: '50', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 28, name: 'Áo gối dự phòng', unit: 'Cái', qty: '40', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 29, name: 'Dra nệm 1m4 dự phòng', unit: 'Cái', qty: '4', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 30, name: 'Dra nệm 1m6 dự phòng', unit: 'Cái', qty: '25', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 31, name: 'Dra nệm 1m8 dự phòng', unit: 'Cái', qty: '4', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 32, name: 'Bao mền dự phòng', unit: 'Cái', qty: '8', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 33, name: 'Gối dự phòng', unit: 'Cái', qty: '7', condition: 'Tốt', note: 'Kho' },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 34, name: 'Dép dự phòng', unit: 'Cái', qty: '19', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 35, name: 'Ghế gỗ', unit: 'Cái', qty: '37', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 36, name: 'Ghế sắt màu trắng', unit: 'Cái', qty: '28', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 37, name: 'Ghế sắt màu đen', unit: 'Cái', qty: '31', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 38, name: 'Ghế mây', unit: 'Cái', qty: '32', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 39, name: 'Ghế nhựa', unit: 'Cái', qty: '153', condition: 'Khá', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 40, name: 'Bàn cà phê khổ 60cm', unit: 'Cái', qty: '22', condition: 'Khá', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 41, name: 'Bàn cà phê mặt đá khổ 80cm', unit: 'Cái', qty: '15', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 42, name: 'Bàn tiệc', unit: 'Cái', qty: '47', condition: 'Khá', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 43, name: 'Ly uống bia', unit: 'Ly', qty: '120', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 44, name: 'Chén', unit: 'Cái', qty: '120', condition: 'Khá', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 45, name: 'Dĩa các loại', unit: 'Cái', qty: '70', condition: 'Khá', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 46, name: 'Đũa + muỗng các loại', unit: 'Cái', qty: '400', condition: 'Khá', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 47, name: 'Vỏ bình ga bò (lớn)', unit: 'Bình', qty: '3', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 48, name: 'Vỏ bình ga nhở 13kg', unit: 'Bình', qty: '3', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 49, name: 'Bếp ga mini', unit: 'Cái', qty: '16', condition: 'Tốt', note: null },
  { group: 'C. KHU VỰC CHUNG, NGOÀI TRỜI & CẢNH QUAN', stt: 50, name: 'Nồi cơm điện lớn (10L)', unit: 'Cái', qty: '1', condition: 'Tốt', note: null },

  { group: 'D. HẠ TẦNG KỸ THUẬT', stt: 51, name: 'Hệ thống điện (công tơ, tủ điện, dây dẫn)', unit: 'hệ thống', qty: null, condition: 'Đang hoạt động bình thường.', note: 'Chỉ số ghi tại PL V' },
  { group: 'D. HẠ TẦNG KỸ THUẬT', stt: 52, name: 'Hệ thống cấp – thoát nước', unit: 'hệ thống', qty: null, condition: 'Đang hoạt động bình thường.', note: null },
  { group: 'D. HẠ TẦNG KỸ THUẬT', stt: 53, name: 'Camera an ninh', unit: 'cái', qty: null, condition: 'Đang hoạt động bình thường.', note: null },
  { group: 'D. HẠ TẦNG KỸ THUẬT', stt: 54, name: 'Internet / wifi (modem, AP)', unit: 'bộ', qty: null, condition: 'Đang hoạt động bình thường.', note: null },
  { group: 'D. HẠ TẦNG KỸ THUẬT', stt: 55, name: 'Máy bơm nước / bồn chứa', unit: 'cái', qty: null, condition: 'Đang hoạt động bình thường.', note: null },

  { group: 'E. TÀI SẢN KHÁC', stt: 56, name: 'Bộ bàn đá + 6 ghế đá', unit: 'Bộ', qty: '1', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 57, name: 'Máy cắt cỏ (Shinda Wha)', unit: 'Cái', qty: '2', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 58, name: 'Xe máy Honda biển số 52L2 1539', unit: 'Xe máy', qty: '1', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 59, name: 'Xe wave dùng di chuyển nội khu.', unit: 'Xe máy', qty: '1', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 60, name: 'Lược', unit: 'Cái', qty: '500', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 61, name: 'Bàn chải đánh răng', unit: 'Cái', qty: '900', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 62, name: 'Bao chụp tóc', unit: 'Cái', qty: '500', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 63, name: 'Tăm bông', unit: 'Bịch', qty: '100', condition: 'Tốt', note: null },
  { group: 'E. TÀI SẢN KHÁC', stt: 64, name: 'Khăn lạnh', unit: 'Cái', qty: '150', condition: 'Tốt', note: null },
];

const lines = [];
lines.push('-- Generated by scripts/import-asset-source-data.js — safe to re-run, every statement is guarded.');

// 1. asset_locations from existing rooms (one per room, code = P + zero-padded
// display_order — matching the ordering rooms are already presented in elsewhere
// in the app, e.g. functions/api/rooms/index.js's `ORDER BY display_order, id`).
lines.push(`
INSERT INTO asset_locations (location_type, room_id, code, name, created_by, created_at)
SELECT 'room', id, 'P' || printf('%02d', display_order), name, 'system', ${sqlString(now)}
FROM rooms
WHERE NOT EXISTS (SELECT 1 FROM asset_locations WHERE asset_locations.room_id = rooms.id);
`.trim());

// 2. Warehouse + common-area seed locations.
for (const w of WAREHOUSES) {
  lines.push(`
INSERT INTO asset_locations (location_type, code, name, created_by, created_at)
SELECT 'warehouse', ${sqlString(w.code)}, ${sqlString(w.name)}, 'system', ${sqlString(now)}
WHERE NOT EXISTS (SELECT 1 FROM asset_locations WHERE location_type = 'warehouse' AND code = ${sqlString(w.code)});
`.trim());
}
for (const c of COMMON_AREAS) {
  lines.push(`
INSERT INTO asset_locations (location_type, code, name, created_by, created_at)
SELECT 'common_area', ${sqlString(c.code)}, ${sqlString(c.name)}, 'system', ${sqlString(now)}
WHERE NOT EXISTS (SELECT 1 FROM asset_locations WHERE location_type = 'common_area' AND code = ${sqlString(c.code)});
`.trim());
}

// 3. Seed example categories (one per management_type) — admin can add/edit/deactivate freely afterward.
for (const cat of SEED_CATEGORIES) {
  lines.push(`
INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at)
SELECT ${sqlString(cat.managementType)}, ${sqlString(cat.name)}, ${sqlString(cat.defaultUnit)}, 'system', ${sqlString(now)}
WHERE NOT EXISTS (SELECT 1 FROM asset_categories WHERE management_type = ${sqlString(cat.managementType)} AND name = ${sqlString(cat.name)});
`.trim());
}

// 4. Source document (one row).
lines.push(`
INSERT INTO asset_source_documents (title, contract_ref, created_by, created_at)
SELECT ${sqlString(SOURCE_DOCUMENT.title)}, ${sqlString(SOURCE_DOCUMENT.contractRef)}, 'system', ${sqlString(now)}
WHERE NOT EXISTS (SELECT 1 FROM asset_source_documents WHERE title = ${sqlString(SOURCE_DOCUMENT.title)});
`.trim());

// 5. Source rows — 64 rows, tied to the document by title lookup (works whether the
// document above was just inserted or already existed from a prior run).
for (const row of SOURCE_ROWS) {
  lines.push(`
INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_unit, raw_quantity, raw_condition, raw_note, created_at)
SELECT id, ${sqlString(row.group)}, ${row.stt}, ${sqlString(row.name)}, ${sqlString(row.unit)}, ${sqlString(row.qty)}, ${sqlString(row.condition)}, ${sqlString(row.note)}, ${sqlString(now)}
FROM asset_source_documents WHERE title = ${sqlString(SOURCE_DOCUMENT.title)}
AND NOT EXISTS (
  SELECT 1 FROM asset_source_rows
  WHERE asset_source_rows.source_document_id = asset_source_documents.id AND asset_source_rows.stt = ${row.stt}
);
`.trim());
}

console.log(lines.join('\n\n'));
```

- [ ] **Step 7: Verify the script's output is valid SQL and idempotent, against a local D1**

Run (from `v4/`):
```bash
node scripts/import-asset-source-data.js > /tmp/asset-import.sql
wrangler d1 execute hien_le_garden_crm --local --file=/tmp/asset-import.sql
```
Expected: no errors. Then confirm counts:
```bash
wrangler d1 execute hien_le_garden_crm --local --command "SELECT (SELECT COUNT(*) FROM asset_source_rows) AS rows, (SELECT COUNT(*) FROM asset_locations) AS locations, (SELECT COUNT(*) FROM asset_categories) AS categories, (SELECT COUNT(*) FROM asset_source_documents) AS documents;"
```
Expected: `rows=64`, `locations` = (number of active rooms) + 10 (5 warehouses + 5 common areas), `categories=8`, `documents=1`.

Run the exact same 2 commands again (re-apply the same generated file a second time):
```bash
wrangler d1 execute hien_le_garden_crm --local --file=/tmp/asset-import.sql
wrangler d1 execute hien_le_garden_crm --local --command "SELECT (SELECT COUNT(*) FROM asset_source_rows) AS rows, (SELECT COUNT(*) FROM asset_locations) AS locations, (SELECT COUNT(*) FROM asset_categories) AS categories, (SELECT COUNT(*) FROM asset_source_documents) AS documents;"
```
Expected: **identical counts** to the first run — confirms the script is safe to re-run. If any count grew, the idempotency guard on that INSERT is broken — fix it before proceeding (do not commit a script that fails this check).

- [ ] **Step 8: Commit**

```bash
cd v4
git add functions/api/asset-source-documents functions/api/asset-source-rows scripts/import-asset-source-data.js test/assetSourceData.test.js
git commit -m "feat: add asset-source-documents/rows read endpoints and idempotent import script for Phụ lục II

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Client — "Danh mục & vị trí" (`admin/asset-config.html`/`.js`)

**Files:**
- Create: `v4/admin/asset-config.html`
- Create: `v4/admin/asset-config.js`

**Interfaces:**
- Consumes: `GET/POST /api/asset-categories`, `PATCH /api/asset-categories/:id`, `GET/POST /api/asset-locations`, `PATCH /api/asset-locations/:id` from Task 2; `GET /api/rooms` (existing endpoint, returns `[{id, name, roomType, needsCleaning}]`).

- [ ] **Step 1: Create `v4/admin/asset-config.html`**

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
  <title>Danh mục & vị trí — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Danh mục & vị trí</h1>
    <p id="pageError" class="error"></p>

    <h2>Danh mục tài sản</h2>
    <button type="button" id="openAddCategoryBtn" class="hidden">+ Thêm danh mục</button>
    <div id="categoryGroups"></div>

    <div id="categoryFormOverlay" class="confirm-overlay hidden">
      <div class="confirm-box">
        <h3 id="categoryFormTitle">Thêm danh mục</h3>
        <form id="categoryForm">
          <label>Cách quản lý
            <select name="managementType" required></select>
          </label>
          <label>Tên danh mục <input type="text" name="name" required /></label>
          <label>Đơn vị tính <input type="text" name="defaultUnit" required /></label>
          <label>Ghi chú <input type="text" name="note" /></label>
          <button type="submit">Lưu</button>
          <button type="button" id="categoryFormCloseBtn" class="btn-secondary">Đóng</button>
          <p id="categoryFormError" class="error"></p>
        </form>
      </div>
    </div>

    <h2>Vị trí</h2>
    <div class="filters" id="locationTypeToggle">
      <button type="button" class="tab-btn active" data-location-type="room">Phòng</button>
      <button type="button" class="tab-btn" data-location-type="warehouse">Kho</button>
      <button type="button" class="tab-btn" data-location-type="common_area">Khu vực chung</button>
    </div>
    <button type="button" id="openAddLocationBtn" class="hidden">+ Thêm vị trí</button>
    <div id="locationList" class="booking-list"></div>

    <div id="locationFormOverlay" class="confirm-overlay hidden">
      <div class="confirm-box">
        <h3 id="locationFormTitle">Thêm vị trí</h3>
        <form id="locationForm">
          <label id="locationRoomWrap" class="hidden">Phòng
            <select name="roomId"></select>
          </label>
          <label>Mã <input type="text" name="code" /></label>
          <label>Tên hiển thị <input type="text" name="name" required /></label>
          <label>Ghi chú <input type="text" name="note" /></label>
          <button type="submit">Lưu</button>
          <button type="button" id="locationFormCloseBtn" class="btn-secondary">Đóng</button>
          <p id="locationFormError" class="error"></p>
        </form>
      </div>
    </div>
  </div>

  <script src="/admin/asset-config.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `v4/admin/asset-config.js`**

```js
// v4/admin/asset-config.js
let currentRole = null;
let categories = [];
let locations = [];
let currentLocationType = 'room';
let roomsById = {};

const MANAGEMENT_TYPE_LABELS = {
  infrastructure: 'Công trình & hạ tầng',
  individual_device: 'Thiết bị riêng lẻ',
  device_set: 'Bộ thiết bị',
  durable_goods: 'Đồ dùng bền theo số lượng',
  linen: 'Đồ vải luân chuyển',
  consumable: 'Vật tư tiêu hao',
  spare_part: 'Phụ tùng',
  food_beverage: 'Thực phẩm, thức uống',
};
const MANAGEMENT_TYPE_ORDER = ['infrastructure', 'individual_device', 'device_set', 'durable_goods', 'linen', 'consumable', 'spare_part', 'food_beverage'];

function showPageError(message) {
  document.getElementById('pageError').textContent = message || '';
}

function populateManagementTypeSelect(select) {
  select.innerHTML = '';
  MANAGEMENT_TYPE_ORDER.forEach((type) => {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = MANAGEMENT_TYPE_LABELS[type];
    select.appendChild(opt);
  });
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
  const { role } = await res.json();
  currentRole = role;

  if (currentRole === 'admin') {
    document.getElementById('openAddCategoryBtn').classList.remove('hidden');
    document.getElementById('openAddLocationBtn').classList.remove('hidden');
  }

  populateManagementTypeSelect(document.querySelector('#categoryForm select[name="managementType"]'));

  await loadRooms();
  await loadCategories();
  await loadLocations();
})();

async function loadRooms() {
  let response;
  try {
    response = await fetch('/api/rooms');
  } catch (err) {
    return;
  }
  if (!response.ok) return;
  const rooms = await response.json();
  roomsById = {};
  rooms.forEach((r) => { roomsById[r.id] = r; });
  const select = document.querySelector('#locationForm select[name="roomId"]');
  select.innerHTML = '';
  rooms.forEach((r) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = r.name;
    select.appendChild(opt);
  });
}

async function loadCategories() {
  showPageError('');
  let response;
  try {
    response = await fetch('/api/asset-categories?includeInactive=1');
  } catch (err) {
    showPageError('Có lỗi khi tải danh mục');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi tải danh mục');
    return;
  }
  categories = await response.json();
  renderCategories();
}

function renderCategories() {
  const container = document.getElementById('categoryGroups');
  container.innerHTML = '';
  MANAGEMENT_TYPE_ORDER.forEach((type) => {
    const group = categories.filter((c) => c.managementType === type);
    if (group.length === 0) return;
    const h3 = document.createElement('h3');
    h3.textContent = MANAGEMENT_TYPE_LABELS[type];
    container.appendChild(h3);
    const list = document.createElement('div');
    list.className = 'booking-list';
    group.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'booking-card';
      if (!c.isActive) card.style.opacity = '0.5';
      const p = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = c.name;
      p.append(strong, ` — ${c.defaultUnit}${c.isActive ? '' : ' (đã ngừng dùng)'}`);
      card.appendChild(p);
      if (c.note) {
        const noteP = document.createElement('p');
        noteP.textContent = c.note;
        card.appendChild(noteP);
      }
      if (currentRole === 'admin') {
        const actions = document.createElement('div');
        actions.className = 'booking-actions';
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'table-actions-btn';
        editBtn.textContent = 'Sửa';
        editBtn.addEventListener('click', () => openEditCategory(c));
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn-secondary table-actions-btn';
        toggleBtn.textContent = c.isActive ? 'Ngừng dùng' : 'Dùng lại';
        toggleBtn.addEventListener('click', () => toggleCategoryActive(c));
        actions.append(editBtn, toggleBtn);
        card.appendChild(actions);
      }
      list.appendChild(card);
    });
    container.appendChild(list);
  });
}

function openCategoryFormOverlay() {
  document.getElementById('categoryFormOverlay').classList.remove('hidden');
}
function closeCategoryFormOverlay() {
  document.getElementById('categoryFormOverlay').classList.add('hidden');
}

document.getElementById('openAddCategoryBtn').addEventListener('click', () => {
  const form = document.getElementById('categoryForm');
  form.reset();
  delete form.dataset.editingId;
  form.querySelector('[name="managementType"]').disabled = false;
  document.getElementById('categoryFormTitle').textContent = 'Thêm danh mục';
  document.getElementById('categoryFormError').textContent = '';
  openCategoryFormOverlay();
});

document.getElementById('categoryFormCloseBtn').addEventListener('click', closeCategoryFormOverlay);

function openEditCategory(c) {
  const form = document.getElementById('categoryForm');
  form.reset();
  form.querySelector('[name="managementType"]').value = c.managementType;
  form.querySelector('[name="managementType"]').disabled = true;
  form.querySelector('[name="name"]').value = c.name;
  form.querySelector('[name="defaultUnit"]').value = c.defaultUnit;
  form.querySelector('[name="note"]').value = c.note || '';
  form.dataset.editingId = c.id;
  document.getElementById('categoryFormTitle').textContent = 'Sửa danh mục';
  document.getElementById('categoryFormError').textContent = '';
  openCategoryFormOverlay();
}

async function toggleCategoryActive(c) {
  showPageError('');
  const response = await fetch(`/api/asset-categories/${c.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !c.isActive }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi cập nhật danh mục');
    return;
  }
  await loadCategories();
}

document.getElementById('categoryForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('categoryFormError');
  errorEl.textContent = '';

  const editingId = form.dataset.editingId;
  const payload = editingId
    ? {
        name: form.querySelector('[name="name"]').value,
        defaultUnit: form.querySelector('[name="defaultUnit"]').value,
        note: form.querySelector('[name="note"]').value,
      }
    : {
        managementType: form.querySelector('[name="managementType"]').value,
        name: form.querySelector('[name="name"]').value,
        defaultUnit: form.querySelector('[name="defaultUnit"]').value,
        note: form.querySelector('[name="note"]').value,
      };

  let response;
  try {
    response = await fetch(editingId ? `/api/asset-categories/${editingId}` : '/api/asset-categories', {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi lưu danh mục';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu danh mục';
    return;
  }

  closeCategoryFormOverlay();
  await loadCategories();
});

async function loadLocations() {
  showPageError('');
  let response;
  try {
    response = await fetch('/api/asset-locations?includeInactive=1');
  } catch (err) {
    showPageError('Có lỗi khi tải vị trí');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi tải vị trí');
    return;
  }
  locations = await response.json();
  renderLocations();
}

function renderLocations() {
  const container = document.getElementById('locationList');
  container.innerHTML = '';
  const filtered = locations.filter((l) => l.locationType === currentLocationType);
  if (filtered.length === 0) {
    const p = document.createElement('p');
    p.className = 'booking-empty';
    p.textContent = 'Chưa có vị trí nào.';
    container.appendChild(p);
    return;
  }
  filtered.forEach((l) => {
    const card = document.createElement('div');
    card.className = 'booking-card';
    if (!l.isActive) card.style.opacity = '0.5';
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = l.name;
    p.append(strong, ` — ${l.code || ''}${l.isActive ? '' : ' (đã ngừng dùng)'}`);
    card.appendChild(p);
    if (l.locationType === 'room' && roomsById[l.roomId]) {
      const roomNameP = document.createElement('p');
      roomNameP.className = 'booking-meta';
      roomNameP.textContent = `Tên phòng gốc (dùng cho đặt phòng): ${roomsById[l.roomId].name}`;
      card.appendChild(roomNameP);
    }
    if (l.note) {
      const noteP = document.createElement('p');
      noteP.textContent = l.note;
      card.appendChild(noteP);
    }
    if (currentRole === 'admin') {
      const actions = document.createElement('div');
      actions.className = 'booking-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'table-actions-btn';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditLocation(l));
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-secondary table-actions-btn';
      toggleBtn.textContent = l.isActive ? 'Ngừng dùng' : 'Dùng lại';
      toggleBtn.addEventListener('click', () => toggleLocationActive(l));
      actions.append(editBtn, toggleBtn);
      card.appendChild(actions);
    }
    container.appendChild(card);
  });
}

document.querySelectorAll('#locationTypeToggle .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#locationTypeToggle .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentLocationType = btn.dataset.locationType;
    renderLocations();
  });
});

function openLocationFormOverlay() {
  document.getElementById('locationFormOverlay').classList.remove('hidden');
}
function closeLocationFormOverlay() {
  document.getElementById('locationFormOverlay').classList.add('hidden');
}

document.getElementById('openAddLocationBtn').addEventListener('click', () => {
  const form = document.getElementById('locationForm');
  form.reset();
  delete form.dataset.editingId;
  document.getElementById('locationRoomWrap').classList.toggle('hidden', currentLocationType !== 'room');
  document.getElementById('locationFormTitle').textContent = 'Thêm vị trí';
  document.getElementById('locationFormError').textContent = '';
  openLocationFormOverlay();
});

document.getElementById('locationFormCloseBtn').addEventListener('click', closeLocationFormOverlay);

function openEditLocation(l) {
  const form = document.getElementById('locationForm');
  form.reset();
  form.querySelector('[name="code"]').value = l.code || '';
  form.querySelector('[name="name"]').value = l.name;
  form.querySelector('[name="note"]').value = l.note || '';
  form.dataset.editingId = l.id;
  document.getElementById('locationRoomWrap').classList.add('hidden');
  document.getElementById('locationFormTitle').textContent = 'Sửa vị trí';
  document.getElementById('locationFormError').textContent = '';
  openLocationFormOverlay();
}

async function toggleLocationActive(l) {
  showPageError('');
  const response = await fetch(`/api/asset-locations/${l.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !l.isActive }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi cập nhật vị trí');
    return;
  }
  await loadLocations();
}

document.getElementById('locationForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('locationFormError');
  errorEl.textContent = '';

  const editingId = form.dataset.editingId;
  let response;
  try {
    if (editingId) {
      response = await fetch(`/api/asset-locations/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: form.querySelector('[name="code"]').value,
          name: form.querySelector('[name="name"]').value,
          note: form.querySelector('[name="note"]').value,
        }),
      });
    } else {
      const payload = {
        locationType: currentLocationType,
        code: form.querySelector('[name="code"]').value,
        name: form.querySelector('[name="name"]').value,
        note: form.querySelector('[name="note"]').value,
      };
      if (currentLocationType === 'room') {
        payload.roomId = Number(form.querySelector('[name="roomId"]').value);
      }
      response = await fetch('/api/asset-locations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi lưu vị trí';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu vị trí';
    return;
  }

  closeLocationFormOverlay();
  await loadLocations();
});
```

- [ ] **Step 3: Kiểm tra thủ công bằng trình duyệt thật**

`node -c` chỉ kiểm tra cú pháp — bắt buộc dùng trình duyệt thật (`wrangler pages dev .`, KHÔNG dùng `npm run dev` vì flag `--d1=DB` của nó trỏ vào 1 file D1 local khác với file `wrangler d1 migrations apply`/`d1 execute` dùng). Sau khi migrate + chạy script Task 3 vào D1 local, đăng nhập admin và xác nhận:
- Danh mục hiện đúng theo 8 nhóm cách quản lý, nút Thêm/Sửa/Ngừng dùng chỉ admin thấy.
- Thêm 1 danh mục mới, sửa tên/đơn vị/ghi chú 1 danh mục, ngừng dùng rồi dùng lại — mỗi thao tác cập nhật đúng danh sách ngay sau khi lưu.
- Gạt qua 3 tab Phòng/Kho/Khu vực chung, xác nhận danh sách vị trí đúng theo từng loại (Phòng phải thấy đủ số phòng đã seed từ Task 3); mỗi thẻ vị trí loại Phòng phải hiện thêm dòng "Tên phòng gốc (dùng cho đặt phòng): ..." lấy đúng từ `rooms.name`, tách biệt với tên hiển thị riêng của `asset_locations.name`.
- Thêm 1 vị trí Kho mới, sửa tên 1 vị trí Phòng (xác nhận không cho đổi loại/phòng gắn kèm).
- Đăng nhập vai trò `reception`/`observer`, xác nhận thấy đầy đủ danh mục+vị trí nhưng không thấy bất kỳ nút Thêm/Sửa/Ngừng dùng nào.
- 0 lỗi console/page trong toàn bộ quá trình.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/asset-config.html admin/asset-config.js
git commit -m "feat: add Danh mục & vị trí admin page for asset/inventory catalogs and locations

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — "Hồ sơ nguồn" (`admin/asset-source-data.html`/`.js`) + đăng ký nav & clean URLs

**Files:**
- Create: `v4/admin/asset-source-data.html`
- Create: `v4/admin/asset-source-data.js`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`

**Interfaces:**
- Consumes: `GET /api/asset-source-documents`, `GET /api/asset-source-rows?documentId=X` from Task 3.

- [ ] **Step 1: Create `v4/admin/asset-source-data.html`**

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
  <title>Hồ sơ nguồn — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Hồ sơ nguồn</h1>
    <p id="pageError" class="error"></p>
    <p class="warning-banner">Đây là hồ sơ gốc đã ký giữa hai bên, không thể chỉnh sửa tại đây — sẽ được dùng để tạo tài sản vận hành ở bước tiếp theo.</p>

    <label>Hồ sơ <select id="documentSelect"></select></label>

    <div class="table-scroll">
      <table id="sourceRowsTable">
        <thead><tr><th>STT</th><th>Tên tài sản / hạng mục</th><th>ĐVT</th><th>Số lượng</th><th>Tình trạng</th><th>Ghi chú</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script src="/admin/asset-source-data.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `v4/admin/asset-source-data.js`**

```js
// v4/admin/asset-source-data.js
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

  await loadDocuments();
})();

function showPageError(message) {
  document.getElementById('pageError').textContent = message || '';
}

async function loadDocuments() {
  showPageError('');
  let response;
  try {
    response = await fetch('/api/asset-source-documents');
  } catch (err) {
    showPageError('Có lỗi khi tải hồ sơ nguồn');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi tải hồ sơ nguồn');
    return;
  }
  const documents = await response.json();
  const select = document.getElementById('documentSelect');
  select.innerHTML = '';
  documents.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.contractRef ? `${d.title} (${d.contractRef})` : d.title;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => loadSourceRows(select.value));
  if (documents.length > 0) await loadSourceRows(documents[0].id);
}

async function loadSourceRows(documentId) {
  showPageError('');
  let response;
  try {
    response = await fetch(`/api/asset-source-rows?documentId=${documentId}`);
  } catch (err) {
    showPageError('Có lỗi khi tải danh sách hạng mục');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi tải danh sách hạng mục');
    return;
  }
  const rows = await response.json();
  renderRows(rows);
}

function renderRows(rows) {
  const tbody = document.querySelector('#sourceRowsTable tbody');
  tbody.innerHTML = '';
  let currentGroup = null;
  rows.forEach((r) => {
    if (r.sourceGroupLabel !== currentGroup) {
      currentGroup = r.sourceGroupLabel;
      const groupTr = document.createElement('tr');
      const groupTd = document.createElement('td');
      groupTd.colSpan = 6;
      groupTd.style.fontWeight = '600';
      groupTd.textContent = currentGroup;
      groupTr.appendChild(groupTd);
      tbody.appendChild(groupTr);
    }
    const tr = document.createElement('tr');
    const cells = [
      String(r.stt),
      r.rawName,
      r.rawUnit || '',
      r.rawQuantity !== null && r.rawQuantity !== undefined ? r.rawQuantity : 'Chưa xác định',
      r.rawCondition || '',
      r.rawNote || '',
    ];
    cells.forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}
```

- [ ] **Step 3: Register the new "Tài sản & Kho" nav group**

In `v4/admin/nav-drawer.js`, find:
```js
const NAV_GROUPS = [
  {
    label: 'Vận hành',
```
Replace with:
```js
const NAV_GROUPS = [
  {
    label: 'Tài sản & Kho',
    items: [
      { page: 'asset-config.html', label: 'Danh mục & vị trí', icon: '🗂️', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'asset-source-data.html', label: 'Hồ sơ nguồn', icon: '📄', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
  {
    label: 'Vận hành',
```

- [ ] **Step 4: Add clean-URL redirects for both new pages**

In `v4/_redirects`, following the exact 3-line-per-page pattern already used for `catalog.html` (search for `/manager/catalog` to find the right area — add these new lines anywhere among the other `/manager/...`, `/reception/...`, `/observer/...` blocks, keeping each role's own block together as the file already does):

```
/manager/asset-config          /admin/asset-config     200
/manager/asset-source-data     /admin/asset-source-data 200
/reception/asset-config        /admin/asset-config     200
/reception/asset-source-data   /admin/asset-source-data 200
/observer/asset-config         /admin/asset-config     200
/observer/asset-source-data    /admin/asset-source-data 200
```

- [ ] **Step 5: Kiểm tra thủ công bằng trình duyệt thật**

Với D1 local đã migrate + chạy script Task 3: xác nhận menu điều hướng hiện nhóm "Tài sản & Kho" với cả 4 role; trang "Hồ sơ nguồn" hiện đúng 64 dòng, nhóm theo 5 tiêu đề A-E, dòng số lượng trống hiện đúng chữ "Chưa xác định" (không phải ô trống hay "0") — đối chiếu ít nhất 2 dòng cụ thể: STT 4 ("Khu sinh hoạt tập thể / nhà chung") phải hiện "Chưa xác định", STT 2 ("Phòng tập thể (dormitory)") phải hiện đúng "01" (không bị đổi thành "1"). 0 lỗi console/page.

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/asset-source-data.html admin/asset-source-data.js admin/nav-drawer.js _redirects
git commit -m "feat: add Hồ sơ nguồn admin page, register Tài sản & Kho nav group and clean URLs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: E2e coverage (outer repo)

**Files:**
- Create: `tests/e2e/asset-config.spec.js`
- Create: `tests/e2e/asset-source-data.spec.js`

**Interfaces:**
- Consumes: every DOM id from Tasks 4 and 5, and the API contracts from Tasks 2 and 3.

- [ ] **Step 1: Create `tests/e2e/asset-config.spec.js`**

```js
// tests/e2e/asset-config.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

const SAMPLE_CATEGORIES = [
  { id: 1, managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', isActive: true, note: null, createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
  { id: 2, managementType: 'linen', name: 'Khăn', defaultUnit: 'cái', isActive: false, note: 'Ngừng dùng', createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
];

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'room', roomId: 4, code: 'P04', name: 'Nhà tròn 1 (khu tài sản)', isActive: true, note: null, createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
  { id: 2, locationType: 'warehouse', roomId: null, code: 'BP', name: 'Buồng phòng', isActive: true, note: null, createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
];

const SAMPLE_ROOMS = [{ id: 4, name: 'Circle House 1', roomType: 'circle', needsCleaning: false }];

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    mockAuth(page, role),
    page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROOMS) })),
    page.route('**/api/asset-categories**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
    page.route('**/api/asset-locations**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
  ]);
}

test.describe('Danh mục & vị trí (admin/asset-config.html)', () => {
  test('admin sees add/edit/deactivate controls; reception does not', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    await expect(page.locator('#openAddCategoryBtn')).toBeVisible();
    await expect(page.locator('#openAddLocationBtn')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sửa' }).first()).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.reload();
    await expect(page.locator('#openAddCategoryBtn')).toBeHidden();
    await expect(page.locator('#openAddLocationBtn')).toBeHidden();
    await expect(page.locator('button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('categories render grouped by management type, inactive ones dimmed', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    await expect(page.locator('#categoryGroups')).toContainText('Thiết bị riêng lẻ');
    await expect(page.locator('#categoryGroups')).toContainText('Điều hoà');
    await expect(page.locator('#categoryGroups')).toContainText('Đồ vải luân chuyển');
    await expect(page.locator('#categoryGroups')).toContainText('Khăn');
    await expect(page.locator('#categoryGroups')).toContainText('đã ngừng dùng');
  });

  test('adding a category submits the correct payload', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-categories', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
    });

    await page.goto('/admin/asset-config.html');
    await page.click('#openAddCategoryBtn');
    await page.selectOption('#categoryForm select[name="managementType"]', 'consumable');
    await page.fill('#categoryForm input[name="name"]', 'Nước rửa chén');
    await page.fill('#categoryForm input[name="defaultUnit"]', 'chai');
    await page.click('#categoryForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ managementType: 'consumable', name: 'Nước rửa chén', defaultUnit: 'chai' });
  });

  test('switching location tabs filters the list by type', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    await expect(page.locator('#locationList')).toContainText('Nhà tròn 1 (khu tài sản)');
    await expect(page.locator('#locationList')).not.toContainText('Buồng phòng');

    await page.click('#locationTypeToggle button[data-location-type="warehouse"]');
    await expect(page.locator('#locationList')).toContainText('Buồng phòng');
    await expect(page.locator('#locationList')).not.toContainText('Nhà tròn 1 (khu tài sản)');
  });

  test('a room-type location card shows the original room name (readonly) alongside its own asset name', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    const roomCard = page.locator('#locationList', { hasText: 'Nhà tròn 1 (khu tài sản)' });
    await expect(roomCard).toContainText('Circle House 1');
    await expect(roomCard).toContainText('Tên phòng gốc');
  });

  test('adding a room location includes roomId in the payload; adding a warehouse location does not require it', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-locations', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) });
    });

    await page.goto('/admin/asset-config.html');
    await page.click('#openAddLocationBtn');
    await expect(page.locator('#locationRoomWrap')).toBeVisible();
    await page.selectOption('#locationForm select[name="roomId"]', '4');
    await page.fill('#locationForm input[name="name"]', 'Circle House 1');
    await page.click('#locationForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ locationType: 'room', roomId: 4, name: 'Circle House 1' });
  });
});
```

- [ ] **Step 2: Run the file to verify it passes**

Run: `npx playwright test tests/e2e/asset-config.spec.js --project=v4`
Expected: PASS, 6/6.

- [ ] **Step 3: Create `tests/e2e/asset-source-data.spec.js`**

```js
// tests/e2e/asset-source-data.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_DOCUMENTS = [
  { id: 1, title: 'Phụ lục II — Danh mục tài sản hiện tại của Bên A', contractRef: '0107/HĐHTKD-HLG/2026', documentDate: null, note: null, createdBy: 'system', createdAt: '2026-09-07T00:00:00Z' },
];

const SAMPLE_ROWS = [
  { id: 1, sourceDocumentId: 1, sourceGroupLabel: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 1, rawName: 'Phòng lưu trú gia đình', rawUnit: 'phòng', rawQuantity: '15', rawCondition: 'Tốt', rawNote: null, createdAt: '2026-09-07T00:00:00Z' },
  { id: 2, sourceDocumentId: 1, sourceGroupLabel: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 2, rawName: 'Phòng tập thể (dormitory)', rawUnit: 'phòng', rawQuantity: '01', rawCondition: 'Tốt', rawNote: null, createdAt: '2026-09-07T00:00:00Z' },
  { id: 3, sourceDocumentId: 1, sourceGroupLabel: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 7, rawName: 'Giường 1.4m', rawUnit: 'cái', rawQuantity: null, rawCondition: 'Tốt', rawNote: null, createdAt: '2026-09-07T00:00:00Z' },
];

test.describe('Hồ sơ nguồn (admin/asset-source-data.html)', () => {
  test('renders rows grouped by source group label, shows "Chưa xác định" for a null quantity, preserves "01"', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/asset-source-documents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_DOCUMENTS) }));
    await page.route('**/api/asset-source-rows**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROWS) }));

    await page.goto('/admin/asset-source-data.html');

    await expect(page.locator('#sourceRowsTable')).toContainText('A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG');
    await expect(page.locator('#sourceRowsTable')).toContainText('B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG');

    const row2 = page.locator('#sourceRowsTable tbody tr', { hasText: 'Phòng tập thể (dormitory)' });
    await expect(row2).toContainText('01');

    const row7 = page.locator('#sourceRowsTable tbody tr', { hasText: 'Giường 1.4m' });
    await expect(row7).toContainText('Chưa xác định');
  });

  test('changing the document selector re-fetches source rows for the selected documentId', async ({ page }) => {
    const documents = [...SAMPLE_DOCUMENTS, { id: 2, title: 'Phụ lục khác', contractRef: null, documentDate: null, note: null, createdBy: 'system', createdAt: '2026-09-07T00:00:00Z' }];
    let lastRequestedId = null;
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/asset-source-documents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(documents) }));
    await page.route('**/api/asset-source-rows**', (route) => {
      const url = new URL(route.request().url());
      lastRequestedId = url.searchParams.get('documentId');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROWS) });
    });

    await page.goto('/admin/asset-source-data.html');
    await expect.poll(() => lastRequestedId).toBe('1');

    await page.selectOption('#documentSelect', '2');
    await expect.poll(() => lastRequestedId).toBe('2');
  });
});
```

- [ ] **Step 4: Run the file to verify it passes**

Run: `npx playwright test tests/e2e/asset-source-data.spec.js --project=v4`
Expected: PASS, 2/2.

- [ ] **Step 5: Run the full v4 project to confirm no regressions**

Run: `npx playwright test --project=v4`
Expected: PASS, current baseline (confirm the exact number with `npx playwright test --project=v4 --list` right before this task, since this project has had several plans land on it) + 8 new (6 + 2), same single pre-existing unrelated failure in `reception-ops-board.spec.js` if it's still present — do not attempt to fix that one.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/asset-config.spec.js tests/e2e/asset-source-data.spec.js
git commit -m "test: e2e coverage for asset/inventory Phase 2 (Danh mục & vị trí, Hồ sơ nguồn)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0027 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Chạy script nhập liệu lên production: `node scripts/import-asset-source-data.js > asset-import.sql`, kiểm tra lại nội dung file, rồi `wrangler d1 execute hien_le_garden_crm --remote --file=./asset-import.sql`.
3. Push `v4` (branch `main`), deploy qua `npx wrangler pages deploy .`.
4. Push repo ngoài (e2e test mới).
5. Smoke-test thực tế: vào "Danh mục & vị trí" xác nhận 8 nhóm danh mục + đủ số phòng ở tab Phòng + 5 kho + 5 khu vực chung; vào "Hồ sơ nguồn" xác nhận đủ 64 dòng, đúng nhóm A-E, đúng "Chưa xác định"/đúng "01" ở các dòng đã kiểm tra thủ công tại Task 4/5.
