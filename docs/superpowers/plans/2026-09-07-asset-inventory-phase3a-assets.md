# Asset & Inventory Phase 3a — Operational Asset Records & Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Layer-3 operational asset table, individual-device profiles with QR codes, photo attachments, and a reconciliation flow from the 64-row handover source data into real asset records.

**Architecture:** One new `assets` table stores both individually-tracked devices (`individual_device`/`device_set`, auto-generated internal code + QR, quantity always 1) and quantity-tracked bulk assets (`durable_goods`/`infrastructure`, no code, nullable quantity) at a shared schema. Reconciliation reads `asset_source_rows` (never writes to it) and creates `assets` rows, guarded against double-counting via `SUM(quantity)` per source row. A new admin page lists/edits assets; the existing source-data page gains a "Tạo tài sản" action per row.

**Tech Stack:** Cloudflare Pages Functions + D1 (v4 repo), vanilla JS admin frontend (no build step), R2 (`RECEIPTS` bucket, reused) for asset photos, a vendored self-contained QR-generation library, Playwright e2e (outer repo).

**Spec:** `docs/superpowers/specs/2026-09-07-asset-inventory-phase3a-assets-design.md`

## Global Constraints

- Reuse the 4 existing roles (`admin`, `manager`, `reception`, `observer`) — no new role. Reads on every new endpoint are open to all 4; writes (`POST`/`PATCH` on assets, photo `POST`/`DELETE`, reconcile) are `admin`+`manager` — **not** admin-only like Phase 2's categories/locations, since assets are operational data updated as often as bookings/finance transactions.
- `assets.category_id` can never change via `PATCH` after creation — reject with `400` if the request body contains `categoryId`.
- `internal_code` is auto-generated (`TS` + zero-padded 6-digit id) **only** when the asset's category has `management_type IN ('individual_device', 'device_set')` — every other type leaves it `NULL`. Generation is a 2-step insert-then-update using the row's own `last_row_id`, matching this codebase's established pattern for ID-derived codes.
- `quantity` is forced to `1` server-side for `individual_device`/`device_set` assets (any client-supplied value is ignored) on both create and update. For `durable_goods`/`infrastructure`, `quantity` stays whatever the client sends, `NULL` ("Chưa xác định") when omitted — never coerced to `0` or `1`.
- `location_id = NULL` means "Chưa phân bổ vị trí" — never inferred/guessed.
- **Never write to `asset_source_rows` or `asset_source_documents`** — both stay strictly read-only in every task of this plan. "How much of a source row has been reconciled" is always computed live via `SUM(quantity)` over `assets.source_row_id`, never cached on the source table.
- The reconcile endpoint (`POST /api/asset-source-rows/:id/reconcile`) rejects (`400`) if the source row's `raw_quantity` is a known positive integer and reconciling would push the total (`existing SUM(quantity) + the new count/quantity`) past it — no such ceiling when `raw_quantity` is `NULL`.
- 2 new `audit_log` action types, registered in exactly the 3 required places: `asset_create`, `asset_update`. No parallel logging mechanism.
- No new CSS beyond what's strictly needed for the QR display — reuse `.confirm-overlay`/`.confirm-box`, `.booking-card`/`.booking-list`/`.booking-actions`/`.booking-empty`, `.table-actions-btn`/`.btn-secondary`, `.tab-btn`, `.error`/`.hidden`, `.warning-banner`, `.table-scroll` from `admin/admin.css`.
- Next migration number is `0029` (latest existing: `0028_finance_transaction_permission.sql`). Production D1 database name: `hien_le_garden_crm`.
- The QR library is vendored once via a live `curl` fetch at implementation time (not embedded in this plan as literal file content) — see Task 5 for the exact command and the verification step that must pass before it's used.

---

### Task 1: Migration — `assets` table

**Files:**
- Create: `v4/migrations/0029_asset_inventory_phase3a_assets.sql`
- Test: `v4/test/migrations.test.js`

**Interfaces:**
- Produces: `assets` table (columns: `id, category_id, internal_code, name, brand, serial_number, source_type, source_row_id, acquired_date, purchase_price, location_id, holder, quantity, physical_condition, operational_status, lifecycle_status, photo_key, photo_filename, photo_uploaded_at, note, created_by, created_at, updated_by, updated_at`) — Tasks 2, 3, 4 depend on these exact column names.

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/migrations.test.js`, after the last existing `describe(...)` block:

```js
describe('migration 0029', () => {
  async function seedCategory(managementType) {
    const insert = await env.DB.prepare(
      `INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES (?, 'Test Category', 'cái', 'system', '2026-09-07T00:00:00Z')`
    ).bind(managementType).run();
    return insert.meta.last_row_id;
  }

  it('creates an asset with required fields and defaults for the 3 status fields', async () => {
    const categoryId = await seedCategory('durable_goods');
    const insert = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, created_by, created_at) VALUES (?, 'Giường 1', 'handover_a', 'system', '2026-09-07T00:00:00Z')`
    ).bind(categoryId).run();
    const row = await env.DB.prepare(`SELECT physical_condition, operational_status, lifecycle_status FROM assets WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ physical_condition: 'chua_danh_gia', operational_status: 'san_sang', lifecycle_status: 'dang_quan_ly' });
  });

  it('rejects an invalid source_type', async () => {
    const categoryId = await seedCategory('durable_goods');
    await expect(
      env.DB.prepare(
        `INSERT INTO assets (category_id, name, source_type, created_by, created_at) VALUES (?, 'X', 'invalid', 'system', '2026-09-07T00:00:00Z')`
      ).bind(categoryId).run()
    ).rejects.toThrow();
  });

  it('rejects an invalid physical_condition', async () => {
    const categoryId = await seedCategory('durable_goods');
    await expect(
      env.DB.prepare(
        `INSERT INTO assets (category_id, name, source_type, physical_condition, created_by, created_at) VALUES (?, 'X', 'handover_a', 'invalid', 'system', '2026-09-07T00:00:00Z')`
      ).bind(categoryId).run()
    ).rejects.toThrow();
  });

  it('rejects an invalid operational_status', async () => {
    const categoryId = await seedCategory('durable_goods');
    await expect(
      env.DB.prepare(
        `INSERT INTO assets (category_id, name, source_type, operational_status, created_by, created_at) VALUES (?, 'X', 'handover_a', 'invalid', 'system', '2026-09-07T00:00:00Z')`
      ).bind(categoryId).run()
    ).rejects.toThrow();
  });

  it('rejects an invalid lifecycle_status', async () => {
    const categoryId = await seedCategory('durable_goods');
    await expect(
      env.DB.prepare(
        `INSERT INTO assets (category_id, name, source_type, lifecycle_status, created_by, created_at) VALUES (?, 'X', 'handover_a', 'invalid', 'system', '2026-09-07T00:00:00Z')`
      ).bind(categoryId).run()
    ).rejects.toThrow();
  });

  it('allows a NULL quantity ("Chưa xác định") and a NULL location_id ("Chưa phân bổ vị trí")', async () => {
    const categoryId = await seedCategory('durable_goods');
    const insert = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, created_by, created_at) VALUES (?, 'X', 'handover_a', 'system', '2026-09-07T00:00:00Z')`
    ).bind(categoryId).run();
    const row = await env.DB.prepare(`SELECT quantity, location_id FROM assets WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ quantity: null, location_id: null });
  });

  it('rejects a duplicate internal_code', async () => {
    const categoryId = await seedCategory('individual_device');
    await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, internal_code, created_by, created_at) VALUES (?, 'A', 'handover_a', 'TS000001', 'system', '2026-09-07T00:00:00Z')`
    ).bind(categoryId).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO assets (category_id, name, source_type, internal_code, created_by, created_at) VALUES (?, 'B', 'handover_a', 'TS000001', 'system', '2026-09-07T00:00:00Z')`
      ).bind(categoryId).run()
    ).rejects.toThrow();
  });

  it('allows multiple rows with a NULL internal_code (durable_goods/infrastructure never get one)', async () => {
    const categoryId = await seedCategory('durable_goods');
    await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, created_by, created_at) VALUES (?, 'A', 'handover_a', 'system', '2026-09-07T00:00:00Z')`
    ).bind(categoryId).run();
    const insert2 = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, created_by, created_at) VALUES (?, 'B', 'handover_a', 'system', '2026-09-07T00:00:00Z')`
    ).bind(categoryId).run();
    const row = await env.DB.prepare(`SELECT internal_code FROM assets WHERE id = ?`).bind(insert2.meta.last_row_id).first();
    expect(row.internal_code).toBeNull();
  });

  it('links to a real asset_source_rows row via source_row_id', async () => {
    const categoryId = await seedCategory('individual_device');
    const docInsert = await env.DB.prepare(
      `INSERT INTO asset_source_documents (title, created_by, created_at) VALUES ('Test Doc M29', 'system', '2026-09-07T00:00:00Z')`
    ).run();
    const rowInsert = await env.DB.prepare(
      `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_quantity, created_at) VALUES (?, 'A', 1, 'Điều hoà', '8', '2026-09-07T00:00:00Z')`
    ).bind(docInsert.meta.last_row_id).run();
    const insert = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, source_row_id, created_by, created_at) VALUES (?, 'Điều hoà 1', 'handover_a', ?, 'system', '2026-09-07T00:00:00Z')`
    ).bind(categoryId, rowInsert.meta.last_row_id).run();
    const row = await env.DB.prepare(`SELECT source_row_id FROM assets WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.source_row_id).toBe(rowInsert.meta.last_row_id);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/migrations.test.js`
Expected: FAIL — `no such table: assets`.

- [ ] **Step 3: Write the migration**

```sql
-- v4/migrations/0029_asset_inventory_phase3a_assets.sql

CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES asset_categories(id),
  internal_code TEXT UNIQUE,
  name TEXT NOT NULL,
  brand TEXT,
  serial_number TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('handover_a', 'purchased_b', 'other')),
  source_row_id INTEGER REFERENCES asset_source_rows(id),
  acquired_date TEXT,
  purchase_price INTEGER,
  location_id INTEGER REFERENCES asset_locations(id),
  holder TEXT,
  quantity INTEGER,
  physical_condition TEXT NOT NULL DEFAULT 'chua_danh_gia' CHECK (physical_condition IN ('tot', 'kha', 'trung_binh', 'can_sua', 'chua_danh_gia')),
  operational_status TEXT NOT NULL DEFAULT 'san_sang' CHECK (operational_status IN ('san_sang', 'dang_su_dung', 'ngung_su_dung', 'dang_sua')),
  lifecycle_status TEXT NOT NULL DEFAULT 'dang_quan_ly' CHECK (lifecycle_status IN ('dang_quan_ly', 'da_hoan_tra', 'da_thanh_ly')),
  photo_key TEXT,
  photo_filename TEXT,
  photo_uploaded_at TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
