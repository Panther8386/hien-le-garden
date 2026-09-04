# Order ăn uống tại chỗ (khách không lưu trú) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép lễ tân/quản lý nhận order ăn uống của khách đến trực tiếp (không lưu trú): mở bàn, gọi món theo menu, huỷ dòng/huỷ bàn, chốt và thu tiền (tiền mặt/chuyển khoản), in hoá đơn — hoàn toàn độc lập với `bookings`.

**Architecture:** 3 bảng D1 mới (`dine_in_menu_items`, `dine_in_orders`, `dine_in_order_items`), không đụng vào `bookings`/`booking_service_items`. Endpoint theo convention narrow-action-endpoint đã dùng xuyên suốt dự án. 4 trang admin mới theo đúng pattern các trang đã có (`finance-categories.html` cho CRUD menu, `stay-registration-print.html` cho trang in).

**Tech Stack:** Cloudflare Pages Functions + D1 (SQLite), vanilla JS admin frontend (không build step), Playwright cho e2e.

**Spec:** docs/superpowers/specs/2026-09-04-dine-in-orders-design.md

## Global Constraints

- Không đụng vào `bookings`/`booking_service_items` — bảng hoàn toàn độc lập.
- Roles cho mọi thao tác ghi (mở bàn, gọi món, huỷ dòng, huỷ bàn, chốt): `reception, manager, admin`. Roles đọc (board, chi tiết order, menu): thêm `observer`.
- Menu CRUD: `GET` cho `reception, manager, admin, observer`; `POST`/`PATCH` chỉ `admin`.
- Huỷ chỉ đổi trạng thái (`voided`), không xoá cứng — cả món trong menu (`is_active=0`) lẫn dòng order.
- Chốt order tạo đúng **1** bút toán Sổ thu chi (`category='khach_vang_lai'`), không tách theo loại món (đã xác nhận rõ với người dùng).
- Chốt order bắt buộc `paymentMethod` (`'cash'` hoặc `'transfer'`) — 400 phía server nếu thiếu/sai; phía client nút "Chốt & Thanh toán" vô hiệu hoá cho đến khi chọn 1 trong 2 radio.
- `name`/`unit_price` trên `dine_in_order_items` là snapshot tại thời điểm gọi món — sửa giá menu sau không ảnh hưởng order cũ.
- **Deviation 1 (phát hiện khi viết plan, áp dụng quy ước codebase thay vì làm ít hơn spec ngụ ý):** `functions/api/finance/categories/index.js` và `[id].js` ghi `audit_log` cho **cả** tạo lẫn sửa danh mục. Áp dụng tương tự cho `dine_in_menu_items`: đăng ký `dine_in_menu_item_create`/`dine_in_menu_item_update` ở cả 3 registry, ghi audit_log ở cả POST lẫn PATCH menu.
- **Deviation 2 (phát hiện khi viết plan):** grep toàn bộ `admin/*.js` xác nhận **0** chỗ dùng `window.confirm()` trước bất kỳ hành động huỷ nào hiện có (huỷ đặt phòng, huỷ dịch vụ...) — nút bấm gọi API trực tiếp. Áp dụng nhất quán: nút "Huỷ dòng"/"Huỷ bàn" trong tính năng này **không** có hộp thoại xác nhận.
- Mọi endpoint dùng `env.DB.prepare(...).bind(...)` tham số hoá — không nối chuỗi SQL.

---

### Task 1: Migration — 3 bảng mới + seed danh mục Sổ thu chi

**Files:**
- Create: `v4/migrations/0021_dine_in_orders.sql`
- Test: `v4/test/migrations.test.js` (thêm `describe('migration 0021', ...)` vào cuối file)

**Interfaces:**
- Produces: bảng `dine_in_menu_items(id, name, category, price, display_order, is_active, updated_by, updated_at)`, `dine_in_orders(id, table_label, note, status, opened_by, opened_at, closed_by, closed_at, payment_method, total_amount, finance_transaction_id)`, `dine_in_order_items(id, order_id, menu_item_id, name, unit_price, quantity, amount, status, created_by, created_at, voided_by, voided_at)`. Danh mục `finance_categories` mới `slug='khach_vang_lai'`. Mọi task sau đều dùng đúng tên cột này.

- [ ] **Step 1: Viết migration**

Tạo `v4/migrations/0021_dine_in_orders.sql`:

```sql
-- v4/migrations/0021_dine_in_orders.sql

CREATE TABLE dine_in_menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('mon_an', 'do_uong')),
  price INTEGER NOT NULL CHECK (price > 0),
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_dine_in_menu_items_active ON dine_in_menu_items(is_active, category, display_order);

CREATE TABLE dine_in_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_label TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'voided')) DEFAULT 'open',
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  payment_method TEXT CHECK (payment_method IN ('cash', 'transfer')),
  total_amount INTEGER,
  finance_transaction_id INTEGER REFERENCES finance_transactions(id)
);
CREATE INDEX idx_dine_in_orders_status ON dine_in_orders(status, opened_at);

CREATE TABLE dine_in_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES dine_in_orders(id),
  menu_item_id INTEGER REFERENCES dine_in_menu_items(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted', 'voided')) DEFAULT 'posted',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_by TEXT,
  voided_at TEXT
);
CREATE INDEX idx_dine_in_order_items_order ON dine_in_order_items(order_id, status);

INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at, updated_by, updated_at)
VALUES ('khach_vang_lai', 'Khách vãng lai', 'income', 1, 'system', '2026-09-04T00:00:00Z', 'system', '2026-09-04T00:00:00Z');
```

- [ ] **Step 2: Viết test**

Thêm vào cuối `v4/test/migrations.test.js`:

```js
describe('migration 0021', () => {
  it('creates dine_in_menu_items, dine_in_orders, and dine_in_order_items with working relationships', async () => {
    const menuInsert = await env.DB.prepare(
      `INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at)
       VALUES ('Mì Quảng', 'mon_an', 45000, 1, 1, 'system', '2026-09-04T00:00:00Z')`
    ).run();
    const menuId = menuInsert.meta.last_row_id;

    const orderInsert = await env.DB.prepare(
      `INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 1', 'open', 'le_tan', '2026-09-04T08:00:00Z')`
    ).run();
    const orderId = orderInsert.meta.last_row_id;

    const itemInsert = await env.DB.prepare(
      `INSERT INTO dine_in_order_items (order_id, menu_item_id, name, unit_price, quantity, amount, status, created_by, created_at)
       VALUES (?, ?, 'Mì Quảng', 45000, 2, 90000, 'posted', 'le_tan', '2026-09-04T08:05:00Z')`
    ).bind(orderId, menuId).run();

    const menuRow = await env.DB.prepare(`SELECT name, category, price, is_active FROM dine_in_menu_items WHERE id = ?`).bind(menuId).first();
    expect(menuRow).toEqual({ name: 'Mì Quảng', category: 'mon_an', price: 45000, is_active: 1 });

    const orderRow = await env.DB.prepare(`SELECT table_label, status, total_amount FROM dine_in_orders WHERE id = ?`).bind(orderId).first();
    expect(orderRow).toEqual({ table_label: 'Bàn 1', status: 'open', total_amount: null });

    const itemRow = await env.DB.prepare(`SELECT order_id, name, quantity, amount, status FROM dine_in_order_items WHERE id = ?`).bind(itemInsert.meta.last_row_id).first();
    expect(itemRow).toEqual({ order_id: orderId, name: 'Mì Quảng', quantity: 2, amount: 90000, status: 'posted' });
  });

  it('rejects an invalid dine_in_menu_items category via the CHECK constraint', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at)
         VALUES ('X', 'trang_mieng', 10000, 0, 1, 'system', '2026-09-04T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });

  it('seeds the "Khách vãng lai" income category', async () => {
    const row = await env.DB.prepare(`SELECT slug, label, type, is_active FROM finance_categories WHERE slug = 'khach_vang_lai'`).first();
    expect(row).toEqual({ slug: 'khach_vang_lai', label: 'Khách vãng lai', type: 'income', is_active: 1 });
  });
});
```

- [ ] **Step 3: Chạy test**

Run: `cd v4 && npx vitest run test/migrations.test.js`
Expected: PASS (toàn bộ file, bao gồm các describe cũ).

- [ ] **Step 4: Commit**

```bash
cd v4
git add migrations/0021_dine_in_orders.sql test/migrations.test.js
git commit -m "feat: add dine-in orders schema (menu items, orders, order items) + Khách vãng lai category

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Menu API (`/api/dine-in-menu`)

