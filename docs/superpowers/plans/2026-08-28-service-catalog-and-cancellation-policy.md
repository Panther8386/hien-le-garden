# Service Catalog & Cancellation Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-managed price catalog covering Lưu Trú / F&B & Hoạt Động / Sự Kiện & Team Building, synced across every public price display, plus an admin-managed deposit-refund policy tiered by days-before-check-in, wired into the existing cancel-booking flow.

**Architecture:** Two new D1 tables (`service_catalog`, `cancellation_policy_tier`) plus one new nullable column on `bookings`. Public read endpoints for both (unauthenticated for the catalog by default, an explicit `?public=1` escape hatch for the policy tiers) feed the public site; admin-only write endpoints feed two new vanilla-JS admin pages mirroring the existing `admin/users.html` pattern exactly.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS (no build step), Vitest + `@cloudflare/vitest-pool-workers`, Playwright.

**Spec:** docs/specs/2026-08-28-service-catalog-and-cancellation-policy-design.md

## Global Constraints

- `service_catalog.category` is exactly one of `'luu_tru'`, `'fnb_hoat_dong'`, `'su_kien_team_building'` — no other values.
- `service_catalog.price_type` is exactly one of `'range'`, `'fixed'`, `'label'`. `range` requires `price_min`+`price_max` (integers, `price_max >= price_min`); `fixed` requires `price_min` only; `label` requires non-empty `price_label`. Switching `price_type` on an edit must clear the fields the new type doesn't use.
- `service_catalog.room_type_key`, when set, must be one of `triangle`, `circle`, `ede_cozy`, `vip`, `bungalow`, `dormitory` (the keys of `ROOM_TYPES` in `v4/lib/roomTypes.js`) — validate against that import, don't hardcode a second copy of the list. At most one **active** row may hold a given key.
- **`GET /api/catalog` (no query string) takes NO `requireAuth` call at all** — it is consumed by anonymous visitors on the public site. This is deliberate, matching the existing precedent in `functions/api/availability.js`. Do not add auth to this branch.
- `GET /api/catalog?all=1` requires auth, roles `['reception', 'manager', 'admin', 'observer']`.
- `POST` / `PATCH` / `DELETE /api/catalog[...]` require auth, roles `['admin']` **only** — not `manager`, a deliberate exception to this codebase's usual `['manager', 'admin']` write convention.
- `GET /api/cancellation-policy` (no query string) requires auth, roles `['reception', 'manager', 'admin', 'observer']`. Originally scoped to `['reception', 'manager', 'admin']` (observer excluded, matching `functions/api/policy.js`'s existing convention for promo policy), but corrected during Task 7's review to include `observer`, matching this endpoint's own Admin UI role list and the sibling `catalog` endpoint's `?all=1` precedent.
- `GET /api/cancellation-policy?public=1` takes **no auth** — consumed by the homepage FAQ chatbot.
- `POST` / `PATCH` / `DELETE /api/cancellation-policy[...]` require auth, roles `['admin']` only.
- The 20 `service_catalog` seed rows in Task 1 must match the wording and amounts already published on `/bang-gia` **exactly** — copy verbatim, do not paraphrase.
- `cancellation_policy_tier` starts with **zero seed rows** — do not invent refund percentages, even though a similar-looking policy already appears as static chatbot copy today (Task 10 replaces that static copy with a message reflecting the real, empty table until an admin configures it).
- All VND amounts are stored as plain integers (no decimals, no formatting) and only formatted with `.toLocaleString('vi-VN')` at render time, matching the existing convention throughout this codebase (e.g. `admin/catalog.js`, `bang-gia/index.html`'s existing static markup).
- There is no payment gateway anywhere in this system. The refund percentage/amount computed in Task 5 is a reference number for a human to act on manually — never describe it as an automated refund in any UI copy.
- Every new admin page follows the exact structure of `admin/users.html` / `admin/users.js`: an auth-check IIFE that redirects to `/admin` on a 401 from `/api/auth/me`, a `<script src="/admin/nav-drawer.js">` include, DOM built with `document.createElement`, no templating library.

---

### Task 1: Migration — service_catalog, cancellation_policy_tier, bookings.refund_percent_applied

**Files:**
- Create: `v4/migrations/0009_service_catalog_and_cancellation_policy.sql`
- Test: `v4/test/serviceCatalogSchema.test.js`

**Interfaces:**
- Produces: table `service_catalog` (columns: `id, category, subgroup, name, price_type, price_min, price_max, price_label, unit_capacity, note, room_type_key, display_order, is_active, updated_by, updated_at`); table `cancellation_policy_tier` (columns: `id, min_days_before_checkin, refund_percent, label, display_order, updated_by, updated_at`); `bookings.refund_percent_applied` (nullable INTEGER). All later tasks read/write these exact column names.

- [ ] **Step 1: Confirm this is the next migration number**

Run: `ls v4/migrations` — confirm `0001` through `0008` exist and `0009` does not. If a different next number is already taken (another change landed first), use that number instead and adjust every reference to `0009` in this plan's remaining tasks accordingly.

- [ ] **Step 2: Write the migration**

```sql
-- v4/migrations/0009_service_catalog_and_cancellation_policy.sql

CREATE TABLE service_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('luu_tru', 'fnb_hoat_dong', 'su_kien_team_building')),
  subgroup TEXT,
  name TEXT NOT NULL,
  price_type TEXT NOT NULL CHECK (price_type IN ('range', 'fixed', 'label')),
  price_min INTEGER,
  price_max INTEGER,
  price_label TEXT,
  unit_capacity TEXT,
  note TEXT,
  room_type_key TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_service_catalog_category ON service_catalog(category, is_active, display_order);

CREATE TABLE cancellation_policy_tier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  min_days_before_checkin INTEGER NOT NULL CHECK (min_days_before_checkin >= 0),
  refund_percent INTEGER NOT NULL CHECK (refund_percent >= 0 AND refund_percent <= 100),
  label TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_cancellation_policy_days ON cancellation_policy_tier(min_days_before_checkin);

ALTER TABLE bookings ADD COLUMN refund_percent_applied INTEGER;

INSERT INTO service_catalog (category, subgroup, name, price_type, price_min, price_max, price_label, unit_capacity, note, room_type_key, display_order, is_active, updated_by, updated_at) VALUES
('luu_tru', 'Lưu Trú Theo Đêm', 'Triangle House (Tiêu Chuẩn)', 'fixed', 300000, NULL, NULL, '2–3 người', 'View vườn, giường đôi', 'triangle', 1, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Lưu Trú Theo Đêm', 'Circle House — Superior', 'fixed', 600000, NULL, NULL, '2–4 người', 'View hồ, tiện nghi cao cấp hơn', 'circle', 2, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Lưu Trú Theo Đêm', 'E Đê Cozy — Deluxe', 'fixed', 600000, NULL, NULL, '2–4 người', 'Bao gồm bữa sáng', 'ede_cozy', 3, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Lưu Trú Theo Đêm', 'VIP House — Premium Garden View', 'fixed', 900000, NULL, NULL, '3–5 người', 'Sân hiên riêng, view tốt nhất', 'vip', 4, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Lưu Trú Theo Đêm', 'Bungalow Gia Đình', 'fixed', 700000, NULL, NULL, '4–6 người', 'Phòng rộng, full amenities', 'bungalow', 5, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Lưu Trú Theo Đêm', 'Phòng Tập Thể', 'fixed', 1200000, NULL, NULL, '4–8 người', 'Giá trọn phòng theo đêm, giường tầng', 'dormitory', 6, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Thuê Theo Giờ', 'Giờ Đầu Tiên', 'fixed', 130000, NULL, NULL, '1 giờ', 'Áp dụng toàn bộ loại phòng', NULL, 7, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Thuê Theo Giờ', 'Combo 2 Giờ', 'fixed', 200000, NULL, NULL, '2 giờ', 'Tiết kiệm hơn giờ lẻ', NULL, 8, 1, 'system', '2026-08-28T00:00:00Z'),
('luu_tru', 'Thuê Theo Giờ', 'Giờ Phát Sinh Thêm', 'fixed', 60000, NULL, NULL, '/ giờ thêm', 'Sau combo 2H', NULL, 9, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Cà phê & Nước uống', 'range', 30000, 80000, NULL, '/ phần', 'Quán cà phê tại chỗ', NULL, 1, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Ăn uống theo yêu cầu', 'range', 120000, 300000, NULL, '/ người / bữa', 'Đặt trước 24h', NULL, 2, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Đốt lửa trại (Campfire)', 'range', 500000, 1000000, NULL, '/ buổi nhóm', 'Bao gồm củi, setup, 10–50 người', NULL, 3, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Hái trái cây tại vườn', 'range', 50000, 100000, NULL, '/ người', 'Theo mùa', NULL, 4, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Chụp ảnh / Check-in', 'range', 200000, 500000, NULL, '/ buổi', 'Sử dụng cảnh quan nông trại', NULL, 5, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Cắm trại qua đêm', 'range', 200000, 400000, NULL, '/ đêm / người', 'Lều tự mang hoặc thuê', NULL, 6, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Nông nghiệp trải nghiệm', 'range', 100000, 200000, NULL, '/ người', 'Trồng rau, chăm sóc cây', NULL, 7, 1, 'system', '2026-08-28T00:00:00Z'),
('fnb_hoat_dong', NULL, 'Khu vui chơi trẻ em', 'label', NULL, NULL, 'Miễn phí', '—', 'Tiện ích kèm theo', NULL, 8, 1, 'system', '2026-08-28T00:00:00Z'),
('su_kien_team_building', NULL, 'Team Building / Sự kiện nhỏ', 'range', 3000000, 5000000, NULL, '20–50 người', 'Cần đặt trước, tùy chỉnh theo yêu cầu', NULL, 1, 1, 'system', '2026-08-28T00:00:00Z'),
('su_kien_team_building', NULL, 'Sự kiện doanh nghiệp lớn', 'range', 5000000, 10000000, NULL, '50–100 người', 'Setup đầy đủ, tùy chỉnh theo công ty', NULL, 2, 1, 'system', '2026-08-28T00:00:00Z'),
('su_kien_team_building', NULL, 'Bán nông sản & sản phẩm', 'label', NULL, NULL, 'Theo giá thị trường', '—', 'Cà phê, rau củ, trái cây tươi', NULL, 3, 1, 'system', '2026-08-28T00:00:00Z');
```

- [ ] **Step 3: Apply the migration locally**

Run: `cd v4 && npx wrangler d1 migrations apply hien_le_garden_crm --local`
Expected: `0009_service_catalog_and_cancellation_policy.sql` listed as applied, no errors.

- [ ] **Step 4: Write the failing schema test**

```javascript
// v4/test/serviceCatalogSchema.test.js
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';

describe('service_catalog seed data', () => {
  it('has exactly 20 rows across the three categories', async () => {
    const { results } = await env.DB.prepare(`SELECT category, COUNT(*) AS n FROM service_catalog GROUP BY category`).all();
    const counts = Object.fromEntries(results.map((r) => [r.category, r.n]));
    expect(counts.luu_tru).toBe(9);
    expect(counts.fnb_hoat_dong).toBe(8);
    expect(counts.su_kien_team_building).toBe(3);
  });

  it('links exactly six luu_tru rows to a room_type_key, one per key', async () => {
    const { results } = await env.DB.prepare(`SELECT room_type_key FROM service_catalog WHERE room_type_key IS NOT NULL ORDER BY room_type_key`).all();
    expect(results.map((r) => r.room_type_key)).toEqual(['bungalow', 'circle', 'dormitory', 'ede_cozy', 'triangle', 'vip']);
  });

  it('has two label-type rows with the expected non-numeric labels', async () => {
    const { results } = await env.DB.prepare(`SELECT name, price_label FROM service_catalog WHERE price_type = 'label' ORDER BY id`).all();
    expect(results).toEqual([
      { name: 'Khu vui chơi trẻ em', price_label: 'Miễn phí' },
      { name: 'Bán nông sản & sản phẩm', price_label: 'Theo giá thị trường' },
    ]);
  });

  it('splits luu_tru into the two expected subgroups', async () => {
    const { results } = await env.DB.prepare(`SELECT subgroup, COUNT(*) AS n FROM service_catalog WHERE category = 'luu_tru' GROUP BY subgroup`).all();
    const counts = Object.fromEntries(results.map((r) => [r.subgroup, r.n]));
    expect(counts['Lưu Trú Theo Đêm']).toBe(6);
    expect(counts['Thuê Theo Giờ']).toBe(3);
  });
});

describe('cancellation_policy_tier seed data', () => {
  it('starts empty', async () => {
    const { results } = await env.DB.prepare(`SELECT * FROM cancellation_policy_tier`).all();
    expect(results).toEqual([]);
  });
});

describe('bookings.refund_percent_applied column', () => {
  it('exists and defaults to NULL on a new row', async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Schema Test Guest', '0900000001', 'triangle', '2026-09-01', '2026-09-02', 'pending', 'website', ?)`
    ).bind(now).run();
    const row = await env.DB.prepare(`SELECT refund_percent_applied FROM bookings WHERE guest_name = 'Schema Test Guest'`).first();
    expect(row.refund_percent_applied).toBeNull();
  });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd v4 && npx vitest run test/serviceCatalogSchema.test.js`
Expected: 5 tests pass. If Windows Miniflare's known "Isolated storage failed" teardown flake appears (an unrelated assertion inside `vitest-pool-workers`' own teardown, not one of the 5 tests above), re-run the same single-file command — never run this alongside another test file in the same command.

- [ ] **Step 6: Commit**

```bash
cd v4
git add migrations/0009_service_catalog_and_cancellation_policy.sql test/serviceCatalogSchema.test.js
git commit -m "feat: add service_catalog and cancellation_policy_tier tables"
```

---

### Task 2: GET/POST /api/catalog

**Files:**
- Create: `v4/functions/api/catalog/index.js`
- Test: `v4/test/serviceCatalogEndpoints.test.js`

**Interfaces:**
- Consumes: `env.DB` (D1), `requireAuth(request, env, allowedRoles)` from `v4/lib/requireAuth.js`, `ROOM_TYPES` from `v4/lib/roomTypes.js`.
- Produces: `onRequestGet` (public by default, `?all=1` requires auth), `onRequestPost` (admin only). Response rows are camelCase: `{ id, category, subgroup, name, priceType, priceMin, priceMax, priceLabel, unitCapacity, note, roomTypeKey, displayOrder, isActive }`. Later tasks (3, 6, 9, 10) consume this exact shape.

- [ ] **Step 1: Write the failing tests**

```javascript
// v4/test/serviceCatalogEndpoints.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getCatalog, onRequestPost as postCatalog } from '../functions/api/catalog/index.js';
import { createSession } from '../lib/auth.js';