CREATE INDEX idx_assets_category ON assets(category_id);
CREATE INDEX idx_assets_location ON assets(location_id);
CREATE INDEX idx_assets_source_row ON assets(source_row_id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/migrations.test.js`
Expected: PASS, 53/53 (45 existing + 8 new). If you hit the documented Windows Miniflare teardown flake (`AssertionError: Isolated storage failed`, EBUSY on a `.sqlite-wal`/`.sqlite`/`.sqlite-shm` file — not a real assertion failure), retry the command; this flake has been unusually persistent in this project recently, sometimes needing many retries or an isolated `-t "<test name>"` re-run to get a clean signal on one specific test.

- [ ] **Step 5: Commit**

```bash
cd v4
git add migrations/0029_asset_inventory_phase3a_assets.sql test/migrations.test.js
git commit -m "feat: add assets table (Layer 3 operational asset records)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — Assets CRUD (`GET`/`POST`/`PATCH`)

**Files:**
- Create: `v4/functions/api/assets/index.js`
- Create: `v4/functions/api/assets/[id].js`
- Modify: `v4/functions/api/audit-log/index.js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Test: `v4/test/assets.test.js`

**Interfaces:**
- Consumes: `requireAuth(request, env, roles)` from `../../../lib/requireAuth.js`; `assets` schema from Task 1; `asset_categories`/`asset_locations` (read-only, for FK validation).
- Produces: `GET /api/assets` → `[{id, categoryId, managementType, internalCode, name, brand, serialNumber, sourceType, sourceRowId, acquiredDate, purchasePrice, locationId, holder, quantity, physicalCondition, operationalStatus, lifecycleStatus, photoKey, photoFilename, photoUploadedAt, note, createdBy, createdAt, updatedBy, updatedAt}]`; `POST /api/assets` body `{categoryId, name, brand?, serialNumber?, sourceType, acquiredDate?, purchasePrice?, locationId?, holder?, quantity?, note?}`; `PATCH /api/assets/:id` body — any of the above except `categoryId`. Tasks 4, 5, 6 consume these exact field names and the `TS` + 6-digit `internalCode` format.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/assets.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listAssets, onRequestPost as createAsset } from '../functions/api/assets/index.js';
import { onRequestPatch as patchAsset } from '../functions/api/assets/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;
let individualCategoryId, bulkCategoryId, locationId;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM assets');
  await env.DB.exec('DELETE FROM asset_categories');
  await env.DB.exec('DELETE FROM asset_locations');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_as', 'x', 'manager', '2026-09-07T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_as', 'x', 'reception', '2026-09-07T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_as', 'x', 'admin', '2026-09-07T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_as', 'x', 'observer', '2026-09-07T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  const cat1 = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('individual_device', 'Điều hoà', 'bộ', 'admin_as', '2026-09-07T00:00:00Z')`).run();
  individualCategoryId = cat1.meta.last_row_id;
  const cat2 = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('durable_goods', 'Giường', 'cái', 'admin_as', '2026-09-07T00:00:00Z')`).run();
  bulkCategoryId = cat2.meta.last_row_id;

  const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();
  const loc = await env.DB.prepare(`INSERT INTO asset_locations (location_type, room_id, name, created_by, created_at) VALUES ('room', ?, 'Test Room', 'admin_as', '2026-09-07T00:00:00Z')`).bind(roomRow.id).run();
  locationId = loc.meta.last_row_id;
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/assets', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listAssets({ request: new Request('https://x/api/assets'), env });
    expect(response.status).toBe(401);
  });

  it('lets all 4 roles read', async () => {
    for (const token of [managerToken, receptionToken, adminToken, observerToken]) {
      const response = await listAssets({ request: authedRequest('https://x/api/assets', token, 'GET'), env });
      expect(response.status).toBe(200);
    }
  });

  it('filters by categoryId', async () => {
    await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà A', sourceType: 'handover_a' }), env });
    await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: bulkCategoryId, name: 'Giường A', sourceType: 'handover_a' }), env });
    const response = await listAssets({ request: authedRequest(`https://x/api/assets?categoryId=${individualCategoryId}`, adminToken, 'GET'), env });
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe('Điều hoà A');
  });

  it('filters by managementType via the category join', async () => {
    await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà A', sourceType: 'handover_a' }), env });
    await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: bulkCategoryId, name: 'Giường A', sourceType: 'handover_a' }), env });
    const response = await listAssets({ request: authedRequest('https://x/api/assets?managementType=durable_goods', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.map((a) => a.name)).toEqual(['Giường A']);
  });

  it('searches by name, internalCode, or serialNumber', async () => {
    const createResponse = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà Daikin', sourceType: 'handover_a', serialNumber: 'SN123' }), env });
    const { id } = await createResponse.json();
    const byName = await listAssets({ request: authedRequest('https://x/api/assets?q=daikin', adminToken, 'GET'), env });
    expect(await byName.json()).toHaveLength(1);
    const bySerial = await listAssets({ request: authedRequest('https://x/api/assets?q=SN123', adminToken, 'GET'), env });
    expect(await bySerial.json()).toHaveLength(1);
    const created = await env.DB.prepare(`SELECT internal_code FROM assets WHERE id = ?`).bind(id).first();
    const byCode = await listAssets({ request: authedRequest(`https://x/api/assets?q=${created.internal_code}`, adminToken, 'GET'), env });
    expect(await byCode.json()).toHaveLength(1);
  });
});