**Files:**
- Create: `v4/functions/api/dine-in-menu/index.js`
- Create: `v4/functions/api/dine-in-menu/[id].js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Modify: `v4/functions/api/audit-log/index.js`
- Test: `v4/test/dineInMenu.test.js` (mới)

**Interfaces:**
- Consumes: bảng `dine_in_menu_items` (Task 1).
- Produces: `GET /api/dine-in-menu` → `200 [{ id, name, category, price, displayOrder, isActive, updatedBy, updatedAt }, ...]` (bao gồm cả `isActive=false`). `POST /api/dine-in-menu` → `201 { id, name, category, price, displayOrder, isActive }`. `PATCH /api/dine-in-menu/:id` → `200 { ok: true }`. Task 4 và Task 8 (client) dùng đúng field name này. Action types mới: `dine_in_menu_item_create`, `dine_in_menu_item_update`.

- [ ] **Step 1: Viết endpoint GET + POST**

Tạo `v4/functions/api/dine-in-menu/index.js`:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_CATEGORIES = ['mon_an', 'do_uong'];

function coerceRow(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    price: r.price,
    displayOrder: r.display_order,
    isActive: !!r.is_active,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(`SELECT * FROM dine_in_menu_items ORDER BY category, display_order, id`).all();
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
  const { name, category, price } = body || {};

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Tên món không được để trống', 400);
  if (name.trim().length > 200) return jsonError('Tên món quá dài', 400);
  if (!VALID_CATEGORIES.includes(category)) return jsonError('Loại món không hợp lệ', 400);
  if (!Number.isInteger(price) || price <= 0) return jsonError('Giá phải là số nguyên lớn hơn 0', 400);

  const trimmedName = name.trim();
  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES (?, ?, ?, 0, 1, ?, ?)`
  ).bind(trimmedName, category, price, auth.username, now).run();
  const newId = insert.meta.last_row_id;

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('dine_in_menu_item_create', 'dine_in_menu_item', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, trimmedName, `${trimmedName} — ${price.toLocaleString('vi-VN')}đ`, auth.username, now).run();

  return new Response(JSON.stringify({ id: newId, name: trimmedName, category, price, displayOrder: 0, isActive: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

Tạo `v4/functions/api/dine-in-menu/[id].js`:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM dine_in_menu_items WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy món', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const safeBody = body || {};
  const name = safeBody.name !== undefined ? safeBody.name : existing.name;
  const price = safeBody.price !== undefined ? safeBody.price : existing.price;
  const isActive = safeBody.isActive !== undefined ? safeBody.isActive : !!existing.is_active;
  // `category` is intentionally never read from the request body -- immutable after creation.

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Tên món không được để trống', 400);
  if (name.trim().length > 200) return jsonError('Tên món quá dài', 400);
  if (!Number.isInteger(price) || price <= 0) return jsonError('Giá phải là số nguyên lớn hơn 0', 400);

  const trimmedName = name.trim();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE dine_in_menu_items SET name = ?, price = ?, is_active = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(trimmedName, price, isActive ? 1 : 0, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('dine_in_menu_item_update', 'dine_in_menu_item', ?, ?, ?, ?, ?, ?)`
    ).bind(
      params.id,
      trimmedName,
      `${existing.name} — ${existing.price.toLocaleString('vi-VN')}đ (${existing.is_active ? 'active' : 'inactive'})`,
      `${trimmedName} — ${price.toLocaleString('vi-VN')}đ (${isActive ? 'active' : 'inactive'})`,
      auth.username,
      now
    ),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Đăng ký 2 action type mới ở cả 3 registry**

Trong `v4/admin/audit-log.js`, thêm 2 dòng ngay sau dòng `guest_identity_update: 'Cập nhật giấy tờ khách',` trong `ACTION_TYPE_LABELS`:

```js
  dine_in_menu_item_create: 'Tạo món trong menu',
  dine_in_menu_item_update: 'Sửa món trong menu',
```

Trong `v4/admin/audit-log.html`, thêm 2 `<option>` ngay sau dòng `<option value="guest_identity_update">Cập nhật giấy tờ khách</option>`:

```html
        <option value="dine_in_menu_item_create">Tạo món trong menu</option>
        <option value="dine_in_menu_item_update">Sửa món trong menu</option>
```

Trong `v4/functions/api/audit-log/index.js`, thêm 2 giá trị mới vào cuối mảng `VALID_ACTION_TYPES` (sau `'guest_identity_update'`):

```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update'];
```

- [ ] **Step 3: Viết test**

Tạo `v4/test/dineInMenu.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listMenu, onRequestPost as createMenuItem } from '../functions/api/dine-in-menu/index.js';
import { onRequestPatch as patchMenuItem } from '../functions/api/dine-in-menu/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM dine_in_menu_items');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_menu', 'x', 'manager', '2026-09-04T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_menu', 'x', 'reception', '2026-09-04T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_menu', 'x', 'admin', '2026-09-04T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_menu', 'x', 'observer', '2026-09-04T00:00:00Z')`).run();
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

describe('GET /api/dine-in-menu', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listMenu({ request: new Request('https://x/api/dine-in-menu'), env });
    expect(response.status).toBe(401);
  });

  it('allows reception, manager, admin, and observer to read', async () => {
    for (const token of [receptionToken, managerToken, adminToken, observerToken]) {
      const response = await listMenu({ request: authedRequest('https://x/api/dine-in-menu', token, 'GET'), env });
      expect(response.status).toBe(200);
    }
  });

  it('returns created items including inactive ones', async () => {
    await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Cà phê đen', 'do_uong', 25000, 1, 0, 'system', '2026-09-04T00:00:00Z')`).run();
    const response = await listMenu({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body).toEqual([
      { id: expect.any(Number), name: 'Cà phê đen', category: 'do_uong', price: 25000, displayOrder: 1, isActive: false, updatedBy: 'system', updatedAt: '2026-09-04T00:00:00Z' },
    ]);
  });
});

