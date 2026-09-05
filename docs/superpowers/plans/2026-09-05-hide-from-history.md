# Ẩn khỏi lịch sử Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép admin ẩn bản ghi đã ở trạng thái kết thúc (phiên Giờ Xanh đã chốt/huỷ, bàn Order ăn uống đã chốt/huỷ, đặt phòng đã trả phòng/đã huỷ) khỏi danh sách hiển thị hàng ngày, không xoá dữ liệu; chỉ admin thấy checkbox "Hiển thị các log đã ẩn" để xem lại.

**Architecture:** Lặp lại 1 mẫu nhỏ ở 3 bảng độc lập (`gio_xanh_sessions`, `dine_in_orders`, `bookings`): thêm cột `is_hidden`, GET endpoint hiện có lọc bỏ theo mặc định (thêm `includeHidden=1` chỉ admin dùng được), 1 endpoint `PATCH .../:id/hide` mới mỗi hệ thống. Giờ Xanh và Order ăn uống cần thêm mới khu vực "Lịch sử" trên trang board (hiện chưa có); trang lễ tân (`reception.html`) cũng cần thêm mới khu vực "Lịch sử đặt phòng" tương tự (xác nhận qua code thật: không có danh sách nào hiện tại hiển thị đặt phòng `checked_out`/`cancelled`).

**Tech Stack:** Cloudflare Pages Functions + D1 (SQLite), vanilla JS admin frontend (không build step), Playwright cho e2e.

**Spec:** docs/superpowers/specs/2026-09-05-hide-from-history-design.md

## Global Constraints

- Không xoá cứng — "ẩn" chỉ đổi cột `is_hidden`, dữ liệu giữ nguyên.
- Chỉ được ẩn bản ghi đã ở trạng thái kết thúc: `gio_xanh_sessions`/`dine_in_orders` → `status IN ('closed','voided')`; `bookings` → `status IN ('checked_out','cancelled')`. Cố ẩn bản ghi khác trạng thái → `400`.
- `PATCH .../:id/hide` — role `admin` only ở cả 3 hệ thống. Body `{ hidden: boolean }` bắt buộc.
- `includeHidden=1` trên GET chỉ có tác dụng khi `auth.role === 'admin'`; role khác gửi thì bị bỏ qua lặng lẽ (không lỗi).
- Đăng ký đúng 1 action_type audit_log mới, dùng chung cho cả 3 hệ thống: `record_hide` — đăng ký ở cả 3 nơi bắt buộc (`admin/audit-log.js`, `admin/audit-log.html`, `functions/api/audit-log/index.js`), chỉ đăng ký 1 lần (Task 2).
- Khu vực "Lịch sử" ở Giờ Xanh/Order ăn uống/Đặt phòng hiển thị cho MỌI role đã đăng nhập (không chỉ admin) — chỉ riêng checkbox "Hiển thị các log đã ẩn" và nút Ẩn/Hiện mới giới hạn admin-only.
- Dùng đúng class CSS checkbox có sẵn `label.checkbox` (định nghĩa toàn cục trong `admin.css`) cho checkbox mới — KHÔNG dùng `.checkbox-label` (class đó chỉ có style khi nằm trong `.add-service-form`, dùng sai sẽ không có giao diện).
- Không dùng `window.confirm()` ở bất kỳ đâu (quy ước codebase).
- Mọi endpoint dùng `env.DB.prepare(...).bind(...)` tham số hoá.

---

### Task 1: Migration — thêm `is_hidden` vào 3 bảng

**Files:**
- Create: `v4/migrations/0025_hide_from_history.sql`
- Test: `v4/test/migrations.test.js` (thêm `describe('migration 0025', ...)` vào cuối file)

**Interfaces:**
- Produces: cột `is_hidden INTEGER NOT NULL DEFAULT 0` trên `gio_xanh_sessions`, `dine_in_orders`, `bookings`. Mọi task sau dùng đúng tên cột này.

- [ ] **Step 1: Viết migration**

Tạo `v4/migrations/0025_hide_from_history.sql`:

```sql
-- v4/migrations/0025_hide_from_history.sql

ALTER TABLE gio_xanh_sessions ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dine_in_orders ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Viết test**

Thêm vào cuối `v4/test/migrations.test.js`:

```js
describe('migration 0025', () => {
  it('adds is_hidden defaulting to 0 on gio_xanh_sessions, dine_in_orders, and bookings', async () => {
    const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();

    const sessionInsert = await env.DB.prepare(
      `INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Test Guest', 'open', 'system', '2026-09-05T00:00:00Z')`
    ).bind(roomRow.id).run();
    const sessionRow = await env.DB.prepare(`SELECT is_hidden FROM gio_xanh_sessions WHERE id = ?`).bind(sessionInsert.meta.last_row_id).first();
    expect(sessionRow.is_hidden).toBe(0);

    const orderInsert = await env.DB.prepare(
      `INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn Test', 'open', 'system', '2026-09-05T00:00:00Z')`
    ).run();
    const orderRow = await env.DB.prepare(`SELECT is_hidden FROM dine_in_orders WHERE id = ?`).bind(orderInsert.meta.last_row_id).first();
    expect(orderRow.is_hidden).toBe(0);

    const bookingInsert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest', '0900000000', 'circle', '2026-09-10', '2026-09-11', 'pending', 'phone', '2026-09-05T00:00:00Z')`
    ).run();
    const bookingRow = await env.DB.prepare(`SELECT is_hidden FROM bookings WHERE id = ?`).bind(bookingInsert.meta.last_row_id).first();
    expect(bookingRow.is_hidden).toBe(0);
  });

  it('accepts is_hidden = 1 on all three tables', async () => {
    const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();

    const sessionInsert = await env.DB.prepare(
      `INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at, is_hidden) VALUES (?, 'Test Guest', 'closed', 'system', '2026-09-05T00:00:00Z', 1)`
    ).bind(roomRow.id).run();
    const sessionRow = await env.DB.prepare(`SELECT is_hidden FROM gio_xanh_sessions WHERE id = ?`).bind(sessionInsert.meta.last_row_id).first();
    expect(sessionRow.is_hidden).toBe(1);

    const orderInsert = await env.DB.prepare(
      `INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at, is_hidden) VALUES ('Bàn Test', 'closed', 'system', '2026-09-05T00:00:00Z', 1)`
    ).run();
    const orderRow = await env.DB.prepare(`SELECT is_hidden FROM dine_in_orders WHERE id = ?`).bind(orderInsert.meta.last_row_id).first();
    expect(orderRow.is_hidden).toBe(1);

    const bookingInsert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at, is_hidden) VALUES ('Test Guest', '0900000000', 'circle', '2026-09-10', '2026-09-11', 'cancelled', 'phone', '2026-09-05T00:00:00Z', 1)`
    ).run();
    const bookingRow = await env.DB.prepare(`SELECT is_hidden FROM bookings WHERE id = ?`).bind(bookingInsert.meta.last_row_id).first();
    expect(bookingRow.is_hidden).toBe(1);
  });
});
```

- [ ] **Step 3: Chạy test**

Run: `cd v4 && npx vitest run test/migrations.test.js`
Expected: PASS (toàn bộ file, bao gồm các describe cũ).

- [ ] **Step 4: Commit**

```bash
cd v4
git add migrations/0025_hide_from_history.sql test/migrations.test.js
git commit -m "feat: add is_hidden column to gio_xanh_sessions, dine_in_orders, bookings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Backend — Ẩn/hiện phiên Giờ Xanh (+ đăng ký action_type `record_hide`)

**Files:**
- Modify: `v4/functions/api/gio-xanh-sessions/index.js`
- Create: `v4/functions/api/gio-xanh-sessions/[id]/hide.js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Modify: `v4/functions/api/audit-log/index.js`
- Test: `v4/test/gioXanhSessions.test.js`

**Interfaces:**
- Consumes: cột `is_hidden` (Task 1).
- Produces: `GET /api/gio-xanh-sessions` response mỗi phiên thêm field `isHidden` (boolean); hỗ trợ query `includeHidden=1`. `PATCH /api/gio-xanh-sessions/:id/hide` body `{ hidden: boolean }` → `200 { ok: true }`. Action type `record_hide` đã đăng ký — Task 3/4 tái dùng, KHÔNG đăng ký lại.

- [ ] **Step 1: Sửa GET để lọc `is_hidden` và trả `isHidden`**

Trong `v4/functions/api/gio-xanh-sessions/index.js`, sửa `onRequestGet`:

```js
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  if (!VALID_STATUSES.includes(status)) return jsonError('Trạng thái không hợp lệ', 400);
  const includeHidden = url.searchParams.get('includeHidden') === '1' && auth.role === 'admin';

  const { results } = await env.DB.prepare(
    `SELECT s.id, s.room_id AS roomId, r.name AS roomName, s.guest_name AS guestName, s.phone, s.status,
       s.opened_by AS openedBy, s.opened_at AS openedAt, s.is_hidden AS isHidden,
       COALESCE((SELECT SUM(amount) FROM gio_xanh_session_items WHERE session_id = s.id AND status = 'posted'), 0) AS currentTotal
     FROM gio_xanh_sessions s JOIN rooms r ON r.id = s.room_id
     WHERE s.status = ?${includeHidden ? '' : ' AND s.is_hidden = 0'} ORDER BY s.opened_at ASC`
  ).bind(status).all();

  return new Response(JSON.stringify(results.map((r) => ({ ...r, isHidden: !!r.isHidden }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

(Giữ nguyên `onRequestPost` — không đổi gì.)

- [ ] **Step 2: Viết endpoint ẩn/hiện**

Tạo `v4/functions/api/gio-xanh-sessions/[id]/hide.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const session = await env.DB.prepare(`SELECT id, status, is_hidden FROM gio_xanh_sessions WHERE id = ?`).bind(params.id).first();
  if (!session) return jsonError('Không tìm thấy phiên', 404);
  if (session.status !== 'closed' && session.status !== 'voided') {
    return jsonError('Chỉ có thể ẩn phiên đã chốt hoặc đã huỷ', 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { hidden } = body || {};
  if (typeof hidden !== 'boolean') return jsonError('Thiếu trạng thái ẩn/hiện', 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE gio_xanh_sessions SET is_hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('record_hide', 'gio_xanh_session', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, `Phiên #${params.id}`, session.is_hidden ? 'ẩn' : 'hiện', hidden ? 'ẩn' : 'hiện', auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Đăng ký action_type `record_hide` (3 nơi bắt buộc)**

Trong `v4/admin/audit-log.js`, thêm 1 dòng ngay sau `gio_xanh_session_void: 'Huỷ phiên Giờ Xanh',`:

```js
  record_hide: 'Ẩn/hiện bản ghi',
```

Trong `v4/admin/audit-log.html`, thêm 1 `<option>` ngay sau `<option value="gio_xanh_session_void">Huỷ phiên Giờ Xanh</option>`:

```html
        <option value="record_hide">Ẩn/hiện bản ghi</option>
```

Trong `v4/functions/api/audit-log/index.js`, thêm `'record_hide'` vào cuối mảng `VALID_ACTION_TYPES`:

```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void', 'gio_xanh_session_void', 'record_hide'];
```

- [ ] **Step 4: Viết test**

Thêm import vào đầu `v4/test/gioXanhSessions.test.js`, cạnh các import đã có:

```js
import { onRequestPatch as hideSession } from '../functions/api/gio-xanh-sessions/[id]/hide.js';
```

Thêm vào cuối file:

```js
describe('GET /api/gio-xanh-sessions — is_hidden filtering', () => {
  it('excludes hidden sessions by default', async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at, is_hidden) VALUES (?, 'Khách Ẩn', 'closed', 'le_tan_gx', '2026-09-05T08:00:00Z', 1)`).bind(roomId1).run();
    const response = await listSessions({ request: authedRequest('https://x/api/gio-xanh-sessions?status=closed', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((s) => s.id === session.meta.last_row_id)).toBeUndefined();
  });

  it('includes hidden sessions when includeHidden=1 and role is admin', async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at, is_hidden) VALUES (?, 'Khách Ẩn', 'closed', 'le_tan_gx', '2026-09-05T08:00:00Z', 1)`).bind(roomId1).run();
    const response = await listSessions({ request: authedRequest('https://x/api/gio-xanh-sessions?status=closed&includeHidden=1', adminToken, 'GET'), env });
    const body = await response.json();
    const found = body.find((s) => s.id === session.meta.last_row_id);
    expect(found).toBeTruthy();
    expect(found.isHidden).toBe(true);
  });

  it('ignores includeHidden=1 for a non-admin role', async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at, is_hidden) VALUES (?, 'Khách Ẩn', 'closed', 'le_tan_gx', '2026-09-05T08:00:00Z', 1)`).bind(roomId1).run();
    const response = await listSessions({ request: authedRequest('https://x/api/gio-xanh-sessions?status=closed&includeHidden=1', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((s) => s.id === session.meta.last_row_id)).toBeUndefined();
  });
});

describe('PATCH /api/gio-xanh-sessions/:id/hide', () => {
  let closedSessionId, openSessionId;
  beforeEach(async () => {
    const closed = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách Đã Chốt', 'closed', 'le_tan_gx', '2026-09-05T08:00:00Z')`).bind(roomId1).run();
    closedSessionId = closed.meta.last_row_id;
    const open = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách Đang Mở', 'open', 'le_tan_gx', '2026-09-05T08:00:00Z')`).bind(roomId2).run();
    openSessionId = open.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await hideSession({ request: new Request(`https://x/api/gio-xanh-sessions/${closedSessionId}/hide`, { method: 'PATCH' }), env, params: { id: String(closedSessionId) } });
    expect(response.status).toBe(401);
  });

  it('rejects manager (403) — hiding is admin-only', async () => {
    const response = await hideSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${closedSessionId}/hide`, managerToken, 'PATCH', { hidden: true }), env, params: { id: String(closedSessionId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent session', async () => {
    const response = await hideSession({ request: authedRequest('https://x/api/gio-xanh-sessions/999999/hide', adminToken, 'PATCH', { hidden: true }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects hiding a session that is still open (400)', async () => {
    const response = await hideSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${openSessionId}/hide`, adminToken, 'PATCH', { hidden: true }), env, params: { id: String(openSessionId) } });
    expect(response.status).toBe(400);
  });

  it('hides a closed session and writes a record_hide audit_log row', async () => {
    const response = await hideSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${closedSessionId}/hide`, adminToken, 'PATCH', { hidden: true }), env, params: { id: String(closedSessionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM gio_xanh_sessions WHERE id = ?`).bind(closedSessionId).first();
    expect(row.is_hidden).toBe(1);
    const auditRow = await env.DB.prepare(`SELECT action_type, entity_type, old_value, new_value FROM audit_log WHERE entity_type = 'gio_xanh_session' AND entity_id = ?`).bind(closedSessionId).first();
    expect(auditRow).toEqual({ action_type: 'record_hide', entity_type: 'gio_xanh_session', old_value: 'hiện', new_value: 'ẩn' });
  });

  it('unhides a hidden session (hidden: false)', async () => {
    await env.DB.prepare(`UPDATE gio_xanh_sessions SET is_hidden = 1 WHERE id = ?`).bind(closedSessionId).run();
    const response = await hideSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${closedSessionId}/hide`, adminToken, 'PATCH', { hidden: false }), env, params: { id: String(closedSessionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM gio_xanh_sessions WHERE id = ?`).bind(closedSessionId).first();
    expect(row.is_hidden).toBe(0);
  });
});
```

- [ ] **Step 5: Chạy test**

Run: `cd v4 && npx vitest run test/gioXanhSessions.test.js`
Expected: PASS (52 tests: 43 hiện có + 9 mới).
Cũng chạy: `cd v4 && npx vitest run test/auditLog.test.js` — expect PASS (đảm bảo đăng ký action_type mới không phá vỡ test hiện có).

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/gio-xanh-sessions admin/audit-log.js admin/audit-log.html functions/api/audit-log/index.js test/gioXanhSessions.test.js
git commit -m "feat: add gio-xanh session hide/unhide endpoint, register record_hide audit action

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Backend — Ẩn/hiện bàn Order ăn uống

**Files:**
- Modify: `v4/functions/api/dine-in-orders/index.js`
- Create: `v4/functions/api/dine-in-orders/[id]/hide.js`
- Test: `v4/test/dineInOrders.test.js`

**Interfaces:**
- Consumes: cột `is_hidden` (Task 1), action_type `record_hide` đã đăng ký (Task 2) — KHÔNG đăng ký lại.
- Produces: `GET /api/dine-in-orders` response mỗi bàn thêm field `isHidden`; hỗ trợ `includeHidden=1`. `PATCH /api/dine-in-orders/:id/hide` body `{ hidden: boolean }` → `200 { ok: true }`.

- [ ] **Step 1: Sửa GET để lọc `is_hidden` và trả `isHidden`**

Trong `v4/functions/api/dine-in-orders/index.js`, sửa `onRequestGet`:

```js
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'open';
  if (!VALID_STATUSES.includes(status)) return jsonError('Trạng thái không hợp lệ', 400);
  const includeHidden = url.searchParams.get('includeHidden') === '1' && auth.role === 'admin';

  const { results } = await env.DB.prepare(
    `SELECT o.id, o.table_label AS tableLabel, o.note, o.status, o.opened_by AS openedBy, o.opened_at AS openedAt, o.is_hidden AS isHidden,
       COALESCE((SELECT SUM(amount) FROM dine_in_order_items WHERE order_id = o.id AND status = 'posted'), 0) AS currentTotal
     FROM dine_in_orders o WHERE o.status = ?${includeHidden ? '' : ' AND o.is_hidden = 0'} ORDER BY o.opened_at ASC`
  ).bind(status).all();

  return new Response(JSON.stringify(results.map((r) => ({ ...r, isHidden: !!r.isHidden }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

(Giữ nguyên `onRequestPost` — không đổi gì.)

- [ ] **Step 2: Viết endpoint ẩn/hiện**

Tạo `v4/functions/api/dine-in-orders/[id]/hide.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const order = await env.DB.prepare(`SELECT id, status, is_hidden FROM dine_in_orders WHERE id = ?`).bind(params.id).first();
  if (!order) return jsonError('Không tìm thấy order', 404);
  if (order.status !== 'closed' && order.status !== 'voided') {
    return jsonError('Chỉ có thể ẩn bàn đã chốt hoặc đã huỷ', 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { hidden } = body || {};
  if (typeof hidden !== 'boolean') return jsonError('Thiếu trạng thái ẩn/hiện', 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE dine_in_orders SET is_hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('record_hide', 'dine_in_order', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, `Order #${params.id}`, order.is_hidden ? 'ẩn' : 'hiện', hidden ? 'ẩn' : 'hiện', auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Viết test**

Thêm import vào đầu `v4/test/dineInOrders.test.js`, cạnh các import đã có:

```js
import { onRequestPatch as hideOrder } from '../functions/api/dine-in-orders/[id]/hide.js';
```

Thêm vào cuối file (dùng `managerToken`/`adminToken`/`observerToken` đã có sẵn trong file này):

```js
describe('GET /api/dine-in-orders — is_hidden filtering', () => {
  it('excludes hidden orders by default', async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at, is_hidden) VALUES ('Bàn Ẩn', 'closed', 'le_tan_order', '2026-09-05T08:00:00Z', 1)`).run();
    const response = await listOrders({ request: authedRequest('https://x/api/dine-in-orders?status=closed', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((o) => o.id === order.meta.last_row_id)).toBeUndefined();
  });

  it('includes hidden orders when includeHidden=1 and role is admin', async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at, is_hidden) VALUES ('Bàn Ẩn', 'closed', 'le_tan_order', '2026-09-05T08:00:00Z', 1)`).run();
    const response = await listOrders({ request: authedRequest('https://x/api/dine-in-orders?status=closed&includeHidden=1', adminToken, 'GET'), env });
    const body = await response.json();
    const found = body.find((o) => o.id === order.meta.last_row_id);
    expect(found).toBeTruthy();
    expect(found.isHidden).toBe(true);
  });

  it('ignores includeHidden=1 for a non-admin role', async () => {
    const order = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at, is_hidden) VALUES ('Bàn Ẩn', 'closed', 'le_tan_order', '2026-09-05T08:00:00Z', 1)`).run();
    const response = await listOrders({ request: authedRequest('https://x/api/dine-in-orders?status=closed&includeHidden=1', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((o) => o.id === order.meta.last_row_id)).toBeUndefined();
  });
});