describe('POST /api/assets', () => {
  it('rejects reception (403)', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', receptionToken, 'POST', { categoryId: individualCategoryId, name: 'X', sourceType: 'handover_a' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', observerToken, 'POST', { categoryId: individualCategoryId, name: 'X', sourceType: 'handover_a' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a missing categoryId (400)', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { name: 'X', sourceType: 'handover_a' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a nonexistent categoryId (400)', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: 999999, name: 'X', sourceType: 'handover_a' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid sourceType (400)', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'X', sourceType: 'invalid' }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a nonexistent locationId (400)', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'X', sourceType: 'handover_a', locationId: 999999 }), env });
    expect(response.status).toBe(400);
  });

  it('creates an individual_device asset with an auto-generated internalCode and quantity forced to 1, ignoring a client-supplied quantity', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà A', sourceType: 'handover_a', quantity: 99 }), env });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const row = await env.DB.prepare(`SELECT internal_code, quantity FROM assets WHERE id = ?`).bind(id).first();
    expect(row.internal_code).toBe(`TS${String(id).padStart(6, '0')}`);
    expect(row.quantity).toBe(1);
  });

  it('creates a durable_goods asset with no internalCode, keeping the given quantity', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: bulkCategoryId, name: 'Giường A', sourceType: 'handover_a', quantity: 14 }), env });
    const { id } = await response.json();
    const row = await env.DB.prepare(`SELECT internal_code, quantity FROM assets WHERE id = ?`).bind(id).first();
    expect(row.internal_code).toBeNull();
    expect(row.quantity).toBe(14);
  });

  it('leaves quantity NULL ("Chưa xác định") for a durable_goods asset with no quantity given', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: bulkCategoryId, name: 'Giường B', sourceType: 'handover_a' }), env });
    const { id } = await response.json();
    const row = await env.DB.prepare(`SELECT quantity FROM assets WHERE id = ?`).bind(id).first();
    expect(row.quantity).toBeNull();
  });

  it('leaves locationId NULL ("Chưa phân bổ vị trí") when not given', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà C', sourceType: 'handover_a' }), env });
    const { id } = await response.json();
    const row = await env.DB.prepare(`SELECT location_id FROM assets WHERE id = ?`).bind(id).first();
    expect(row.location_id).toBeNull();
  });

  it('lets manager create too, and writes an audit_log row', async () => {
    const response = await createAsset({ request: authedRequest('https://x/api/assets', managerToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà D', sourceType: 'handover_a' }), env });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_create' AND entity_id = ?`).bind(id).first();
    expect(audit.entity_type).toBe('asset');
    expect(audit.entity_label).toBe('Điều hoà D');
    expect(audit.actor).toBe('quan_ly_as');
  });
});

describe('PATCH /api/assets/:id', () => {
  let individualAssetId, bulkAssetId;

  beforeEach(async () => {
    const r1 = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: individualCategoryId, name: 'Điều hoà E', sourceType: 'handover_a' }), env });
    individualAssetId = (await r1.json()).id;
    const r2 = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: bulkCategoryId, name: 'Giường C', sourceType: 'handover_a', quantity: 5 }), env });
    bulkAssetId = (await r2.json()).id;
  });

  it('rejects reception (403)', async () => {
    const response = await patchAsset({ request: authedRequest(`https://x/api/assets/${bulkAssetId}`, receptionToken, 'PATCH', { name: 'X' }), env, params: { id: String(bulkAssetId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await patchAsset({ request: authedRequest('https://x/api/assets/999999', adminToken, 'PATCH', { name: 'X' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an attempt to change categoryId (400)', async () => {
    const response = await patchAsset({ request: authedRequest(`https://x/api/assets/${bulkAssetId}`, adminToken, 'PATCH', { categoryId: individualCategoryId }), env, params: { id: String(bulkAssetId) } });
    expect(response.status).toBe(400);
  });

  it('updates quantity/location for a durable_goods asset', async () => {
    const response = await patchAsset({ request: authedRequest(`https://x/api/assets/${bulkAssetId}`, adminToken, 'PATCH', { quantity: 12, locationId }), env, params: { id: String(bulkAssetId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT quantity, location_id FROM assets WHERE id = ?`).bind(bulkAssetId).first();
    expect(row.quantity).toBe(12);
    expect(row.location_id).toBe(locationId);
  });

  it('keeps quantity forced to 1 for an individual_device asset even if the client tries to change it', async () => {
    const response = await patchAsset({ request: authedRequest(`https://x/api/assets/${individualAssetId}`, adminToken, 'PATCH', { quantity: 5 }), env, params: { id: String(individualAssetId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT quantity FROM assets WHERE id = ?`).bind(individualAssetId).first();
    expect(row.quantity).toBe(1);
  });

  it('rejects an invalid physicalCondition (400)', async () => {
    const response = await patchAsset({ request: authedRequest(`https://x/api/assets/${bulkAssetId}`, adminToken, 'PATCH', { physicalCondition: 'invalid' }), env, params: { id: String(bulkAssetId) } });
    expect(response.status).toBe(400);
  });

  it('writes an audit_log row with old and new name', async () => {
    await patchAsset({ request: authedRequest(`https://x/api/assets/${bulkAssetId}`, adminToken, 'PATCH', { name: 'Giường C - sửa' }), env, params: { id: String(bulkAssetId) } });
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_update' AND entity_id = ?`).bind(bulkAssetId).first();
    expect(audit.old_value).toBe('Giường C');
    expect(audit.new_value).toBe('Giường C - sửa');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/assets.test.js`
Expected: FAIL — import errors (the endpoint files don't exist yet).

- [ ] **Step 3: Create `v4/functions/api/assets/index.js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_SOURCE_TYPES = ['handover_a', 'purchased_b', 'other'];
const INDIVIDUAL_MANAGEMENT_TYPES = ['individual_device', 'device_set'];

function coerceRow(r) {
  return {
    id: r.id,
    categoryId: r.category_id,
    managementType: r.management_type,
    internalCode: r.internal_code,
    name: r.name,
    brand: r.brand,
    serialNumber: r.serial_number,
    sourceType: r.source_type,
    sourceRowId: r.source_row_id,
    acquiredDate: r.acquired_date,
    purchasePrice: r.purchase_price,
    locationId: r.location_id,
    holder: r.holder,
    quantity: r.quantity,
    physicalCondition: r.physical_condition,
    operationalStatus: r.operational_status,
    lifecycleStatus: r.lifecycle_status,
    photoKey: r.photo_key,
    photoFilename: r.photo_filename,
    photoUploadedAt: r.photo_uploaded_at,
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
  const categoryId = url.searchParams.get('categoryId');
  const locationId = url.searchParams.get('locationId');
  const sourceType = url.searchParams.get('sourceType');
  const managementType = url.searchParams.get('managementType');
  const q = url.searchParams.get('q');

  const clauses = [];
  const params = [];
  if (categoryId) { clauses.push('a.category_id = ?'); params.push(Number(categoryId)); }
  if (locationId) { clauses.push('a.location_id = ?'); params.push(Number(locationId)); }
  if (sourceType) { clauses.push('a.source_type = ?'); params.push(sourceType); }
  if (managementType) { clauses.push('c.management_type = ?'); params.push(managementType); }
  if (q) {
    clauses.push('(a.name LIKE ? COLLATE NOCASE OR a.internal_code LIKE ? COLLATE NOCASE OR a.serial_number LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await env.DB.prepare(
    `SELECT a.*, c.management_type FROM assets a JOIN asset_categories c ON c.id = a.category_id ${where} ORDER BY a.id DESC`
  ).bind(...params).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { categoryId, name, brand, serialNumber, sourceType, acquiredDate, purchasePrice, locationId, holder, quantity, note } = body || {};

  if (!Number.isInteger(categoryId)) return jsonError('Vui lòng chọn danh mục', 400);
  const category = await env.DB.prepare(`SELECT id, management_type FROM asset_categories WHERE id = ?`).bind(categoryId).first();
  if (!category) return jsonError('Không tìm thấy danh mục', 400);

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Vui lòng nhập tên tài sản', 400);
  if (!VALID_SOURCE_TYPES.includes(sourceType)) return jsonError('Nguồn hình thành không hợp lệ', 400);

  if (locationId !== undefined && locationId !== null) {
    const location = await env.DB.prepare(`SELECT id FROM asset_locations WHERE id = ?`).bind(locationId).first();
    if (!location) return jsonError('Không tìm thấy vị trí', 400);
  }

  const isIndividual = INDIVIDUAL_MANAGEMENT_TYPES.includes(category.management_type);
  const resolvedQuantity = isIndividual ? 1 : (quantity !== undefined ? quantity : null);
  if (resolvedQuantity !== null && !Number.isInteger(resolvedQuantity)) return jsonError('Số lượng phải là số nguyên', 400);

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO assets (category_id, name, brand, serial_number, source_type, acquired_date, purchase_price, location_id, holder, quantity, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(categoryId, name.trim(), brand || null, serialNumber || null, sourceType, acquiredDate || null, purchasePrice ?? null, locationId ?? null, holder || null, resolvedQuantity, note || null, auth.username, now).run();
  const newId = insert.meta.last_row_id;

  if (isIndividual) {
    const internalCode = `TS${String(newId).padStart(6, '0')}`;
    await env.DB.prepare(`UPDATE assets SET internal_code = ? WHERE id = ?`).bind(internalCode, newId).run();
  }

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('asset_create', 'asset', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, name.trim(), name.trim(), auth.username, now).run();

  return new Response(JSON.stringify({ id: newId, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Create `v4/functions/api/assets/[id].js`**

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_SOURCE_TYPES = ['handover_a', 'purchased_b', 'other'];
const VALID_PHYSICAL_CONDITIONS = ['tot', 'kha', 'trung_binh', 'can_sua', 'chua_danh_gia'];
const VALID_OPERATIONAL_STATUSES = ['san_sang', 'dang_su_dung', 'ngung_su_dung', 'dang_sua'];
const VALID_LIFECYCLE_STATUSES = ['dang_quan_ly', 'da_hoan_tra', 'da_thanh_ly'];
const INDIVIDUAL_MANAGEMENT_TYPES = ['individual_device', 'device_set'];

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(
    `SELECT a.*, c.management_type FROM assets a JOIN asset_categories c ON c.id = a.category_id WHERE a.id = ?`
  ).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy tài sản', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};
  if ('categoryId' in body) return jsonError('Không thể đổi danh mục của tài sản đã tạo', 400);

  const name = 'name' in body ? body.name : existing.name;
  const brand = 'brand' in body ? body.brand : existing.brand;
  const serialNumber = 'serialNumber' in body ? body.serialNumber : existing.serial_number;
  const sourceType = 'sourceType' in body ? body.sourceType : existing.source_type;
  const acquiredDate = 'acquiredDate' in body ? body.acquiredDate : existing.acquired_date;
  const purchasePrice = 'purchasePrice' in body ? body.purchasePrice : existing.purchase_price;
  const locationId = 'locationId' in body ? body.locationId : existing.location_id;
  const holder = 'holder' in body ? body.holder : existing.holder;
  const physicalCondition = 'physicalCondition' in body ? body.physicalCondition : existing.physical_condition;
  const operationalStatus = 'operationalStatus' in body ? body.operationalStatus : existing.operational_status;
  const lifecycleStatus = 'lifecycleStatus' in body ? body.lifecycleStatus : existing.lifecycle_status;
  const note = 'note' in body ? body.note : existing.note;

  const isIndividual = INDIVIDUAL_MANAGEMENT_TYPES.includes(existing.management_type);
  const quantity = isIndividual ? 1 : ('quantity' in body ? body.quantity : existing.quantity);

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Vui lòng nhập tên tài sản', 400);
  if (!VALID_SOURCE_TYPES.includes(sourceType)) return jsonError('Nguồn hình thành không hợp lệ', 400);
  if (!VALID_PHYSICAL_CONDITIONS.includes(physicalCondition)) return jsonError('Tình trạng vật lý không hợp lệ', 400);
  if (!VALID_OPERATIONAL_STATUSES.includes(operationalStatus)) return jsonError('Trạng thái hoạt động không hợp lệ', 400);
  if (!VALID_LIFECYCLE_STATUSES.includes(lifecycleStatus)) return jsonError('Trạng thái vòng đời không hợp lệ', 400);
  if (quantity !== null && quantity !== undefined && !Number.isInteger(quantity)) return jsonError('Số lượng phải là số nguyên', 400);

  if (locationId !== null && locationId !== undefined) {
    const location = await env.DB.prepare(`SELECT id FROM asset_locations WHERE id = ?`).bind(locationId).first();
    if (!location) return jsonError('Không tìm thấy vị trí', 400);
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE assets SET name = ?, brand = ?, serial_number = ?, source_type = ?, acquired_date = ?, purchase_price = ?, location_id = ?, holder = ?, quantity = ?, physical_condition = ?, operational_status = ?, lifecycle_status = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?`
    ).bind(name.trim(), brand || null, serialNumber || null, sourceType, acquiredDate || null, purchasePrice ?? null, locationId ?? null, holder || null, quantity ?? null, physicalCondition, operationalStatus, lifecycleStatus, note || null, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('asset_update', 'asset', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, name.trim(), existing.name, name.trim(), auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Register `asset_create`/`asset_update` in the 3-registry audit-log pattern**

In `v4/functions/api/audit-log/index.js`, find:
```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void', 'gio_xanh_session_void', 'record_hide', 'asset_category_create', 'asset_category_update', 'asset_location_create', 'asset_location_update'];
```
Replace with:
```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void', 'gio_xanh_session_void', 'record_hide', 'asset_category_create', 'asset_category_update', 'asset_location_create', 'asset_location_update', 'asset_create', 'asset_update'];
```

In `v4/admin/audit-log.js`, find:
```js
  asset_location_update: 'Sửa vị trí tài sản',
};
```
Replace with:
```js
  asset_location_update: 'Sửa vị trí tài sản',
  asset_create: 'Tạo tài sản',
  asset_update: 'Sửa tài sản',
};
```

In `v4/admin/audit-log.html`, find:
```html
        <option value="asset_location_update">Sửa vị trí tài sản</option>
```
Replace with:
```html
        <option value="asset_location_update">Sửa vị trí tài sản</option>
        <option value="asset_create">Tạo tài sản</option>
        <option value="asset_update">Sửa tài sản</option>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/assets.test.js`
Expected: PASS, 23/23. Retry on the documented Windows Miniflare teardown flake.

- [ ] **Step 7: Commit**

```bash
cd v4
git add functions/api/assets/index.js "functions/api/assets/[id].js" functions/api/audit-log/index.js admin/audit-log.js admin/audit-log.html test/assets.test.js
git commit -m "feat: add assets CRUD endpoints (GET/POST/PATCH)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend — Asset photo attachment (`POST`/`GET`/`DELETE`)

**Files:**
- Create: `v4/functions/api/assets/[id]/photo.js`
- Test: `v4/test/assetPhotos.test.js`

**Interfaces:**
- Consumes: `assets` schema from Task 1 (`photo_key`, `photo_filename`, `photo_uploaded_at` columns); R2 bucket binding `env.RECEIPTS` (already declared in `wrangler.toml`, reused as-is — no new binding).
- Produces: `POST /api/assets/:id/photo` (multipart form, field `file`) → `{ok, photoFilename}`; `GET /api/assets/:id/photo` → streams the file; `DELETE /api/assets/:id/photo` → `{ok}`. R2 key format `asset-photos/<assetId>/<timestamp>-<sanitizedFilename>`.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/assetPhotos.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as uploadPhoto, onRequestDelete as deletePhoto, onRequestGet as getPhoto } from '../functions/api/assets/[id]/photo.js';
import { onRequestPost as createAsset } from '../functions/api/assets/index.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken;
let assetId;

function imageFile(name = 'anh.jpg', bytes = new Uint8Array([1, 2, 3, 4])) {
  return new File([bytes], name, { type: 'image/jpeg' });
}

function authedFormRequest(url, token, file) {
  const form = new FormData();
  if (file) form.append('file', file);
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method: 'POST', headers, body: form });
}

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function authedPlainRequest(url, token, method) {
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers });
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM assets');
  await env.DB.exec('DELETE FROM asset_categories');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_ph', 'x', 'manager', '2026-09-07T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_ph', 'x', 'reception', '2026-09-07T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_ph', 'x', 'admin', '2026-09-07T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);

  const cat = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('individual_device', 'Điều hoà', 'bộ', 'admin_ph', '2026-09-07T00:00:00Z')`).run();
  const createResponse = await createAsset({ request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: cat.meta.last_row_id, name: 'Điều hoà test', sourceType: 'handover_a' }), env });
  assetId = (await createResponse.json()).id;
});

describe('POST /api/assets/:id/photo', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, null, imageFile()), env, params: { id: String(assetId) } });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, receptionToken, imageFile()), env, params: { id: String(assetId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent asset', async () => {
    const response = await uploadPhoto({ request: authedFormRequest('https://x/api/assets/999999/photo', adminToken, imageFile()), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('400s when no file is included', async () => {
    const response = await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, null), env, params: { id: String(assetId) } });
    expect(response.status).toBe(400);
  });

  it('400s for a disallowed content type', async () => {
    const badFile = new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' });
    const response = await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, badFile), env, params: { id: String(assetId) } });
    expect(response.status).toBe(400);
  });

  it('uploads a valid file, stores the R2 object, and updates the asset row', async () => {
    const response = await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, imageFile('may-lanh.jpg')), env, params: { id: String(assetId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT photo_key, photo_filename FROM assets WHERE id = ?`).bind(assetId).first();
    expect(row.photo_filename).toBe('may-lanh.jpg');
    expect(row.photo_key).toContain(`asset-photos/${assetId}/`);
    const object = await env.RECEIPTS.get(row.photo_key);
    expect(object).not.toBeNull();
  });

  it('replacing an existing photo deletes the old R2 object', async () => {
    await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, imageFile('anh1.jpg')), env, params: { id: String(assetId) } });
    const firstRow = await env.DB.prepare(`SELECT photo_key FROM assets WHERE id = ?`).bind(assetId).first();
    const oldKey = firstRow.photo_key;

    await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, imageFile('anh2.jpg')), env, params: { id: String(assetId) } });
    const oldObject = await env.RECEIPTS.get(oldKey);
    expect(oldObject).toBeNull();
  });
});