let managerId, receptionId, adminId, observerId, managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM service_catalog');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_catalog', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_catalog', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_catalog', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_catalog', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  managerId = m.meta.last_row_id;
  receptionId = r.meta.last_row_id;
  adminId = a.meta.last_row_id;
  observerId = o.meta.last_row_id;
  managerToken = await createSession(env.DB, managerId);
  receptionToken = await createSession(env.DB, receptionId);
  adminToken = await createSession(env.DB, adminId);
  observerToken = await createSession(env.DB, observerId);

  await env.DB.prepare(
    `INSERT INTO service_catalog (category, subgroup, name, price_type, price_min, price_max, unit_capacity, note, room_type_key, display_order, is_active, updated_by, updated_at)
     VALUES ('luu_tru', 'Lưu Trú Theo Đêm', 'Triangle House Test', 'fixed', 300000, NULL, '2–3 người', 'note', 'triangle', 1, 1, 'seed', '2026-08-01T00:00:00Z')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO service_catalog (category, subgroup, name, price_type, price_min, price_max, unit_capacity, note, room_type_key, display_order, is_active, updated_by, updated_at)
     VALUES ('fnb_hoat_dong', NULL, 'Inactive Item', 'range', 10000, 20000, '/ phần', NULL, NULL, 1, 0, 'seed', '2026-08-01T00:00:00Z')`
  ).run();
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/catalog', () => {
  it('is public: returns active rows with no session at all', async () => {
    const response = await getCatalog({ request: new Request('https://x/api/catalog'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'Triangle House Test', priceType: 'fixed', priceMin: 300000, roomTypeKey: 'triangle', isActive: true });
  });

  it('?all=1 without a session returns 401', async () => {
    const response = await getCatalog({ request: new Request('https://x/api/catalog?all=1'), env });
    expect(response.status).toBe(401);
  });

  it('?all=1 with a staff session returns inactive rows too', async () => {
    const response = await getCatalog({ request: authedRequest('https://x/api/catalog?all=1', observerToken, 'GET'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(2);
  });
});

describe('POST /api/catalog', () => {
  it('lets an admin create a range-priced row', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', {
        category: 'fnb_hoat_dong', name: 'Trà đá', priceType: 'range', priceMin: 10000, priceMax: 20000, unitCapacity: '/ ly',
      }),
      env,
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM service_catalog WHERE name = 'Trà đá'`).first();
    expect(row.price_min).toBe(10000);
    expect(row.price_max).toBe(20000);
    expect(row.updated_by).toBe('admin_catalog');
  });

  it('lets an admin create a label-priced row', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', {
        category: 'su_kien_team_building', name: 'Dịch vụ đặc biệt', priceType: 'label', priceLabel: 'Liên hệ',
      }),
      env,
    });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT price_label, price_min FROM service_catalog WHERE name = 'Dịch vụ đặc biệt'`).first();
    expect(row.price_label).toBe('Liên hệ');
    expect(row.price_min).toBeNull();
  });

  it('rejects a range row missing priceMax (400)', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', { category: 'fnb_hoat_dong', name: 'Bad range', priceType: 'range', priceMin: 10000 }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a label row missing priceLabel (400)', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', { category: 'fnb_hoat_dong', name: 'Bad label', priceType: 'label' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid roomTypeKey (400)', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', { category: 'luu_tru', name: 'Bad key', priceType: 'fixed', priceMin: 100000, roomTypeKey: 'not_a_room' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a roomTypeKey already claimed by an active row (400)', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', adminToken, 'POST', { category: 'luu_tru', name: 'Duplicate triangle', priceType: 'fixed', priceMin: 100000, roomTypeKey: 'triangle' }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects manager (403) -- write is admin-only, not the usual manager+admin', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', managerToken, 'POST', { category: 'fnb_hoat_dong', name: 'x', priceType: 'fixed', priceMin: 1000 }),
      env,
    });
    expect(response.status).toBe(403);
  });

  it('rejects reception (403)', async () => {
    const response = await postCatalog({
      request: authedRequest('https://x/api/catalog', receptionToken, 'POST', { category: 'fnb_hoat_dong', name: 'x', priceType: 'fixed', priceMin: 1000 }),
      env,
    });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd v4 && npx vitest run test/serviceCatalogEndpoints.test.js`
Expected: FAIL — `functions/api/catalog/index.js` does not exist yet.

- [ ] **Step 3: Implement**

```javascript
// v4/functions/api/catalog/index.js
import { requireAuth } from '../../../lib/requireAuth.js';
import { ROOM_TYPES } from '../../../lib/roomTypes.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_CATEGORIES = ['luu_tru', 'fnb_hoat_dong', 'su_kien_team_building'];
const VALID_PRICE_TYPES = ['range', 'fixed', 'label'];
const VALID_ROOM_TYPE_KEYS = Object.keys(ROOM_TYPES);

function validateCatalogFields(body) {
  const { category, name, priceType, priceMin, priceMax, priceLabel, roomTypeKey, subgroup, unitCapacity, note } = body;

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
  return null;
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const wantsAll = url.searchParams.get('all') === '1';

  if (wantsAll) {
    const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
    if (auth instanceof Response) return auth;
  }

  const baseSelect = `SELECT id, category, subgroup, name, price_type AS priceType, price_min AS priceMin, price_max AS priceMax,
              price_label AS priceLabel, unit_capacity AS unitCapacity, note, room_type_key AS roomTypeKey,
              display_order AS displayOrder, is_active AS isActive
       FROM service_catalog`;
  const query = wantsAll
    ? `${baseSelect} ORDER BY category, subgroup, display_order`
    : `${baseSelect} WHERE is_active = 1 ORDER BY category, subgroup, display_order`;

  const { results } = await env.DB.prepare(query).all();
  const coerced = results.map((row) => ({ ...row, isActive: !!row.isActive }));

  return new Response(JSON.stringify(coerced), { status: 200, headers: { 'Content-Type': 'application/json' } });
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

  const validationError = validateCatalogFields(body);
  if (validationError) return jsonError(validationError, 400);

  const { category, subgroup, name, priceType, priceMin, priceMax, priceLabel, unitCapacity, note, roomTypeKey, displayOrder } = body;

  if (roomTypeKey) {
    const conflict = await env.DB.prepare(`SELECT id FROM service_catalog WHERE room_type_key = ? AND is_active = 1`).bind(roomTypeKey).first();
    if (conflict) return jsonError('Loại phòng này đã được liên kết với 1 dòng khác', 400);
  }

  const finalPriceMin = priceType === 'label' ? null : priceMin;
  const finalPriceMax = priceType === 'range' ? priceMax : null;
  const finalPriceLabel = priceType === 'label' ? priceLabel : null;

  await env.DB.prepare(
    `INSERT INTO service_catalog (category, subgroup, name, price_type, price_min, price_max, price_label, unit_capacity, note, room_type_key, display_order, is_active, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
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
      auth.username,
      new Date().toISOString()
    )
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd v4 && npx vitest run test/serviceCatalogEndpoints.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/catalog/index.js test/serviceCatalogEndpoints.test.js
git commit -m "feat: add GET/POST /api/catalog"
```

---

### Task 3: PATCH/DELETE /api/catalog/:id

**Files:**
- Create: `v4/functions/api/catalog/[id].js`
- Modify: `v4/test/serviceCatalogEndpoints.test.js`

**Interfaces:**
- Consumes: same fixtures and `authedRequest` helper already defined in Task 2's test file, plus the same `service_catalog` seed rows from that file's `beforeEach`.
- Produces: `onRequestPatch`, `onRequestDelete`, both admin-only, same request/response field names as Task 2.

- [ ] **Step 1: Add the failing tests**

Append to `v4/test/serviceCatalogEndpoints.test.js` (add the import at the top alongside the existing ones):

```javascript
import { onRequestPatch as patchCatalog, onRequestDelete as deleteCatalog } from '../functions/api/catalog/[id].js';
```

```javascript
describe('PATCH /api/catalog/:id', () => {
  it('lets an admin edit a row and switch price_type, clearing the old fields', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM service_catalog WHERE name = 'Triangle House Test'`).first();
    const response = await patchCatalog({
      request: authedRequest(`https://x/api/catalog/${existing.id}`, adminToken, 'PATCH', { priceType: 'label', priceLabel: 'Liên hệ' }),
      env,
      params: { id: String(existing.id) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT price_type, price_label, price_min FROM service_catalog WHERE id = ?`).bind(existing.id).first();
    expect(row.price_type).toBe('label');
    expect(row.price_label).toBe('Liên hệ');
    expect(row.price_min).toBeNull();
  });

  it('allows re-saving the same row without tripping its own roomTypeKey uniqueness check', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM service_catalog WHERE room_type_key = 'triangle'`).first();
    const response = await patchCatalog({
      request: authedRequest(`https://x/api/catalog/${existing.id}`, adminToken, 'PATCH', { note: 'updated note' }),
      env,
      params: { id: String(existing.id) },
    });
    expect(response.status).toBe(200);
  });

  it('rejects manager (403)', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM service_catalog WHERE name = 'Triangle House Test'`).first();
    const response = await patchCatalog({
      request: authedRequest(`https://x/api/catalog/${existing.id}`, managerToken, 'PATCH', { note: 'x' }),
      env,
      params: { id: String(existing.id) },
    });
    expect(response.status).toBe(403);
  });

  it('404s for a missing id', async () => {
    const response = await patchCatalog({ request: authedRequest('https://x/api/catalog/999999', adminToken, 'PATCH', { note: 'x' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/catalog/:id', () => {
  it('lets an admin delete a row', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM service_catalog WHERE name = 'Triangle House Test'`).first();
    const response = await deleteCatalog({ request: authedRequest(`https://x/api/catalog/${existing.id}`, adminToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(204);
    const row = await env.DB.prepare(`SELECT id FROM service_catalog WHERE id = ?`).bind(existing.id).first();
    expect(row).toBeNull();
  });

  it('rejects reception (403)', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM service_catalog WHERE name = 'Triangle House Test'`).first();
    const response = await deleteCatalog({ request: authedRequest(`https://x/api/catalog/${existing.id}`, receptionToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(403);
  });

  it('404s for a missing id', async () => {
    const response = await deleteCatalog({ request: authedRequest('https://x/api/catalog/999999', adminToken, 'DELETE'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd v4 && npx vitest run test/serviceCatalogEndpoints.test.js`
Expected: FAIL — `functions/api/catalog/[id].js` does not exist.

- [ ] **Step 3: Implement**

```javascript
// v4/functions/api/catalog/[id].js
import { requireAuth } from '../../../lib/requireAuth.js';
import { ROOM_TYPES } from '../../../lib/roomTypes.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_CATEGORIES = ['luu_tru', 'fnb_hoat_dong', 'su_kien_team_building'];
const VALID_PRICE_TYPES = ['range', 'fixed', 'label'];
const VALID_ROOM_TYPE_KEYS = Object.keys(ROOM_TYPES);

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM service_catalog WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy dịch vụ', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }

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

  if (roomTypeKey && isActive) {
    const conflict = await env.DB.prepare(`SELECT id FROM service_catalog WHERE room_type_key = ? AND is_active = 1 AND id != ?`).bind(roomTypeKey, params.id).first();
    if (conflict) return jsonError('Loại phòng này đã được liên kết với 1 dòng khác', 400);
  }

  const finalPriceMin = priceType === 'label' ? null : priceMin;
  const finalPriceMax = priceType === 'range' ? priceMax : null;
  const finalPriceLabel = priceType === 'label' ? priceLabel : null;

  await env.DB.prepare(
    `UPDATE service_catalog SET category = ?, subgroup = ?, name = ?, price_type = ?, price_min = ?, price_max = ?,
       price_label = ?, unit_capacity = ?, note = ?, room_type_key = ?, display_order = ?, is_active = ?,
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
      auth.username,
      new Date().toISOString(),
      params.id
    )
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT id FROM service_catalog WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy dịch vụ', 404);

  await env.DB.prepare(`DELETE FROM service_catalog WHERE id = ?`).bind(params.id).run();
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 4: Run to verify passing**

Run: `cd v4 && npx vitest run test/serviceCatalogEndpoints.test.js`
Expected: PASS (19 tests total: 12 from Task 2 + 7 new).

- [ ] **Step 5: Commit**

```bash
cd v4
git add "functions/api/catalog/[id].js" test/serviceCatalogEndpoints.test.js
git commit -m "feat: add PATCH/DELETE /api/catalog/:id"
```

---

### Task 4: Cancellation policy CRUD

**Files:**
- Create: `v4/functions/api/cancellation-policy/index.js`
- Create: `v4/functions/api/cancellation-policy/[id].js`
- Test: `v4/test/cancellationPolicyEndpoints.test.js`

**Interfaces:**
- Consumes: `requireAuth`, `env.DB`.
- Produces: `onRequestGet` (staff-only by default, roles `['reception', 'manager', 'admin']`; `?public=1` no auth — Task 10 consumes the public variant), `onRequestPost`/`onRequestPatch`/`onRequestDelete` (admin only). Response rows: `{ id, minDaysBeforeCheckin, refundPercent, label, displayOrder }`. Task 5 reads directly from the table (not through this endpoint), but must use the same column names.

- [ ] **Step 1: Write the failing tests**

```javascript
// v4/test/cancellationPolicyEndpoints.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as getTiers, onRequestPost as postTier } from '../functions/api/cancellation-policy/index.js';
import { onRequestPatch as patchTier, onRequestDelete as deleteTier } from '../functions/api/cancellation-policy/[id].js';
import { createSession } from '../lib/auth.js';

let managerId, receptionId, adminId, observerId, managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM cancellation_policy_tier');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_policy', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_policy', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_policy', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_policy', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  managerId = m.meta.last_row_id;
  receptionId = r.meta.last_row_id;
  adminId = a.meta.last_row_id;
  observerId = o.meta.last_row_id;
  managerToken = await createSession(env.DB, managerId);
  receptionToken = await createSession(env.DB, receptionId);
  adminToken = await createSession(env.DB, adminId);
  observerToken = await createSession(env.DB, observerId);

  await env.DB.prepare(
    `INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, label, display_order, updated_by, updated_at) VALUES (7, 100, 'Huỷ trước 7 ngày', 1, 'seed', '2026-08-01T00:00:00Z')`
  ).run();
  await env.DB.prepare(
    `INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, label, display_order, updated_by, updated_at) VALUES (0, 0, NULL, 2, 'seed', '2026-08-01T00:00:00Z')`
  ).run();
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('GET /api/cancellation-policy', () => {
  it('lets reception view tiers, ordered newest-threshold-first', async () => {
    const response = await getTiers({ request: authedRequest('https://x/api/cancellation-policy', receptionToken, 'GET'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.map((t) => t.minDaysBeforeCheckin)).toEqual([7, 0]);
  });

  it('rejects observer (403) -- matches the promo_policy GET convention', async () => {
    const response = await getTiers({ request: authedRequest('https://x/api/cancellation-policy', observerToken, 'GET'), env });
    expect(response.status).toBe(403);
  });

  it('rejects no session (401)', async () => {
    const response = await getTiers({ request: new Request('https://x/api/cancellation-policy'), env });
    expect(response.status).toBe(401);
  });

  it('?public=1 needs no session at all', async () => {
    const response = await getTiers({ request: new Request('https://x/api/cancellation-policy?public=1'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(2);
  });
});

describe('POST /api/cancellation-policy', () => {
  it('lets an admin add a tier', async () => {
    const response = await postTier({ request: authedRequest('https://x/api/cancellation-policy', adminToken, 'POST', { minDaysBeforeCheckin: 3, refundPercent: 50, label: 'Huỷ trước 3 ngày' }), env });
    expect(response.status).toBe(201);
    const row = await env.DB.prepare(`SELECT * FROM cancellation_policy_tier WHERE min_days_before_checkin = 3`).first();
    expect(row.refund_percent).toBe(50);
  });

  it('rejects refundPercent over 100 (400)', async () => {
    const response = await postTier({ request: authedRequest('https://x/api/cancellation-policy', adminToken, 'POST', { minDaysBeforeCheckin: 3, refundPercent: 150 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a negative minDaysBeforeCheckin (400)', async () => {
    const response = await postTier({ request: authedRequest('https://x/api/cancellation-policy', adminToken, 'POST', { minDaysBeforeCheckin: -1, refundPercent: 50 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects manager (403)', async () => {
    const response = await postTier({ request: authedRequest('https://x/api/cancellation-policy', managerToken, 'POST', { minDaysBeforeCheckin: 3, refundPercent: 50 }), env });
    expect(response.status).toBe(403);
  });
});

describe('PATCH /api/cancellation-policy/:id', () => {
  it('lets an admin edit a tier', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM cancellation_policy_tier WHERE min_days_before_checkin = 7`).first();
    const response = await patchTier({ request: authedRequest(`https://x/api/cancellation-policy/${existing.id}`, adminToken, 'PATCH', { refundPercent: 90 }), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT refund_percent FROM cancellation_policy_tier WHERE id = ?`).bind(existing.id).first();
    expect(row.refund_percent).toBe(90);
  });

  it('404s for a missing id', async () => {
    const response = await patchTier({ request: authedRequest('https://x/api/cancellation-policy/999999', adminToken, 'PATCH', { refundPercent: 90 }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });
});

describe('DELETE /api/cancellation-policy/:id', () => {
  it('lets an admin delete a tier', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM cancellation_policy_tier WHERE min_days_before_checkin = 7`).first();
    const response = await deleteTier({ request: authedRequest(`https://x/api/cancellation-policy/${existing.id}`, adminToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(204);
  });

  it('rejects reception (403)', async () => {
    const existing = await env.DB.prepare(`SELECT id FROM cancellation_policy_tier WHERE min_days_before_checkin = 7`).first();
    const response = await deleteTier({ request: authedRequest(`https://x/api/cancellation-policy/${existing.id}`, receptionToken, 'DELETE'), env, params: { id: String(existing.id) } });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd v4 && npx vitest run test/cancellationPolicyEndpoints.test.js`
Expected: FAIL — files don't exist.

- [ ] **Step 3: Implement `index.js`**

```javascript
// v4/functions/api/cancellation-policy/index.js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const isPublic = url.searchParams.get('public') === '1';

  if (!isPublic) {
    const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
    if (auth instanceof Response) return auth;
  }

  const { results } = await env.DB.prepare(
    `SELECT id, min_days_before_checkin AS minDaysBeforeCheckin, refund_percent AS refundPercent, label, display_order AS displayOrder
     FROM cancellation_policy_tier ORDER BY min_days_before_checkin DESC`
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
  const { minDaysBeforeCheckin, refundPercent, label, displayOrder } = body;

  if (!Number.isInteger(minDaysBeforeCheckin) || minDaysBeforeCheckin < 0) {
    return jsonError('Số ngày tối thiểu phải là số nguyên không âm', 400);
  }
  if (!Number.isInteger(refundPercent) || refundPercent < 0 || refundPercent > 100) {
    return jsonError('Phần trăm hoàn cọc phải là số nguyên từ 0 đến 100', 400);
  }

  await env.DB.prepare(
    `INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, label, display_order, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(minDaysBeforeCheckin, refundPercent, label || null, Number.isInteger(displayOrder) ? displayOrder : 0, auth.username, new Date().toISOString())
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Implement `[id].js`**

```javascript
// v4/functions/api/cancellation-policy/[id].js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM cancellation_policy_tier WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy bậc chính sách', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }

  const minDaysBeforeCheckin = body.minDaysBeforeCheckin !== undefined ? body.minDaysBeforeCheckin : existing.min_days_before_checkin;
  const refundPercent = body.refundPercent !== undefined ? body.refundPercent : existing.refund_percent;
  const label = body.label !== undefined ? body.label : existing.label;
  const displayOrder = body.displayOrder !== undefined ? body.displayOrder : existing.display_order;

  if (!Number.isInteger(minDaysBeforeCheckin) || minDaysBeforeCheckin < 0) {
    return jsonError('Số ngày tối thiểu phải là số nguyên không âm', 400);
  }
  if (!Number.isInteger(refundPercent) || refundPercent < 0 || refundPercent > 100) {
    return jsonError('Phần trăm hoàn cọc phải là số nguyên từ 0 đến 100', 400);
  }

  await env.DB.prepare(
    `UPDATE cancellation_policy_tier SET min_days_before_checkin = ?, refund_percent = ?, label = ?, display_order = ?, updated_by = ?, updated_at = ? WHERE id = ?`
  )
    .bind(minDaysBeforeCheckin, refundPercent, label || null, Number.isInteger(displayOrder) ? displayOrder : 0, auth.username, new Date().toISOString(), params.id)
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT id FROM cancellation_policy_tier WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy bậc chính sách', 404);

  await env.DB.prepare(`DELETE FROM cancellation_policy_tier WHERE id = ?`).bind(params.id).run();
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 5: Run to verify passing**

Run: `cd v4 && npx vitest run test/cancellationPolicyEndpoints.test.js`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/cancellation-policy test/cancellationPolicyEndpoints.test.js
git commit -m "feat: add cancellation policy tier CRUD endpoints"
```

---

### Task 5: Wire refund computation into cancel-booking

**Files:**
- Modify: `v4/functions/api/bookings/[id]/cancel.js`
- Modify: `v4/test/bookingsEndpoints.test.js`

**Interfaces:**
- Consumes: `cancellation_policy_tier` table (Task 4's schema).
- Produces: cancel response now includes `refundPercentApplied` and `refundAmount`; `bookings.refund_percent_applied` gets populated. Task 8 (reception.js) consumes these two response fields.

- [ ] **Step 1: Read the current file**

Run: `cat v4/functions/api/bookings/\[id\]/cancel.js` — confirm it still matches this plan's assumption (a `SELECT id, status FROM bookings` followed by an `UPDATE ... SET status = 'cancelled', cancel_reason = ?`). If it has diverged, adapt Step 3 below to the current shape rather than blindly overwriting.

- [ ] **Step 2: Add the failing tests**

Find the existing `describe('POST /api/bookings/:id/cancel', ...)` block in `v4/test/bookingsEndpoints.test.js` and add these cases inside it (reuse whatever booking-creation/confirm helper or fixture pattern the existing cases in that block already use to get a `confirmed` booking with a known `check_in` date and `deposit_amount`):

```javascript
  it('computes 0% refund when no cancellation_policy_tier rows exist', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    const booking = await createConfirmedBookingWithDeposit({ checkIn: '2099-01-15', depositAmount: 200000 });
    const response = await cancelBooking({ request: authedRequest(`https://x/api/bookings/${booking.id}/cancel`, receptionToken, 'POST', {}), env, params: { id: String(booking.id) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.refundPercentApplied).toBe(0);
    expect(body.refundAmount).toBe(0);
    const row = await env.DB.prepare(`SELECT refund_percent_applied FROM bookings WHERE id = ?`).bind(booking.id).first();
    expect(row.refund_percent_applied).toBe(0);
  });

  it('applies the matching tier at the exact day-boundary', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (7, 100, 'seed', '2026-08-01T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (0, 0, 'seed', '2026-08-01T00:00:00Z')`).run();

    const checkIn = new Date();
    checkIn.setUTCDate(checkIn.getUTCDate() + 7);
    const checkInStr = checkIn.toISOString().slice(0, 10);

    const booking = await createConfirmedBookingWithDeposit({ checkIn: checkInStr, depositAmount: 300000 });
    const response = await cancelBooking({ request: authedRequest(`https://x/api/bookings/${booking.id}/cancel`, receptionToken, 'POST', {}), env, params: { id: String(booking.id) } });
    const body = await response.json();
    expect(body.refundPercentApplied).toBe(100);
    expect(body.refundAmount).toBe(300000);
  });

  it('falls back to 0% below the smallest configured tier', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (3, 50, 'seed', '2026-08-01T00:00:00Z')`).run();

    const checkIn = new Date();
    checkIn.setUTCDate(checkIn.getUTCDate() + 1);
    const booking = await createConfirmedBookingWithDeposit({ checkIn: checkIn.toISOString().slice(0, 10), depositAmount: 100000 });
    const response = await cancelBooking({ request: authedRequest(`https://x/api/bookings/${booking.id}/cancel`, receptionToken, 'POST', {}), env, params: { id: String(booking.id) } });
    const body = await response.json();
    expect(body.refundPercentApplied).toBe(0);
    expect(body.refundAmount).toBe(0);
  });
```

If this test file has no existing `createConfirmedBookingWithDeposit` helper, add one near the top of the file next to the other fixture helpers, matching however this file already creates a confirmed booking row (check the existing `describe('POST /api/bookings/:id/cancel', ...)` block's `beforeEach` or first test for the exact INSERT columns already used — `bookings` requires `guest_name, phone, room_type, check_in, check_out, status, source, created_at` at minimum, per the schema from Task 1's migration read):

```javascript
async function createConfirmedBookingWithDeposit({ checkIn, depositAmount }) {
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 1);
  const result = await env.DB.prepare(
    `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, deposit_amount, created_at) VALUES (?, ?, 'triangle', ?, ?, 'confirmed', 'website', ?, ?)`
  ).bind('Refund Test Guest', '0900000002', checkIn, checkOut.toISOString().slice(0, 10), depositAmount, new Date().toISOString()).run();
  return { id: result.meta.last_row_id };
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: FAIL — `refundPercentApplied` is `undefined` in the response, since `cancel.js` doesn't compute it yet.

- [ ] **Step 4: Implement**

```javascript
// v4/functions/api/bookings/[id]/cancel.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function daysBeforeCheckin(checkIn) {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [y, m, d] = checkIn.split('-').map(Number);
  const checkInUTC = Date.UTC(y, m - 1, d);
  return Math.floor((checkInUTC - todayUTC) / 86400000);
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    body = {};
  }
  body = body || {};
  const { reason } = body;

  const booking = await env.DB.prepare(`SELECT id, status, check_in, deposit_amount FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }
  if (booking.status !== 'confirmed') {
    return jsonError('Chỉ có thể huỷ đặt phòng đã xác nhận', 400);
  }

  const daysBefore = daysBeforeCheckin(booking.check_in);
  const tier = await env.DB.prepare(
    `SELECT refund_percent FROM cancellation_policy_tier WHERE min_days_before_checkin <= ? ORDER BY min_days_before_checkin DESC LIMIT 1`
  ).bind(daysBefore).first();
  const refundPercentApplied = tier ? tier.refund_percent : 0;
  const refundAmount = Math.round((booking.deposit_amount || 0) * refundPercentApplied / 100);

  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancel_reason = ?, refund_percent_applied = ? WHERE id = ?`
  ).bind(reason || null, refundPercentApplied, params.id).run();

  return new Response(
    JSON.stringify({ ok: true, refundPercentApplied, refundAmount }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
```

- [ ] **Step 5: Run to verify passing**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: PASS — existing cancel tests still pass (the response shape only gained fields, nothing removed) plus the 3 new ones.

- [ ] **Step 6: Commit**

```bash
cd v4
git add "functions/api/bookings/[id]/cancel.js" test/bookingsEndpoints.test.js
git commit -m "feat: compute deposit refund on booking cancellation"
```

---

### Task 6: Admin catalog page

**Files:**
- Create: `v4/admin/catalog.html`
- Create: `v4/admin/catalog.js`
- Modify: `v4/admin/admin.css`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`
- Test: `tests/e2e/admin-catalog.spec.js` (outer repo)

**Interfaces:**
- Consumes: `GET /api/catalog?all=1`, `POST/PATCH/DELETE /api/catalog[...]` from Tasks 2–3; `GET /api/auth/me`.
- Produces: nothing later tasks import — this is a leaf page. Task 7 makes a parallel, independent edit to `nav-drawer.js` and `_redirects` (different array entries / different lines), so no conflict between the two tasks despite touching the same files.

- [ ] **Step 1: Add CSS for the tab buttons**

In `v4/admin/admin.css`, after the existing `.pagination button { width: auto; padding: 8px 14px; }` rule, add:

```css
.tab-btn { width: auto; padding: 8px 16px; background: rgba(245, 240, 230, 0.08); color: var(--cream); border-radius: 6px; }
.tab-btn.active { background: var(--gold); color: var(--dark-green); }
```

- [ ] **Step 2: Create the page markup**

```html
<!-- v4/admin/catalog.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Bảng giá dịch vụ — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Bảng giá dịch vụ</h1>

    <div class="filters" id="catalogTabs">
      <button type="button" class="tab-btn active" data-category="luu_tru">Lưu Trú</button>
      <button type="button" class="tab-btn" data-category="fnb_hoat_dong">F&amp;B &amp; Hoạt Động</button>
      <button type="button" class="tab-btn" data-category="su_kien_team_building">Sự Kiện &amp; Team Building</button>
    </div>

    <form id="catalogForm" class="hidden">
      <input type="hidden" name="id" />
      <input type="hidden" name="category" />
      <label>Nhóm phụ (tuỳ chọn) <input type="text" name="subgroup" /></label>
      <label>Tên dịch vụ <input type="text" name="name" required /></label>
      <label>Kiểu giá
        <select name="priceType">
          <option value="range">Khoảng giá (A–B)</option>
          <option value="fixed">Giá cố định</option>
          <option value="label">Nhãn tự do</option>
        </select>
      </label>
      <div class="form-row" id="priceRangeFields">
        <label>Giá A <input type="number" name="priceMin" min="0" step="1000" /></label>
        <label>Giá B <input type="number" name="priceMax" min="0" step="1000" /></label>
      </div>
      <label id="priceFixedField" class="hidden">Giá <input type="number" name="priceFixed" min="0" step="1000" /></label>
      <label id="priceLabelField" class="hidden">Nhãn giá <input type="text" name="priceLabel" placeholder="VD: Miễn phí" /></label>
      <label>Đơn vị / Sức chứa <input type="text" name="unitCapacity" /></label>
      <label>Ghi chú <input type="text" name="note" /></label>
      <label id="roomTypeField" class="hidden">Liên kết loại phòng
        <select name="roomTypeKey">
          <option value="">Không liên kết</option>
          <option value="triangle">Triangle House</option>
          <option value="circle">Circle House</option>
          <option value="ede_cozy">Ê Đê Cozy House</option>
          <option value="vip">VIP House</option>
          <option value="bungalow">Bungalow Gia Đình</option>
          <option value="dormitory">Phòng Tập Thể</option>
        </select>
      </label>
      <button type="submit" id="catalogSubmitBtn">Thêm dịch vụ</button>
      <button type="button" id="catalogCancelBtn" class="btn-secondary">Huỷ</button>
      <p id="formError" class="error"></p>
    </form>

    <button type="button" id="addServiceBtn" class="hidden">+ Thêm dịch vụ</button>

    <p id="listError" class="error"></p>
    <div class="table-scroll">
      <table id="catalogTable">
        <thead><tr><th>Tên</th><th>Giá A</th><th>Giá B</th><th>Đơn vị/Sức chứa</th><th>Ghi chú</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script src="/admin/catalog.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create the page script**

```javascript
// v4/admin/catalog.js
let currentRole = null;
let catalogItems = [];
let activeCategory = 'luu_tru';

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
  }
  await loadCatalog();
})();

async function loadCatalog() {
  const listError = document.getElementById('listError');
  listError.textContent = '';
  const response = await fetch('/api/catalog?all=1');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi tải bảng giá';
    return;
  }
  catalogItems = await response.json();
  renderTable();
}

function formatPrice(item) {
  if (item.priceType === 'label') return { a: item.priceLabel, b: '' };
  if (item.priceType === 'fixed') return { a: `${item.priceMin.toLocaleString('vi-VN')} đ`, b: '' };
  return { a: `${item.priceMin.toLocaleString('vi-VN')} đ`, b: `${item.priceMax.toLocaleString('vi-VN')} đ` };
}

function renderTable() {
  const tbody = document.querySelector('#catalogTable tbody');
  tbody.innerHTML = '';
  const items = catalogItems.filter((i) => i.category === activeCategory);

  let lastSubgroup;
  items.forEach((item, index) => {
    if (index === 0 || item.subgroup !== lastSubgroup) {
      lastSubgroup = item.subgroup;
      if (item.subgroup) {
        const trHead = document.createElement('tr');
        const tdHead = document.createElement('td');
        tdHead.colSpan = 6;
        tdHead.textContent = item.subgroup;
        tdHead.style.fontWeight = 'bold';
        trHead.appendChild(tdHead);
        tbody.appendChild(trHead);
      }
    }

    const tr = document.createElement('tr');
    if (!item.isActive) tr.style.opacity = '0.5';

    const tdName = document.createElement('td');
    tdName.textContent = item.name;

    const price = formatPrice(item);
    const tdA = document.createElement('td');
    tdA.textContent = price.a;
    const tdB = document.createElement('td');
    tdB.textContent = price.b;

    const tdUnit = document.createElement('td');
    tdUnit.textContent = item.unitCapacity || '';

    const tdNote = document.createElement('td');
    tdNote.textContent = item.note || '';

    const tdActions = document.createElement('td');
    if (currentRole === 'admin') {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditForm(item));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Xoá';
      deleteBtn.addEventListener('click', () => deleteItem(item.id));
      tdActions.append(editBtn, deleteBtn);
    }

    tr.append(tdName, tdA, tdB, tdUnit, tdNote, tdActions);
    tbody.appendChild(tr);
  });
}

document.querySelectorAll('#catalogTabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#catalogTabs .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activeCategory = btn.dataset.category;
    renderTable();
  });
});

function updatePriceTypeFields() {
  const priceType = document.querySelector('#catalogForm select[name="priceType"]').value;
  document.getElementById('priceRangeFields').classList.toggle('hidden', priceType !== 'range');
  document.getElementById('priceFixedField').classList.toggle('hidden', priceType !== 'fixed');
  document.getElementById('priceLabelField').classList.toggle('hidden', priceType !== 'label');
}

document.querySelector('#catalogForm select[name="priceType"]').addEventListener('change', updatePriceTypeFields);

function resetForm() {
  const form = document.getElementById('catalogForm');
  form.reset();
  form.querySelector('input[name="id"]').value = '';
  form.querySelector('input[name="category"]').value = activeCategory;
  document.getElementById('roomTypeField').classList.toggle('hidden', activeCategory !== 'luu_tru');
  document.getElementById('catalogSubmitBtn').textContent = 'Thêm dịch vụ';
  updatePriceTypeFields();
}

document.getElementById('addServiceBtn').addEventListener('click', () => {
  resetForm();
  document.getElementById('catalogForm').classList.remove('hidden');
});

document.getElementById('catalogCancelBtn').addEventListener('click', () => {
  document.getElementById('catalogForm').classList.add('hidden');
});

function openEditForm(item) {
  const form = document.getElementById('catalogForm');
  form.classList.remove('hidden');
  form.querySelector('input[name="id"]').value = item.id;
  form.querySelector('input[name="category"]').value = item.category;
  form.querySelector('input[name="subgroup"]').value = item.subgroup || '';
  form.querySelector('input[name="name"]').value = item.name;
  form.querySelector('select[name="priceType"]').value = item.priceType;
  form.querySelector('input[name="priceMin"]').value = item.priceType === 'range' ? item.priceMin : '';
  form.querySelector('input[name="priceMax"]').value = item.priceType === 'range' ? item.priceMax : '';
  form.querySelector('input[name="priceFixed"]').value = item.priceType === 'fixed' ? item.priceMin : '';
  form.querySelector('input[name="priceLabel"]').value = item.priceType === 'label' ? item.priceLabel : '';
  form.querySelector('input[name="unitCapacity"]').value = item.unitCapacity || '';
  form.querySelector('input[name="note"]').value = item.note || '';
  const roomTypeSelect = form.querySelector('select[name="roomTypeKey"]');
  if (roomTypeSelect) roomTypeSelect.value = item.roomTypeKey || '';
  document.getElementById('roomTypeField').classList.toggle('hidden', item.category !== 'luu_tru');
  document.getElementById('catalogSubmitBtn').textContent = 'Lưu thay đổi';
  updatePriceTypeFields();
}

async function deleteItem(id) {
  const listError = document.getElementById('listError');
  const response = await fetch(`/api/catalog/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi xoá dịch vụ';
    return;
  }
  await loadCatalog();
}

document.getElementById('catalogForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = document.getElementById('formError');
  errorEl.textContent = '';

  const id = data.get('id');
  const priceType = data.get('priceType');
  const payload = {
    category: data.get('category'),
    subgroup: data.get('subgroup') || null,
    name: data.get('name'),
    priceType,
    unitCapacity: data.get('unitCapacity') || null,
    note: data.get('note') || null,
    roomTypeKey: data.get('roomTypeKey') || null,
  };
  if (priceType === 'range') {
    payload.priceMin = Number(data.get('priceMin'));
    payload.priceMax = Number(data.get('priceMax'));
  } else if (priceType === 'fixed') {
    payload.priceMin = Number(data.get('priceFixed'));
  } else if (priceType === 'label') {
    payload.priceLabel = data.get('priceLabel');
  }

  const response = await fetch(id ? `/api/catalog/${id}` : '/api/catalog', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu dịch vụ';
    return;
  }

  form.classList.add('hidden');
  await loadCatalog();
});
```

- [ ] **Step 4: Add the nav-drawer entry**

In `v4/admin/nav-drawer.js`, inside the `'Cấu hình & Quản trị'` group's `items` array, add a new entry after the `manager.html` line:

```javascript
      { page: 'catalog.html', label: 'Bảng giá dịch vụ', icon: '💰', roles: ['reception', 'manager', 'admin', 'observer'] },
```

And add `'catalog.html': 'catalog'` to the `pageSlug` map (same line as the other entries, e.g. `{ 'dashboard.html': 'dashboard', 'customers.html': 'customers', 'templates.html': 'templates', 'manager.html': 'config', 'catalog.html': 'catalog', 'users.html': 'users', 'change-password.html': 'change-password' }`).

- [ ] **Step 5: Add the clean-URL routes**

In `v4/_redirects`, add three lines near the other `/manager/...`, `/reception/...`, `/observer/...` config-page rows:

```
/manager/catalog               /admin/catalog          200
/reception/catalog             /admin/catalog          200
/observer/catalog              /admin/catalog          200
```

- [ ] **Step 6: Write the Playwright test**

```javascript
// tests/e2e/admin-catalog.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Admin service catalog', () => {
  const catalogItems = [
    { id: 1, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Triangle House', priceType: 'fixed', priceMin: 300000, priceMax: null, priceLabel: null, unitCapacity: '2–3 người', note: '', roomTypeKey: 'triangle', displayOrder: 1, isActive: true },
    { id: 2, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê', priceType: 'range', priceMin: 30000, priceMax: 80000, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
  ];

  test('admin sees edit/delete controls and can add a service', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));

    let created = false;
    await page.route('**/api/catalog*', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      const items = created ? [...catalogItems, { id: 3, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Trà đá', priceType: 'fixed', priceMin: 20000, priceMax: null, priceLabel: null, unitCapacity: '', note: '', roomTypeKey: null, displayOrder: 2, isActive: true }] : catalogItems;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    });

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#catalogTable tbody')).toContainText('Triangle House');
    await expect(page.locator('#addServiceBtn')).toBeVisible();
    await expect(page.locator('#catalogTable tbody tr button', { hasText: 'Sửa' }).first()).toBeVisible();

    await page.click('#addServiceBtn');
    await page.fill('input[name="name"]', 'Trà đá');
    await page.selectOption('select[name="priceType"]', 'fixed');
    await page.fill('input[name="priceFixed"]', '20000');
    await page.click('#catalogSubmitBtn');

    await expect(page.locator('#catalogTable tbody')).toContainText('Trà đá');
  });

  test('a non-admin role sees the data read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception' }) }));
    await page.route('**/api/catalog*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogItems) }));

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#catalogTable tbody')).toContainText('Triangle House');
    await expect(page.locator('#addServiceBtn')).toBeHidden();
    await expect(page.locator('#catalogTable tbody tr button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/catalog.html');
    await page.waitForURL('**/admin');
  });
});
```

- [ ] **Step 7: Run the test**

Run these commands from `D:\VDX\HienLeGarden\LandingPage` (the outer repo), in order, cleaning up afterward even if a step fails:
1. `cd v4 && (npx http-server . -p 4174 -s -c-1 &)` then poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:4174/` until it returns `200`.
2. `npx playwright test admin-catalog --project=v4`
3. `netstat -ano | grep ":4174"` then `taskkill //F //PID <pid>` for whatever PID owns port 4174.

Expected: 3 tests pass.

- [ ] **Step 8: Commit**

```bash
cd v4
git add admin/catalog.html admin/catalog.js admin/admin.css admin/nav-drawer.js _redirects
git commit -m "feat: add admin service catalog page"
cd ..
git add tests/e2e/admin-catalog.spec.js
git commit -m "test: add e2e coverage for the admin catalog page"
```

---

### Task 7: Admin cancellation-policy page

**Files:**
- Create: `v4/admin/cancellation-policy.html`
- Create: `v4/admin/cancellation-policy.js`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`
- Test: `tests/e2e/admin-cancellation-policy.spec.js` (outer repo)

**Interfaces:**
- Consumes: `GET /api/cancellation-policy`, `POST/PATCH/DELETE /api/cancellation-policy[...]` from Task 4; `GET /api/auth/me`.
- Produces: nothing later tasks import.

- [ ] **Step 1: Create the page markup**

```html
<!-- v4/admin/cancellation-policy.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Chính sách hoàn cọc — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page">
    <h1>Chính sách hoàn cọc</h1>
    <p>Số ngày trước ngày nhận phòng (check-in) quyết định phần trăm hoàn cọc khi huỷ đặt phòng.</p>

    <form id="tierForm" class="hidden">
      <input type="hidden" name="id" />
      <label>Số ngày tối thiểu trước check-in <input type="number" name="minDaysBeforeCheckin" min="0" required /></label>
      <label>Phần trăm hoàn cọc <input type="number" name="refundPercent" min="0" max="100" required /></label>
      <label>Ghi chú (tuỳ chọn) <input type="text" name="label" /></label>
      <button type="submit" id="tierSubmitBtn">Thêm bậc</button>
      <button type="button" id="tierCancelBtn" class="btn-secondary">Huỷ</button>
      <p id="formError" class="error"></p>
    </form>

    <button type="button" id="addTierBtn" class="hidden">+ Thêm bậc</button>

    <p id="listError" class="error"></p>
    <p id="emptyState" class="hidden">Chưa cấu hình chính sách hoàn cọc — mặc định không hoàn cọc khi huỷ.</p>
    <div class="table-scroll">
      <table id="tierTable">
        <thead><tr><th>Số ngày tối thiểu trước check-in</th><th>% Hoàn cọc</th><th>Ghi chú</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <script src="/admin/cancellation-policy.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create the page script**

```javascript
// v4/admin/cancellation-policy.js
let currentRole = null;

(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;
  if (currentRole === 'admin') {
    document.getElementById('addTierBtn').classList.remove('hidden');
  }
  await loadTiers();
})();

async function loadTiers() {
  const listError = document.getElementById('listError');
  listError.textContent = '';
  const response = await fetch('/api/cancellation-policy');
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi tải chính sách hoàn cọc';
    return;
  }
  const tiers = await response.json();
  renderTable(tiers);
}

function renderTable(tiers) {
  const tbody = document.querySelector('#tierTable tbody');
  tbody.innerHTML = '';
  document.getElementById('emptyState').classList.toggle('hidden', tiers.length > 0);

  tiers.forEach((tier) => {
    const tr = document.createElement('tr');

    const tdDays = document.createElement('td');
    tdDays.textContent = `≥ ${tier.minDaysBeforeCheckin} ngày`;

    const tdPercent = document.createElement('td');
    tdPercent.textContent = `${tier.refundPercent}%`;

    const tdLabel = document.createElement('td');
    tdLabel.textContent = tier.label || '';

    const tdActions = document.createElement('td');
    if (currentRole === 'admin') {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditForm(tier));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Xoá';
      deleteBtn.addEventListener('click', () => deleteTier(tier.id));
      tdActions.append(editBtn, deleteBtn);
    }

    tr.append(tdDays, tdPercent, tdLabel, tdActions);
    tbody.appendChild(tr);
  });
}

function resetForm() {
  const form = document.getElementById('tierForm');
  form.reset();
  form.querySelector('input[name="id"]').value = '';
  document.getElementById('tierSubmitBtn').textContent = 'Thêm bậc';
}

document.getElementById('addTierBtn').addEventListener('click', () => {
  resetForm();
  document.getElementById('tierForm').classList.remove('hidden');
});

document.getElementById('tierCancelBtn').addEventListener('click', () => {
  document.getElementById('tierForm').classList.add('hidden');
});

function openEditForm(tier) {
  const form = document.getElementById('tierForm');
  form.classList.remove('hidden');
  form.querySelector('input[name="id"]').value = tier.id;
  form.querySelector('input[name="minDaysBeforeCheckin"]').value = tier.minDaysBeforeCheckin;
  form.querySelector('input[name="refundPercent"]').value = tier.refundPercent;
  form.querySelector('input[name="label"]').value = tier.label || '';
  document.getElementById('tierSubmitBtn').textContent = 'Lưu thay đổi';
}

async function deleteTier(id) {
  const listError = document.getElementById('listError');
  const response = await fetch(`/api/cancellation-policy/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    listError.textContent = body.error || 'Có lỗi khi xoá bậc chính sách';
    return;
  }
  await loadTiers();
}

document.getElementById('tierForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const errorEl = document.getElementById('formError');
  errorEl.textContent = '';

  const id = data.get('id');
  const payload = {
    minDaysBeforeCheckin: Number(data.get('minDaysBeforeCheckin')),
    refundPercent: Number(data.get('refundPercent')),
    label: data.get('label') || null,
  };

  const response = await fetch(id ? `/api/cancellation-policy/${id}` : '/api/cancellation-policy', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu bậc chính sách';
    return;
  }

  form.classList.add('hidden');
  await loadTiers();
});
```

- [ ] **Step 3: Add the nav-drawer entry**

In `v4/admin/nav-drawer.js`, add another entry to the `'Cấu hình & Quản trị'` group, after the `catalog.html` entry added in Task 6:

```javascript
      { page: 'cancellation-policy.html', label: 'Chính sách hoàn cọc', icon: '🔄', roles: ['reception', 'manager', 'admin', 'observer'] },
```

And add `'cancellation-policy.html': 'cancellation-policy'` to the `pageSlug` map.

- [ ] **Step 4: Add the clean-URL routes**

In `v4/_redirects`, add:

```
/manager/cancellation-policy    /admin/cancellation-policy   200
/reception/cancellation-policy  /admin/cancellation-policy   200
/observer/cancellation-policy   /admin/cancellation-policy   200
```

- [ ] **Step 5: Write the Playwright test**

```javascript
// tests/e2e/admin-cancellation-policy.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Admin cancellation policy', () => {
  test('admin can add a tier; a non-admin role sees it read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));

    let created = false;
    await page.route('**/api/cancellation-policy', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      const tiers = created ? [{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: 'Huỷ trước 7 ngày' }] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tiers) });
    });

    await page.goto('/admin/cancellation-policy.html');
    await expect(page.locator('#emptyState')).toBeVisible();
    await page.click('#addTierBtn');
    await page.fill('input[name="minDaysBeforeCheckin"]', '7');
    await page.fill('input[name="refundPercent"]', '100');
    await page.click('#tierSubmitBtn');
    await expect(page.locator('#tierTable tbody')).toContainText('100%');
  });

  test('a non-admin role sees the list read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception' }) }));
    await page.route('**/api/cancellation-policy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: null }]) }));

    await page.goto('/admin/cancellation-policy.html');
    await expect(page.locator('#tierTable tbody')).toContainText('100%');
    await expect(page.locator('#addTierBtn')).toBeHidden();
    await expect(page.locator('#tierTable tbody tr button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/cancellation-policy.html');
    await page.waitForURL('**/admin');
  });
});
```

- [ ] **Step 6: Run the test**

Same local-server dance as Task 6 Step 7, but `npx playwright test admin-cancellation-policy --project=v4`.
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
cd v4
git add admin/cancellation-policy.html admin/cancellation-policy.js admin/nav-drawer.js _redirects
git commit -m "feat: add admin cancellation policy page"
cd ..
git add tests/e2e/admin-cancellation-policy.spec.js
git commit -m "test: add e2e coverage for the admin cancellation policy page"
```

---

### Task 8: Reception cancel-flow refund display

**Files:**
- Modify: `v4/admin/reception.js`
- Modify: `tests/e2e/reception-ops-board.spec.js` (outer repo)

**Interfaces:**
- Consumes: the `refundPercentApplied`/`refundAmount` fields Task 5 added to the cancel response; the existing `showOpsError` function already defined in this file.

- [ ] **Step 1: Add the failing test**

Add to `tests/e2e/reception-ops-board.spec.js`, following this file's existing route-mocking pattern exactly (camelCase booking fields, one route per `status=` value, the reverse-registration-order note already documented in the `'observer sees a read-only ops board'` test above):

```javascript
  test('cancelling a booking with a deposit shows the computed refund suggestion', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, guestName: 'Trần Thị B', phone: '0900000009', roomType: 'circle', checkIn: '2099-02-01', checkOut: '2099-02-03', status: 'confirmed' }]) })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/9/cancel', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, refundPercentApplied: 50, refundAmount: 150000 }) }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trần Thị B');
    await page.click('#upcomingConfirmedList >> text=Hủy đặt phòng');

    await expect(page.locator('#opsError')).toContainText('50%');
    await expect(page.locator('#opsError')).toContainText('150.000');
  });
```

- [ ] **Step 2: Run to verify failure**

Run the same local-server + `npx playwright test reception-ops-board --project=v4` dance as before.
Expected: FAIL — `#opsError` is empty after cancel, since `cancelBooking` doesn't read the response body yet.

- [ ] **Step 3: Implement**

In `v4/admin/reception.js`, replace the existing `cancelBooking` function:

```javascript
async function cancelBooking(id) {
  let response;
  try {
    response = await fetch(`/api/bookings/${id}/cancel`, { method: 'POST' });
  } catch (err) {
    showOpsError('Có lỗi xảy ra');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showOpsError(body.error || 'Có lỗi xảy ra');
    return;
  }
  const result = await response.json().catch(() => ({}));
  if (result.refundAmount > 0) {
    showOpsError(`Đã huỷ đặt phòng. Hoàn cọc đề xuất: ${result.refundPercentApplied}% (~${result.refundAmount.toLocaleString('vi-VN')} đ)`);
  } else {
    showOpsError('');
  }
  await refreshAll();
}
```

- [ ] **Step 4: Run to verify passing**

Same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd v4
git add admin/reception.js
git commit -m "feat: show computed deposit refund after cancelling a booking"
cd ..
git add tests/e2e/reception-ops-board.spec.js
git commit -m "test: cover the deposit refund suggestion shown after cancel"
```

---

### Task 9: `/bang-gia` dynamic rendering

**Files:**
- Modify: `v4/bang-gia/index.html`
- Test: `tests/e2e/bang-gia-catalog-sync.spec.js` (outer repo, new)

**Interfaces:**
- Consumes: `GET /api/catalog` (public variant) from Task 2.

- [ ] **Step 1: Empty the four static tables and tag their `<tbody>`s**

In `v4/bang-gia/index.html`, replace each of the four `<tbody>...</tbody>` blocks (inside `#tab-overnight`'s two tables and `#tab-activities`/`#tab-events`'s one table each) with an empty, `id`-tagged `<tbody>`:

Replace:
```html
        <tbody>
          <tr><td>Triangle House (Tiêu Chuẩn)</td><td><span class="price">300.000 đ</span></td><td class="capacity">2–3 người</td><td class="note">View vườn, giường đôi</td></tr>
          <tr><td>Circle House — Superior</td><td><span class="price">600.000 đ</span></td><td class="capacity">2–4 người</td><td class="note">View hồ, tiện nghi cao cấp hơn</td></tr>
          <tr><td>E Đê Cozy — Deluxe</td><td><span class="price">600.000 đ</span></td><td class="capacity">2–4 người</td><td class="note">Bao gồm bữa sáng</td></tr>
          <tr><td>VIP House — Premium Garden View</td><td><span class="price">900.000 đ</span></td><td class="capacity">3–5 người</td><td class="note">Sân hiên riêng, view tốt nhất</td></tr>
          <tr><td>Bungalow Gia Đình</td><td><span class="price">700.000 đ</span></td><td class="capacity">4–6 người</td><td class="note">Phòng rộng, full amenities</td></tr>
          <tr><td>Phòng Tập Thể</td><td><span class="price">1.200.000 đ</span></td><td class="capacity">4–8 người</td><td class="note">Giá trọn phòng theo đêm, giường tầng</td></tr>
        </tbody>
```
with:
```html
        <tbody id="tbody-overnight"></tbody>
```

Replace:
```html
        <tbody>
          <tr><td>Giờ Đầu Tiên</td><td><span class="price">130.000 đ</span></td><td class="capacity">1 giờ</td><td class="note">Áp dụng toàn bộ loại phòng</td></tr>
          <tr><td>Combo 2 Giờ</td><td><span class="price">200.000 đ</span></td><td class="capacity">2 giờ</td><td class="note">Tiết kiệm hơn giờ lẻ</td></tr>
          <tr><td>Giờ Phát Sinh Thêm</td><td><span class="price">60.000 đ</span></td><td class="capacity">/ giờ thêm</td><td class="note">Sau combo 2H</td></tr>
        </tbody>
```
with:
```html
        <tbody id="tbody-hourly"></tbody>
```

Replace the `#tab-activities` table's 8-row `<tbody>` with:
```html
        <tbody id="tbody-activities"></tbody>
```

Replace the `#tab-events` table's 3-row `<tbody>` with:
```html
        <tbody id="tbody-events"></tbody>
```

- [ ] **Step 2: Add the rendering script**

After the existing `<script>` block that handles `.pricing-tab` clicks (near the end of the file, before `</body>`), add a new `<script>` block:

```html
  <script>
    function formatCatalogPrice(item) {
      if (item.priceType === 'label') return item.priceLabel;
      if (item.priceType === 'fixed') return `${item.priceMin.toLocaleString('vi-VN')} đ`;
      return `${item.priceMin.toLocaleString('vi-VN')}–${item.priceMax.toLocaleString('vi-VN')} đ`;
    }

    function renderPricingRow(item) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      tdName.textContent = item.name;
      const tdPrice = document.createElement('td');
      const priceSpan = document.createElement('span');
      priceSpan.className = 'price';
      priceSpan.textContent = formatCatalogPrice(item);
      tdPrice.appendChild(priceSpan);
      const tdCapacity = document.createElement('td');
      tdCapacity.className = 'capacity';
      tdCapacity.textContent = item.unitCapacity || '';
      const tdNote = document.createElement('td');
      tdNote.className = 'note';
      tdNote.textContent = item.note || '';
      tr.append(tdName, tdPrice, tdCapacity, tdNote);
      return tr;
    }

    (async () => {
      let items;
      try {
        const res = await fetch('/api/catalog');
        if (!res.ok) throw new Error('fetch failed');
        items = await res.json();
      } catch (err) {
        document.querySelectorAll('.pricing-table tbody').forEach((tbody) => {
          const tr = document.createElement('tr');
          const td = document.createElement('td');
          td.colSpan = 4;
          td.textContent = 'Không tải được bảng giá, vui lòng gọi hotline.';
          tr.appendChild(td);
          tbody.appendChild(tr);
        });
        return;
      }

      const overnightBody = document.getElementById('tbody-overnight');
      const hourlyBody = document.getElementById('tbody-hourly');
      const activitiesBody = document.getElementById('tbody-activities');
      const eventsBody = document.getElementById('tbody-events');

      items.forEach((item) => {
        if (item.category === 'luu_tru' && item.subgroup === 'Lưu Trú Theo Đêm') overnightBody.appendChild(renderPricingRow(item));
        else if (item.category === 'luu_tru' && item.subgroup === 'Thuê Theo Giờ') hourlyBody.appendChild(renderPricingRow(item));
        else if (item.category === 'fnb_hoat_dong') activitiesBody.appendChild(renderPricingRow(item));
        else if (item.category === 'su_kien_team_building') eventsBody.appendChild(renderPricingRow(item));
      });
    })();
  </script>
```

- [ ] **Step 3: Write the Playwright test**

```javascript
// tests/e2e/bang-gia-catalog-sync.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Bảng giá reads from the catalog API', () => {
  test('renders rows from /api/catalog into the correct tab tables', async ({ page }) => {
    await page.route('**/api/catalog', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Triangle House Mock', priceType: 'fixed', priceMin: 300000, priceMax: null, priceLabel: null, unitCapacity: '2–3 người', note: 'note-a', roomTypeKey: 'triangle', displayOrder: 1, isActive: true },
          { id: 2, category: 'luu_tru', subgroup: 'Thuê Theo Giờ', name: 'Giờ Đầu Mock', priceType: 'fixed', priceMin: 130000, priceMax: null, priceLabel: null, unitCapacity: '1 giờ', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
          { id: 3, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê Mock', priceType: 'range', priceMin: 30000, priceMax: 80000, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
          { id: 4, category: 'su_kien_team_building', subgroup: null, name: 'Sự kiện Mock', priceType: 'label', priceMin: null, priceMax: null, priceLabel: 'Theo giá thị trường', unitCapacity: '—', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
        ]),
      })
    );

    await page.goto('/bang-gia/');
    await expect(page.locator('#tbody-overnight')).toContainText('Triangle House Mock');
    await expect(page.locator('#tbody-overnight')).toContainText('300.000 đ');
    await expect(page.locator('#tbody-hourly')).toContainText('Giờ Đầu Mock');

    await page.click('.pricing-tab[data-tab="activities"]');
    await expect(page.locator('#tbody-activities')).toContainText('30.000–80.000 đ');

    await page.click('.pricing-tab[data-tab="events"]');
    await expect(page.locator('#tbody-events')).toContainText('Theo giá thị trường');
  });

  test('shows a fallback message when the catalog fetch fails', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 500 }));
    await page.goto('/bang-gia/');
    await expect(page.locator('#tbody-overnight')).toContainText('Không tải được bảng giá');
  });
});
```

- [ ] **Step 4: Run the test**

Same local-server dance, `npx playwright test bang-gia-catalog-sync --project=v4`.
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
cd v4
git add bang-gia/index.html
git commit -m "feat: render bang-gia pricing tables from /api/catalog"
cd ..
git add tests/e2e/bang-gia-catalog-sync.spec.js
git commit -m "test: add e2e coverage for bang-gia catalog sync"
```

---

### Task 10: Homepage public sync (booking select, room cards, FAQ chatbot)

**Files:**
- Modify: `v4/index.html`
- Test: `tests/e2e/home-catalog-sync.spec.js` (outer repo, new)

**Interfaces:**
- Consumes: `GET /api/catalog` (Task 2), `GET /api/cancellation-policy?public=1` (Task 4).

- [ ] **Step 1: Tag the six room cards**

In `v4/index.html`'s `#rooms` section, add a `data-room-type` attribute to each of the six `<div class="room-card fade-in">` opening tags:

```html
        <div class="room-card fade-in" data-room-type="triangle">
```
```html
        <div class="room-card fade-in" data-room-type="circle">
```
```html
        <div class="room-card fade-in" data-room-type="ede_cozy">
```
```html
        <div class="room-card fade-in" data-room-type="vip">
```
```html
        <div class="room-card fade-in" data-room-type="bungalow">
```
```html
        <div class="room-card fade-in" data-room-type="dormitory">
```

(Match each attribute to the card's existing `<span class="room-badge">` text so the mapping is unambiguous: Triangle House → `triangle`, Circle House → `circle`, Ê Đê Cozy → `ede_cozy`, VIP House → `vip`, Bungalow → `bungalow`, Tập Thể → `dormitory`.)

- [ ] **Step 2: Expose the chatbot's `KB` array**

Inside the `initAIConcierge` IIFE (`function initAIConcierge() { ... }`), immediately after the `const KB = [ ... ];` array literal closes (right before `const QUICK_CHIPS = ...`), add:

```javascript
      window.__aiConciergeKB = KB;
```

- [ ] **Step 3: Add the shared sync script**

Add a new `<script>` block immediately after the `initAIConcierge` script's closing `</script>` tag (order matters: this new block reads `window.__aiConciergeKB`, which must already be set by the time it runs):

```html
  <script>
    (async () => {
      const ROOM_TYPE_KEYS = ['triangle', 'circle', 'ede_cozy', 'vip', 'bungalow', 'dormitory'];
      const ROOM_TYPE_FAQ_LABELS = { triangle: 'Triangle House', circle: 'Circle House', ede_cozy: 'Ê Đê Cozy', vip: 'VIP House', bungalow: 'Bungalow GĐ', dormitory: 'Phòng tập thể' };

      let catalogItems = [];
      let policyTiers = [];
      try {
        const [catalogRes, policyRes] = await Promise.all([
          fetch('/api/catalog'),
          fetch('/api/cancellation-policy?public=1'),
        ]);
        if (catalogRes.ok) catalogItems = await catalogRes.json();
        if (policyRes.ok) policyTiers = await policyRes.json();
      } catch (err) {
        return;
      }

      const roomTypeSelect = document.getElementById('roomType');
      if (roomTypeSelect) {
        ROOM_TYPE_KEYS.forEach((key) => {
          const item = catalogItems.find((i) => i.roomTypeKey === key && i.isActive);
          if (!item || item.priceType !== 'fixed') return;
          const option = roomTypeSelect.querySelector(`option[value="${key}"]`);
          if (!option) return;
          const baseLabel = option.textContent.split(' — ')[0];
          option.textContent = `${baseLabel} — ${item.priceMin.toLocaleString('vi-VN')}đ/đêm`;
        });
      }

      document.querySelectorAll('.room-card[data-room-type]').forEach((card) => {
        const key = card.dataset.roomType;
        const item = catalogItems.find((i) => i.roomTypeKey === key && i.isActive);
        if (!item || item.priceType !== 'fixed') return;
        const tag = card.querySelector('.room-price-tag');
        if (!tag) return;
        tag.textContent = `${Math.round(item.priceMin / 1000)}k/đêm`;
      });

      const kb = window.__aiConciergeKB;
      if (!kb) return;

      const giaEntry = kb.find((k) => k.keys.includes('giá'));
      if (giaEntry && catalogItems.length > 0) {
        const lines = ROOM_TYPE_KEYS.map((key) => {
          const item = catalogItems.find((i) => i.roomTypeKey === key && i.isActive);
          if (!item || item.priceType !== 'fixed') return null;
          return `• ${ROOM_TYPE_FAQ_LABELS[key]}: **${item.priceMin.toLocaleString('vi-VN')}đ/đêm**`;
        }).filter(Boolean);
        if (lines.length > 0) {
          giaEntry.answer = `🏡 Giá phòng tại Hiền Lê Garden:\n${lines.join('\n')}\n\nGiá có thể thay đổi vào mùa lễ tết. Nhắn Zalo để được báo giá chính xác nhất! 😊`;
        }
      }

      const refundEntry = kb.find((k) => k.keys.includes('hoàn tiền'));
      if (refundEntry) {
        if (policyTiers.length > 0) {
          const sorted = [...policyTiers].sort((a, b) => b.minDaysBeforeCheckin - a.minDaysBeforeCheckin);
          const lines = sorted.map((t) => `• Hủy trước **${t.minDaysBeforeCheckin} ngày**: hoàn tiền cọc **${t.refundPercent}%**`);
          refundEntry.answer = `📋 Chính sách hủy phòng:\n\n${lines.join('\n')}\n\nVới trường hợp đặc biệt, vui lòng liên hệ Zalo để được hỗ trợ!`;
        } else {
          refundEntry.answer = '📋 Chính sách hủy phòng đang được cập nhật. Vui lòng liên hệ Zalo để biết chi tiết mới nhất về hoàn cọc!';
        }
      }
    })();
  </script>
```

- [ ] **Step 4: Write the Playwright test**

```javascript
// tests/e2e/home-catalog-sync.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Homepage reads room prices and cancellation policy from the API', () => {
  test('updates the booking select and room card price tags from /api/catalog', async ({ page }) => {
    await page.route('**/api/catalog', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Triangle House', priceType: 'fixed', priceMin: 350000, priceMax: null, priceLabel: null, unitCapacity: '2–3 người', note: '', roomTypeKey: 'triangle', displayOrder: 1, isActive: true },
        ]),
      })
    );
    await page.route('**/api/cancellation-policy?public=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/');
    await expect(page.locator('#roomType option[value="triangle"]')).toHaveText('Triangle House — 350.000đ/đêm');
    await expect(page.locator('.room-card[data-room-type="triangle"] .room-price-tag')).toHaveText('350k/đêm');
  });

  test('rebuilds the FAQ chatbot refund answer from /api/cancellation-policy', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/cancellation-policy?public=1', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: null }]) })
    );

    await page.goto('/');
    await page.click('#aiConciergeBtn');
    await page.fill('#aiInput', 'chính sách hoàn tiền khi hủy?');
    await page.click('#aiSendBtn');
    await expect(page.locator('#aiMessages')).toContainText('7 ngày');
    await expect(page.locator('#aiMessages')).toContainText('100%');
  });

  test('shows the default message when no cancellation tiers are configured', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/cancellation-policy?public=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/');
    await page.click('#aiConciergeBtn');
    await page.fill('#aiInput', 'hủy đặt phòng hoàn tiền không?');
    await page.click('#aiSendBtn');
    await expect(page.locator('#aiMessages')).toContainText('đang được cập nhật');
  });
});
```

- [ ] **Step 5: Run the test**

Same local-server dance, `npx playwright test home-catalog-sync --project=v4`.
Expected: 3 tests pass.

- [ ] **Step 6: Run the full local suite**

Run: `npx playwright test --project=v4` (from the outer repo, server still up from Step 5).
Expected: all tests pass, including every earlier suite (`home-interactions`, `console-errors`, `reception-ops-board`, etc.) — this task touches shared page structure (`index.html`) most likely to have knock-on effects, so this is the point to catch any.
Then tear down the local server per the established convention (`netstat -ano | grep ":4174"` → `taskkill //F //PID <pid>`).

- [ ] **Step 7: Commit**

```bash
cd v4
git add index.html
git commit -m "feat: sync room prices and cancellation policy FAQ answer from the API"
cd ..
git add tests/e2e/home-catalog-sync.spec.js
git commit -m "test: add e2e coverage for homepage catalog/policy sync"
```