describe('POST /api/dine-in-menu', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await createMenuItem({ request: new Request('https://x/api/dine-in-menu', { method: 'POST' }), env });
    expect(response.status).toBe(401);
  });

  it('rejects non-admin roles (403)', async () => {
    for (const token of [receptionToken, managerToken, observerToken]) {
      const response = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', token, 'POST', { name: 'Mì Quảng', category: 'mon_an', price: 45000 }), env });
      expect(response.status).toBe(403);
    }
  });

  it('rejects an invalid category (400)', async () => {
    const response = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Mì Quảng', category: 'trang_mieng', price: 45000 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a non-positive price (400)', async () => {
    const response = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Mì Quảng', category: 'mon_an', price: 0 }), env });
    expect(response.status).toBe(400);
  });

  it('creates a menu item and writes an audit_log row', async () => {
    const response = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Mì Quảng', category: 'mon_an', price: 45000 }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ name: 'Mì Quảng', category: 'mon_an', price: 45000, isActive: true });

    const row = await env.DB.prepare(`SELECT name, category, price, is_active FROM dine_in_menu_items WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ name: 'Mì Quảng', category: 'mon_an', price: 45000, is_active: 1 });

    const auditRow = await env.DB.prepare(`SELECT actor FROM audit_log WHERE action_type = 'dine_in_menu_item_create' AND entity_id = ?`).bind(body.id).first();
    expect(auditRow.actor).toBe('admin_menu');
  });
});

describe('PATCH /api/dine-in-menu/:id', () => {
  let itemId;
  beforeEach(async () => {
    const created = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Trà đá', 'do_uong', 10000, 0, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    itemId = created.meta.last_row_id;
  });

  it('404s for a non-existent id', async () => {
    const response = await patchMenuItem({ request: authedRequest('https://x/api/dine-in-menu/999999', adminToken, 'PATCH', { name: 'x' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects non-admin roles (403)', async () => {
    const response = await patchMenuItem({ request: authedRequest(`https://x/api/dine-in-menu/${itemId}`, managerToken, 'PATCH', { price: 15000 }), env, params: { id: String(itemId) } });
    expect(response.status).toBe(403);
  });

  it('updates name/price/isActive and ignores category, writing an audit_log row', async () => {
    const response = await patchMenuItem({ request: authedRequest(`https://x/api/dine-in-menu/${itemId}`, adminToken, 'PATCH', { name: 'Trà đá lớn', price: 15000, isActive: false, category: 'mon_an' }), env, params: { id: String(itemId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT name, category, price, is_active FROM dine_in_menu_items WHERE id = ?`).bind(itemId).first();
    expect(row).toEqual({ name: 'Trà đá lớn', category: 'do_uong', price: 15000, is_active: 0 });

    const auditRow = await env.DB.prepare(`SELECT actor FROM audit_log WHERE action_type = 'dine_in_menu_item_update' AND entity_id = ?`).bind(itemId).first();
    expect(auditRow.actor).toBe('admin_menu');
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/dineInMenu.test.js`
Expected: PASS (11 tests). Cũng chạy `npx vitest run test/auditLog.test.js` để xác nhận đăng ký registry không phá gì — expect PASS.

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/dine-in-menu admin/audit-log.js admin/audit-log.html functions/api/audit-log/index.js test/dineInMenu.test.js
git commit -m "feat: add dine-in menu CRUD API, register menu item audit types

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Order core — mở bàn, danh sách, chi tiết

**Files:**
- Create: `v4/functions/api/dine-in-orders/index.js`
- Create: `v4/functions/api/dine-in-orders/[id]/index.js`
- Test: `v4/test/dineInOrders.test.js` (mới)

**Interfaces:**
- Consumes: bảng `dine_in_orders`, `dine_in_order_items` (Task 1).
- Produces: `POST /api/dine-in-orders` → `201 { id, ok: true }`. `GET /api/dine-in-orders?status=open` → `200 [{ id, tableLabel, note, status, openedBy, openedAt, currentTotal }, ...]`. `GET /api/dine-in-orders/:id` → `200 { id, tableLabel, note, status, openedBy, openedAt, closedBy, closedAt, paymentMethod, totalAmount, items: [{ id, menuItemId, name, unitPrice, quantity, amount, status, createdBy, createdAt, voidedBy, voidedAt }, ...] }`. Task 4/5/7/8 dùng đúng field name này.

- [ ] **Step 1: Viết endpoint tạo + danh sách**

Tạo `v4/functions/api/dine-in-orders/index.js`:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_STATUSES = ['open', 'closed', 'voided'];

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  if (!VALID_STATUSES.includes(status)) return jsonError('Trạng thái không hợp lệ', 400);

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.table_label AS tableLabel, o.note, o.status, o.opened_by AS openedBy, o.opened_at AS openedAt,
       COALESCE((SELECT SUM(amount) FROM dine_in_order_items WHERE order_id = o.id AND status = 'posted'), 0) AS currentTotal
     FROM dine_in_orders o WHERE o.status = ? ORDER BY o.opened_at ASC`
  ).bind(status).all();

  return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { tableLabel, note } = body || {};
  if (typeof tableLabel !== 'string' || tableLabel.trim() === '') return jsonError('Vui lòng nhập số bàn', 400);
  if (tableLabel.trim().length > 100) return jsonError('Số bàn quá dài', 400);
  if (note !== undefined && note !== null && typeof note !== 'string') return jsonError('Ghi chú không hợp lệ', 400);

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO dine_in_orders (table_label, note, status, opened_by, opened_at) VALUES (?, ?, 'open', ?, ?)`
  ).bind(tableLabel.trim(), note ? (note.trim() || null) : null, auth.username, now).run();

  return new Response(JSON.stringify({ id: insert.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint chi tiết**

Tạo `v4/functions/api/dine-in-orders/[id]/index.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const order = await env.DB.prepare(
    `SELECT id, table_label AS tableLabel, note, status, opened_by AS openedBy, opened_at AS openedAt,
       closed_by AS closedBy, closed_at AS closedAt, payment_method AS paymentMethod, total_amount AS totalAmount
     FROM dine_in_orders WHERE id = ?`
  ).bind(params.id).first();
  if (!order) return jsonError('Không tìm thấy order', 404);

  const { results: items } = await env.DB.prepare(
    `SELECT id, menu_item_id AS menuItemId, name, unit_price AS unitPrice, quantity, amount, status,
       created_by AS createdBy, created_at AS createdAt, voided_by AS voidedBy, voided_at AS voidedAt
     FROM dine_in_order_items WHERE order_id = ? ORDER BY created_at ASC`
  ).bind(params.id).all();

  return new Response(JSON.stringify({ ...order, items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Viết test**

Tạo `v4/test/dineInOrders.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listOrders, onRequestPost as createOrder } from '../functions/api/dine-in-orders/index.js';
import { onRequestGet as getOrder } from '../functions/api/dine-in-orders/[id]/index.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM dine_in_orders');
  await env.DB.exec('DELETE FROM dine_in_order_items');
  await env.DB.exec('DELETE FROM dine_in_menu_items');
  await env.DB.exec('DELETE FROM audit_log');
  await env.DB.exec(`DELETE FROM finance_transactions WHERE category = 'khach_vang_lai'`);

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_order', 'x', 'manager', '2026-09-04T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_order', 'x', 'reception', '2026-09-04T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_order', 'x', 'admin', '2026-09-04T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_order', 'x', 'observer', '2026-09-04T00:00:00Z')`).run();
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

describe('POST /api/dine-in-orders', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await createOrder({ request: new Request('https://x/api/dine-in-orders', { method: 'POST' }), env });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await createOrder({ request: authedRequest('https://x/api/dine-in-orders', observerToken, 'POST', { tableLabel: 'Bàn 1' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a missing tableLabel (400)', async () => {
    const response = await createOrder({ request: authedRequest('https://x/api/dine-in-orders', receptionToken, 'POST', {}), env });
    expect(response.status).toBe(400);
  });

  it('opens a table with status=open', async () => {
    const response = await createOrder({ request: authedRequest('https://x/api/dine-in-orders', receptionToken, 'POST', { tableLabel: 'Bàn 3', note: 'gần cửa' }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT table_label, note, status, opened_by FROM dine_in_orders WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ table_label: 'Bàn 3', note: 'gần cửa', status: 'open', opened_by: 'le_tan_order' });
  });
});

describe('GET /api/dine-in-orders', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listOrders({ request: new Request('https://x/api/dine-in-orders'), env });
    expect(response.status).toBe(401);
  });

  it('defaults to status=open and computes currentTotal from posted items only', async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 5', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    const orderId = order.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO dine_in_order_items (order_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Mì Quảng', 45000, 1, 45000, 'posted', 'le_tan_order', '2026-09-04T08:05:00Z')`).bind(orderId).run();
    await env.DB.prepare(`INSERT INTO dine_in_order_items (order_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Cà phê', 25000, 1, 25000, 'voided', 'le_tan_order', '2026-09-04T08:06:00Z')`).bind(orderId).run();

    const response = await listOrders({ request: authedRequest('https://x/api/dine-in-orders', observerToken, 'GET'), env });
    const body = await response.json();
    expect(body).toEqual([{ id: orderId, tableLabel: 'Bàn 5', note: null, status: 'open', openedBy: 'le_tan_order', openedAt: '2026-09-04T08:00:00Z', currentTotal: 45000 }]);
  });

  it('rejects an invalid status query param (400)', async () => {
    const response = await listOrders({ request: authedRequest('https://x/api/dine-in-orders?status=deleted', receptionToken, 'GET'), env });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/dine-in-orders/:id', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getOrder({ request: new Request('https://x/api/dine-in-orders/1'), env, params: { id: '1' } });
    expect(response.status).toBe(401);
  });

  it('404s for a non-existent id', async () => {
    const response = await getOrder({ request: authedRequest('https://x/api/dine-in-orders/999999', receptionToken, 'GET'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('returns order detail including its items', async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 7', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    const orderId = order.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO dine_in_order_items (order_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Mì Quảng', 45000, 1, 45000, 'posted', 'le_tan_order', '2026-09-04T08:05:00Z')`).bind(orderId).run();

    const response = await getOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}`, observerToken, 'GET'), env, params: { id: String(orderId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.tableLabel).toBe('Bàn 7');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted' });
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/dineInOrders.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/dine-in-orders test/dineInOrders.test.js
git commit -m "feat: add dine-in order create/list/detail endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Order items — gọi món, huỷ dòng

**Files:**
- Create: `v4/functions/api/dine-in-orders/[id]/items/index.js`
- Create: `v4/functions/api/dine-in-orders/[id]/items/[itemId].js`
- Test: `v4/test/dineInOrders.test.js` (thêm 2 describe block mới vào cuối file)

**Interfaces:**
- Consumes: `dine_in_menu_items` (Task 2), `dine_in_orders`/`dine_in_order_items` (Task 3).
- Produces: `POST /api/dine-in-orders/:id/items` → `201 { id, ok: true }`. `PATCH /api/dine-in-orders/:id/items/:itemId` → `200 { ok: true }`, ghi `audit_log` với `action_type='service_void'` (tái dùng), `entity_type='dine_in_order_item'`.

- [ ] **Step 1: Viết endpoint thêm món**

Tạo `v4/functions/api/dine-in-orders/[id]/items/index.js`:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const order = await env.DB.prepare(`SELECT id, status FROM dine_in_orders WHERE id = ?`).bind(params.id).first();
  if (!order) return jsonError('Không tìm thấy order', 404);
  if (order.status !== 'open') return jsonError('Chỉ có thể thêm món khi bàn còn đang mở', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { menuItemId, quantity } = body || {};
  if (!Number.isInteger(menuItemId)) return jsonError('Vui lòng chọn món', 400);
  if (!Number.isInteger(quantity) || quantity < 1) return jsonError('Số lượng phải là số nguyên lớn hơn 0', 400);

  const menuItem = await env.DB.prepare(`SELECT id, name, price FROM dine_in_menu_items WHERE id = ? AND is_active = 1`).bind(menuItemId).first();
  if (!menuItem) return jsonError('Món không tồn tại hoặc đã ngừng bán', 400);

  const amount = menuItem.price * quantity;
  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO dine_in_order_items (order_id, menu_item_id, name, unit_price, quantity, amount, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?)`
  ).bind(params.id, menuItem.id, menuItem.name, menuItem.price, quantity, amount, auth.username, now).run();

  return new Response(JSON.stringify({ id: insert.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint huỷ dòng**

Tạo `v4/functions/api/dine-in-orders/[id]/items/[itemId].js`:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const item = await env.DB.prepare(
    `SELECT oi.id, oi.order_id, oi.status, oi.name, oi.quantity, o.table_label AS tableLabel, o.status AS orderStatus
     FROM dine_in_order_items oi JOIN dine_in_orders o ON o.id = oi.order_id
     WHERE oi.id = ?`
  ).bind(params.itemId).first();
  if (!item || String(item.order_id) !== String(params.id)) {
    return jsonError('Không tìm thấy dòng món', 404);
  }
  if (item.status === 'voided') return jsonError('Dòng này đã được huỷ trước đó', 400);
  if (item.orderStatus !== 'open') return jsonError('Chỉ có thể huỷ dòng khi bàn còn đang mở', 400);

  const now = new Date().toISOString();
  const entityLabel = `${item.name} ×${item.quantity} — ${item.tableLabel}`;

  await env.DB.batch([
    env.DB.prepare(`UPDATE dine_in_order_items SET status = 'voided', voided_by = ?, voided_at = ? WHERE id = ?`)
      .bind(auth.username, now, params.itemId),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('service_void', 'dine_in_order_item', ?, ?, 'posted', 'voided', ?, ?)`
    ).bind(item.id, entityLabel, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Viết test**

Thêm vào cuối `v4/test/dineInOrders.test.js`, sau describe block `GET /api/dine-in-orders/:id`:

```js
import { onRequestPost as addItem } from '../functions/api/dine-in-orders/[id]/items/index.js';
import { onRequestPatch as voidItem } from '../functions/api/dine-in-orders/[id]/items/[itemId].js';
```

(Thêm 2 dòng import này vào đầu file, cạnh các import `onRequestGet`/`onRequestPost` đã có.)

```js
describe('POST /api/dine-in-orders/:id/items', () => {
  let orderId, menuItemId;
  beforeEach(async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 2', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    orderId = order.meta.last_row_id;
    const menu = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Mì Quảng', 'mon_an', 45000, 0, 1, 'admin_order', '2026-09-04T00:00:00Z')`).run();
    menuItemId = menu.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await addItem({ request: new Request(`https://x/api/dine-in-orders/${orderId}/items`, { method: 'POST' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items`, observerToken, 'POST', { menuItemId, quantity: 1 }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent order', async () => {
    const response = await addItem({ request: authedRequest('https://x/api/dine-in-orders/999999/items', receptionToken, 'POST', { menuItemId, quantity: 1 }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an inactive menu item (400)', async () => {
    const inactive = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Ngừng bán', 'mon_an', 30000, 0, 0, 'admin_order', '2026-09-04T00:00:00Z')`).run();
    const response = await addItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items`, receptionToken, 'POST', { menuItemId: inactive.meta.last_row_id, quantity: 1 }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(400);
  });

  it('snapshots name/price and computes amount = unitPrice * quantity', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items`, receptionToken, 'POST', { menuItemId, quantity: 3 }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT name, unit_price, quantity, amount, status FROM dine_in_order_items WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ name: 'Mì Quảng', unit_price: 45000, quantity: 3, amount: 135000, status: 'posted' });
  });

  it('rejects adding items when the order is not open', async () => {
    await env.DB.prepare(`UPDATE dine_in_orders SET status = 'closed' WHERE id = ?`).bind(orderId).run();
    const response = await addItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items`, receptionToken, 'POST', { menuItemId, quantity: 1 }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/dine-in-orders/:id/items/:itemId', () => {
  let orderId, itemId;
  beforeEach(async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 4', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    orderId = order.meta.last_row_id;
    const item = await env.DB.prepare(`INSERT INTO dine_in_order_items (order_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Mì Quảng', 45000, 1, 45000, 'posted', 'le_tan_order', '2026-09-04T08:05:00Z')`).bind(orderId).run();
    itemId = item.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await voidItem({ request: new Request(`https://x/api/dine-in-orders/${orderId}/items/${itemId}`, { method: 'PATCH' }), env, params: { id: String(orderId), itemId: String(itemId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await voidItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items/${itemId}`, observerToken, 'PATCH'), env, params: { id: String(orderId), itemId: String(itemId) } });
    expect(response.status).toBe(403);
  });

  it('404s when the item does not belong to this order', async () => {
    const otherOrder = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn khác', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    const response = await voidItem({ request: authedRequest(`https://x/api/dine-in-orders/${otherOrder.meta.last_row_id}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(otherOrder.meta.last_row_id), itemId: String(itemId) } });
    expect(response.status).toBe(404);
  });

  it('voids the item and writes a service_void audit_log row', async () => {
    const response = await voidItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(orderId), itemId: String(itemId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT status, voided_by FROM dine_in_order_items WHERE id = ?`).bind(itemId).first();
    expect(row).toEqual({ status: 'voided', voided_by: 'le_tan_order' });

    const auditRow = await env.DB.prepare(`SELECT action_type, entity_type, actor FROM audit_log WHERE entity_type = 'dine_in_order_item' AND entity_id = ?`).bind(itemId).first();
    expect(auditRow).toEqual({ action_type: 'service_void', entity_type: 'dine_in_order_item', actor: 'le_tan_order' });
  });

  it('rejects voiding an already-voided item (400)', async () => {
    await voidItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(orderId), itemId: String(itemId) } });
    const response = await voidItem({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(orderId), itemId: String(itemId) } });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/dineInOrders.test.js`
Expected: PASS (21 tests: 10 từ Task 3 + 11 mới).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/dine-in-orders test/dineInOrders.test.js
git commit -m "feat: add dine-in order item add/void endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Huỷ bàn + Chốt & thanh toán (tích hợp Sổ thu chi)

**Files:**
- Create: `v4/functions/api/dine-in-orders/[id]/void.js`
- Create: `v4/functions/api/dine-in-orders/[id]/close.js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Modify: `v4/functions/api/audit-log/index.js`
- Test: `v4/test/dineInOrders.test.js` (thêm 2 describe block mới vào cuối file)

**Interfaces:**
- Consumes: `dine_in_orders`/`dine_in_order_items` (Task 3/4), `finance_categories` slug `khach_vang_lai` (Task 1).
- Produces: `POST /api/dine-in-orders/:id/void` → `200 { ok: true }`, ghi `audit_log` action type mới `dine_in_order_void`. `POST /api/dine-in-orders/:id/close` → `200 { ok: true, totalAmount, financeTransactionId }`, tạo 1 dòng `finance_transactions`. Task 8 (client) dùng đúng response shape này.

- [ ] **Step 1: Viết endpoint huỷ bàn**

Tạo `v4/functions/api/dine-in-orders/[id]/void.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const order = await env.DB.prepare(`SELECT id, table_label AS tableLabel, status FROM dine_in_orders WHERE id = ?`).bind(params.id).first();
  if (!order) return jsonError('Không tìm thấy order', 404);
  if (order.status !== 'open') return jsonError('Chỉ có thể huỷ bàn khi còn đang mở', 400);

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM dine_in_order_items WHERE order_id = ? AND status = 'posted'`
  ).bind(params.id).first();

  const now = new Date().toISOString();
  const entityLabel = `${order.tableLabel} — ${totals.n} món, ${totals.total.toLocaleString('vi-VN')}đ`;

  await env.DB.batch([
    env.DB.prepare(`UPDATE dine_in_orders SET status = 'voided' WHERE id = ?`).bind(params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('dine_in_order_void', 'dine_in_order', ?, ?, 'open', 'voided', ?, ?)`
    ).bind(order.id, entityLabel, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint chốt & thanh toán**

Tạo `v4/functions/api/dine-in-orders/[id]/close.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const order = await env.DB.prepare(`SELECT id, table_label AS tableLabel, status FROM dine_in_orders WHERE id = ?`).bind(params.id).first();
  if (!order) return jsonError('Không tìm thấy order', 404);
  if (order.status !== 'open') return jsonError('Chỉ có thể chốt khi bàn còn đang mở', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { paymentMethod } = body || {};
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) return jsonError('Vui lòng chọn hình thức thanh toán', 400);

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM dine_in_order_items WHERE order_id = ? AND status = 'posted'`
  ).bind(params.id).first();
  if (totals.n === 0) return jsonError('Bàn chưa có món nào, vui lòng huỷ bàn thay vì chốt', 400);

  const now = new Date().toISOString();
  const note = `Order ${order.tableLabel} — ${totals.n} món`;

  const txInsert = await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
     VALUES ('income', 'khach_vang_lai', ?, ?, ?, 'confirmed', ?, ?)`
  ).bind(totals.total, note, now.slice(0, 10), auth.username, now).run();
  const financeTransactionId = txInsert.meta.last_row_id;

  await env.DB.prepare(
    `UPDATE dine_in_orders SET status = 'closed', closed_by = ?, closed_at = ?, payment_method = ?, total_amount = ?, finance_transaction_id = ? WHERE id = ?`
  ).bind(auth.username, now, paymentMethod, totals.total, financeTransactionId, params.id).run();

  return new Response(JSON.stringify({ ok: true, totalAmount: totals.total, financeTransactionId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Đăng ký action type `dine_in_order_void`**

Trong `v4/admin/audit-log.js`, thêm 1 dòng ngay sau `dine_in_menu_item_update: 'Sửa món trong menu',`:

```js
  dine_in_order_void: 'Huỷ bàn order ăn uống',
```

Trong `v4/admin/audit-log.html`, thêm 1 `<option>` ngay sau `<option value="dine_in_menu_item_update">Sửa món trong menu</option>`:

```html
        <option value="dine_in_order_void">Huỷ bàn order ăn uống</option>
```

Trong `v4/functions/api/audit-log/index.js`, thêm `'dine_in_order_void'` vào cuối mảng `VALID_ACTION_TYPES`:

```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void'];
```

- [ ] **Step 4: Viết test**

Thêm import vào đầu `v4/test/dineInOrders.test.js`, cạnh các import đã có:

```js
import { onRequestPost as voidOrder } from '../functions/api/dine-in-orders/[id]/void.js';
import { onRequestPost as closeOrder } from '../functions/api/dine-in-orders/[id]/close.js';
```

Thêm vào cuối file, sau describe block `PATCH /api/dine-in-orders/:id/items/:itemId`:

```js
describe('POST /api/dine-in-orders/:id/void', () => {
  let orderId;
  beforeEach(async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 8', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    orderId = order.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await voidOrder({ request: new Request(`https://x/api/dine-in-orders/${orderId}/void`, { method: 'POST' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await voidOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/void`, observerToken, 'POST'), env, params: { id: String(orderId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent order', async () => {
    const response = await voidOrder({ request: authedRequest('https://x/api/dine-in-orders/999999/void', receptionToken, 'POST'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('voids the order without creating a finance_transactions row, writing a dine_in_order_void audit_log row', async () => {
    const response = await voidOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/void`, receptionToken, 'POST'), env, params: { id: String(orderId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT status FROM dine_in_orders WHERE id = ?`).bind(orderId).first();
    expect(row.status).toBe('voided');

    const txCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions WHERE category = 'khach_vang_lai'`).first();
    expect(txCount.n).toBe(0);

    const auditRow = await env.DB.prepare(`SELECT action_type, actor FROM audit_log WHERE entity_type = 'dine_in_order' AND entity_id = ?`).bind(orderId).first();
    expect(auditRow).toEqual({ action_type: 'dine_in_order_void', actor: 'le_tan_order' });
  });

  it('rejects voiding an order that is not open (400)', async () => {
    await env.DB.prepare(`UPDATE dine_in_orders SET status = 'closed' WHERE id = ?`).bind(orderId).run();
    const response = await voidOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/void`, receptionToken, 'POST'), env, params: { id: String(orderId) } });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/dine-in-orders/:id/close', () => {
  let orderId;
  beforeEach(async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn 9', 'open', 'le_tan_order', '2026-09-04T08:00:00Z')`).run();
    orderId = order.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO dine_in_order_items (order_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Mì Quảng', 45000, 2, 90000, 'posted', 'le_tan_order', '2026-09-04T08:05:00Z')`).bind(orderId).run();
    await env.DB.prepare(`INSERT INTO dine_in_order_items (order_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Cà phê', 25000, 1, 25000, 'voided', 'le_tan_order', '2026-09-04T08:06:00Z')`).bind(orderId).run();
  });

  it('rejects unauthenticated requests', async () => {
    const response = await closeOrder({ request: new Request(`https://x/api/dine-in-orders/${orderId}/close`, { method: 'POST' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await closeOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/close`, observerToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent order', async () => {
    const response = await closeOrder({ request: authedRequest('https://x/api/dine-in-orders/999999/close', receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects a missing/invalid paymentMethod (400)', async () => {
    const response = await closeOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/close`, receptionToken, 'POST', {}), env, params: { id: String(orderId) } });
    expect(response.status).toBe(400);
  });

  it('closes the order, computing total from posted items only, and creates exactly one finance_transactions row', async () => {
    const response = await closeOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/close`, receptionToken, 'POST', { paymentMethod: 'transfer' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalAmount).toBe(90000);

    const orderRow = await env.DB.prepare(`SELECT status, closed_by, payment_method, total_amount, finance_transaction_id FROM dine_in_orders WHERE id = ?`).bind(orderId).first();
    expect(orderRow).toEqual({ status: 'closed', closed_by: 'le_tan_order', payment_method: 'transfer', total_amount: 90000, finance_transaction_id: body.financeTransactionId });

    const txRows = await env.DB.prepare(`SELECT type, category, amount, status FROM finance_transactions WHERE id = ?`).bind(body.financeTransactionId).first();
    expect(txRows).toEqual({ type: 'income', category: 'khach_vang_lai', amount: 90000, status: 'confirmed' });

    const txCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions WHERE category = 'khach_vang_lai'`).first();
    expect(txCount.n).toBe(1);
  });

  it('rejects closing an order with zero posted items (400)', async () => {
    await env.DB.exec(`DELETE FROM dine_in_order_items WHERE order_id = ${orderId}`);
    const response = await closeOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/close`, receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(400);
  });

  it('rejects closing an order that is not open (400)', async () => {
    await env.DB.prepare(`UPDATE dine_in_orders SET status = 'voided' WHERE id = ?`).bind(orderId).run();
    const response = await closeOrder({ request: authedRequest(`https://x/api/dine-in-orders/${orderId}/close`, receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(orderId) } });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 5: Chạy test**

Run: `cd v4 && npx vitest run test/dineInOrders.test.js`
Expected: PASS (33 tests: 21 từ Task 3+4 + 12 mới). Cũng chạy `npx vitest run test/auditLog.test.js` — expect PASS.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/dine-in-orders admin/audit-log.js admin/audit-log.html functions/api/audit-log/index.js test/dineInOrders.test.js
git commit -m "feat: add dine-in order void/close endpoints, integrate close with finance_transactions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Client — trang quản lý Menu quán (admin)

**Files:**
- Create: `v4/admin/dine-in-menu.html`
- Create: `v4/admin/dine-in-menu.js`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`

**Interfaces:**
- Consumes: `GET/POST /api/dine-in-menu`, `PATCH /api/dine-in-menu/:id` (Task 2).
- Produces: trang `/admin/dine-in-menu.html`, không có interface nào task sau dùng lại.

- [ ] **Step 1: Tạo trang HTML**

Tạo `v4/admin/dine-in-menu.html`:

```html
<!-- v4/admin/dine-in-menu.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Menu quán — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Menu quán</h1>
    <p id="pageError" class="error"></p>

    <h2>Món ăn</h2>
    <div class="table-scroll">
      <table id="monAnTable">
        <thead><tr><th>Tên món</th><th>Giá</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <form id="monAnAddForm" class="hidden">
      <label>Tên món ăn mới <input type="text" name="name" required /></label>
      <label>Giá (đ) <input type="number" name="price" min="1" step="1" required /></label>
      <button type="submit">+ Thêm món</button>
      <p id="monAnAddError" class="error"></p>
    </form>

    <h2>Thức uống</h2>
    <div class="table-scroll">
      <table id="doUongTable">
        <thead><tr><th>Tên món</th><th>Giá</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <form id="doUongAddForm" class="hidden">
      <label>Tên thức uống mới <input type="text" name="name" required /></label>
      <label>Giá (đ) <input type="number" name="price" min="1" step="1" required /></label>
      <button type="submit">+ Thêm thức uống</button>
      <p id="doUongAddError" class="error"></p>
    </form>
  </div>

  <script src="/admin/dine-in-menu.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Tạo trang JS**

Tạo `v4/admin/dine-in-menu.js`:

```js
// v4/admin/dine-in-menu.js
let currentRole = null;
let menuItems = [];

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
    document.getElementById('monAnAddForm').classList.remove('hidden');
    document.getElementById('doUongAddForm').classList.remove('hidden');
  }

  await loadMenu();
})();

async function loadMenu() {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch('/api/dine-in-menu');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải menu';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải menu';
    return;
  }
  menuItems = await response.json();
  renderTable('mon_an', document.querySelector('#monAnTable tbody'));
  renderTable('do_uong', document.querySelector('#doUongTable tbody'));
}

function renderTable(category, tbody) {
  tbody.innerHTML = '';
  menuItems.filter((m) => m.category === category).forEach((m) => {
    const tr = document.createElement('tr');
    if (!m.isActive) tr.style.opacity = '0.5';

    const tdName = document.createElement('td');
    tdName.textContent = m.name;

    const tdPrice = document.createElement('td');
    tdPrice.textContent = `${m.price.toLocaleString('vi-VN')}đ`;

    const tdStatus = document.createElement('td');
    tdStatus.textContent = m.isActive ? 'Đang bán' : 'Đã ẩn';

    const tdActions = document.createElement('td');
    if (currentRole === 'admin') {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => editItem(m));
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn-secondary';
      toggleBtn.textContent = m.isActive ? 'Ẩn' : 'Hiện lại';
      toggleBtn.addEventListener('click', () => toggleActive(m));
      tdActions.append(editBtn, toggleBtn);
    }

    tr.append(tdName, tdPrice, tdStatus, tdActions);
    tbody.appendChild(tr);
  });
}

async function editItem(item) {
  const newName = window.prompt('Tên món mới:', item.name);
  if (newName === null) return;
  const trimmedName = newName.trim();
  if (!trimmedName) return;

  const newPriceStr = window.prompt('Giá mới (đ):', String(item.price));
  if (newPriceStr === null) return;
  const newPrice = Number(newPriceStr);
  const errorEl = document.getElementById('pageError');
  if (!Number.isInteger(newPrice) || newPrice <= 0) {
    errorEl.textContent = 'Giá không hợp lệ';
    return;
  }

  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-menu/${item.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmedName, price: newPrice }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi sửa món';
    return;
  }
  await loadMenu();
}

async function toggleActive(item) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-menu/${item.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !item.isActive }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi cập nhật món';
    return;
  }
  await loadMenu();
}

function wireAddForm(formId, errorId, category) {
  const form = document.getElementById(formId);
  const errorEl = document.getElementById(errorId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const name = form.querySelector('[name="name"]').value.trim();
    const price = Number(form.querySelector('[name="price"]').value);
    if (!name) {
      errorEl.textContent = 'Vui lòng nhập tên món';
      return;
    }
    if (!Number.isInteger(price) || price <= 0) {
      errorEl.textContent = 'Vui lòng nhập giá hợp lệ';
      return;
    }
    const response = await fetch('/api/dine-in-menu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, price }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi thêm món';
      return;
    }
    form.reset();
    await loadMenu();
  });
}

wireAddForm('monAnAddForm', 'monAnAddError', 'mon_an');
wireAddForm('doUongAddForm', 'doUongAddError', 'do_uong');
```

- [ ] **Step 3: Đăng ký vào nav-drawer**

Trong `v4/admin/nav-drawer.js`, thêm 1 dòng vào `NAV_GROUPS`, nhóm `'Cấu hình & Quản trị'`, ngay sau dòng `{ page: 'finance-categories.html', label: 'Danh mục Sổ thu chi', icon: '🏷️', roles: ['admin'] },`:

```js
      { page: 'dine-in-menu.html', label: 'Menu quán', icon: '📋', roles: ['admin'] },
```

Trong cùng file, thêm vào `pageSlug` object (biến cục bộ trong `buildDrawer`), sau `'finance-categories.html': 'finance-categories',`:

```js
'dine-in-menu.html': 'dine-in-menu',
```

- [ ] **Step 4: Thêm redirect**

Trong `v4/_redirects`, thêm 1 dòng ngay sau dòng `/manager/finance-categories     /admin/finance-categories   200`:

```
/manager/dine-in-menu           /admin/dine-in-menu     200
```

- [ ] **Step 5: Kiểm tra thủ công**

Từ `v4/`: `npx http-server . -p 8899 -s -c-1` (chạy nền). Mở `http://localhost:8899/admin/dine-in-menu.html` — sẽ chuyển hướng về `/admin` vì không có session thật trên static server (đúng như mong đợi, xác nhận đoạn code kiểm tra auth chạy không lỗi). Dừng server sau khi kiểm tra.

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/dine-in-menu.html admin/dine-in-menu.js admin/nav-drawer.js _redirects
git commit -m "feat: add dine-in menu management page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Client — Board các bàn đang mở

**Files:**
- Create: `v4/admin/dine-in-orders.html`
- Create: `v4/admin/dine-in-orders.js`
- Modify: `v4/admin/admin.css`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`

**Interfaces:**
- Consumes: `GET /api/dine-in-orders?status=open`, `POST /api/dine-in-orders` (Task 3).
- Produces: trang `/admin/dine-in-orders.html`, điều hướng tới `/admin/dine-in-order-detail.html?orderId={id}` (Task 8 dùng route này).

- [ ] **Step 1: Thêm CSS cho board**

Trong `v4/admin/admin.css`, thêm vào cuối file:

```css
.dine-orders-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.dine-order-card {
  background: rgba(245, 240, 230, 0.06);
  border: 1px solid rgba(245, 240, 230, 0.15);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 0.85rem;
  cursor: pointer;
}
.dine-order-card .table-label { font-weight: 600; margin-bottom: 4px; }
.dine-order-card .order-total { color: var(--gold); font-weight: 600; }
```

- [ ] **Step 2: Tạo trang HTML**

Tạo `v4/admin/dine-in-orders.html`:

```html
<!-- v4/admin/dine-in-orders.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Order ăn uống — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Order ăn uống</h1>
    <p id="pageError" class="error"></p>

    <form id="openTableForm" class="hidden">
      <label>Số bàn <input type="text" name="tableLabel" required maxlength="100" /></label>
      <label>Ghi chú <input type="text" name="note" maxlength="500" /></label>
      <button type="submit">➕ Mở bàn mới</button>
      <p id="openTableError" class="error"></p>
    </form>

    <div id="ordersGrid" class="dine-orders-grid"></div>
    <p id="emptyState" class="hidden">Không có bàn nào đang mở.</p>
  </div>

  <script src="/admin/dine-in-orders.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Tạo trang JS**

Tạo `v4/admin/dine-in-orders.js`:

```js
// v4/admin/dine-in-orders.js
let currentRole = null;

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

  if (currentRole !== 'observer') {
    document.getElementById('openTableForm').classList.remove('hidden');
  }

  await loadOrders();
})();

async function loadOrders() {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch('/api/dine-in-orders?status=open');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải danh sách bàn';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải danh sách bàn';
    return;
  }
  const orders = await response.json();
  renderGrid(orders);
}

function renderGrid(orders) {
  const grid = document.getElementById('ordersGrid');
  const emptyState = document.getElementById('emptyState');
  grid.innerHTML = '';
  if (orders.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  orders.forEach((o) => {
    const card = document.createElement('div');
    card.className = 'dine-order-card';

    const tableLabel = document.createElement('div');
    tableLabel.className = 'table-label';
    tableLabel.textContent = o.tableLabel;

    const total = document.createElement('div');
    total.className = 'order-total';
    total.textContent = `${o.currentTotal.toLocaleString('vi-VN')}đ`;

    const opened = document.createElement('div');
    opened.textContent = `Mở lúc: ${new Date(o.openedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;

    card.append(tableLabel, total, opened);
    card.addEventListener('click', () => {
      window.location.href = `/admin/dine-in-order-detail.html?orderId=${o.id}`;
    });
    grid.appendChild(card);
  });
}

document.getElementById('openTableForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('openTableError');
  errorEl.textContent = '';
  const form = event.target;
  const tableLabel = form.querySelector('[name="tableLabel"]').value.trim();
  const note = form.querySelector('[name="note"]').value.trim();
  if (!tableLabel) {
    errorEl.textContent = 'Vui lòng nhập số bàn';
    return;
  }
  const response = await fetch('/api/dine-in-orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tableLabel, note: note || undefined }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi mở bàn';
    return;
  }
  const result = await response.json();
  window.location.href = `/admin/dine-in-order-detail.html?orderId=${result.id}`;
});
```

- [ ] **Step 4: Đăng ký vào nav-drawer**

Trong `v4/admin/nav-drawer.js`, thêm 1 dòng vào `NAV_GROUPS`, nhóm `'Vận hành'`, ngay sau dòng `{ page: 'reception.html', label: 'Vận hành hôm nay', icon: '🛎️', roles: ['reception', 'manager', 'admin', 'observer'] },`:

```js
      { page: 'dine-in-orders.html', label: 'Order ăn uống', icon: '🍽️', roles: ['reception', 'manager', 'admin', 'observer'] },
```

Trong cùng file, thêm vào `pageSlug` object, sau `'reception.html'` không có (reception.html không nằm trong pageSlug map — nó là `urlFor` case đặc biệt), nên thêm ngay sau `'dashboard.html': 'dashboard',`:

```js
'dine-in-orders.html': 'dine-in-orders',
```

- [ ] **Step 5: Thêm redirect**

Trong `v4/_redirects`, thêm 1 dòng ngay sau `/manager/change-password      /admin/change-password 200` (dòng cuối khối `/manager/...`):

```
/manager/dine-in-orders         /admin/dine-in-orders   200
```

Thêm 1 dòng ngay sau `/reception/change-password    /admin/change-password 200` (dòng cuối khối `/reception/...`):

```
/reception/dine-in-orders       /admin/dine-in-orders   200
```

Thêm 1 dòng ngay sau `/observer/change-password      /admin/change-password 200` (dòng cuối khối `/observer/...`):

```
/observer/dine-in-orders        /admin/dine-in-orders   200
```

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/dine-in-orders.html admin/dine-in-orders.js admin/admin.css admin/nav-drawer.js _redirects
git commit -m "feat: add dine-in orders board page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Client — Chi tiết order (gọi món, chốt) + In hoá đơn

**Files:**
- Create: `v4/admin/dine-in-order-detail.html`
- Create: `v4/admin/dine-in-order-detail.js`
- Create: `v4/admin/dine-in-order-print.html`
- Create: `v4/admin/dine-in-order-print.js`

**Interfaces:**
- Consumes: `GET /api/dine-in-menu` (Task 2), `GET /api/dine-in-orders/:id`, `POST /api/dine-in-orders/:id/items`, `PATCH /api/dine-in-orders/:id/items/:itemId`, `POST /api/dine-in-orders/:id/void`, `POST /api/dine-in-orders/:id/close` (Task 3/4/5).
- Produces: `window.open('/admin/dine-in-order-print.html?orderId={id}', '_blank')` — không có interface nào task sau dùng lại (Task 9 test trực tiếp qua URL).

- [ ] **Step 1: Tạo trang chi tiết HTML**

Tạo `v4/admin/dine-in-order-detail.html`:

```html
<!-- v4/admin/dine-in-order-detail.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Chi tiết order — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1 id="pageTitle">Chi tiết bàn</h1>
    <p id="pageError" class="error"></p>

    <div id="itemsList" class="services-section"></div>

    <form id="addItemForm" class="add-service-form hidden">
      <select name="menuItemId" required></select>
      <input type="number" name="quantity" min="1" step="1" value="1" required />
      <button type="submit">+ Thêm món</button>
    </form>
    <p id="addItemError" class="error"></p>

    <p id="orderTotal"></p>

    <div id="closeSection" class="hidden">
      <label class="checkbox-label"><input type="radio" name="paymentMethod" value="cash" /> 💵 Tiền mặt</label>
      <label class="checkbox-label"><input type="radio" name="paymentMethod" value="transfer" /> 🏦 Chuyển khoản</label>
      <button type="button" id="closeBtn" disabled>✅ Chốt & Thanh toán</button>
      <button type="button" id="voidBtn" class="btn-secondary">❌ Huỷ bàn</button>
      <p id="closeError" class="error"></p>
    </div>

    <button type="button" id="printBtn" class="hidden">🖨 In hoá đơn</button>
  </div>

  <script src="/admin/dine-in-order-detail.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Tạo trang chi tiết JS**

Tạo `v4/admin/dine-in-order-detail.js`:

```js
// v4/admin/dine-in-order-detail.js
let currentRole = null;
let currentOrder = null;
let menuItems = [];

function orderIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('orderId');
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

  const orderId = orderIdFromQuery();
  if (!orderId) {
    document.getElementById('pageError').textContent = 'Thiếu mã order';
    return;
  }

  if (currentRole !== 'observer') {
    let menuResponse;
    try {
      menuResponse = await fetch('/api/dine-in-menu');
    } catch (err) {
      document.getElementById('pageError').textContent = 'Có lỗi khi tải menu';
      return;
    }
    if (menuResponse.ok) {
      menuItems = (await menuResponse.json()).filter((m) => m.isActive);
      populateMenuSelect();
    }
  }

  await loadOrder(orderId);
})();

function populateMenuSelect() {
  const select = document.querySelector('#addItemForm select[name="menuItemId"]');
  select.innerHTML = '<option value="">-- Chọn món --</option>';
  const groups = { mon_an: 'Món ăn', do_uong: 'Thức uống' };
  Object.entries(groups).forEach(([category, label]) => {
    const items = menuItems.filter((m) => m.category === category);
    if (items.length === 0) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = label;
    items.forEach((m) => {
      const option = document.createElement('option');
      option.value = m.id;
      option.textContent = `${m.name} — ${m.price.toLocaleString('vi-VN')}đ`;
      optgroup.appendChild(option);
    });
    select.appendChild(optgroup);
  });
}

async function loadOrder(orderId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/dine-in-orders/${orderId}`);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải order';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải order';
    return;
  }
  currentOrder = await response.json();
  render();
}

function render() {
  const o = currentOrder;
  document.getElementById('pageTitle').textContent = `Bàn: ${o.tableLabel}`;

  const list = document.getElementById('itemsList');
  list.innerHTML = '';
  o.items.forEach((item) => {
    const line = document.createElement('div');
    line.className = 'service-line';
    if (item.status === 'voided') line.style.textDecoration = 'line-through';

    const label = document.createElement('span');
    label.textContent = `${item.name} ×${item.quantity} — ${item.amount.toLocaleString('vi-VN')}đ`;
    line.appendChild(label);

    if (item.status === 'posted' && currentOrder.status === 'open' && currentRole !== 'observer') {
      const voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'btn-secondary';
      voidBtn.textContent = 'Huỷ dòng';
      voidBtn.addEventListener('click', () => voidItem(item.id));
      line.appendChild(voidBtn);
    }

    list.appendChild(line);
  });

  const currentTotal = o.items.filter((i) => i.status === 'posted').reduce((sum, i) => sum + i.amount, 0);
  document.getElementById('orderTotal').textContent = `Tổng: ${currentTotal.toLocaleString('vi-VN')}đ`;

  const addForm = document.getElementById('addItemForm');
  const closeSection = document.getElementById('closeSection');
  const printBtn = document.getElementById('printBtn');

  if (o.status === 'open' && currentRole !== 'observer') {
    addForm.classList.remove('hidden');
    closeSection.classList.remove('hidden');
  } else {
    addForm.classList.add('hidden');
    closeSection.classList.add('hidden');
  }

  if (o.status === 'closed') {
    printBtn.classList.remove('hidden');
  } else {
    printBtn.classList.add('hidden');
  }
}

document.getElementById('addItemForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('addItemError');
  errorEl.textContent = '';
  const form = event.target;
  const menuItemId = Number(form.querySelector('[name="menuItemId"]').value);
  const quantity = Number(form.querySelector('[name="quantity"]').value);
  if (!menuItemId) {
    errorEl.textContent = 'Vui lòng chọn món';
    return;
  }
  const response = await fetch(`/api/dine-in-orders/${currentOrder.id}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ menuItemId, quantity }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi thêm món';
    return;
  }
  form.reset();
  form.querySelector('[name="quantity"]').value = 1;
  await loadOrder(currentOrder.id);
});

async function voidItem(itemId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-orders/${currentOrder.id}/items/${itemId}`, { method: 'PATCH' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi huỷ dòng';
    return;
  }
  await loadOrder(currentOrder.id);
}

document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    document.getElementById('closeBtn').disabled = false;
  });
});

document.getElementById('closeBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('closeError');
  errorEl.textContent = '';
  const selected = document.querySelector('input[name="paymentMethod"]:checked');
  if (!selected) {
    errorEl.textContent = 'Vui lòng chọn hình thức thanh toán';
    return;
  }
  const response = await fetch(`/api/dine-in-orders/${currentOrder.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentMethod: selected.value }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi chốt order';
    return;
  }
  await loadOrder(currentOrder.id);
});

document.getElementById('voidBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('closeError');
  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-orders/${currentOrder.id}/void`, { method: 'POST' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi huỷ bàn';
    return;
  }
  window.location.href = '/admin/dine-in-orders.html';
});

document.getElementById('printBtn').addEventListener('click', () => {
  window.open(`/admin/dine-in-order-print.html?orderId=${currentOrder.id}`, '_blank');
});
```

- [ ] **Step 3: Tạo trang in HTML**

Tạo `v4/admin/dine-in-order-print.html` (không có `nav-drawer.js` — trang in không cần menu điều hướng, giống `stay-registration-print.html`):

```html
<!-- v4/admin/dine-in-order-print.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Hoá đơn — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
  <style>
    .form-print { background: #fff; color: #111; padding: 32px; max-width: 700px; margin: 0 auto; font-family: 'Inter', sans-serif; }
    .form-print h2 { text-align: center; margin-bottom: 4px; color: #111; }
    .form-print .subtitle { text-align: center; margin-top: 0; margin-bottom: 24px; opacity: 0.7; }
    .form-print table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .form-print th, .form-print td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
    .form-print th:last-child, .form-print td:last-child { text-align: right; }
    .form-print .total-row td { font-weight: 600; border-top: 2px solid #111; border-bottom: none; }
    .form-print dl { display: grid; grid-template-columns: 160px 1fr; gap: 4px 12px; margin: 0 0 16px; }
    .form-print dt { font-weight: 600; }
    .form-print dd { margin: 0; }
    @media print {
      .no-print { display: none !important; }
      .form-print { padding: 0; }
    }
  </style>
</head>
<body>
  <div class="page page-wide no-print">
    <h1>In hoá đơn</h1>
    <p id="pageError" class="error"></p>
    <button type="button" id="printBtn">🖨 In</button>
  </div>

  <div id="formPrint" class="form-print"></div>

  <script src="/admin/dine-in-order-print.js"></script>
</body>
</html>
```

- [ ] **Step 4: Tạo trang in JS**

Tạo `v4/admin/dine-in-order-print.js`:

```js
// v4/admin/dine-in-order-print.js
function orderIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('orderId');
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

  const orderId = orderIdFromQuery();
  if (!orderId) {
    document.getElementById('pageError').textContent = 'Thiếu mã order';
    return;
  }

  await loadOrder(orderId);
})();

async function loadOrder(orderId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/dine-in-orders/${orderId}`);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải order';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải order';
    return;
  }
  const order = await response.json();
  renderInvoice(order);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('vi-VN');
}

function renderInvoice(order) {
  const el = document.getElementById('formPrint');
  el.innerHTML = '';

  const h2 = document.createElement('h2');
  h2.textContent = 'HOÁ ĐƠN ĂN UỐNG';
  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'Hiền Lê Garden';

  const dl = document.createElement('dl');
  const rows = [
    ['Bàn', order.tableLabel],
    ['Giờ mở', formatDateTime(order.openedAt)],
    ['Giờ chốt', order.closedAt ? formatDateTime(order.closedAt) : ''],
    ['Hình thức thanh toán', order.paymentMethod === 'cash' ? 'Tiền mặt' : order.paymentMethod === 'transfer' ? 'Chuyển khoản' : ''],
  ];
  rows.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  });

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Món</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr>';
  const tbody = document.createElement('tbody');
  let total = 0;
  order.items.filter((i) => i.status === 'posted').forEach((item) => {
    total += item.amount;
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    const tdQty = document.createElement('td');
    tdQty.textContent = item.quantity;
    const tdPrice = document.createElement('td');
    tdPrice.textContent = `${item.unitPrice.toLocaleString('vi-VN')}đ`;
    const tdAmount = document.createElement('td');
    tdAmount.textContent = `${item.amount.toLocaleString('vi-VN')}đ`;
    tr.append(tdName, tdQty, tdPrice, tdAmount);
    tbody.appendChild(tr);
  });
  const totalRow = document.createElement('tr');
  totalRow.className = 'total-row';
  totalRow.innerHTML = `<td colspan="3">Tổng cộng</td><td>${total.toLocaleString('vi-VN')}đ</td>`;
  tbody.appendChild(totalRow);
  table.append(thead, tbody);

  el.append(h2, subtitle, dl, table);
}

document.getElementById('printBtn').addEventListener('click', () => {
  window.print();
});
```

- [ ] **Step 5: Kiểm tra thủ công**

Từ `v4/`: `npx http-server . -p 8899 -s -c-1` (chạy nền). Mở `http://localhost:8899/admin/dine-in-order-detail.html?orderId=1` và `http://localhost:8899/admin/dine-in-order-print.html?orderId=1` — cả hai sẽ chuyển hướng về `/admin` vì không có session thật (đúng như mong đợi). Dừng server sau khi kiểm tra.

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/dine-in-order-detail.html admin/dine-in-order-detail.js admin/dine-in-order-print.html admin/dine-in-order-print.js
git commit -m "feat: add dine-in order detail page (add/void items, close, void) and print invoice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: E2e coverage (outer repo)

**Files:**
- Create: `LandingPage/tests/e2e/dine-in-orders.spec.js` (outer repo)

**Interfaces:**
- Consumes: DOM contract của `admin/dine-in-order-detail.html`/`.js` và `admin/dine-in-order-print.html`/`.js` (Task 8).

- [ ] **Step 1: Viết e2e test**

Tạo `tests/e2e/dine-in-orders.spec.js` (outer repo):

```js
// tests/e2e/dine-in-orders.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role }) }));
}

const MENU_ITEMS = [
  { id: 1, name: 'Mì Quảng', category: 'mon_an', price: 45000, displayOrder: 1, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z' },
  { id: 2, name: 'Cà phê đen', category: 'do_uong', price: 25000, displayOrder: 1, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z' },
];

function baseOrder(overrides) {
  return {
    id: 42, tableLabel: 'Bàn 3', note: null, status: 'open',
    openedBy: 'le_tan_a', openedAt: '2026-09-04T08:00:00Z',
    closedBy: null, closedAt: null, paymentMethod: null, totalAmount: null,
    items: [],
    ...overrides,
  };
}

test.describe('Dine-in order detail page', () => {
  test('adding items updates the total, voiding a line removes it from the total', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));

    let order = baseOrder();
    let nextItemId = 1;
    await page.route('**/api/dine-in-orders/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) });
    });
    await page.route('**/api/dine-in-orders/42/items', (route) => {
      const body = route.request().postDataJSON();
      const menuItem = MENU_ITEMS.find((m) => m.id === body.menuItemId);
      const item = { id: nextItemId++, menuItemId: menuItem.id, name: menuItem.name, unitPrice: menuItem.price, quantity: body.quantity, amount: menuItem.price * body.quantity, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null };
      order = { ...order, items: [...order.items, item] };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: item.id, ok: true }) });
    });
    await page.route('**/api/dine-in-orders/42/items/*', (route) => {
      const itemId = Number(route.request().url().split('/').pop());
      order = { ...order, items: order.items.map((i) => (i.id === itemId ? { ...i, status: 'voided' } : i)) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await expect(page.locator('#pageTitle')).toContainText('Bàn 3');

    await page.selectOption('select[name="menuItemId"]', '1');
    await page.fill('input[name="quantity"]', '2');
    await page.click('#addItemForm button[type="submit"]');
    await expect(page.locator('#orderTotal')).toContainText('90.000');

    await page.selectOption('select[name="menuItemId"]', '2');
    await page.fill('input[name="quantity"]', '1');
    await page.click('#addItemForm button[type="submit"]');
    await expect(page.locator('#orderTotal')).toContainText('115.000');

    await page.click('#itemsList button:has-text("Huỷ dòng")');
    await expect(page.locator('#orderTotal')).toContainText('70.000');
  });

  test('close button stays disabled until a payment method is chosen', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    const order = baseOrder({ items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/dine-in-orders/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) }));

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await expect(page.locator('#closeBtn')).toBeDisabled();
    await page.check('input[name="paymentMethod"][value="cash"]');
    await expect(page.locator('#closeBtn')).toBeEnabled();
  });

  test('closing the order posts the chosen payment method and shows the print button', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    let order = baseOrder({ items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    let closedBody = null;
    await page.route('**/api/dine-in-orders/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) });
    });
    await page.route('**/api/dine-in-orders/42/close', (route) => {
      closedBody = route.request().postDataJSON();
      order = { ...order, status: 'closed', paymentMethod: closedBody.paymentMethod, closedAt: '2026-09-04T09:00:00Z', totalAmount: 45000 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, totalAmount: 45000, financeTransactionId: 7 }) });
    });

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await page.check('input[name="paymentMethod"][value="cash"]');
    await page.click('#closeBtn');

    await expect.poll(() => closedBody).toMatchObject({ paymentMethod: 'cash' });
    await expect(page.locator('#printBtn')).toBeVisible();
  });

  test('observer sees no action controls', async ({ page }) => {
    await mockAuth(page, 'observer');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    const order = baseOrder({ items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/dine-in-orders/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) }));

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await expect(page.locator('#addItemForm')).toBeHidden();
    await expect(page.locator('#closeSection')).toBeHidden();
  });
});

test.describe('Dine-in order invoice print page', () => {
  test('renders items and total, print button calls window.print()', async ({ page }) => {
    await mockAuth(page, 'reception');
    const order = baseOrder({
      status: 'closed', paymentMethod: 'cash', closedAt: '2026-09-04T09:00:00Z', totalAmount: 45000,
      items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }],
    });
    await page.route('**/api/dine-in-orders/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) }));

    await page.goto('/admin/dine-in-order-print.html?orderId=42');
    await expect(page.locator('#formPrint')).toContainText('Mì Quảng');
    await expect(page.locator('#formPrint')).toContainText('45.000');
    await expect(page.locator('#formPrint')).toContainText('Bàn 3');

    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printBtn');
    const called = await page.evaluate(() => window.__printCalled);
    expect(called).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy spec mới**

Từ `LandingPage/` (outer repo root): `npx playwright test tests/e2e/dine-in-orders.spec.js --project=v4`
Expected: PASS — 5/5.

- [ ] **Step 3: Chạy toàn bộ project v4 để kiểm tra hồi quy**

`npx playwright test --project=v4`
Expected: PASS — toàn bộ test trong project v4, bao gồm spec mới và mọi spec trước đó (`reception-ops-board.spec.js`, `finance-dashboard.spec.js`, `finance-categories.spec.js`, `stay-registration-print.spec.js`...).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dine-in-orders.spec.js
git commit -m "test: e2e coverage for dine-in order taking and invoice printing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0021 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), xác nhận Cloudflare Pages deploy thành công.
3. Push outer repo (thêm e2e test).
4. Smoke-test thực tế: đăng nhập reception/manager, vào "Order ăn uống", mở 1 bàn test, gọi 2 món, huỷ 1 dòng, chốt (chọn tiền mặt), xác nhận tổng đúng + xuất hiện dòng "Khách vãng lai" trong Sổ thu chi đúng số tiền, in hoá đơn xem đúng nội dung. Dọn sạch dữ liệu test sau khi xong (huỷ giao dịch/xoá bản ghi test qua SQL trực tiếp).