describe('DELETE /api/assets/:id/photo', () => {
  it('rejects reception (403)', async () => {
    const response = await deletePhoto({ request: authedPlainRequest(`https://x/api/assets/${assetId}/photo`, receptionToken, 'DELETE'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(403);
  });

  it('400s when the asset has no photo to remove', async () => {
    const response = await deletePhoto({ request: authedPlainRequest(`https://x/api/assets/${assetId}/photo`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(400);
  });

  it('removes the R2 object and clears all three photo columns', async () => {
    await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, imageFile()), env, params: { id: String(assetId) } });
    const response = await deletePhoto({ request: authedPlainRequest(`https://x/api/assets/${assetId}/photo`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT photo_key, photo_filename, photo_uploaded_at FROM assets WHERE id = ?`).bind(assetId).first();
    expect(row.photo_key).toBeNull();
    expect(row.photo_filename).toBeNull();
    expect(row.photo_uploaded_at).toBeNull();
  });
});

describe('GET /api/assets/:id/photo', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getPhoto({ request: authedPlainRequest(`https://x/api/assets/${assetId}/photo`, null, 'GET'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(401);
  });

  it('404s when the asset has no photo', async () => {
    const response = await getPhoto({ request: authedPlainRequest(`https://x/api/assets/${assetId}/photo`, adminToken, 'GET'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(404);
  });

  it('streams the file back for all 4 roles, including observer', async () => {
    await uploadPhoto({ request: authedFormRequest(`https://x/api/assets/${assetId}/photo`, adminToken, imageFile('bill.jpg')), env, params: { id: String(assetId) } });
    const observerAccount = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_ph', 'x', 'observer', '2026-09-07T00:00:00Z')`).run();
    const observerToken = await createSession(env.DB, observerAccount.meta.last_row_id);
    const response = await getPhoto({ request: authedPlainRequest(`https://x/api/assets/${assetId}/photo`, observerToken, 'GET'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Content-Disposition')).toContain('bill.jpg');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/assetPhotos.test.js`
Expected: FAIL — import errors.

- [ ] **Step 3: Create `v4/functions/api/assets/[id]/photo.js`**

```js
// v4/functions/api/assets/[id]/photo.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

function photoKeyFor(assetId, filename) {
  return `asset-photos/${assetId}/${Date.now()}-${sanitizeFilename(filename)}`;
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM assets WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy tài sản', 404);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return jsonError('Vui lòng chọn tệp để tải lên', 400);
  if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
    return jsonError('Chỉ chấp nhận ảnh (JPG/PNG/WebP) hoặc PDF', 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return jsonError('Tệp vượt quá dung lượng tối đa 10MB', 400);
  }

  if (existing.photo_key) {
    await env.RECEIPTS.delete(existing.photo_key);
  }

  const key = photoKeyFor(params.id, file.name);
  await env.RECEIPTS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE assets SET photo_key = ?, photo_filename = ?, photo_uploaded_at = ? WHERE id = ?`
  ).bind(key, file.name, now, params.id).run();

  return new Response(JSON.stringify({ ok: true, photoFilename: file.name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM assets WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy tài sản', 404);
  if (!existing.photo_key) return jsonError('Tài sản này chưa có ảnh đính kèm', 400);

  await env.RECEIPTS.delete(existing.photo_key);

  await env.DB.prepare(
    `UPDATE assets SET photo_key = NULL, photo_filename = NULL, photo_uploaded_at = NULL WHERE id = ?`
  ).bind(params.id).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM assets WHERE id = ?`).bind(params.id).first();
  if (!existing || !existing.photo_key) return jsonError('Không tìm thấy ảnh', 404);

  const object = await env.RECEIPTS.get(existing.photo_key);
  if (!object) return jsonError('Không tìm thấy ảnh', 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  const displayName = existing.photo_filename || 'anh-tai-san';
  headers.set('Content-Disposition', `inline; filename="${sanitizeFilename(displayName)}"; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { status: 200, headers });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/assetPhotos.test.js`
Expected: PASS, 12/12. Retry on the documented Windows Miniflare teardown flake (this file exercises R2, which has been the most flake-prone binding in this project — expect to need several retries, and use `-t "<test name>"` to isolate a specific test's real pass/fail if the full-file run keeps crashing on teardown).

- [ ] **Step 5: Commit**

```bash
cd v4
git add "functions/api/assets/[id]/photo.js" test/assetPhotos.test.js
git commit -m "feat: add asset photo attachment endpoints (POST/GET/DELETE)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend — Reconciliation (`reconciledCount` field + `reconcile` endpoint)

**Files:**
- Modify: `v4/functions/api/asset-source-rows/index.js`
- Create: `v4/functions/api/asset-source-rows/[id]/reconcile.js`
- Test: `v4/test/assetReconcile.test.js`

**Interfaces:**
- Consumes: `assets`/`asset_categories`/`asset_source_rows` schemas.
- Produces: `GET /api/asset-source-rows?documentId=X` response rows gain a `reconciledCount` field (integer, `SUM(quantity)` over `assets.source_row_id = row.id`, `NULL`-safe, defaults `0`). `POST /api/asset-source-rows/:id/reconcile` → `{ok, createdIds: [number, ...]}`. Task 6 (client) consumes both.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/assetReconcile.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listSourceRows } from '../functions/api/asset-source-rows/index.js';
import { onRequestPost as reconcileRow } from '../functions/api/asset-source-rows/[id]/reconcile.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;
let individualCategoryId, bulkCategoryId;
let knownRowId, unknownRowId, documentId;

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM assets');
  await env.DB.exec('DELETE FROM asset_categories');
  await env.DB.exec('DELETE FROM asset_source_rows');
  await env.DB.exec('DELETE FROM asset_source_documents');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_rc', 'x', 'manager', '2026-09-07T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_rc', 'x', 'reception', '2026-09-07T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_rc', 'x', 'admin', '2026-09-07T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_rc', 'x', 'observer', '2026-09-07T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  const cat1 = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('individual_device', 'Điều hoà', 'bộ', 'admin_rc', '2026-09-07T00:00:00Z')`).run();
  individualCategoryId = cat1.meta.last_row_id;
  const cat2 = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('durable_goods', 'Giường', 'cái', 'admin_rc', '2026-09-07T00:00:00Z')`).run();
  bulkCategoryId = cat2.meta.last_row_id;

  const doc = await env.DB.prepare(`INSERT INTO asset_source_documents (title, created_by, created_at) VALUES ('Test Doc', 'admin_rc', '2026-09-07T00:00:00Z')`).run();
  documentId = doc.meta.last_row_id;
  const knownRow = await env.DB.prepare(
    `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, raw_quantity, created_at) VALUES (?, 'B', 1, 'Điều hoà', '3', '2026-09-07T00:00:00Z')`
  ).bind(documentId).run();
  knownRowId = knownRow.meta.last_row_id;
  const unknownRow = await env.DB.prepare(
    `INSERT INTO asset_source_rows (source_document_id, source_group_label, stt, raw_name, created_at) VALUES (?, 'C', 2, 'Máy bơm', '2026-09-07T00:00:00Z')`
  ).bind(documentId).run();
  unknownRowId = unknownRow.meta.last_row_id;
});

describe('GET /api/asset-source-rows — reconciledCount', () => {
  it('defaults reconciledCount to 0 when no assets reference the row', async () => {
    const response = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, adminToken, 'GET'), env });
    const body = await response.json();
    const row = body.find((r) => r.id === knownRowId);
    expect(row.reconciledCount).toBe(0);
  });

  it('sums quantity (not row count) across individual assets created from the row', async () => {
    await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 3 }), env, params: { id: String(knownRowId) } });
    const response = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((r) => r.id === knownRowId).reconciledCount).toBe(3);
  });

  it('sums quantity across a bulk asset created from the row', async () => {
    await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${unknownRowId}/reconcile`, adminToken, 'POST', { categoryId: bulkCategoryId, quantity: 14 }), env, params: { id: String(unknownRowId) } });
    const response = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((r) => r.id === unknownRowId).reconciledCount).toBe(14);
  });
});

describe('POST /api/asset-source-rows/:id/reconcile', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await reconcileRow({ request: new Request(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, { method: 'POST' }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(401);
  });

  it('rejects reception (403)', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, receptionToken, 'POST', { categoryId: individualCategoryId }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(403);
  });

  it('rejects observer (403)', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, observerToken, 'POST', { categoryId: individualCategoryId }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent source row', async () => {
    const response = await reconcileRow({ request: authedRequest('https://x/api/asset-source-rows/999999/reconcile', adminToken, 'POST', { categoryId: individualCategoryId }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('400s for a missing categoryId', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', {}), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(400);
  });

  it('400s for a nonexistent categoryId', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: 999999 }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(400);
  });

  it('creates `count` individual assets, each with its own internalCode, quantity=1, sourceType=handover_a and sourceRowId set; defaults count to 1', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(201);
    const { createdIds } = await response.json();
    expect(createdIds).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT internal_code, quantity, source_type, source_row_id FROM assets WHERE id = ?`).bind(createdIds[0]).first();
    expect(row.internal_code).toBe(`TS${String(createdIds[0]).padStart(6, '0')}`);
    expect(row.quantity).toBe(1);
    expect(row.source_type).toBe('handover_a');
    expect(row.source_row_id).toBe(knownRowId);
  });

  it('creates exactly 1 bulk asset with the given quantity when categoryId is durable_goods', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${unknownRowId}/reconcile`, adminToken, 'POST', { categoryId: bulkCategoryId, quantity: 5 }), env, params: { id: String(unknownRowId) } });
    expect(response.status).toBe(201);
    const { createdIds } = await response.json();
    expect(createdIds).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT internal_code, quantity FROM assets WHERE id = ?`).bind(createdIds[0]).first();
    expect(row.internal_code).toBeNull();
    expect(row.quantity).toBe(5);
  });

  it('leaves quantity NULL for a bulk asset when quantity is omitted', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${unknownRowId}/reconcile`, adminToken, 'POST', { categoryId: bulkCategoryId }), env, params: { id: String(unknownRowId) } });
    const { createdIds } = await response.json();
    const row = await env.DB.prepare(`SELECT quantity FROM assets WHERE id = ?`).bind(createdIds[0]).first();
    expect(row.quantity).toBeNull();
  });

  it('blocks reconciling past a known raw_quantity (individual case)', async () => {
    await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 3 }), env, params: { id: String(knownRowId) } });
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 1 }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(400);
  });

  it('blocks reconciling past a known raw_quantity (bulk case)', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: bulkCategoryId, quantity: 4 }), env, params: { id: String(knownRowId) } });
    expect(response.status).toBe(400);
  });

  it('does not block reconciling when raw_quantity is NULL ("Chưa xác định")', async () => {
    const first = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${unknownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 50 }), env, params: { id: String(unknownRowId) } });
    expect(first.status).toBe(201);
    const second = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${unknownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 50 }), env, params: { id: String(unknownRowId) } });
    expect(second.status).toBe(201);
  });

  it('writes an asset_create audit_log row for each created asset', async () => {
    const response = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 2 }), env, params: { id: String(knownRowId) } });
    const { createdIds } = await response.json();
    for (const id of createdIds) {
      const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_create' AND entity_id = ?`).bind(id).first();
      expect(audit).not.toBeNull();
    }
  });

  it('never modifies the source row itself', async () => {
    const before = await env.DB.prepare(`SELECT * FROM asset_source_rows WHERE id = ?`).bind(knownRowId).first();
    await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 2 }), env, params: { id: String(knownRowId) } });
    const after = await env.DB.prepare(`SELECT * FROM asset_source_rows WHERE id = ?`).bind(knownRowId).first();
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/assetReconcile.test.js`
Expected: FAIL — `reconciledCount` undefined / import error for the new reconcile module.

- [ ] **Step 3: Modify `v4/functions/api/asset-source-rows/index.js`**

Find the whole file's current content:
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

Replace the entire file with:
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
    reconciledCount: r.reconciled_count,
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
    `SELECT r.*, (SELECT COALESCE(SUM(quantity), 0) FROM assets WHERE assets.source_row_id = r.id) AS reconciled_count
     FROM asset_source_rows r WHERE r.source_document_id = ? ORDER BY r.stt`
  ).bind(documentId).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Create `v4/functions/api/asset-source-rows/[id]/reconcile.js`**

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const INDIVIDUAL_MANAGEMENT_TYPES = ['individual_device', 'device_set'];

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  const sourceRow = await env.DB.prepare(`SELECT * FROM asset_source_rows WHERE id = ?`).bind(params.id).first();
  if (!sourceRow) return jsonError('Không tìm thấy dòng nguồn', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};
  const { categoryId, locationId } = body;

  if (!Number.isInteger(categoryId)) return jsonError('Vui lòng chọn danh mục', 400);
  const category = await env.DB.prepare(`SELECT id, management_type FROM asset_categories WHERE id = ?`).bind(categoryId).first();
  if (!category) return jsonError('Không tìm thấy danh mục', 400);

  if (locationId !== undefined && locationId !== null) {
    const location = await env.DB.prepare(`SELECT id FROM asset_locations WHERE id = ?`).bind(locationId).first();
    if (!location) return jsonError('Không tìm thấy vị trí', 400);
  }

  const isIndividual = INDIVIDUAL_MANAGEMENT_TYPES.includes(category.management_type);
  const { reconciled_count: reconciledCount } = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS reconciled_count FROM assets WHERE source_row_id = ?`
  ).bind(params.id).first();

  const knownQuantity = sourceRow.raw_quantity !== null ? Number(sourceRow.raw_quantity) : null;
  const isKnownPositiveInteger = knownQuantity !== null && Number.isInteger(knownQuantity) && knownQuantity > 0;

  const now = new Date().toISOString();
  const createdIds = [];

  if (isIndividual) {
    const count = body.count !== undefined ? body.count : 1;
    if (!Number.isInteger(count) || count <= 0) return jsonError('Số lượng tạo phải là số nguyên dương', 400);
    if (isKnownPositiveInteger && reconciledCount + count > knownQuantity) {
      return jsonError(`Dòng nguồn này chỉ có ${knownQuantity} theo hồ sơ bàn giao, đã đối chiếu ${reconciledCount} — không thể tạo thêm ${count}`, 400);
    }
    for (let i = 0; i < count; i++) {
      const insert = await env.DB.prepare(
        `INSERT INTO assets (category_id, name, source_type, source_row_id, location_id, quantity, created_by, created_at)
         VALUES (?, ?, 'handover_a', ?, ?, 1, ?, ?)`
      ).bind(categoryId, sourceRow.raw_name, params.id, locationId ?? null, auth.username, now).run();
      const newId = insert.meta.last_row_id;
      const internalCode = `TS${String(newId).padStart(6, '0')}`;
      await env.DB.prepare(`UPDATE assets SET internal_code = ? WHERE id = ?`).bind(internalCode, newId).run();
      await env.DB.prepare(
        `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
         VALUES ('asset_create', 'asset', ?, ?, NULL, ?, ?, ?)`
      ).bind(newId, sourceRow.raw_name, sourceRow.raw_name, auth.username, now).run();
      createdIds.push(newId);
    }
  } else {
    const quantity = body.quantity !== undefined ? body.quantity : null;
    if (quantity !== null && !Number.isInteger(quantity)) return jsonError('Số lượng phải là số nguyên', 400);
    if (isKnownPositiveInteger && quantity !== null && reconciledCount + quantity > knownQuantity) {
      return jsonError(`Dòng nguồn này chỉ có ${knownQuantity} theo hồ sơ bàn giao, đã đối chiếu ${reconciledCount} — không thể tạo thêm ${quantity}`, 400);
    }
    const insert = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, source_row_id, location_id, quantity, created_by, created_at)
       VALUES (?, ?, 'handover_a', ?, ?, ?, ?, ?)`
    ).bind(categoryId, sourceRow.raw_name, params.id, locationId ?? null, quantity, auth.username, now).run();
    const newId = insert.meta.last_row_id;
    await env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('asset_create', 'asset', ?, ?, NULL, ?, ?, ?)`
    ).bind(newId, sourceRow.raw_name, sourceRow.raw_name, auth.username, now).run();
    createdIds.push(newId);
  }

  return new Response(JSON.stringify({ ok: true, createdIds }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/assetReconcile.test.js`
Expected: PASS, 17/17. Retry on the documented Windows Miniflare teardown flake.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/asset-source-rows/index.js "functions/api/asset-source-rows/[id]/reconcile.js" test/assetReconcile.test.js
git commit -m "feat: add reconciledCount to asset-source-rows and a reconcile endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — "Danh mục tài sản" (`admin/assets.html`/`.js`) + vendor QR library

**Files:**
- Create: `v4/admin/lib/qrcode.min.js` (vendored, not authored)
- Create: `v4/admin/assets.html`
- Create: `v4/admin/assets.js`

**Interfaces:**
- Consumes: `GET/POST /api/assets`, `PATCH /api/assets/:id`, `POST/GET/DELETE /api/assets/:id/photo` (Tasks 2-3); `GET /api/asset-categories`, `GET /api/asset-locations` (existing, Phase 2); global `QRCode` constructor from the vendored library.

- [ ] **Step 1: Vendor the QR library**

From `v4/`, run:
```bash
mkdir -p admin/lib
curl -sL https://raw.githubusercontent.com/davidshimjs/qrcodejs/master/qrcode.min.js -o admin/lib/qrcode.min.js
```

Verify the fetch actually succeeded and produced a real, self-contained QR encoder before using it anywhere:
```bash
wc -c admin/lib/qrcode.min.js
grep -c "QRCode" admin/lib/qrcode.min.js
```
Expected: file size in the 10-20KB range (not a 0-byte or tiny error-page file), and at least one match for `QRCode` (the constructor the library exposes on `window`). If the fetch fails (network error, 404, HTML error page instead of JS, or the grep finds nothing) — **stop and report BLOCKED** rather than writing a substitute file yourself; do not hand-author a QR encoding algorithm from memory, since a subtly wrong implementation would produce QR codes that don't scan correctly and that's very hard to catch by reading the code.

This file is vendored (copied once, then committed like any other static asset) — the shipped page never fetches it from GitHub or any other external host at runtime; `admin/assets.html` loads it from this project's own `/admin/lib/qrcode.min.js` path, same as every other admin script.

- [ ] **Step 2: Create `v4/admin/assets.html`**

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
  <title>Danh mục tài sản — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Danh mục tài sản</h1>
    <p id="pageError" class="error"></p>
    <button type="button" id="openAddAssetBtn" class="hidden">+ Thêm tài sản</button>

    <div class="filters" id="assetFilters">
      <select id="filterCategory"><option value="">Tất cả danh mục</option></select>
      <select id="filterLocation"><option value="">Tất cả vị trí</option></select>
      <select id="filterSourceType">
        <option value="">Tất cả nguồn</option>
        <option value="handover_a">Bàn giao (Bên A)</option>
        <option value="purchased_b">Bên B mua mới</option>
        <option value="other">Khác</option>
      </select>
      <input type="text" id="filterSearch" placeholder="Tìm theo tên, mã, serial..." />
    </div>

    <div id="assetList" class="booking-list"></div>
  </div>

  <div id="assetFormOverlay" class="confirm-overlay form-overlay hidden">
    <div class="confirm-box wide">
      <h3 id="assetFormTitle">Thêm tài sản</h3>
      <form id="assetForm">
        <label>Danh mục
          <select name="categoryId" required></select>
        </label>
        <label>Tên tài sản <input type="text" name="name" required /></label>
        <label>Hãng/model <input type="text" name="brand" /></label>
        <label>Số serial <input type="text" name="serialNumber" /></label>
        <label>Nguồn hình thành
          <select name="sourceType" required>
            <option value="handover_a">Bàn giao (Bên A)</option>
            <option value="purchased_b">Bên B mua mới</option>
            <option value="other">Khác</option>
          </select>
        </label>
        <label>Ngày tiếp nhận/mua <input type="date" name="acquiredDate" /></label>
        <label>Giá mua (đ) <input type="number" name="purchasePrice" min="0" step="1000" /></label>
        <label>Vị trí
          <select name="locationId"><option value="">Chưa phân bổ vị trí</option></select>
        </label>
        <label>Người phụ trách <input type="text" name="holder" /></label>
        <label id="assetQuantityWrap">Số lượng <input type="number" name="quantity" min="0" step="1" /></label>
        <label>Tình trạng vật lý
          <select name="physicalCondition">
            <option value="chua_danh_gia">Chưa đánh giá</option>
            <option value="tot">Tốt</option>
            <option value="kha">Khá</option>
            <option value="trung_binh">Trung bình</option>
            <option value="can_sua">Cần sửa</option>
          </select>
        </label>
        <label>Trạng thái hoạt động
          <select name="operationalStatus">
            <option value="san_sang">Sẵn sàng</option>
            <option value="dang_su_dung">Đang sử dụng</option>
            <option value="ngung_su_dung">Ngừng sử dụng</option>
            <option value="dang_sua">Đang sửa</option>
          </select>
        </label>
        <label>Vòng đời
          <select name="lifecycleStatus">
            <option value="dang_quan_ly">Đang quản lý</option>
            <option value="da_hoan_tra">Đã hoàn trả</option>
            <option value="da_thanh_ly">Đã thanh lý</option>
          </select>
        </label>
        <label>Ghi chú <input type="text" name="note" /></label>

        <div id="assetQrSection" class="hidden">
          <p>Mã nội bộ: <strong id="assetInternalCode"></strong></p>
          <div id="assetQrCode"></div>
          <button type="button" id="downloadQrBtn" class="btn-secondary">Tải mã QR</button>
        </div>

        <div id="assetPhotoSection" class="hidden">
          <p id="assetPhotoInfo"></p>
          <input type="file" id="assetPhotoInput" accept="image/jpeg,image/png,image/webp,application/pdf" />
          <button type="button" id="uploadPhotoBtn" class="btn-secondary">Tải ảnh lên</button>
          <button type="button" id="deletePhotoBtn" class="btn-secondary hidden">Xoá ảnh</button>
        </div>

        <button type="submit">Lưu</button>
        <button type="button" id="assetFormCloseBtn" class="btn-secondary">Đóng</button>
        <p id="assetFormError" class="error"></p>
      </form>
    </div>
  </div>

  <script src="/admin/lib/qrcode.min.js"></script>
  <script src="/admin/assets.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create `v4/admin/assets.js`**

```js
// v4/admin/assets.js
let currentRole = null;
let categories = [];
let locations = [];
let editingAssetId = null;
let editingManagementType = null;

const PHYSICAL_CONDITION_LABELS = { chua_danh_gia: 'Chưa đánh giá', tot: 'Tốt', kha: 'Khá', trung_binh: 'Trung bình', can_sua: 'Cần sửa' };
const OPERATIONAL_STATUS_LABELS = { san_sang: 'Sẵn sàng', dang_su_dung: 'Đang sử dụng', ngung_su_dung: 'Ngừng sử dụng', dang_sua: 'Đang sửa' };
const SOURCE_TYPE_LABELS = { handover_a: 'Bàn giao (Bên A)', purchased_b: 'Bên B mua mới', other: 'Khác' };
const INDIVIDUAL_MANAGEMENT_TYPES = ['individual_device', 'device_set'];

function showPageError(message) {
  document.getElementById('pageError').textContent = message || '';
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

  if (currentRole === 'admin' || currentRole === 'manager') {
    document.getElementById('openAddAssetBtn').classList.remove('hidden');
  }

  await loadCategories();
  await loadLocations();
  await loadAssets();

  document.getElementById('filterCategory').addEventListener('change', loadAssets);
  document.getElementById('filterLocation').addEventListener('change', loadAssets);
  document.getElementById('filterSourceType').addEventListener('change', loadAssets);
  document.getElementById('filterSearch').addEventListener('input', loadAssets);
})();

async function loadCategories() {
  let response;
  try {
    response = await fetch('/api/asset-categories');
  } catch (err) {
    return;
  }
  if (!response.ok) return;
  categories = await response.json();

  const filterSelect = document.getElementById('filterCategory');
  const formSelect = document.querySelector('#assetForm select[name="categoryId"]');
  [filterSelect].forEach((select) => {
    while (select.options.length > 1) select.remove(1);
  });
  formSelect.innerHTML = '';
  categories.forEach((c) => {
    const filterOpt = document.createElement('option');
    filterOpt.value = c.id;
    filterOpt.textContent = `${c.name} (${c.managementType})`;
    filterSelect.appendChild(filterOpt);

    const formOpt = document.createElement('option');
    formOpt.value = c.id;
    formOpt.textContent = c.name;
    formOpt.dataset.managementType = c.managementType;
    formSelect.appendChild(formOpt);
  });
}

async function loadLocations() {
  let response;
  try {
    response = await fetch('/api/asset-locations');
  } catch (err) {
    return;
  }
  if (!response.ok) return;
  locations = await response.json();

  const filterSelect = document.getElementById('filterLocation');
  const formSelect = document.querySelector('#assetForm select[name="locationId"]');
  while (filterSelect.options.length > 1) filterSelect.remove(1);
  while (formSelect.options.length > 1) formSelect.remove(1);
  locations.forEach((l) => {
    const filterOpt = document.createElement('option');
    filterOpt.value = l.id;
    filterOpt.textContent = l.name;
    filterSelect.appendChild(filterOpt);

    const formOpt = document.createElement('option');
    formOpt.value = l.id;
    formOpt.textContent = l.name;
    formSelect.appendChild(formOpt);
  });
}

function categoryById(id) {
  return categories.find((c) => c.id === Number(id));
}

async function loadAssets() {
  showPageError('');
  const params = new URLSearchParams();
  const categoryId = document.getElementById('filterCategory').value;
  const locationId = document.getElementById('filterLocation').value;
  const sourceType = document.getElementById('filterSourceType').value;
  const q = document.getElementById('filterSearch').value.trim();
  if (categoryId) params.set('categoryId', categoryId);
  if (locationId) params.set('locationId', locationId);
  if (sourceType) params.set('sourceType', sourceType);
  if (q) params.set('q', q);

  let response;
  try {
    response = await fetch(`/api/assets?${params.toString()}`);
  } catch (err) {
    showPageError('Có lỗi khi tải danh sách tài sản');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showPageError(body.error || 'Có lỗi khi tải danh sách tài sản');
    return;
  }
  const assets = await response.json();
  renderAssetList(assets);
}

function locationName(locationId) {
  const loc = locations.find((l) => l.id === locationId);
  return loc ? loc.name : 'Chưa phân bổ vị trí';
}

function renderAssetList(assets) {
  const container = document.getElementById('assetList');
  container.innerHTML = '';
  if (assets.length === 0) {
    const p = document.createElement('p');
    p.className = 'booking-empty';
    p.textContent = 'Chưa có tài sản nào phù hợp bộ lọc.';
    container.appendChild(p);
    return;
  }
  assets.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'booking-card';
    const line1 = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = a.name;
    line1.appendChild(strong);
    line1.append(a.internalCode ? ` — ${a.internalCode}` : '');
    card.appendChild(line1);

    const line2 = document.createElement('p');
    const category = categoryById(a.categoryId);
    line2.textContent = `${category ? category.name : a.managementType} — ${locationName(a.locationId)} — ${SOURCE_TYPE_LABELS[a.sourceType]}`;
    card.appendChild(line2);

    const line3 = document.createElement('p');
    line3.textContent = `${a.quantity !== null ? `Số lượng: ${a.quantity}` : 'Số lượng: Chưa xác định'} — ${PHYSICAL_CONDITION_LABELS[a.physicalCondition]} — ${OPERATIONAL_STATUS_LABELS[a.operationalStatus]}`;
    card.appendChild(line3);

    if (currentRole === 'admin' || currentRole === 'manager') {
      const actions = document.createElement('div');
      actions.className = 'booking-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'table-actions-btn';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditAsset(a));
      actions.appendChild(editBtn);
      card.appendChild(actions);
    }

    container.appendChild(card);
  });
}