describe('PATCH /api/dine-in-orders/:id/hide', () => {
  let closedOrderId, openOrderId;
  beforeEach(async () => {
    const closed = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn Đã Chốt', 'closed', 'le_tan_order', '2026-09-05T08:00:00Z')`).run();
    closedOrderId = closed.meta.last_row_id;
    const open = await env.DB.prepare(`INSERT INTO dine_in_orders (table_label, status, opened_by, opened_at) VALUES ('Bàn Đang Mở', 'open', 'le_tan_order', '2026-09-05T08:00:00Z')`).run();
    openOrderId = open.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await hideOrder({ request: new Request(`https://x/api/dine-in-orders/${closedOrderId}/hide`, { method: 'PATCH' }), env, params: { id: String(closedOrderId) } });
    expect(response.status).toBe(401);
  });

  it('rejects manager (403) — hiding is admin-only', async () => {
    const response = await hideOrder({ request: authedRequest(`https://x/api/dine-in-orders/${closedOrderId}/hide`, managerToken, 'PATCH', { hidden: true }), env, params: { id: String(closedOrderId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent order', async () => {
    const response = await hideOrder({ request: authedRequest('https://x/api/dine-in-orders/999999/hide', adminToken, 'PATCH', { hidden: true }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects hiding an order that is still open (400)', async () => {
    const response = await hideOrder({ request: authedRequest(`https://x/api/dine-in-orders/${openOrderId}/hide`, adminToken, 'PATCH', { hidden: true }), env, params: { id: String(openOrderId) } });
    expect(response.status).toBe(400);
  });

  it('hides a closed order and writes a record_hide audit_log row', async () => {
    const response = await hideOrder({ request: authedRequest(`https://x/api/dine-in-orders/${closedOrderId}/hide`, adminToken, 'PATCH', { hidden: true }), env, params: { id: String(closedOrderId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM dine_in_orders WHERE id = ?`).bind(closedOrderId).first();
    expect(row.is_hidden).toBe(1);
    const auditRow = await env.DB.prepare(`SELECT action_type, entity_type, old_value, new_value FROM audit_log WHERE entity_type = 'dine_in_order' AND entity_id = ?`).bind(closedOrderId).first();
    expect(auditRow).toEqual({ action_type: 'record_hide', entity_type: 'dine_in_order', old_value: 'hiện', new_value: 'ẩn' });
  });

  it('unhides a hidden order (hidden: false)', async () => {
    await env.DB.prepare(`UPDATE dine_in_orders SET is_hidden = 1 WHERE id = ?`).bind(closedOrderId).run();
    const response = await hideOrder({ request: authedRequest(`https://x/api/dine-in-orders/${closedOrderId}/hide`, adminToken, 'PATCH', { hidden: false }), env, params: { id: String(closedOrderId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM dine_in_orders WHERE id = ?`).bind(closedOrderId).first();
    expect(row.is_hidden).toBe(0);
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/dineInOrders.test.js`
Expected: PASS (toàn bộ file hiện có + 9 test mới).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/dine-in-orders test/dineInOrders.test.js
git commit -m "feat: add dine-in-order hide/unhide endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Backend — Ẩn/hiện đặt phòng

**Files:**
- Modify: `v4/functions/api/bookings/index.js`
- Create: `v4/functions/api/bookings/[id]/hide.js`
- Test: `v4/test/bookingsEndpoints.test.js`

**Interfaces:**
- Consumes: cột `is_hidden` (Task 1), action_type `record_hide` đã đăng ký (Task 2) — KHÔNG đăng ký lại.
- Produces: `GET /api/bookings` response mỗi đặt phòng thêm field `isHidden`; hỗ trợ `includeHidden=1`. `PATCH /api/bookings/:id/hide` body `{ hidden: boolean }` → `200 { ok: true }`.

**Lưu ý quan trọng:** `v4/test/bookingsEndpoints.test.js` hiện KHÔNG có `adminToken` (chỉ có `managerToken`/`observerToken`/`receptionToken`) — task này phải thêm fixture đó vào `beforeEach`.

- [ ] **Step 1: Sửa GET để lọc `is_hidden` và trả `isHidden`**

Trong `v4/functions/api/bookings/index.js`, sửa `onRequestGet` — thêm biến `includeHidden`, thêm điều kiện vào mảng `conditions`, thêm `is_hidden AS isHidden` vào SELECT, và map lại `isHidden` thành boolean trước khi trả về:

```js
export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const date = url.searchParams.get('date');
  const view = url.searchParams.get('view');
  const includeHidden = url.searchParams.get('includeHidden') === '1' && auth.role === 'admin';

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (date && view === 'arrivals') {
    conditions.push('check_in = ?');
    params.push(date);
  } else if (date && view === 'departures') {
    conditions.push('check_out <= ?');
    params.push(date);
  } else if (date && view === 'inhouse') {
    conditions.push('check_out > ?');
    params.push(date);
  }
  if (!includeHidden) {
    conditions.push('is_hidden = 0');
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT id, guest_name AS guestName, phone, email, room_type AS roomType, room_id AS roomId,
            check_in AS checkIn, check_out AS checkOut, guests_count AS guestsCount, notes, status, source,
            deposit_amount AS depositAmount, is_hidden AS isHidden,
            created_at AS createdAt, created_by AS createdBy, confirmed_by AS confirmedBy, confirmed_at AS confirmedAt,
            cancel_reason AS cancelReason
     FROM bookings ${where} ORDER BY check_in ASC`
  ).bind(...params).all();

  results.forEach((r) => { r.isHidden = !!r.isHidden; });

  if (auth.role === 'observer') {
    results.forEach((r) => {
      r.phone = null;
      r.email = null;
    });
  }

  results.forEach((r) => {
    r.services = [];
  });
  if (results.length > 0) {
    const { results: serviceRows } = await env.DB.prepare(
      `SELECT id, booking_id AS bookingId, name, unit_price AS unitPrice, quantity, amount, status,
              payment_status AS paymentStatus, payment_method AS paymentMethod,
              created_by AS createdBy, created_at AS createdAt, voided_by AS voidedBy, voided_at AS voidedAt,
              experience_date AS experienceDate, slot_template_id AS slotTemplateId,
              experience_slot_label AS experienceSlotLabel, experience_start_time AS experienceStartTime,
              terms_accepted_at AS termsAcceptedAt
       FROM booking_service_items
       WHERE booking_id IN (SELECT id FROM bookings ${where})
       ORDER BY created_at ASC, id ASC`
    ).bind(...params).all();

    const byBooking = {};
    serviceRows.forEach((row) => {
      if (!byBooking[row.bookingId]) byBooking[row.bookingId] = [];
      byBooking[row.bookingId].push(row);
    });
    results.forEach((r) => {
      r.services = byBooking[r.id] || [];
    });
  }

  return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

Đây là 1 câu SELECT dùng chung cho 2 truy vấn (`bookings` chính và `booking_service_items` phụ, cả 2 đều dùng `${where}`) — khi `includeHidden=false`, điều kiện `is_hidden = 0` được thêm vào TRƯỚC KHI build `where`, nên áp dụng đúng cho cả 2 truy vấn tự động, không cần sửa gì thêm ở phần `booking_service_items`.

- [ ] **Step 2: Viết endpoint ẩn/hiện**

Tạo `v4/functions/api/bookings/[id]/hide.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const booking = await env.DB.prepare(`SELECT id, status, is_hidden, guest_name FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) return jsonError('Không tìm thấy đặt phòng', 404);
  if (booking.status !== 'checked_out' && booking.status !== 'cancelled') {
    return jsonError('Chỉ có thể ẩn đặt phòng đã trả phòng hoặc đã huỷ', 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { hidden } = body || {};
  if (typeof hidden !== 'boolean') return jsonError('Thiếu trạng thái ẩn/hiện', 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE bookings SET is_hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('record_hide', 'booking', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, booking.guest_name, booking.is_hidden ? 'ẩn' : 'hiện', hidden ? 'ẩn' : 'hiện', auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Thêm `adminToken` fixture + viết test**

Trong `v4/test/bookingsEndpoints.test.js`, sửa phần khai báo token và `beforeEach` — thêm biến `adminToken` và insert tài khoản admin:

```js
let managerToken;
let observerToken;
let receptionToken;
let adminToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM bookings');
  await env.DB.exec('DELETE FROM notification_settings');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_a', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'observer_a', 'x', 'observer', '2026-08-01T00:00:00Z')`).run();
  observerToken = await createSession(env.DB, 2);

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'le_tan_a', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  receptionToken = await createSession(env.DB, 3);

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (4, 'admin_a', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 4);
});
```

Thêm import vào đầu file, cạnh các import đã có:

```js
import { onRequestPatch as hideBooking } from '../functions/api/bookings/[id]/hide.js';
```

File này đã có sẵn 2 helper — `postReq(url, body)` (POST có body, KHÔNG có Cookie) và `authedRequest(url, token, method = 'GET')` (có Cookie, KHÔNG có body) — không cái nào hỗ trợ PATCH có Cookie + body cùng lúc. Thêm 1 helper mới ngay cạnh 2 helper đó:

```js
function authedPatchRequest(url, token, body) {
  return new Request(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: `session=${token}` }, body: JSON.stringify(body || {}) });
}
```

Thêm vào cuối file:

```js
describe('GET /api/bookings — is_hidden filtering', () => {
  it('excludes hidden bookings by default', async () => {
    const booking = await env.DB.prepare(`INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at, is_hidden) VALUES ('Khách Ẩn', '0900000001', 'circle', '2026-09-10', '2026-09-11', 'cancelled', 'phone', '2026-09-05T00:00:00Z', 1)`).run();
    const response = await listBookings({ request: authedRequest('https://x/api/bookings?status=cancelled', adminToken, 'GET') });
    const body = await response.json();
    expect(body.find((b) => b.id === booking.meta.last_row_id)).toBeUndefined();
  });

  it('includes hidden bookings when includeHidden=1 and role is admin', async () => {
    const booking = await env.DB.prepare(`INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at, is_hidden) VALUES ('Khách Ẩn', '0900000001', 'circle', '2026-09-10', '2026-09-11', 'cancelled', 'phone', '2026-09-05T00:00:00Z', 1)`).run();
    const response = await listBookings({ request: authedRequest('https://x/api/bookings?status=cancelled&includeHidden=1', adminToken, 'GET') });
    const body = await response.json();
    const found = body.find((b) => b.id === booking.meta.last_row_id);
    expect(found).toBeTruthy();
    expect(found.isHidden).toBe(true);
  });

  it('ignores includeHidden=1 for a non-admin role', async () => {
    const booking = await env.DB.prepare(`INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at, is_hidden) VALUES ('Khách Ẩn', '0900000001', 'circle', '2026-09-10', '2026-09-11', 'cancelled', 'phone', '2026-09-05T00:00:00Z', 1)`).run();
    const response = await listBookings({ request: authedRequest('https://x/api/bookings?status=cancelled&includeHidden=1', managerToken, 'GET') });
    const body = await response.json();
    expect(body.find((b) => b.id === booking.meta.last_row_id)).toBeUndefined();
  });
});

describe('PATCH /api/bookings/:id/hide', () => {
  let cancelledBookingId, pendingBookingId;
  beforeEach(async () => {
    const cancelled = await env.DB.prepare(`INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Khách Đã Huỷ', '0900000001', 'circle', '2026-09-10', '2026-09-11', 'cancelled', 'phone', '2026-09-05T00:00:00Z')`).run();
    cancelledBookingId = cancelled.meta.last_row_id;
    const pending = await env.DB.prepare(`INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Khách Đang Chờ', '0900000002', 'circle', '2026-09-12', '2026-09-13', 'pending', 'phone', '2026-09-05T00:00:00Z')`).run();
    pendingBookingId = pending.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await hideBooking({ request: new Request(`https://x/api/bookings/${cancelledBookingId}/hide`, { method: 'PATCH' }), env, params: { id: String(cancelledBookingId) } });
    expect(response.status).toBe(401);
  });

  it('rejects manager (403) — hiding is admin-only', async () => {
    const response = await hideBooking({ request: authedRequest(`https://x/api/bookings/${cancelledBookingId}/hide`, managerToken, 'PATCH'), env, params: { id: String(cancelledBookingId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent booking', async () => {
    const response = await hideBooking({ request: authedRequest('https://x/api/bookings/999999/hide', adminToken, 'PATCH'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects hiding a booking that is still pending (400)', async () => {
    const response = await hideBooking({ request: authedRequest(`https://x/api/bookings/${pendingBookingId}/hide`, adminToken, 'PATCH'), env, params: { id: String(pendingBookingId) } });
    expect(response.status).toBe(400);
  });

  it('hides a cancelled booking and writes a record_hide audit_log row', async () => {
    const response = await hideBooking({ request: authedPatchRequest(`https://x/api/bookings/${cancelledBookingId}/hide`, adminToken, { hidden: true }), env, params: { id: String(cancelledBookingId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM bookings WHERE id = ?`).bind(cancelledBookingId).first();
    expect(row.is_hidden).toBe(1);
    const auditRow = await env.DB.prepare(`SELECT action_type, entity_type, old_value, new_value FROM audit_log WHERE entity_type = 'booking' AND entity_id = ?`).bind(cancelledBookingId).first();
    expect(auditRow).toEqual({ action_type: 'record_hide', entity_type: 'booking', old_value: 'hiện', new_value: 'ẩn' });
  });

  it('unhides a hidden booking (hidden: false)', async () => {
    await env.DB.prepare(`UPDATE bookings SET is_hidden = 1 WHERE id = ?`).bind(cancelledBookingId).run();
    const response = await hideBooking({ request: authedPatchRequest(`https://x/api/bookings/${cancelledBookingId}/hide`, adminToken, { hidden: false }), env, params: { id: String(cancelledBookingId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_hidden FROM bookings WHERE id = ?`).bind(cancelledBookingId).first();
    expect(row.is_hidden).toBe(0);
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: PASS (toàn bộ file hiện có + 9 test mới).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/bookings test/bookingsEndpoints.test.js
git commit -m "feat: add booking hide/unhide endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — Khu vực "Lịch sử phiên" (Giờ Xanh)

**Files:**
- Modify: `v4/admin/gio-xanh.html`
- Modify: `v4/admin/gio-xanh.js`

**Interfaces:**
- Consumes: `GET /api/gio-xanh-sessions?status=closed|voided[&includeHidden=1]` (Task 2), `PATCH /api/gio-xanh-sessions/:id/hide` (Task 2).

- [ ] **Step 1: Thêm HTML cho khu vực lịch sử**

Trong `v4/admin/gio-xanh.html`, thêm ngay trước thẻ đóng `</div>` cuối cùng của `.page` (sau dòng `<p id="emptyState" class="hidden">Không có phiên Giờ Xanh nào đang mở.</p>`):

```html
    <h2>Lịch sử phiên</h2>
    <label class="checkbox hidden" id="showHiddenSessionsWrap"><input type="checkbox" id="showHiddenSessions" /> Hiển thị các log đã ẩn</label>
    <div id="sessionHistoryGrid" class="gio-xanh-grid"></div>
    <p id="historyEmptyState" class="hidden">Chưa có phiên nào đã chốt/huỷ.</p>
```

- [ ] **Step 2: Thêm JS cho khu vực lịch sử**

Trong `v4/admin/gio-xanh.js`, sửa IIFE đầu file để gọi `loadSessionHistory()` và hiện checkbox cho admin:

```js
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

  await loadSessions();
  await loadSessionHistory();

  if (currentRole !== 'observer') {
    document.getElementById('openSessionForm').classList.remove('hidden');
    await populateRoomSelect();
  }

  if (currentRole === 'admin') {
    document.getElementById('showHiddenSessionsWrap').classList.remove('hidden');
  }
  document.getElementById('showHiddenSessions').addEventListener('change', loadSessionHistory);
})();
```

Thêm vào cuối file (sau hàm `renderGrid` và trước hoặc sau phần `openSessionForm` submit handler đều được, không phụ thuộc thứ tự):

```js
async function loadSessionHistory() {
  const errorEl = document.getElementById('pageError');
  const showHidden = currentRole === 'admin' && document.getElementById('showHiddenSessions').checked;
  const suffix = showHidden ? '&includeHidden=1' : '';
  let closedRes, voidedRes;
  try {
    [closedRes, voidedRes] = await Promise.all([
      fetch(`/api/gio-xanh-sessions?status=closed${suffix}`),
      fetch(`/api/gio-xanh-sessions?status=voided${suffix}`),
    ]);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải lịch sử phiên';
    return;
  }
  if (!closedRes.ok || !voidedRes.ok) {
    errorEl.textContent = 'Có lỗi khi tải lịch sử phiên';
    return;
  }
  const closed = await closedRes.json();
  const voided = await voidedRes.json();
  const all = [...closed, ...voided].sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  renderHistoryGrid(all);
}

function renderHistoryGrid(sessions) {
  const grid = document.getElementById('sessionHistoryGrid');
  const emptyState = document.getElementById('historyEmptyState');
  grid.innerHTML = '';
  if (sessions.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  sessions.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'gio-xanh-card';
    if (s.isHidden) card.style.opacity = '0.5';

    const roomLabel = document.createElement('div');
    roomLabel.className = 'room-label';
    roomLabel.textContent = s.roomName;

    const guestLabel = document.createElement('div');
    guestLabel.textContent = s.guestName;

    const statusLabel = document.createElement('div');
    statusLabel.textContent = s.status === 'closed' ? 'Đã chốt' : 'Đã huỷ';

    const total = document.createElement('div');
    total.className = 'session-total';
    total.textContent = `${s.currentTotal.toLocaleString('vi-VN')}đ`;

    card.append(roomLabel, guestLabel, statusLabel, total);

    if (currentRole === 'admin') {
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'btn-secondary table-actions-btn';
      hideBtn.textContent = s.isHidden ? 'Hiện' : 'Ẩn';
      hideBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const errorEl = document.getElementById('pageError');
        errorEl.textContent = '';
        const response = await fetch(`/api/gio-xanh-sessions/${s.id}/hide`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hidden: !s.isHidden }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          errorEl.textContent = body.error || 'Có lỗi khi ẩn/hiện phiên';
          return;
        }
        await loadSessionHistory();
      });
      card.appendChild(hideBtn);
    }

    card.addEventListener('click', () => {
      window.location.href = `/admin/gio-xanh-detail.html?sessionId=${s.id}`;
    });
    grid.appendChild(card);
  });
}
```

- [ ] **Step 3: Kiểm tra thủ công bằng trình duyệt thật**

Đây là thay đổi client thuần — `node -c` chỉ kiểm tra cú pháp, KHÔNG phát hiện lỗi runtime (thiếu phần tử DOM, tên hàm sai...). Bắt buộc dùng trình duyệt thật (Playwright headless Chrome hoặc tương đương, repo đã có `@playwright/test`) để xác nhận: trang tải không lỗi console, khu vực lịch sử hiện đúng phiên `closed`/`voided`, checkbox chỉ hiện với admin, nút Ẩn/Hiện hoạt động đúng, click vào thẻ lịch sử điều hướng đúng sang trang chi tiết.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/gio-xanh.html admin/gio-xanh.js
git commit -m "feat: add session history section to Giờ Xanh board (hide/unhide, admin-only checkbox)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Client — Khu vực "Lịch sử" (Order ăn uống)

**Files:**
- Modify: `v4/admin/dine-in-orders.html`
- Modify: `v4/admin/dine-in-orders.js`

**Interfaces:**
- Consumes: `GET /api/dine-in-orders?status=closed|voided[&includeHidden=1]` (Task 3), `PATCH /api/dine-in-orders/:id/hide` (Task 3).

- [ ] **Step 1: Thêm HTML cho khu vực lịch sử**

Trong `v4/admin/dine-in-orders.html`, thêm ngay trước thẻ đóng `</div>` cuối cùng của `.page` (sau dòng `<p id="emptyState" class="hidden">Không có bàn nào đang mở.</p>`):

```html
    <h2>Lịch sử</h2>
    <label class="checkbox hidden" id="showHiddenOrdersWrap"><input type="checkbox" id="showHiddenOrders" /> Hiển thị các log đã ẩn</label>
    <div id="orderHistoryGrid" class="dine-orders-grid"></div>
    <p id="historyEmptyState" class="hidden">Chưa có bàn nào đã chốt/huỷ.</p>
```

- [ ] **Step 2: Thêm JS cho khu vực lịch sử**

Trong `v4/admin/dine-in-orders.js`, sửa IIFE đầu file:

```js
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
  await loadOrderHistory();

  if (currentRole === 'admin') {
    document.getElementById('showHiddenOrdersWrap').classList.remove('hidden');
  }
  document.getElementById('showHiddenOrders').addEventListener('change', loadOrderHistory);
})();
```

Thêm vào cuối file:

```js
async function loadOrderHistory() {
  const errorEl = document.getElementById('pageError');
  const showHidden = currentRole === 'admin' && document.getElementById('showHiddenOrders').checked;
  const suffix = showHidden ? '&includeHidden=1' : '';
  let closedRes, voidedRes;
  try {
    [closedRes, voidedRes] = await Promise.all([
      fetch(`/api/dine-in-orders?status=closed${suffix}`),
      fetch(`/api/dine-in-orders?status=voided${suffix}`),
    ]);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải lịch sử';
    return;
  }
  if (!closedRes.ok || !voidedRes.ok) {
    errorEl.textContent = 'Có lỗi khi tải lịch sử';
    return;
  }
  const closed = await closedRes.json();
  const voided = await voidedRes.json();
  const all = [...closed, ...voided].sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt));
  renderHistoryGrid(all);
}

function renderHistoryGrid(orders) {
  const grid = document.getElementById('orderHistoryGrid');
  const emptyState = document.getElementById('historyEmptyState');
  grid.innerHTML = '';
  if (orders.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  orders.forEach((o) => {
    const card = document.createElement('div');
    card.className = 'dine-order-card';
    if (o.isHidden) card.style.opacity = '0.5';

    const tableLabel = document.createElement('div');
    tableLabel.className = 'table-label';
    tableLabel.textContent = o.tableLabel;

    const statusLabel = document.createElement('div');
    statusLabel.textContent = o.status === 'closed' ? 'Đã chốt' : 'Đã huỷ';

    const total = document.createElement('div');
    total.className = 'order-total';
    total.textContent = `${o.currentTotal.toLocaleString('vi-VN')}đ`;

    card.append(tableLabel, statusLabel, total);

    if (currentRole === 'admin') {
      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'btn-secondary table-actions-btn';
      hideBtn.textContent = o.isHidden ? 'Hiện' : 'Ẩn';
      hideBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const errorEl = document.getElementById('pageError');
        errorEl.textContent = '';
        const response = await fetch(`/api/dine-in-orders/${o.id}/hide`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hidden: !o.isHidden }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          errorEl.textContent = body.error || 'Có lỗi khi ẩn/hiện bàn';
          return;
        }
        await loadOrderHistory();
      });
      card.appendChild(hideBtn);
    }

    card.addEventListener('click', () => {
      window.location.href = `/admin/dine-in-order-detail.html?orderId=${o.id}`;
    });
    grid.appendChild(card);
  });
}
```

- [ ] **Step 3: Kiểm tra thủ công bằng trình duyệt thật**

Giống Task 5 Step 3 — bắt buộc trình duyệt thật, không chỉ `node -c`.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/dine-in-orders.html admin/dine-in-orders.js
git commit -m "feat: add order history section to Order ăn uống board (hide/unhide, admin-only checkbox)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Client — Khu vực "Lịch sử đặt phòng" (Bảng lễ tân)

**Files:**
- Modify: `v4/admin/reception.html`
- Modify: `v4/admin/reception.js`

**Interfaces:**
- Consumes: `GET /api/bookings?status=checked_out|cancelled[&includeHidden=1]` (Task 4), `PATCH /api/bookings/:id/hide` (Task 4), hàm `fetchBookings(query)`/`renderList(containerId, bookings, emptyText, buildActions)` đã có sẵn trong `reception.js` (không đổi chữ ký).

- [ ] **Step 1: Thêm HTML cho khu vực lịch sử**

Trong `v4/admin/reception.html`, thêm ngay sau khối `<h2>Đang ở</h2><div id="inhouseList" ...></div>` và trước `<h2>Trạng thái phòng</h2>`:

```html
    <h2>Lịch sử đặt phòng</h2>
    <label class="checkbox hidden" id="showHiddenBookingsWrap"><input type="checkbox" id="showHiddenBookings" /> Hiển thị các log đã ẩn</label>
    <div id="bookingHistoryList" class="booking-list"></div>
```

- [ ] **Step 2: Thêm JS cho khu vực lịch sử**

Trong `v4/admin/reception.js`, sửa `refreshAll()` để gọi thêm `loadBookingHistory()`:

```js
async function refreshAll() {
  await Promise.all([loadPending(), loadArrivals(), loadDepartures(), loadUpcomingConfirmed(), loadInhouse(), loadBookingHistory(), loadRooms(), loadReminders()]);
}
```

Trong IIFE đầu file, sau dòng `document.getElementById('roomStatusFilter').addEventListener('change', applyRoomStatusFilter);` và trước `await refreshAll();`, thêm:

```js
  if (currentRole === 'admin') {
    document.getElementById('showHiddenBookingsWrap').classList.remove('hidden');
  }
  document.getElementById('showHiddenBookings').addEventListener('change', loadBookingHistory);
```

Thêm vào cuối file (sau hàm `loadInhouse` hiện có, hoặc bất kỳ đâu ở top-level — thứ tự khai báo hàm không quan trọng trong file này vì mọi lệnh gọi đều nằm trong các hàm async, chạy sau khi toàn bộ file đã parse xong):

```js
async function loadBookingHistory() {
  const showHidden = currentRole === 'admin' && document.getElementById('showHiddenBookings').checked;
  const suffix = showHidden ? '&includeHidden=1' : '';
  const [checkedOut, cancelled] = await Promise.all([
    fetchBookings(`status=checked_out${suffix}`),
    fetchBookings(`status=cancelled${suffix}`),
  ]);
  const all = [...checkedOut, ...cancelled].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderList('bookingHistoryList', all, 'Chưa có đặt phòng nào đã trả phòng/huỷ.', (actions, b) => {
    if (currentRole !== 'admin') return;
    const hideBtn = document.createElement('button');
    hideBtn.type = 'button';
    hideBtn.className = 'btn-secondary table-actions-btn';
    hideBtn.textContent = b.isHidden ? 'Hiện' : 'Ẩn';
    hideBtn.addEventListener('click', async () => {
      let response;
      try {
        response = await fetch(`/api/bookings/${b.id}/hide`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hidden: !b.isHidden }),
        });
      } catch (err) {
        showOpsError('Có lỗi khi ẩn/hiện đặt phòng');
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showOpsError(body.error || 'Có lỗi khi ẩn/hiện đặt phòng');
        return;
      }
      showOpsError('');
      await loadBookingHistory();
    });
    actions.appendChild(hideBtn);
  });
}
```

Ghi chú: `renderBookingCard` (hàm dùng chung có sẵn trong file, được gọi bên trong `renderList`) đã tự hiển thị đúng badge trạng thái cho `checked_out`/`cancelled` (xem `statusLabel()` đã có sẵn 2 nhãn này) — không cần sửa gì thêm ở đó. Card cũng đã tự hiển thị `notes`/`services` nếu có, không ảnh hưởng bởi thay đổi này.

- [ ] **Step 3: Kiểm tra thủ công bằng trình duyệt thật**

Giống Task 5 Step 3. `reception.html` là trang phức tạp nhất trong 3 trang — kiểm tra kỹ: `refreshAll()` không bị lỗi khi thêm `loadBookingHistory()` vào `Promise.all`, checkbox chỉ hiện với admin, nút Ẩn/Hiện chỉ xuất hiện trên dòng lịch sử (không xuất hiện ở 5 danh sách hoạt động hiện có), 5 danh sách hoạt động hiện có không bị ảnh hưởng bởi thay đổi này.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/reception.html admin/reception.js
git commit -m "feat: add booking history section to reception board (hide/unhide, admin-only checkbox)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: E2e coverage (outer repo)

**Files:**
- Modify: `LandingPage/tests/e2e/gio-xanh-sessions.spec.js`
- Modify: `LandingPage/tests/e2e/dine-in-orders.spec.js`
- Modify: `LandingPage/tests/e2e/reception-ops-board.spec.js`

**Interfaces:**
- Consumes: DOM contract của Task 5/6/7 (`#showHiddenSessionsWrap`/`#showHiddenSessions`, `#showHiddenOrdersWrap`/`#showHiddenOrders`, `#showHiddenBookingsWrap`/`#showHiddenBookings`, nút "Ẩn"/"Hiện" trong mỗi khu vực lịch sử).

- [ ] **Step 1: Thêm test cho `gio-xanh-sessions.spec.js`**

Đọc file hiện có trước để nắm đúng `mockAuth`/fixture helper đã dùng (`baseSession` hoặc tương đương), rồi thêm 2 test mới vào `describe` khối chính:

```js
test('admin sees the "Hiển thị các log đã ẩn" checkbox on the board; other roles do not', async ({ page }) => {
  await mockAuth(page, 'admin');
  await page.route('**/api/gio-xanh-sessions?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/gio-xanh-sessions?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/gio-xanh-sessions?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('/admin/gio-xanh.html');
  await expect(page.locator('#showHiddenSessionsWrap')).toBeVisible();
});

test('clicking "Ẩn" on a closed session in history calls the hide endpoint', async ({ page }) => {
  await mockAuth(page, 'admin');
  await page.route('**/api/gio-xanh-sessions?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/gio-xanh-sessions?status=closed*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, roomName: 'Circle House 1', guestName: 'Khách Cũ', status: 'closed', openedAt: '2026-09-01T08:00:00Z', currentTotal: 130000, isHidden: false }]) })
  );
  await page.route('**/api/gio-xanh-sessions?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  let hideBody = null;
  await page.route('**/api/gio-xanh-sessions/9/hide', (route) => {
    hideBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/admin/gio-xanh.html');
  await page.locator('#sessionHistoryGrid .gio-xanh-card', { hasText: 'Khách Cũ' }).locator('button', { hasText: 'Ẩn' }).click();

  await expect.poll(() => hideBody).toMatchObject({ hidden: true });
});
```

- [ ] **Step 2: Chạy test riêng file này**

Run: `npx playwright test tests/e2e/gio-xanh-sessions.spec.js --project=v4`
Expected: PASS (toàn bộ file hiện có + 2 test mới).

- [ ] **Step 3: Thêm test cho `dine-in-orders.spec.js`**

Đọc file hiện có trước để nắm đúng `mockAuth`/fixture helper đã dùng, rồi thêm 2 test tương tự Step 1 (đổi tên biến/endpoint sang `dine-in-orders`, selector `#orderHistoryGrid .dine-order-card`, `#showHiddenOrdersWrap`).

- [ ] **Step 4: Chạy test riêng file này**

Run: `npx playwright test tests/e2e/dine-in-orders.spec.js --project=v4`
Expected: PASS (toàn bộ file hiện có + 2 test mới).

- [ ] **Step 5: Thêm test cho `reception-ops-board.spec.js`**

Đọc file hiện có trước để nắm đúng cách mock `**/api/bookings?status=X*` đã dùng (xem ví dụ ở đầu file: `page.route('**/api/bookings?status=pending', ...)`). Thêm 1 test mới — lưu ý phải mock ĐỦ cả 5 danh sách hoạt động hiện có (pending/confirmed x2/checked_in x2) NGOÀI 2 route mới (`status=checked_out`, `status=cancelled`) vì `refreshAll()` giờ gọi cả 7 hàm cùng lúc:

```js
test('admin sees a booking history section with a hide button; clicking it calls the hide endpoint', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
  await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/bookings?status=checked_out*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/bookings?status=cancelled*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 5, guestName: 'Khách Đã Huỷ', phone: '0900000001', roomType: 'circle', checkIn: '2026-09-01', checkOut: '2026-09-02', status: 'cancelled', createdAt: '2026-09-01T00:00:00Z', isHidden: false }]) })
  );
  await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/reception/reminders', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingDeposits: [], cleaningNeeded: [] }) }));
  await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/rooms/layout-log*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  let hideBody = null;
  await page.route('**/api/bookings/5/hide', (route) => {
    hideBody = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto('/admin/reception.html');
  await expect(page.locator('#showHiddenBookingsWrap')).toBeVisible();
  await page.locator('#bookingHistoryList .booking-card', { hasText: 'Khách Đã Huỷ' }).locator('button', { hasText: 'Ẩn' }).click();

  await expect.poll(() => hideBody).toMatchObject({ hidden: true });
});
```

- [ ] **Step 6: Chạy test riêng file này**

Run: `npx playwright test tests/e2e/reception-ops-board.spec.js --project=v4`
Expected: PASS (toàn bộ file hiện có + 1 test mới).

- [ ] **Step 7: Chạy toàn bộ v4 project**

Run: `npx playwright test --project=v4`
Expected: PASS toàn bộ (không có test nào bị regress).

- [ ] **Step 8: Commit**

```bash
git add tests/e2e/gio-xanh-sessions.spec.js tests/e2e/dine-in-orders.spec.js tests/e2e/reception-ops-board.spec.js
git commit -m "test: e2e coverage for hide-from-history (Giờ Xanh, Order ăn uống, Đặt phòng)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0025 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), xác nhận Cloudflare Pages deploy thành công.
3. Push outer repo (e2e test mới).
4. Smoke-test thực tế: vào từng trang (Giờ Xanh, Order ăn uống, Bảng lễ tân), xác nhận khu vực lịch sử hiện đúng bản ghi đã chốt/huỷ, thử ẩn 1 bản ghi test (tick checkbox để xác nhận nó biến mất khỏi mặc định rồi hiện lại khi tick "Hiển thị các log đã ẩn"), xác nhận role không phải admin không thấy checkbox/nút Ẩn-Hiện. Dọn dữ liệu test sau khi xong.