function isIndividualManagementType(managementType) {
  return INDIVIDUAL_MANAGEMENT_TYPES.includes(managementType);
}

function toggleQuantityField(managementType) {
  document.getElementById('assetQuantityWrap').classList.toggle('hidden', isIndividualManagementType(managementType));
}

function openFormOverlay() {
  document.getElementById('assetFormOverlay').classList.remove('hidden');
}
function closeFormOverlay() {
  document.getElementById('assetFormOverlay').classList.add('hidden');
}

document.getElementById('openAddAssetBtn').addEventListener('click', () => {
  editingAssetId = null;
  editingManagementType = null;
  const form = document.getElementById('assetForm');
  form.reset();
  form.querySelector('select[name="categoryId"]').disabled = false;
  document.getElementById('assetFormTitle').textContent = 'Thêm tài sản';
  document.getElementById('assetFormError').textContent = '';
  document.getElementById('assetQrSection').classList.add('hidden');
  document.getElementById('assetPhotoSection').classList.add('hidden');
  const firstCategory = categories[0];
  toggleQuantityField(firstCategory ? firstCategory.managementType : 'durable_goods');
  openFormOverlay();
});

document.querySelector('#assetForm select[name="categoryId"]').addEventListener('change', (event) => {
  if (editingAssetId) return;
  const selected = event.target.selectedOptions[0];
  toggleQuantityField(selected ? selected.dataset.managementType : '');
});

document.getElementById('assetFormCloseBtn').addEventListener('click', closeFormOverlay);

function renderQrCode(internalCode) {
  const qrContainer = document.getElementById('assetQrCode');
  qrContainer.innerHTML = '';
  // eslint-disable-next-line no-undef
  new QRCode(qrContainer, { text: internalCode, width: 128, height: 128 });
}

document.getElementById('downloadQrBtn').addEventListener('click', () => {
  const canvas = document.querySelector('#assetQrCode canvas');
  if (!canvas) return;
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${document.getElementById('assetInternalCode').textContent}.png`;
  link.click();
});

function openEditAsset(asset) {
  editingAssetId = asset.id;
  editingManagementType = asset.managementType;
  const form = document.getElementById('assetForm');
  form.reset();
  form.querySelector('select[name="categoryId"]').value = asset.categoryId;
  form.querySelector('select[name="categoryId"]').disabled = true;
  form.querySelector('input[name="name"]').value = asset.name;
  form.querySelector('input[name="brand"]').value = asset.brand || '';
  form.querySelector('input[name="serialNumber"]').value = asset.serialNumber || '';
  form.querySelector('select[name="sourceType"]').value = asset.sourceType;
  form.querySelector('input[name="acquiredDate"]').value = asset.acquiredDate || '';
  form.querySelector('input[name="purchasePrice"]').value = asset.purchasePrice ?? '';
  form.querySelector('select[name="locationId"]').value = asset.locationId || '';
  form.querySelector('input[name="holder"]').value = asset.holder || '';
  form.querySelector('input[name="quantity"]').value = asset.quantity ?? '';
  form.querySelector('select[name="physicalCondition"]').value = asset.physicalCondition;
  form.querySelector('select[name="operationalStatus"]').value = asset.operationalStatus;
  form.querySelector('select[name="lifecycleStatus"]').value = asset.lifecycleStatus;
  form.querySelector('input[name="note"]').value = asset.note || '';

  toggleQuantityField(asset.managementType);
  document.getElementById('assetFormTitle').textContent = 'Sửa tài sản';
  document.getElementById('assetFormError').textContent = '';

  if (isIndividualManagementType(asset.managementType)) {
    document.getElementById('assetQrSection').classList.remove('hidden');
    document.getElementById('assetInternalCode').textContent = asset.internalCode || '';
    renderQrCode(asset.internalCode);
  } else {
    document.getElementById('assetQrSection').classList.add('hidden');
  }

  document.getElementById('assetPhotoSection').classList.remove('hidden');
  document.getElementById('assetPhotoInfo').textContent = asset.photoFilename ? `Ảnh hiện tại: ${asset.photoFilename}` : 'Chưa có ảnh đính kèm.';
  document.getElementById('deletePhotoBtn').classList.toggle('hidden', !asset.photoFilename);

  openFormOverlay();
}

document.getElementById('uploadPhotoBtn').addEventListener('click', async () => {
  if (!editingAssetId) return;
  const fileInput = document.getElementById('assetPhotoInput');
  if (!fileInput.files[0]) return;
  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  const errorEl = document.getElementById('assetFormError');
  let response;
  try {
    response = await fetch(`/api/assets/${editingAssetId}/photo`, { method: 'POST', body: formData });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải ảnh lên';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải ảnh lên';
    return;
  }
  const { photoFilename } = await response.json();
  document.getElementById('assetPhotoInfo').textContent = `Ảnh hiện tại: ${photoFilename}`;
  document.getElementById('deletePhotoBtn').classList.remove('hidden');
  errorEl.textContent = '';
});

document.getElementById('deletePhotoBtn').addEventListener('click', async () => {
  if (!editingAssetId) return;
  const errorEl = document.getElementById('assetFormError');
  let response;
  try {
    response = await fetch(`/api/assets/${editingAssetId}/photo`, { method: 'DELETE' });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi xoá ảnh';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi xoá ảnh';
    return;
  }
  document.getElementById('assetPhotoInfo').textContent = 'Chưa có ảnh đính kèm.';
  document.getElementById('deletePhotoBtn').classList.add('hidden');
  errorEl.textContent = '';
});

document.getElementById('assetForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('assetFormError');
  errorEl.textContent = '';

  const purchasePriceValue = form.querySelector('input[name="purchasePrice"]').value;
  const quantityValue = form.querySelector('input[name="quantity"]').value;

  const payload = {
    name: form.querySelector('input[name="name"]').value,
    brand: form.querySelector('input[name="brand"]').value,
    serialNumber: form.querySelector('input[name="serialNumber"]').value,
    sourceType: form.querySelector('select[name="sourceType"]').value,
    acquiredDate: form.querySelector('input[name="acquiredDate"]').value || null,
    purchasePrice: purchasePriceValue === '' ? null : Number(purchasePriceValue),
    locationId: form.querySelector('select[name="locationId"]').value ? Number(form.querySelector('select[name="locationId"]').value) : null,
    holder: form.querySelector('input[name="holder"]').value,
    physicalCondition: form.querySelector('select[name="physicalCondition"]').value,
    operationalStatus: form.querySelector('select[name="operationalStatus"]').value,
    lifecycleStatus: form.querySelector('select[name="lifecycleStatus"]').value,
    note: form.querySelector('input[name="note"]').value,
  };
  if (!editingAssetId || !isIndividualManagementType(editingManagementType)) {
    payload.quantity = quantityValue === '' ? null : Number(quantityValue);
  }

  let response;
  try {
    if (editingAssetId) {
      response = await fetch(`/api/assets/${editingAssetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      payload.categoryId = Number(form.querySelector('select[name="categoryId"]').value);
      response = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi lưu tài sản';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu tài sản';
    return;
  }

  closeFormOverlay();
  await loadAssets();
});
```

- [ ] **Step 4: Kiểm tra thủ công / xác nhận qua e2e**

Vì môi trường `wrangler pages dev` cục bộ trên máy này đã từng bị treo request không rõ nguyên nhân (ghi nhận ở phiên làm việc trước, không liên quan tới code) — nếu gặp lại tình trạng này, đừng lặng lẽ bỏ qua bước kiểm tra: thử dọn tiến trình `workerd` còn sót (`taskkill //F //IM workerd.exe` trên Windows) rồi khởi động lại; nếu vẫn treo, dùng cách thay thế đã dùng thành công trước đó — chạy `npx http-server v4 -p <port> -s -c-1` (server tĩnh, không cần D1 thật) rồi viết 1 script Playwright tạm mock toàn bộ `/api/*` để xác nhận trang render đúng, hoặc để việc xác nhận động lại cho Task 7 (e2e chính thức) và báo cáo rõ ràng (DONE_WITH_CONCERNS, không phải im lặng bỏ qua) nếu không tự xác nhận được bằng trình duyệt thật hôm nay.

Checklist cần xác nhận (bằng 1 trong các cách trên):
- Trang tải được, không lỗi console.
- Admin/manager thấy nút "+ Thêm tài sản"; reception/observer không thấy.
- Chọn danh mục thuộc `individual_device`/`device_set` trong form Thêm → ô Số lượng tự ẩn.
- Sửa 1 tài sản thuộc loại cá thể → thấy đúng mã nội bộ + mã QR hiển thị (canvas thực sự vẽ được, không rỗng).
- Lọc theo danh mục/vị trí/nguồn/tìm kiếm hoạt động đúng.

- [ ] **Step 5: Commit**

```bash
cd v4
git add admin/lib/qrcode.min.js admin/assets.html admin/assets.js
git commit -m "feat: add Danh mục tài sản admin page with QR display for individual devices

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Client — mở rộng "Hồ sơ nguồn" với luồng đối chiếu + đăng ký nav/redirects

**Files:**
- Modify: `v4/admin/asset-source-data.html`
- Modify: `v4/admin/asset-source-data.js`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`

**Interfaces:**
- Consumes: `reconciledCount` field + `POST /api/asset-source-rows/:id/reconcile` (Task 4); `GET /api/asset-categories`, `GET /api/asset-locations` (Phase 2).

- [ ] **Step 1: Modify `v4/admin/asset-source-data.html`**

Find:
```html
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

Replace with:
```html
    <label>Hồ sơ <select id="documentSelect"></select></label>

    <div class="table-scroll">
      <table id="sourceRowsTable">
        <thead><tr><th>STT</th><th>Tên tài sản / hạng mục</th><th>ĐVT</th><th>Số lượng</th><th>Tình trạng</th><th>Ghi chú</th><th>Đã tạo</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <div id="reconcileFormOverlay" class="confirm-overlay hidden">
    <div class="confirm-box">
      <h3>Tạo tài sản từ dòng nguồn</h3>
      <p id="reconcileRowLabel"></p>
      <form id="reconcileForm">
        <label>Danh mục
          <select name="categoryId" required></select>
        </label>
        <label>Vị trí (tuỳ chọn)
          <select name="locationId"><option value="">Chưa phân bổ vị trí</option></select>
        </label>
        <label id="reconcileCountWrap">Số lượng tạo <input type="number" name="count" min="1" step="1" value="1" /></label>
        <label id="reconcileQuantityWrap" class="hidden">Số lượng <input type="number" name="quantity" min="0" step="1" /></label>
        <button type="submit">Tạo tài sản</button>
        <button type="button" id="reconcileFormCloseBtn" class="btn-secondary">Đóng</button>
        <p id="reconcileFormError" class="error"></p>
      </form>
    </div>
  </div>

  <script src="/admin/asset-source-data.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Modify `v4/admin/asset-source-data.js`**

Find:
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
```

Replace with:
```js
// v4/admin/asset-source-data.js
let currentRole = null;
let categories = [];
let locations = [];
let reconcilingRowId = null;

const INDIVIDUAL_MANAGEMENT_TYPES = ['individual_device', 'device_set'];

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

  if (currentRole === 'admin' || currentRole === 'manager') {
    await loadCategoriesAndLocations();
  }

  await loadDocuments();
})();

async function loadCategoriesAndLocations() {
  try {
    const [categoriesResponse, locationsResponse] = await Promise.all([
      fetch('/api/asset-categories'),
      fetch('/api/asset-locations'),
    ]);
    categories = categoriesResponse.ok ? await categoriesResponse.json() : [];
    locations = locationsResponse.ok ? await locationsResponse.json() : [];
  } catch (err) {
    categories = [];
    locations = [];
  }

  const categorySelect = document.querySelector('#reconcileForm select[name="categoryId"]');
  categorySelect.innerHTML = '';
  categories.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    opt.dataset.managementType = c.managementType;
    categorySelect.appendChild(opt);
  });

  const locationSelect = document.querySelector('#reconcileForm select[name="locationId"]');
  locations.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.name;
    locationSelect.appendChild(opt);
  });
}
```

- [ ] **Step 3: Modify `renderRows()` in `v4/admin/asset-source-data.js`**

Find:
```js
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

Replace with:
```js
function renderRows(rows) {
  const tbody = document.querySelector('#sourceRowsTable tbody');
  tbody.innerHTML = '';
  let currentGroup = null;
  rows.forEach((r) => {
    if (r.sourceGroupLabel !== currentGroup) {
      currentGroup = r.sourceGroupLabel;
      const groupTr = document.createElement('tr');
      const groupTd = document.createElement('td');
      groupTd.colSpan = 8;
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

    const reconciledTd = document.createElement('td');
    const knownQuantity = r.rawQuantity !== null && r.rawQuantity !== undefined ? Number(r.rawQuantity) : null;
    const hasKnownQuantity = knownQuantity !== null && Number.isInteger(knownQuantity);
    reconciledTd.textContent = hasKnownQuantity ? `${r.reconciledCount}/${knownQuantity}` : `Đã tạo ${r.reconciledCount}`;
    tr.appendChild(reconciledTd);

    const actionTd = document.createElement('td');
    if (currentRole === 'admin' || currentRole === 'manager') {
      const reconcileBtn = document.createElement('button');
      reconcileBtn.type = 'button';
      reconcileBtn.className = 'table-actions-btn';
      reconcileBtn.textContent = 'Tạo tài sản';
      reconcileBtn.addEventListener('click', () => openReconcileForm(r));
      actionTd.appendChild(reconcileBtn);
    }
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });
}

function openReconcileForm(row) {
  reconcilingRowId = row.id;
  const form = document.getElementById('reconcileForm');
  form.reset();
  document.getElementById('reconcileRowLabel').textContent = `${row.rawName} (STT ${row.stt})`;
  document.getElementById('reconcileFormError').textContent = '';
  updateReconcileFieldVisibility();
  document.getElementById('reconcileFormOverlay').classList.remove('hidden');
}

function updateReconcileFieldVisibility() {
  const categorySelect = document.querySelector('#reconcileForm select[name="categoryId"]');
  const selected = categorySelect.selectedOptions[0];
  const isIndividual = selected && INDIVIDUAL_MANAGEMENT_TYPES.includes(selected.dataset.managementType);
  document.getElementById('reconcileCountWrap').classList.toggle('hidden', !isIndividual);
  document.getElementById('reconcileQuantityWrap').classList.toggle('hidden', isIndividual);
}

document.getElementById('reconcileFormCloseBtn').addEventListener('click', () => {
  document.getElementById('reconcileFormOverlay').classList.add('hidden');
});

document.querySelector('#reconcileForm select[name="categoryId"]').addEventListener('change', updateReconcileFieldVisibility);

document.getElementById('reconcileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('reconcileFormError');
  errorEl.textContent = '';

  const categorySelect = form.querySelector('select[name="categoryId"]');
  const selected = categorySelect.selectedOptions[0];
  const isIndividual = selected && INDIVIDUAL_MANAGEMENT_TYPES.includes(selected.dataset.managementType);

  const payload = {
    categoryId: Number(categorySelect.value),
    locationId: form.querySelector('select[name="locationId"]').value ? Number(form.querySelector('select[name="locationId"]').value) : null,
  };
  if (isIndividual) {
    payload.count = Number(form.querySelector('input[name="count"]').value || 1);
  } else {
    const quantityValue = form.querySelector('input[name="quantity"]').value;
    payload.quantity = quantityValue === '' ? null : Number(quantityValue);
  }

  let response;
  try {
    response = await fetch(`/api/asset-source-rows/${reconcilingRowId}/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tạo tài sản';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tạo tài sản';
    return;
  }

  document.getElementById('reconcileFormOverlay').classList.add('hidden');
  const documentSelect = document.getElementById('documentSelect');
  await loadSourceRows(documentSelect.value);
});
```

- [ ] **Step 4: Register `admin/assets.html` in `v4/admin/nav-drawer.js`**

Find:
```js
      { page: 'asset-config.html', label: 'Danh mục & vị trí', icon: '🗂️', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'asset-source-data.html', label: 'Hồ sơ nguồn', icon: '📄', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
```
Replace with:
```js
      { page: 'asset-config.html', label: 'Danh mục & vị trí', icon: '🗂️', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'asset-source-data.html', label: 'Hồ sơ nguồn', icon: '📄', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'assets.html', label: 'Danh mục tài sản', icon: '🏷️', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
```

Find:
```js
  const pageSlug = { 'dashboard.html': 'dashboard', 'dine-in-orders.html': 'dine-in-orders', 'gio-xanh.html': 'gio-xanh', 'finance.html': 'finance', 'finance-categories.html': 'finance-categories', 'dine-in-menu.html': 'dine-in-menu', 'customers.html': 'customers', 'templates.html': 'templates', 'manager.html': 'config', 'catalog.html': 'catalog', 'audit-log.html': 'audit-log', 'cancellation-policy.html': 'cancellation-policy', 'users.html': 'users', 'change-password.html': 'change-password', 'asset-config.html': 'asset-config', 'asset-source-data.html': 'asset-source-data' };
```
Replace with:
```js
  const pageSlug = { 'dashboard.html': 'dashboard', 'dine-in-orders.html': 'dine-in-orders', 'gio-xanh.html': 'gio-xanh', 'finance.html': 'finance', 'finance-categories.html': 'finance-categories', 'dine-in-menu.html': 'dine-in-menu', 'customers.html': 'customers', 'templates.html': 'templates', 'manager.html': 'config', 'catalog.html': 'catalog', 'audit-log.html': 'audit-log', 'cancellation-policy.html': 'cancellation-policy', 'users.html': 'users', 'change-password.html': 'change-password', 'asset-config.html': 'asset-config', 'asset-source-data.html': 'asset-source-data', 'assets.html': 'assets' };
```

- [ ] **Step 5: Add `_redirects` lines**

In `v4/_redirects`, find:
```
/manager/asset-config          /admin/asset-config     200
/manager/asset-source-data     /admin/asset-source-data 200
```
Replace with:
```
/manager/asset-config          /admin/asset-config     200
/manager/asset-source-data     /admin/asset-source-data 200
/manager/assets                /admin/assets           200
```

Find:
```
/reception/asset-config        /admin/asset-config     200
/reception/asset-source-data   /admin/asset-source-data 200
```
Replace with:
```
/reception/asset-config        /admin/asset-config     200
/reception/asset-source-data   /admin/asset-source-data 200
/reception/assets               /admin/assets           200
```

Find:
```
/observer/asset-config         /admin/asset-config     200
/observer/asset-source-data    /admin/asset-source-data 200
```
Replace with:
```
/observer/asset-config         /admin/asset-config     200
/observer/asset-source-data    /admin/asset-source-data 200
/observer/assets                /admin/assets           200
```

- [ ] **Step 6: Kiểm tra thủ công / xác nhận qua e2e**

Cùng lưu ý môi trường như Task 5 Step 4. Checklist:
- Cột "Đã tạo" hiện đúng "X/N" khi biết số lượng nguồn, "Đã tạo X" khi chưa biết.
- Admin/manager thấy nút "Tạo tài sản" trên mỗi dòng; reception/observer không thấy.
- Bấm "Tạo tài sản" trên 1 dòng thuộc danh mục cá thể → chỉ hiện ô "Số lượng tạo"; đổi sang danh mục số lượng → chỉ hiện ô "Số lượng".
- Sau khi tạo, cột "Đã tạo" cập nhật ngay không cần tải lại trang.
- Nav "Tài sản & Kho" hiện đủ 3 mục, link "Danh mục tài sản" không bị `/manager/undefined`.

- [ ] **Step 7: Commit**

```bash
cd v4
git add admin/asset-source-data.html admin/asset-source-data.js admin/nav-drawer.js _redirects
git commit -m "feat: add reconciliation UI to Hồ sơ nguồn, register Danh mục tài sản in nav

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: E2e coverage (outer repo)

**Files:**
- Create: `tests/e2e/assets.spec.js`
- Create: `tests/e2e/asset-reconcile.spec.js`

**Interfaces:**
- Consumes: every DOM id from Tasks 5-6, and the API contracts from Tasks 2-4.

- [ ] **Step 1: Create `tests/e2e/assets.spec.js`**

```js
// tests/e2e/assets.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

const SAMPLE_CATEGORIES = [
  { id: 1, managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', isActive: true },
  { id: 2, managementType: 'durable_goods', name: 'Giường', defaultUnit: 'cái', isActive: true },
];

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'room', roomId: 4, code: 'P04', name: 'Nhà tròn 1', isActive: true },
];

const SAMPLE_ASSETS = [
  { id: 1, categoryId: 1, managementType: 'individual_device', internalCode: 'TS000001', name: 'Điều hoà Daikin', brand: 'Daikin', serialNumber: null, sourceType: 'handover_a', sourceRowId: 5, acquiredDate: null, purchasePrice: null, locationId: null, holder: null, quantity: 1, physicalCondition: 'tot', operationalStatus: 'san_sang', lifecycleStatus: 'dang_quan_ly', photoKey: null, photoFilename: null, note: null },
  { id: 2, categoryId: 2, managementType: 'durable_goods', internalCode: null, name: 'Giường 1.6m', brand: null, serialNumber: null, sourceType: 'handover_a', sourceRowId: 6, acquiredDate: null, purchasePrice: null, locationId: null, holder: null, quantity: 11, physicalCondition: 'tot', operationalStatus: 'san_sang', lifecycleStatus: 'dang_quan_ly', photoKey: null, photoFilename: null, note: null },
];

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    mockAuth(page, role),
    page.route('**/api/asset-categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) })),
    page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) })),
    page.route('**/api/assets**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
  ]);
}

test.describe('Danh mục tài sản (admin/assets.html)', () => {
  test('admin sees add button and Sửa buttons; reception does not', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await expect(page.locator('#openAddAssetBtn')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sửa' }).first()).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.reload();
    await expect(page.locator('#openAddAssetBtn')).toBeHidden();
    await expect(page.locator('button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('list renders both individual and quantity-tracked assets with their info', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await expect(page.locator('#assetList')).toContainText('Điều hoà Daikin');
    await expect(page.locator('#assetList')).toContainText('TS000001');
    await expect(page.locator('#assetList')).toContainText('Giường 1.6m');
    await expect(page.locator('#assetList')).toContainText('Số lượng: 11');
  });

  test('opening the add form and picking an individual_device category hides the quantity field', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await page.click('#openAddAssetBtn');
    await page.selectOption('#assetForm select[name="categoryId"]', '1');
    await expect(page.locator('#assetQuantityWrap')).toBeHidden();
    await page.selectOption('#assetForm select[name="categoryId"]', '2');
    await expect(page.locator('#assetQuantityWrap')).toBeVisible();
  });

  test('editing an individual_device asset shows its internal code and renders a QR canvas', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await page.locator('.booking-card', { hasText: 'Điều hoà Daikin' }).locator('button', { hasText: 'Sửa' }).click();
    await expect(page.locator('#assetQrSection')).toBeVisible();
    await expect(page.locator('#assetInternalCode')).toHaveText('TS000001');
    await expect(page.locator('#assetQrCode canvas')).toBeVisible();
  });

  test('editing a durable_goods asset hides the QR section', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await page.locator('.booking-card', { hasText: 'Giường 1.6m' }).locator('button', { hasText: 'Sửa' }).click();
    await expect(page.locator('#assetQrSection')).toBeHidden();
  });

  test('adding a new asset submits the correct payload', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/assets', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
    });

    await page.goto('/admin/assets.html');
    await page.click('#openAddAssetBtn');
    await page.selectOption('#assetForm select[name="categoryId"]', '2');
    await page.fill('#assetForm input[name="name"]', 'Nệm mới');
    await page.selectOption('#assetForm select[name="sourceType"]', 'purchased_b');
    await page.fill('#assetForm input[name="quantity"]', '3');
    await page.click('#assetForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ categoryId: 2, name: 'Nệm mới', sourceType: 'purchased_b', quantity: 3 });
  });

  test('filtering by category re-fetches with the categoryId param', async ({ page }) => {
    let requestedUrl = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/assets**', (route) => {
      requestedUrl = route.request().url();
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    });

    await page.goto('/admin/assets.html');
    await page.selectOption('#filterCategory', '1');
    await expect.poll(() => requestedUrl).toContain('categoryId=1');
  });
});
```

- [ ] **Step 2: Run the file to verify it passes**

Run: `npx playwright test tests/e2e/assets.spec.js --project=v4`
Expected: PASS, 7/7.

- [ ] **Step 3: Create `tests/e2e/asset-reconcile.spec.js`**

```js
// tests/e2e/asset-reconcile.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_DOCUMENTS = [
  { id: 1, title: 'Phụ lục II — Danh mục tài sản hiện tại của Bên A', contractRef: '0107/HĐHTKD-HLG/2026' },
];

const SAMPLE_ROWS = [
  { id: 5, sourceDocumentId: 1, sourceGroupLabel: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 11, rawName: 'Điều hoà Daikin 2.5HP', rawUnit: 'bộ', rawQuantity: '1', rawCondition: 'Tốt', rawNote: 'Vip1', reconciledCount: 0 },
  { id: 6, sourceDocumentId: 1, sourceGroupLabel: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 8, rawName: 'Giường 1.6m', rawUnit: 'Cái', rawQuantity: '11', rawCondition: 'Tốt', rawNote: null, reconciledCount: 4 },
];

const SAMPLE_CATEGORIES = [
  { id: 1, managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', isActive: true },
  { id: 2, managementType: 'durable_goods', name: 'Giường', defaultUnit: 'cái', isActive: true },
];

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'room', roomId: 4, code: 'P04', name: 'Nhà tròn 1', isActive: true },
];

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) })),
    page.route('**/api/asset-source-documents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_DOCUMENTS) })),
    page.route('**/api/asset-source-rows**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROWS) })),
    page.route('**/api/asset-categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) })),
    page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) })),
  ]);
}

test.describe('Hồ sơ nguồn — luồng đối chiếu (admin/asset-source-data.html)', () => {
  test('shows "Đã tạo" as X/N when raw quantity is known, and the reconcile button for admin', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-source-data.html');
    const row = page.locator('#sourceRowsTable tbody tr', { hasText: 'Giường 1.6m' });
    await expect(row).toContainText('4/11');
    await expect(row.locator('button', { hasText: 'Tạo tài sản' })).toBeVisible();
  });

  test('reception does not see the "Tạo tài sản" button', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'reception' });
    await page.goto('/admin/asset-source-data.html');
    await expect(page.locator('button', { hasText: 'Tạo tài sản' })).toHaveCount(0);
  });

  test('the reconcile popup toggles between "Số lượng tạo" and "Số lượng" based on category type', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-source-data.html');
    const row = page.locator('#sourceRowsTable tbody tr', { hasText: 'Điều hoà Daikin' });
    await row.locator('button', { hasText: 'Tạo tài sản' }).click();

    await page.selectOption('#reconcileForm select[name="categoryId"]', '1');
    await expect(page.locator('#reconcileCountWrap')).toBeVisible();
    await expect(page.locator('#reconcileQuantityWrap')).toBeHidden();

    await page.selectOption('#reconcileForm select[name="categoryId"]', '2');
    await expect(page.locator('#reconcileCountWrap')).toBeHidden();
    await expect(page.locator('#reconcileQuantityWrap')).toBeVisible();
  });

  test('submitting the reconcile form posts the correct payload', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-source-rows/5/reconcile', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, createdIds: [10] }) });
    });

    await page.goto('/admin/asset-source-data.html');
    const row = page.locator('#sourceRowsTable tbody tr', { hasText: 'Điều hoà Daikin' });
    await row.locator('button', { hasText: 'Tạo tài sản' }).click();
    await page.selectOption('#reconcileForm select[name="categoryId"]', '1');
    await page.selectOption('#reconcileForm select[name="locationId"]', '1');
    await page.fill('#reconcileForm input[name="count"]', '1');
    await page.click('#reconcileForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ categoryId: 1, locationId: 1, count: 1 });
  });
});
```

- [ ] **Step 4: Run the file to verify it passes**

Run: `npx playwright test tests/e2e/asset-reconcile.spec.js --project=v4`
Expected: PASS, 4/4.

- [ ] **Step 5: Run the full v4 project to confirm no regressions**

Run: `npx playwright test --project=v4 --list` first to confirm the current baseline count (this project has had several plans land on it since the last known count), then `npx playwright test --project=v4`.
Expected: PASS, baseline + 11 new (7 + 4), with the same single pre-existing unrelated failure in `reception-ops-board.spec.js` if it's still present — do not attempt to fix that one (it's been observed to pass in isolation and fail only under full-suite parallel load; unrelated to this plan).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/assets.spec.js tests/e2e/asset-reconcile.spec.js
git commit -m "test: e2e coverage for asset/inventory Phase 3a (Danh mục tài sản, đối chiếu bàn giao)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0029 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), deploy qua `npx wrangler pages deploy .`.
3. Push repo ngoài (e2e test mới).
4. Smoke-test thực tế: mở "Danh mục tài sản" xác nhận trang tải được, tạo thử 1 tài sản test rồi sửa lại (không tạo dữ liệu rác thật); mở "Hồ sơ nguồn" xác nhận cột "Đã tạo" hiện đúng, thử đối chiếu 1 dòng lấy 1 tài sản test rồi kiểm tra nó xuất hiện trong "Danh mục tài sản".

