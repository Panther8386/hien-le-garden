# Phiên Giờ Xanh Hiền Lê Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép lễ tân/quản lý mở phiên thuê phòng theo giờ (Giờ Xanh Hiền Lê) — chọn phòng cụ thể, ghi tên khách, thêm combo giờ và/hoặc món ăn/thức uống, chốt & thu tiền (gộp 1 bút toán "Giờ xanh Hiền Lê"), in hoá đơn.

**Architecture:** 2 bảng D1 mới, độc lập với `bookings`. Kiến trúc gần như giống hệt tính năng "Order ăn uống" vừa xây (mở phiên → thêm dòng → huỷ dòng/phiên → chốt & thu tiền), khác biệt: phiên gắn `room_id` thật từ bảng `rooms`; dòng thêm vào phiên đến từ 2 nguồn khác nhau (combo giờ từ `service_catalog`, món ăn/thức uống từ `dine_in_menu_items`) phân biệt qua cột `source`. Áp dụng ngay từ đầu cơ chế chống race-condition khi chốt phiên (đã phải vá bổ sung cho Order ăn uống ở review cuối).

**Tech Stack:** Cloudflare Pages Functions + D1 (SQLite), vanilla JS admin frontend (không build step), Playwright cho e2e.

**Spec:** docs/superpowers/specs/2026-09-04-gio-xanh-sessions-design.md

## Global Constraints

- Không đụng vào `bookings` — bảng hoàn toàn độc lập.
- Roles ghi (mở phiên, thêm dòng, huỷ dòng, huỷ phiên, chốt): `reception, manager, admin`. Roles đọc (board, chi tiết): thêm `observer`.
- Huỷ chỉ đổi trạng thái (`voided`), không xoá cứng.
- Chốt phiên tạo đúng **1** bút toán Sổ thu chi (`category='gio_xanh_hien_le'`), tổng gồm cả combo giờ lẫn món ăn.
- Chốt phiên bắt buộc `paymentMethod` — 400 phía server nếu thiếu/sai; phía client nút vô hiệu hoá cho đến khi chọn.
- **Chốt phiên áp dụng cơ chế chống race-condition NGAY TỪ ĐẦU** (không đợi review bắt lỗi như ở Order ăn uống): UPDATE cuối cùng phải có `AND status = 'open'` trong WHERE, kiểm tra `meta.changes`, nếu bằng 0 thì xoá dòng `finance_transactions` vừa tạo và trả về 409.
- `name`/`unit_price` trên `gio_xanh_session_items` là snapshot tại thời điểm thêm dòng.
- Mở phiên chặn nếu phòng đó đang có phiên `open` khác (không đối chiếu với `bookings`).
- Thêm combo giờ chỉ chấp nhận `sourceId` thuộc đúng `service_catalog WHERE category='luu_tru' AND subgroup='Giờ Xanh Hiền Lê' AND is_active=1` — không cho chọn dịch vụ khác.
- `quantity` khi thêm dòng: số nguyên từ 1 đến 999 (rút kinh nghiệm từ Order ăn uống).
- **Quan trọng khi viết test:** ID của các dòng `service_catalog` (combo giờ) KHÔNG cố định — production đã có dòng được thêm qua UI theo thời gian, dịch id auto-increment. Test PHẢI tra cứu ID thật bằng `SELECT id FROM service_catalog WHERE category='luu_tru' AND subgroup='Giờ Xanh Hiền Lê' AND name='...'`, không bao giờ hardcode ID.
- Mọi endpoint dùng `env.DB.prepare(...).bind(...)` tham số hoá — không nối chuỗi SQL.
- Không dùng `window.confirm()` ở bất kỳ đâu (quy ước codebase đã xác nhận qua grep).

---

### Task 1: Migration — 2 bảng mới

**Files:**
- Create: `v4/migrations/0023_gio_xanh_sessions.sql`
- Test: `v4/test/migrations.test.js` (thêm `describe('migration 0023', ...)` vào cuối file)

**Interfaces:**
- Produces: bảng `gio_xanh_sessions(id, room_id, guest_name, phone, status, opened_by, opened_at, closed_by, closed_at, payment_method, total_amount, finance_transaction_id)`, `gio_xanh_session_items(id, session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at, voided_by, voided_at)`. Mọi task sau dùng đúng tên cột này.

- [ ] **Step 1: Viết migration**

Tạo `v4/migrations/0023_gio_xanh_sessions.sql`:

```sql
-- v4/migrations/0023_gio_xanh_sessions.sql

CREATE TABLE gio_xanh_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  guest_name TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'voided')) DEFAULT 'open',
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  payment_method TEXT CHECK (payment_method IN ('cash', 'transfer')),
  total_amount INTEGER,
  finance_transaction_id INTEGER REFERENCES finance_transactions(id)
);
CREATE INDEX idx_gio_xanh_sessions_status ON gio_xanh_sessions(status, opened_at);
CREATE INDEX idx_gio_xanh_sessions_room ON gio_xanh_sessions(room_id, status);

CREATE TABLE gio_xanh_session_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES gio_xanh_sessions(id),
  source TEXT NOT NULL CHECK (source IN ('gio_combo', 'mon_an_uong')),
  source_id INTEGER,
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
CREATE INDEX idx_gio_xanh_session_items_session ON gio_xanh_session_items(session_id, status);
```

- [ ] **Step 2: Viết test**

Thêm vào cuối `v4/test/migrations.test.js`. Test này KHÔNG phụ thuộc vào `service_catalog` thật — dùng `source_id` tuỳ ý vì cột này không có FK constraint (không kiểm tra khoá ngoại ở cấp schema):

```js
describe('migration 0023', () => {
  it('creates gio_xanh_sessions and gio_xanh_session_items with working relationships', async () => {
    const roomRow = await env.DB.prepare(`SELECT id, name FROM rooms WHERE is_active = 1 LIMIT 1`).first();

    const sessionInsert = await env.DB.prepare(
      `INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Test Guest', 'open', 'le_tan', '2026-09-04T08:00:00Z')`
    ).bind(roomRow.id).run();
    const sessionId = sessionInsert.meta.last_row_id;

    const itemInsert = await env.DB.prepare(
      `INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at)
       VALUES (?, 'gio_combo', 1, 'Giờ Đầu Tiên', 130000, 1, 130000, 'posted', 'le_tan', '2026-09-04T08:05:00Z')`
    ).bind(sessionId).run();

    const sessionRow = await env.DB.prepare(`SELECT room_id, guest_name, status, total_amount FROM gio_xanh_sessions WHERE id = ?`).bind(sessionId).first();
    expect(sessionRow).toEqual({ room_id: roomRow.id, guest_name: 'Test Guest', status: 'open', total_amount: null });

    const itemRow = await env.DB.prepare(`SELECT source, name, amount, status FROM gio_xanh_session_items WHERE id = ?`).bind(itemInsert.meta.last_row_id).first();
    expect(itemRow).toEqual({ source: 'gio_combo', name: 'Giờ Đầu Tiên', amount: 130000, status: 'posted' });
  });

  it('rejects an invalid source via the CHECK constraint', async () => {
    const roomRow = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 LIMIT 1`).first();
    const sessionInsert = await env.DB.prepare(
      `INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Test Guest 2', 'open', 'le_tan', '2026-09-04T08:00:00Z')`
    ).bind(roomRow.id).run();

    await expect(
      env.DB.prepare(
        `INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at)
         VALUES (?, 'invalid_source', 1, 'X', 10000, 1, 10000, 'posted', 'le_tan', '2026-09-04T08:05:00Z')`
      ).bind(sessionInsert.meta.last_row_id).run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Chạy test**

Run: `cd v4 && npx vitest run test/migrations.test.js`
Expected: PASS (toàn bộ file, bao gồm các describe cũ).

- [ ] **Step 4: Commit**

```bash
cd v4
git add migrations/0023_gio_xanh_sessions.sql test/migrations.test.js
git commit -m "feat: add gio_xanh_sessions schema (hourly room-rental sessions + line items)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Session core — mở phiên, danh sách, chi tiết

**Files:**
- Create: `v4/functions/api/gio-xanh-sessions/index.js`
- Create: `v4/functions/api/gio-xanh-sessions/[id]/index.js`
- Test: `v4/test/gioXanhSessions.test.js` (mới)

**Interfaces:**
- Consumes: bảng `gio_xanh_sessions`, `gio_xanh_session_items` (Task 1), bảng `rooms` có sẵn.
- Produces: `POST /api/gio-xanh-sessions` → `201 { id, ok: true }`. `GET /api/gio-xanh-sessions?status=open` → `200 [{ id, roomId, roomName, guestName, phone, status, openedBy, openedAt, currentTotal }, ...]`. `GET /api/gio-xanh-sessions/:id` → `200 { id, roomId, roomName, guestName, phone, status, openedBy, openedAt, closedBy, closedAt, paymentMethod, totalAmount, items: [{ id, source, sourceId, name, unitPrice, quantity, amount, status, createdBy, createdAt, voidedBy, voidedAt }, ...] }`. Task 3/4/5/6 dùng đúng field name này.

- [ ] **Step 1: Viết endpoint mở phiên + danh sách**

Tạo `v4/functions/api/gio-xanh-sessions/index.js`:

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
    `SELECT s.id, s.room_id AS roomId, r.name AS roomName, s.guest_name AS guestName, s.phone, s.status,
       s.opened_by AS openedBy, s.opened_at AS openedAt,
       COALESCE((SELECT SUM(amount) FROM gio_xanh_session_items WHERE session_id = s.id AND status = 'posted'), 0) AS currentTotal
     FROM gio_xanh_sessions s JOIN rooms r ON r.id = s.room_id
     WHERE s.status = ? ORDER BY s.opened_at ASC`
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
  const { roomId, guestName, phone } = body || {};

  if (!Number.isInteger(roomId)) return jsonError('Vui lòng chọn phòng', 400);
  if (typeof guestName !== 'string' || guestName.trim() === '') return jsonError('Vui lòng nhập tên khách', 400);
  if (guestName.trim().length > 200) return jsonError('Tên khách quá dài', 400);
  if (phone !== undefined && phone !== null && typeof phone !== 'string') return jsonError('Số điện thoại không hợp lệ', 400);

  const room = await env.DB.prepare(`SELECT id FROM rooms WHERE id = ? AND is_active = 1`).bind(roomId).first();
  if (!room) return jsonError('Phòng không tồn tại hoặc đã ngừng hoạt động', 400);

  const existing = await env.DB.prepare(`SELECT id FROM gio_xanh_sessions WHERE room_id = ? AND status = 'open'`).bind(roomId).first();
  if (existing) return jsonError('Phòng này đang có phiên Giờ Xanh khác chưa chốt', 400);

  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO gio_xanh_sessions (room_id, guest_name, phone, status, opened_by, opened_at) VALUES (?, ?, ?, 'open', ?, ?)`
  ).bind(roomId, guestName.trim(), phone ? (phone.trim() || null) : null, auth.username, now).run();

  return new Response(JSON.stringify({ id: insert.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint chi tiết**

Tạo `v4/functions/api/gio-xanh-sessions/[id]/index.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;

  const session = await env.DB.prepare(
    `SELECT s.id, s.room_id AS roomId, r.name AS roomName, s.guest_name AS guestName, s.phone, s.status,
       s.opened_by AS openedBy, s.opened_at AS openedAt, s.closed_by AS closedBy, s.closed_at AS closedAt,
       s.payment_method AS paymentMethod, s.total_amount AS totalAmount
     FROM gio_xanh_sessions s JOIN rooms r ON r.id = s.room_id
     WHERE s.id = ?`
  ).bind(params.id).first();
  if (!session) return jsonError('Không tìm thấy phiên', 404);

  const { results: items } = await env.DB.prepare(
    `SELECT id, source, source_id AS sourceId, name, unit_price AS unitPrice, quantity, amount, status,
       created_by AS createdBy, created_at AS createdAt, voided_by AS voidedBy, voided_at AS voidedAt
     FROM gio_xanh_session_items WHERE session_id = ? ORDER BY created_at ASC`
  ).bind(params.id).all();

  return new Response(JSON.stringify({ ...session, items }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Viết test**

Tạo `v4/test/gioXanhSessions.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listSessions, onRequestPost as createSession } from '../functions/api/gio-xanh-sessions/index.js';
import { onRequestGet as getSession } from '../functions/api/gio-xanh-sessions/[id]/index.js';
import { createSession as createStaffSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;
let roomId1, roomId2;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM gio_xanh_session_items');
  await env.DB.exec('DELETE FROM gio_xanh_sessions');
  await env.DB.exec('DELETE FROM audit_log');
  await env.DB.exec(`DELETE FROM finance_transactions WHERE category = 'gio_xanh_hien_le'`);

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_gx', 'x', 'manager', '2026-09-04T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_gx', 'x', 'reception', '2026-09-04T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_gx', 'x', 'admin', '2026-09-04T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_gx', 'x', 'observer', '2026-09-04T00:00:00Z')`).run();
  managerToken = await createStaffSession(env.DB, m.meta.last_row_id);
  receptionToken = await createStaffSession(env.DB, r.meta.last_row_id);
  adminToken = await createStaffSession(env.DB, a.meta.last_row_id);
  observerToken = await createStaffSession(env.DB, o.meta.last_row_id);

  const rooms = await env.DB.prepare(`SELECT id FROM rooms WHERE is_active = 1 ORDER BY id LIMIT 2`).all();
  roomId1 = rooms.results[0].id;
  roomId2 = rooms.results[1].id;
});

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe('POST /api/gio-xanh-sessions', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await createSession({ request: new Request('https://x/api/gio-xanh-sessions', { method: 'POST' }), env });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await createSession({ request: authedRequest('https://x/api/gio-xanh-sessions', observerToken, 'POST', { roomId: roomId1, guestName: 'Nguyễn Văn A' }), env });
    expect(response.status).toBe(403);
  });

  it('rejects a missing guestName (400)', async () => {
    const response = await createSession({ request: authedRequest('https://x/api/gio-xanh-sessions', receptionToken, 'POST', { roomId: roomId1 }), env });
    expect(response.status).toBe(400);
  });

  it('rejects a non-existent room (400)', async () => {
    const response = await createSession({ request: authedRequest('https://x/api/gio-xanh-sessions', receptionToken, 'POST', { roomId: 999999, guestName: 'Nguyễn Văn A' }), env });
    expect(response.status).toBe(400);
  });

  it('opens a session with status=open', async () => {
    const response = await createSession({ request: authedRequest('https://x/api/gio-xanh-sessions', receptionToken, 'POST', { roomId: roomId1, guestName: 'Nguyễn Văn A', phone: '0900000001' }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT room_id, guest_name, phone, status, opened_by FROM gio_xanh_sessions WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ room_id: roomId1, guest_name: 'Nguyễn Văn A', phone: '0900000001', status: 'open', opened_by: 'le_tan_gx' });
  });

  it('rejects opening a second session on a room that already has one open (400)', async () => {
    await createSession({ request: authedRequest('https://x/api/gio-xanh-sessions', receptionToken, 'POST', { roomId: roomId1, guestName: 'Khách 1' }), env });
    const response = await createSession({ request: authedRequest('https://x/api/gio-xanh-sessions', receptionToken, 'POST', { roomId: roomId1, guestName: 'Khách 2' }), env });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/gio-xanh-sessions', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await listSessions({ request: new Request('https://x/api/gio-xanh-sessions'), env });
    expect(response.status).toBe(401);
  });

  it('defaults to status=open and computes currentTotal from posted items only', async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách A', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId1).run();
    const sessionId = session.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'gio_combo', 1, 'Giờ Đầu Tiên', 130000, 1, 130000, 'posted', 'le_tan_gx', '2026-09-04T08:05:00Z')`).bind(sessionId).run();
    await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'mon_an_uong', 1, 'Cà phê', 25000, 1, 25000, 'voided', 'le_tan_gx', '2026-09-04T08:06:00Z')`).bind(sessionId).run();

    const response = await listSessions({ request: authedRequest('https://x/api/gio-xanh-sessions', observerToken, 'GET'), env });
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: sessionId, roomId: roomId1, guestName: 'Khách A', status: 'open', currentTotal: 130000 });
  });

  it('rejects an invalid status query param (400)', async () => {
    const response = await listSessions({ request: authedRequest('https://x/api/gio-xanh-sessions?status=deleted', receptionToken, 'GET'), env });
    expect(response.status).toBe(400);
  });
});

describe('GET /api/gio-xanh-sessions/:id', () => {
  it('rejects unauthenticated requests', async () => {
    const response = await getSession({ request: new Request('https://x/api/gio-xanh-sessions/1'), env, params: { id: '1' } });
    expect(response.status).toBe(401);
  });

  it('404s for a non-existent id', async () => {
    const response = await getSession({ request: authedRequest('https://x/api/gio-xanh-sessions/999999', receptionToken, 'GET'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('returns session detail including its items and joined room name', async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách B', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId1).run();
    const sessionId = session.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'gio_combo', 1, 'Giờ Đầu Tiên', 130000, 1, 130000, 'posted', 'le_tan_gx', '2026-09-04T08:05:00Z')`).bind(sessionId).run();

    const response = await getSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}`, observerToken, 'GET'), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.guestName).toBe('Khách B');
    expect(body.roomId).toBe(roomId1);
    expect(body.roomName).toBeTruthy();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ source: 'gio_combo', name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted' });
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/gioXanhSessions.test.js`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/gio-xanh-sessions test/gioXanhSessions.test.js
git commit -m "feat: add gio-xanh session create/list/detail endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Session items — thêm dòng (2 nguồn), huỷ dòng

**Files:**
- Create: `v4/functions/api/gio-xanh-sessions/[id]/items/index.js`
- Create: `v4/functions/api/gio-xanh-sessions/[id]/items/[itemId].js`
- Test: `v4/test/gioXanhSessions.test.js` (thêm 2 describe block mới vào cuối file)

**Interfaces:**
- Consumes: `service_catalog` có sẵn (combo giờ), `dine_in_menu_items` có sẵn (món ăn/thức uống — từ tính năng Order ăn uống), `gio_xanh_sessions`/`gio_xanh_session_items` (Task 1/2).
- Produces: `POST /api/gio-xanh-sessions/:id/items` → `201 { id, ok: true }`. `PATCH /api/gio-xanh-sessions/:id/items/:itemId` → `200 { ok: true }`, ghi `audit_log` với `action_type='service_void'` (tái dùng), `entity_type='gio_xanh_session_item'`.

- [ ] **Step 1: Viết endpoint thêm dòng**

Tạo `v4/functions/api/gio-xanh-sessions/[id]/items/index.js`:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_SOURCES = ['gio_combo', 'mon_an_uong'];

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const session = await env.DB.prepare(`SELECT id, status FROM gio_xanh_sessions WHERE id = ?`).bind(params.id).first();
  if (!session) return jsonError('Không tìm thấy phiên', 404);
  if (session.status !== 'open') return jsonError('Chỉ có thể thêm dòng khi phiên còn đang mở', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { source, sourceId, quantity } = body || {};

  if (!VALID_SOURCES.includes(source)) return jsonError('Loại dòng không hợp lệ', 400);
  if (!Number.isInteger(sourceId)) return jsonError('Vui lòng chọn mục cần thêm', 400);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) return jsonError('Số lượng phải là số nguyên từ 1 đến 999', 400);

  let name, unitPrice;
  if (source === 'gio_combo') {
    const combo = await env.DB.prepare(
      `SELECT name, price_min AS price FROM service_catalog WHERE id = ? AND category = 'luu_tru' AND subgroup = 'Giờ Xanh Hiền Lê' AND is_active = 1`
    ).bind(sourceId).first();
    if (!combo) return jsonError('Combo giờ không tồn tại hoặc đã ngừng áp dụng', 400);
    name = combo.name;
    unitPrice = combo.price;
  } else {
    const menuItem = await env.DB.prepare(`SELECT name, price FROM dine_in_menu_items WHERE id = ? AND is_active = 1`).bind(sourceId).first();
    if (!menuItem) return jsonError('Món không tồn tại hoặc đã ngừng bán', 400);
    name = menuItem.name;
    unitPrice = menuItem.price;
  }

  const amount = unitPrice * quantity;
  const now = new Date().toISOString();
  const insert = await env.DB.prepare(
    `INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`
  ).bind(params.id, source, sourceId, name, unitPrice, quantity, amount, auth.username, now).run();

  return new Response(JSON.stringify({ id: insert.meta.last_row_id, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint huỷ dòng**

Tạo `v4/functions/api/gio-xanh-sessions/[id]/items/[itemId].js`:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const item = await env.DB.prepare(
    `SELECT si.id, si.session_id, si.status, si.name, si.quantity, s.guest_name AS guestName, s.status AS sessionStatus
     FROM gio_xanh_session_items si JOIN gio_xanh_sessions s ON s.id = si.session_id
     WHERE si.id = ?`
  ).bind(params.itemId).first();
  if (!item || String(item.session_id) !== String(params.id)) {
    return jsonError('Không tìm thấy dòng', 404);
  }
  if (item.status === 'voided') return jsonError('Dòng này đã được huỷ trước đó', 400);
  if (item.sessionStatus !== 'open') return jsonError('Chỉ có thể huỷ dòng khi phiên còn đang mở', 400);

  const now = new Date().toISOString();
  const entityLabel = `${item.name} ×${item.quantity} — ${item.guestName}`;

  await env.DB.batch([
    env.DB.prepare(`UPDATE gio_xanh_session_items SET status = 'voided', voided_by = ?, voided_at = ? WHERE id = ?`)
      .bind(auth.username, now, params.itemId),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('service_void', 'gio_xanh_session_item', ?, ?, 'posted', 'voided', ?, ?)`
    ).bind(item.id, entityLabel, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Viết test**

Thêm import vào đầu `v4/test/gioXanhSessions.test.js`, cạnh các import đã có:

```js
import { onRequestPost as addItem } from '../functions/api/gio-xanh-sessions/[id]/items/index.js';
import { onRequestPatch as voidItem } from '../functions/api/gio-xanh-sessions/[id]/items/[itemId].js';
```

Thêm vào cuối file, sau describe block `GET /api/gio-xanh-sessions/:id`:

```js
describe('POST /api/gio-xanh-sessions/:id/items', () => {
  let sessionId, comboId, comboPrice, menuItemId;
  beforeEach(async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách C', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId1).run();
    sessionId = session.meta.last_row_id;

    const combo = await env.DB.prepare(`SELECT id, price_min FROM service_catalog WHERE category = 'luu_tru' AND subgroup = 'Giờ Xanh Hiền Lê' AND name = 'Giờ Đầu Tiên'`).first();
    comboId = combo.id;
    comboPrice = combo.price_min;

    const menu = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Cà phê', 'do_uong', 25000, 0, 1, 'admin_gx', '2026-09-04T00:00:00Z')`).run();
    menuItemId = menu.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await addItem({ request: new Request(`https://x/api/gio-xanh-sessions/${sessionId}/items`, { method: 'POST' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, observerToken, 'POST', { source: 'gio_combo', sourceId: comboId, quantity: 1 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent session', async () => {
    const response = await addItem({ request: authedRequest('https://x/api/gio-xanh-sessions/999999/items', receptionToken, 'POST', { source: 'gio_combo', sourceId: comboId, quantity: 1 }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an invalid source (400)', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, receptionToken, 'POST', { source: 'khong_hop_le', sourceId: comboId, quantity: 1 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });

  it('rejects a quantity above 999 (400)', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, receptionToken, 'POST', { source: 'gio_combo', sourceId: comboId, quantity: 1000 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });

  it('snapshots a gio_combo line correctly', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, receptionToken, 'POST', { source: 'gio_combo', sourceId: comboId, quantity: 2 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT source, source_id, name, unit_price, quantity, amount, status FROM gio_xanh_session_items WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ source: 'gio_combo', source_id: comboId, name: 'Giờ Đầu Tiên', unit_price: comboPrice, quantity: 2, amount: comboPrice * 2, status: 'posted' });
  });

  it('snapshots a mon_an_uong line correctly', async () => {
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, receptionToken, 'POST', { source: 'mon_an_uong', sourceId: menuItemId, quantity: 1 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(201);
    const body = await response.json();
    const row = await env.DB.prepare(`SELECT source, source_id, name, unit_price, quantity, amount, status FROM gio_xanh_session_items WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ source: 'mon_an_uong', source_id: menuItemId, name: 'Cà phê', unit_price: 25000, quantity: 1, amount: 25000, status: 'posted' });
  });

  it('rejects a gio_combo sourceId that does not belong to the Giờ Xanh Hiền Lê subgroup (400)', async () => {
    const unrelated = await env.DB.prepare(`SELECT id FROM service_catalog WHERE category = 'fnb_hoat_dong' LIMIT 1`).first();
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, receptionToken, 'POST', { source: 'gio_combo', sourceId: unrelated.id, quantity: 1 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });

  it('rejects adding items when the session is not open', async () => {
    await env.DB.prepare(`UPDATE gio_xanh_sessions SET status = 'closed' WHERE id = ?`).bind(sessionId).run();
    const response = await addItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items`, receptionToken, 'POST', { source: 'gio_combo', sourceId: comboId, quantity: 1 }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });
});

describe('PATCH /api/gio-xanh-sessions/:id/items/:itemId', () => {
  let sessionId, itemId;
  beforeEach(async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách D', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId1).run();
    sessionId = session.meta.last_row_id;
    const item = await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'gio_combo', 1, 'Giờ Đầu Tiên', 130000, 1, 130000, 'posted', 'le_tan_gx', '2026-09-04T08:05:00Z')`).bind(sessionId).run();
    itemId = item.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await voidItem({ request: new Request(`https://x/api/gio-xanh-sessions/${sessionId}/items/${itemId}`, { method: 'PATCH' }), env, params: { id: String(sessionId), itemId: String(itemId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await voidItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items/${itemId}`, observerToken, 'PATCH'), env, params: { id: String(sessionId), itemId: String(itemId) } });
    expect(response.status).toBe(403);
  });

  it('404s when the item does not belong to this session', async () => {
    const otherSession = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách khác', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId2).run();
    const response = await voidItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${otherSession.meta.last_row_id}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(otherSession.meta.last_row_id), itemId: String(itemId) } });
    expect(response.status).toBe(404);
  });

  it('voids the item and writes a service_void audit_log row', async () => {
    const response = await voidItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(sessionId), itemId: String(itemId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT status, voided_by FROM gio_xanh_session_items WHERE id = ?`).bind(itemId).first();
    expect(row).toEqual({ status: 'voided', voided_by: 'le_tan_gx' });

    const auditRow = await env.DB.prepare(`SELECT action_type, entity_type, actor FROM audit_log WHERE entity_type = 'gio_xanh_session_item' AND entity_id = ?`).bind(itemId).first();
    expect(auditRow).toEqual({ action_type: 'service_void', entity_type: 'gio_xanh_session_item', actor: 'le_tan_gx' });
  });

  it('rejects voiding an already-voided item (400)', async () => {
    await voidItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(sessionId), itemId: String(itemId) } });
    const response = await voidItem({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/items/${itemId}`, receptionToken, 'PATCH'), env, params: { id: String(sessionId), itemId: String(itemId) } });
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/gioXanhSessions.test.js`
Expected: PASS (26 tests: 12 từ Task 2 + 14 mới).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/gio-xanh-sessions test/gioXanhSessions.test.js
git commit -m "feat: add gio-xanh session item add/void endpoints (combo giờ + món ăn/thức uống)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Huỷ phiên + Chốt & thanh toán (tích hợp Sổ thu chi, chống race-condition ngay từ đầu)

**Files:**
- Create: `v4/functions/api/gio-xanh-sessions/[id]/void.js`
- Create: `v4/functions/api/gio-xanh-sessions/[id]/close.js`
- Modify: `v4/admin/audit-log.js`
- Modify: `v4/admin/audit-log.html`
- Modify: `v4/functions/api/audit-log/index.js`
- Test: `v4/test/gioXanhSessions.test.js` (thêm 2 describe block mới vào cuối file)

**Interfaces:**
- Consumes: `gio_xanh_sessions`/`gio_xanh_session_items` (Task 2/3), `finance_categories` slug `gio_xanh_hien_le` (đã có sẵn từ migration 0018).
- Produces: `POST /api/gio-xanh-sessions/:id/void` → `200 { ok: true }`, ghi `audit_log` action type mới `gio_xanh_session_void`. `POST /api/gio-xanh-sessions/:id/close` → `200 { ok: true, totalAmount, financeTransactionId }` hoặc `409` nếu trùng thao tác, tạo 1 dòng `finance_transactions`.

- [ ] **Step 1: Viết endpoint huỷ phiên**

Tạo `v4/functions/api/gio-xanh-sessions/[id]/void.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const session = await env.DB.prepare(
    `SELECT s.id, s.guest_name AS guestName, s.status, r.name AS roomName
     FROM gio_xanh_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.id = ?`
  ).bind(params.id).first();
  if (!session) return jsonError('Không tìm thấy phiên', 404);
  if (session.status !== 'open') return jsonError('Chỉ có thể huỷ phiên khi còn đang mở', 400);

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM gio_xanh_session_items WHERE session_id = ? AND status = 'posted'`
  ).bind(params.id).first();

  const now = new Date().toISOString();
  const entityLabel = `${session.guestName} — ${session.roomName} — ${totals.n} dòng, ${totals.total.toLocaleString('vi-VN')}đ`;

  await env.DB.batch([
    env.DB.prepare(`UPDATE gio_xanh_sessions SET status = 'voided' WHERE id = ?`).bind(params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('gio_xanh_session_void', 'gio_xanh_session', ?, ?, 'open', 'voided', ?, ?)`
    ).bind(session.id, entityLabel, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint chốt & thanh toán (chống race-condition ngay từ đầu)**

Tạo `v4/functions/api/gio-xanh-sessions/[id]/close.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const session = await env.DB.prepare(
    `SELECT s.id, s.guest_name AS guestName, s.status, r.name AS roomName
     FROM gio_xanh_sessions s JOIN rooms r ON r.id = s.room_id WHERE s.id = ?`
  ).bind(params.id).first();
  if (!session) return jsonError('Không tìm thấy phiên', 404);
  if (session.status !== 'open') return jsonError('Chỉ có thể chốt khi phiên còn đang mở', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { paymentMethod } = body || {};
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) return jsonError('Vui lòng chọn hình thức thanh toán', 400);

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM gio_xanh_session_items WHERE session_id = ? AND status = 'posted'`
  ).bind(params.id).first();
  if (totals.n === 0) return jsonError('Phiên chưa có dòng nào, vui lòng huỷ phiên thay vì chốt', 400);

  const now = new Date().toISOString();
  const note = `Giờ Xanh — Phòng ${session.roomName} — ${session.guestName}`;

  const txInsert = await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
     VALUES ('income', 'gio_xanh_hien_le', ?, ?, ?, 'confirmed', ?, ?)`
  ).bind(totals.total, note, now.slice(0, 10), auth.username, now).run();
  const financeTransactionId = txInsert.meta.last_row_id;

  const sessionUpdate = await env.DB.prepare(
    `UPDATE gio_xanh_sessions SET status = 'closed', closed_by = ?, closed_at = ?, payment_method = ?, total_amount = ?, finance_transaction_id = ? WHERE id = ? AND status = 'open'`
  ).bind(auth.username, now, paymentMethod, totals.total, financeTransactionId, params.id).run();

  if (sessionUpdate.meta.changes === 0) {
    // Thao tác khác vừa đóng/huỷ phiên này giữa lúc đọc và ghi (race condition).
    // Xoá dòng finance_transactions vừa tạo để tránh trùng doanh thu.
    await env.DB.prepare(`DELETE FROM finance_transactions WHERE id = ?`).bind(financeTransactionId).run();
    return jsonError('Phiên này vừa được chốt hoặc huỷ bởi thao tác khác, vui lòng tải lại', 409);
  }

  return new Response(JSON.stringify({ ok: true, totalAmount: totals.total, financeTransactionId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Đăng ký action type `gio_xanh_session_void`**

Trong `v4/admin/audit-log.js`, thêm 1 dòng ngay sau `dine_in_order_void: 'Huỷ bàn order ăn uống',`:

```js
  gio_xanh_session_void: 'Huỷ phiên Giờ Xanh',
```

Trong `v4/admin/audit-log.html`, thêm 1 `<option>` ngay sau `<option value="dine_in_order_void">Huỷ bàn order ăn uống</option>`:

```html
        <option value="gio_xanh_session_void">Huỷ phiên Giờ Xanh</option>
```

Trong `v4/functions/api/audit-log/index.js`, thêm `'gio_xanh_session_void'` vào cuối mảng `VALID_ACTION_TYPES`:

```js
const VALID_ACTION_TYPES = ['deposit_change', 'booking_cancel', 'booking_reject', 'service_void', 'account_role_change', 'account_permission_change', 'account_password_reset', 'account_delete', 'finance_transaction_create', 'finance_transaction_update', 'finance_transaction_void', 'finance_opening_balance_set', 'finance_category_create', 'finance_category_update', 'guest_identity_update', 'dine_in_menu_item_create', 'dine_in_menu_item_update', 'dine_in_order_void', 'gio_xanh_session_void'];
```

- [ ] **Step 4: Viết test**

Thêm import vào đầu `v4/test/gioXanhSessions.test.js`, cạnh các import đã có:

```js
import { onRequestPost as voidSession } from '../functions/api/gio-xanh-sessions/[id]/void.js';
import { onRequestPost as closeSession } from '../functions/api/gio-xanh-sessions/[id]/close.js';
```

Thêm vào cuối file, sau describe block `PATCH /api/gio-xanh-sessions/:id/items/:itemId`:

```js
describe('POST /api/gio-xanh-sessions/:id/void', () => {
  let sessionId;
  beforeEach(async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách E', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId1).run();
    sessionId = session.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await voidSession({ request: new Request(`https://x/api/gio-xanh-sessions/${sessionId}/void`, { method: 'POST' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await voidSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/void`, observerToken, 'POST'), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent session', async () => {
    const response = await voidSession({ request: authedRequest('https://x/api/gio-xanh-sessions/999999/void', receptionToken, 'POST'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('voids the session without creating a finance_transactions row, writing a gio_xanh_session_void audit_log row', async () => {
    const response = await voidSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/void`, receptionToken, 'POST'), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT status FROM gio_xanh_sessions WHERE id = ?`).bind(sessionId).first();
    expect(row.status).toBe('voided');

    const txCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions WHERE category = 'gio_xanh_hien_le'`).first();
    expect(txCount.n).toBe(0);

    const auditRow = await env.DB.prepare(`SELECT action_type, actor FROM audit_log WHERE entity_type = 'gio_xanh_session' AND entity_id = ?`).bind(sessionId).first();
    expect(auditRow).toEqual({ action_type: 'gio_xanh_session_void', actor: 'le_tan_gx' });
  });

  it('rejects voiding a session that is not open (400)', async () => {
    await env.DB.prepare(`UPDATE gio_xanh_sessions SET status = 'closed' WHERE id = ?`).bind(sessionId).run();
    const response = await voidSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/void`, receptionToken, 'POST'), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });
});

describe('POST /api/gio-xanh-sessions/:id/close', () => {
  let sessionId;
  beforeEach(async () => {
    const session = await env.DB.prepare(`INSERT INTO gio_xanh_sessions (room_id, guest_name, status, opened_by, opened_at) VALUES (?, 'Khách F', 'open', 'le_tan_gx', '2026-09-04T08:00:00Z')`).bind(roomId1).run();
    sessionId = session.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'gio_combo', 1, 'Giờ Đầu Tiên', 130000, 1, 130000, 'posted', 'le_tan_gx', '2026-09-04T08:05:00Z')`).bind(sessionId).run();
    await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'mon_an_uong', 1, 'Cà phê', 25000, 1, 25000, 'posted', 'le_tan_gx', '2026-09-04T08:06:00Z')`).bind(sessionId).run();
    await env.DB.prepare(`INSERT INTO gio_xanh_session_items (session_id, source, source_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'mon_an_uong', 2, 'Trà đá', 10000, 1, 10000, 'voided', 'le_tan_gx', '2026-09-04T08:07:00Z')`).bind(sessionId).run();
  });

  it('rejects unauthenticated requests', async () => {
    const response = await closeSession({ request: new Request(`https://x/api/gio-xanh-sessions/${sessionId}/close`, { method: 'POST' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(401);
  });

  it('rejects observer (403)', async () => {
    const response = await closeSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/close`, observerToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent session', async () => {
    const response = await closeSession({ request: authedRequest('https://x/api/gio-xanh-sessions/999999/close', receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects a missing/invalid paymentMethod (400)', async () => {
    const response = await closeSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/close`, receptionToken, 'POST', {}), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });

  it('closes the session, combining gio_combo and mon_an_uong totals (posted only) into one finance_transactions row', async () => {
    const response = await closeSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/close`, receptionToken, 'POST', { paymentMethod: 'transfer' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.totalAmount).toBe(155000);

    const sessionRow = await env.DB.prepare(`SELECT status, closed_by, payment_method, total_amount, finance_transaction_id FROM gio_xanh_sessions WHERE id = ?`).bind(sessionId).first();
    expect(sessionRow).toEqual({ status: 'closed', closed_by: 'le_tan_gx', payment_method: 'transfer', total_amount: 155000, finance_transaction_id: body.financeTransactionId });

    const txRow = await env.DB.prepare(`SELECT type, category, amount, status FROM finance_transactions WHERE id = ?`).bind(body.financeTransactionId).first();
    expect(txRow).toEqual({ type: 'income', category: 'gio_xanh_hien_le', amount: 155000, status: 'confirmed' });

    const txCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions WHERE category = 'gio_xanh_hien_le'`).first();
    expect(txCount.n).toBe(1);
  });

  it('rejects closing a session with zero posted items (400)', async () => {
    await env.DB.exec(`UPDATE gio_xanh_session_items SET status = 'voided' WHERE session_id = ${sessionId}`);
    const response = await closeSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/close`, receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
  });

  it('rejects closing a session that is not open (400) and does not touch finance_transactions when already closed', async () => {
    await closeSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/close`, receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(sessionId) } });
    const response = await closeSession({ request: authedRequest(`https://x/api/gio-xanh-sessions/${sessionId}/close`, receptionToken, 'POST', { paymentMethod: 'cash' }), env, params: { id: String(sessionId) } });
    expect(response.status).toBe(400);
    const txCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions WHERE category = 'gio_xanh_hien_le'`).first();
    expect(txCount.n).toBe(1);
  });
});
```

- [ ] **Step 5: Chạy test**

Run: `cd v4 && npx vitest run test/gioXanhSessions.test.js`
Expected: PASS (38 tests: 26 từ Task 2+3 + 12 mới). Cũng chạy `npx vitest run test/auditLog.test.js` — expect PASS.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/gio-xanh-sessions admin/audit-log.js admin/audit-log.html functions/api/audit-log/index.js test/gioXanhSessions.test.js
git commit -m "feat: add gio-xanh session void/close endpoints, integrate close with finance_transactions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — Board các phiên đang mở

**Files:**
- Create: `v4/admin/gio-xanh.html`
- Create: `v4/admin/gio-xanh.js`
- Modify: `v4/admin/admin.css`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`

**Interfaces:**
- Consumes: `GET /api/gio-xanh-sessions?status=open`, `POST /api/gio-xanh-sessions` (Task 2), `GET /api/rooms` (đã có sẵn, trả về `[{ id, name, roomType, status }, ...]` cho phòng active).
- Produces: trang `/admin/gio-xanh.html`, điều hướng tới `/admin/gio-xanh-detail.html?sessionId={id}` (Task 6 dùng route này).

- [ ] **Step 1: Thêm CSS cho board**

Trong `v4/admin/admin.css`, thêm vào cuối file:

```css
.gio-xanh-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}
.gio-xanh-card {
  background: rgba(245, 240, 230, 0.06);
  border: 1px solid rgba(245, 240, 230, 0.15);
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 0.85rem;
  cursor: pointer;
}
.gio-xanh-card .room-label { font-weight: 600; margin-bottom: 4px; }
.gio-xanh-card .session-total { color: var(--gold); font-weight: 600; }
```

- [ ] **Step 2: Tạo trang HTML**

Tạo `v4/admin/gio-xanh.html`:

```html
<!-- v4/admin/gio-xanh.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Giờ Xanh Hiền Lê — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Giờ Xanh Hiền Lê</h1>
    <p id="pageError" class="error"></p>

    <form id="openSessionForm" class="hidden">
      <label>Phòng
        <select name="roomId" required></select>
      </label>
      <label>Tên khách <input type="text" name="guestName" required maxlength="200" /></label>
      <label>Số điện thoại <input type="text" name="phone" maxlength="20" /></label>
      <button type="submit">➕ Mở phiên mới</button>
      <p id="openSessionError" class="error"></p>
    </form>

    <div id="sessionsGrid" class="gio-xanh-grid"></div>
    <p id="emptyState" class="hidden">Không có phiên Giờ Xanh nào đang mở.</p>
  </div>

  <script src="/admin/gio-xanh.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 3: Tạo trang JS**

Tạo `v4/admin/gio-xanh.js`:

```js
// v4/admin/gio-xanh.js
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
    document.getElementById('openSessionForm').classList.remove('hidden');
    await populateRoomSelect();
  }

  await loadSessions();
})();

async function populateRoomSelect() {
  const select = document.querySelector('#openSessionForm select[name="roomId"]');
  select.innerHTML = '<option value="">-- Chọn phòng --</option>';

  let roomsResponse, sessionsResponse;
  try {
    [roomsResponse, sessionsResponse] = await Promise.all([
      fetch('/api/rooms'),
      fetch('/api/gio-xanh-sessions?status=open'),
    ]);
  } catch (err) {
    return;
  }
  if (!roomsResponse.ok) return;
  const rooms = await roomsResponse.json();
  const openSessions = sessionsResponse.ok ? await sessionsResponse.json() : [];
  const busyRoomIds = new Set(openSessions.map((s) => s.roomId));

  rooms.filter((r) => !busyRoomIds.has(r.id)).forEach((r) => {
    const option = document.createElement('option');
    option.value = r.id;
    option.textContent = r.name;
    select.appendChild(option);
  });
}

async function loadSessions() {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch('/api/gio-xanh-sessions?status=open');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải danh sách phiên';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải danh sách phiên';
    return;
  }
  const sessions = await response.json();
  renderGrid(sessions);
}

function renderGrid(sessions) {
  const grid = document.getElementById('sessionsGrid');
  const emptyState = document.getElementById('emptyState');
  grid.innerHTML = '';
  if (sessions.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  sessions.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'gio-xanh-card';

    const roomLabel = document.createElement('div');
    roomLabel.className = 'room-label';
    roomLabel.textContent = s.roomName;

    const guestLabel = document.createElement('div');
    guestLabel.textContent = s.guestName;

    const total = document.createElement('div');
    total.className = 'session-total';
    total.textContent = `${s.currentTotal.toLocaleString('vi-VN')}đ`;

    const opened = document.createElement('div');
    opened.textContent = `Mở lúc: ${new Date(s.openedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;

    card.append(roomLabel, guestLabel, total, opened);
    card.addEventListener('click', () => {
      window.location.href = `/admin/gio-xanh-detail.html?sessionId=${s.id}`;
    });
    grid.appendChild(card);
  });
}

document.getElementById('openSessionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('openSessionError');
  errorEl.textContent = '';
  const form = event.target;
  const roomId = Number(form.querySelector('[name="roomId"]').value);
  const guestName = form.querySelector('[name="guestName"]').value.trim();
  const phone = form.querySelector('[name="phone"]').value.trim();
  if (!roomId) {
    errorEl.textContent = 'Vui lòng chọn phòng';
    return;
  }
  if (!guestName) {
    errorEl.textContent = 'Vui lòng nhập tên khách';
    return;
  }
  const response = await fetch('/api/gio-xanh-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, guestName, phone: phone || undefined }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi mở phiên';
    return;
  }
  const result = await response.json();
  window.location.href = `/admin/gio-xanh-detail.html?sessionId=${result.id}`;
});
```

- [ ] **Step 4: Đăng ký vào nav-drawer**

Trong `v4/admin/nav-drawer.js`, thêm 1 dòng vào `NAV_GROUPS`, nhóm `'Vận hành'`, ngay sau dòng `{ page: 'dine-in-orders.html', label: 'Order ăn uống', icon: '🍽️', roles: ['reception', 'manager', 'admin', 'observer'] },`:

```js
      { page: 'gio-xanh.html', label: 'Giờ Xanh Hiền Lê', icon: '🌿', roles: ['reception', 'manager', 'admin', 'observer'] },
```

Trong cùng file, thêm vào `pageSlug` object, ngay sau `'dine-in-orders.html': 'dine-in-orders',`:

```js
'gio-xanh.html': 'gio-xanh',
```

- [ ] **Step 5: Thêm redirect**

Trong `v4/_redirects`, thêm 1 dòng ngay sau `/manager/dine-in-orders         /admin/dine-in-orders   200`:

```
/manager/gio-xanh               /admin/gio-xanh         200
```

Thêm 1 dòng ngay sau `/reception/dine-in-orders       /admin/dine-in-orders   200`:

```
/reception/gio-xanh             /admin/gio-xanh         200
```

Thêm 1 dòng ngay sau `/observer/dine-in-orders        /admin/dine-in-orders   200`:

```
/observer/gio-xanh              /admin/gio-xanh         200
```

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/gio-xanh.html admin/gio-xanh.js admin/admin.css admin/nav-drawer.js _redirects
git commit -m "feat: add gio-xanh sessions board page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Client — Chi tiết phiên (2 loại dòng, chốt) + In hoá đơn

**Files:**
- Create: `v4/admin/gio-xanh-detail.html`
- Create: `v4/admin/gio-xanh-detail.js`
- Create: `v4/admin/gio-xanh-print.html`
- Create: `v4/admin/gio-xanh-print.js`

**Interfaces:**
- Consumes: `GET /api/catalog` (đã có sẵn, trả `[{ id, category, subgroup, name, priceType, priceMin, priceMax, priceLabel, unitCapacity, note, roomTypeKey, displayOrder, isActive, isScheduled, termsAndConditions }, ...]` cho mục active), `GET /api/dine-in-menu` (Task 2 của tính năng Order ăn uống, đã có sẵn), `GET /api/gio-xanh-sessions/:id`, `POST /api/gio-xanh-sessions/:id/items`, `PATCH /api/gio-xanh-sessions/:id/items/:itemId`, `POST /api/gio-xanh-sessions/:id/void`, `POST /api/gio-xanh-sessions/:id/close` (Task 2/3/4).
- Produces: `window.open('/admin/gio-xanh-print.html?sessionId={id}', '_blank')` — không có interface nào task sau dùng lại (Task 7 test trực tiếp qua URL).

- [ ] **Step 1: Tạo trang chi tiết HTML**

Tạo `v4/admin/gio-xanh-detail.html`:

```html
<!-- v4/admin/gio-xanh-detail.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Chi tiết phiên Giờ Xanh — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1 id="pageTitle">Chi tiết phiên</h1>
    <p id="pageError" class="error"></p>

    <div id="itemsList" class="services-section"></div>

    <form id="addComboForm" class="add-service-form hidden">
      <select name="comboId" required></select>
      <input type="number" name="quantity" min="1" step="1" value="1" required />
      <button type="submit">+ Thêm combo giờ</button>
    </form>
    <p id="addComboError" class="error"></p>

    <form id="addMenuItemForm" class="add-service-form hidden">
      <select name="menuItemId" required></select>
      <input type="number" name="quantity" min="1" step="1" value="1" required />
      <button type="submit">+ Thêm món ăn/thức uống</button>
    </form>
    <p id="addMenuItemError" class="error"></p>

    <p id="sessionTotal"></p>

    <div id="closeSection" class="hidden">
      <label class="checkbox-label"><input type="radio" name="paymentMethod" value="cash" /> 💵 Tiền mặt</label>
      <label class="checkbox-label"><input type="radio" name="paymentMethod" value="transfer" /> 🏦 Chuyển khoản</label>
      <button type="button" id="closeBtn" disabled>✅ Chốt & Thanh toán</button>
      <button type="button" id="voidBtn" class="btn-secondary">❌ Huỷ phiên</button>
      <p id="closeError" class="error"></p>
    </div>

    <button type="button" id="printBtn" class="hidden">🖨 In hoá đơn</button>
  </div>

  <script src="/admin/gio-xanh-detail.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Tạo trang chi tiết JS**

Tạo `v4/admin/gio-xanh-detail.js`:

```js
// v4/admin/gio-xanh-detail.js
let currentRole = null;
let currentSession = null;
let comboItems = [];
let menuItems = [];

function sessionIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('sessionId');
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

  const sessionId = sessionIdFromQuery();
  if (!sessionId) {
    document.getElementById('pageError').textContent = 'Thiếu mã phiên';
    return;
  }

  if (currentRole !== 'observer') {
    let catalogResponse, menuResponse;
    try {
      [catalogResponse, menuResponse] = await Promise.all([
        fetch('/api/catalog'),
        fetch('/api/dine-in-menu'),
      ]);
    } catch (err) {
      document.getElementById('pageError').textContent = 'Có lỗi khi tải danh sách combo/menu';
      return;
    }
    if (catalogResponse.ok) {
      const catalog = await catalogResponse.json();
      comboItems = catalog.filter((c) => c.category === 'luu_tru' && c.subgroup === 'Giờ Xanh Hiền Lê' && c.isActive);
      populateComboSelect();
    }
    if (menuResponse.ok) {
      menuItems = (await menuResponse.json()).filter((m) => m.isActive);
      populateMenuSelect();
    }
  }

  await loadSession(sessionId);
})();

function populateComboSelect() {
  const select = document.querySelector('#addComboForm select[name="comboId"]');
  select.innerHTML = '<option value="">-- Chọn combo giờ --</option>';
  comboItems.forEach((c) => {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = `${c.name} — ${c.priceMin.toLocaleString('vi-VN')}đ`;
    select.appendChild(option);
  });
}

function populateMenuSelect() {
  const select = document.querySelector('#addMenuItemForm select[name="menuItemId"]');
  select.innerHTML = '<option value="">-- Chọn món --</option>';

  ['mon_an', 'do_uong'].forEach((category) => {
    const groupOrder = [];
    const groups = {};
    menuItems.filter((m) => m.category === category).forEach((m) => {
      const key = m.subgroup || (category === 'mon_an' ? 'Món ăn khác' : 'Thức uống khác');
      if (!(key in groups)) {
        groups[key] = [];
        groupOrder.push(key);
      }
      groups[key].push(m);
    });

    groupOrder.forEach((key) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = key;
      groups[key].forEach((m) => {
        const option = document.createElement('option');
        option.value = m.id;
        const unitSuffix = m.unit ? `/${m.unit}` : '';
        const preorderSuffix = m.requiresPreorder ? ' ⚠ Đặt trước' : '';
        option.textContent = `${m.name} — ${m.price.toLocaleString('vi-VN')}đ${unitSuffix}${preorderSuffix}`;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });
  });
}

async function loadSession(sessionId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/gio-xanh-sessions/${sessionId}`);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải phiên';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải phiên';
    return;
  }
  currentSession = await response.json();
  render();
}

function render() {
  const s = currentSession;
  document.getElementById('pageTitle').textContent = `Phòng: ${s.roomName} — ${s.guestName}`;

  const list = document.getElementById('itemsList');
  list.innerHTML = '';
  s.items.forEach((item) => {
    const line = document.createElement('div');
    line.className = 'service-line';
    if (item.status === 'voided') line.style.textDecoration = 'line-through';

    const icon = item.source === 'gio_combo' ? '🌿' : '🍽️';
    const label = document.createElement('span');
    label.textContent = `${icon} ${item.name} ×${item.quantity} — ${item.amount.toLocaleString('vi-VN')}đ`;
    line.appendChild(label);

    if (item.status === 'posted' && currentSession.status === 'open' && currentRole !== 'observer') {
      const voidBtn = document.createElement('button');
      voidBtn.type = 'button';
      voidBtn.className = 'btn-secondary';
      voidBtn.textContent = 'Huỷ dòng';
      voidBtn.addEventListener('click', () => voidItem(item.id));
      line.appendChild(voidBtn);
    }

    list.appendChild(line);
  });

  const currentTotal = s.items.filter((i) => i.status === 'posted').reduce((sum, i) => sum + i.amount, 0);
  document.getElementById('sessionTotal').textContent = `Tổng: ${currentTotal.toLocaleString('vi-VN')}đ`;

  const addComboForm = document.getElementById('addComboForm');
  const addMenuItemForm = document.getElementById('addMenuItemForm');
  const closeSection = document.getElementById('closeSection');
  const printBtn = document.getElementById('printBtn');

  if (s.status === 'open' && currentRole !== 'observer') {
    addComboForm.classList.remove('hidden');
    addMenuItemForm.classList.remove('hidden');
    closeSection.classList.remove('hidden');
  } else {
    addComboForm.classList.add('hidden');
    addMenuItemForm.classList.add('hidden');
    closeSection.classList.add('hidden');
  }

  if (s.status === 'closed') {
    printBtn.classList.remove('hidden');
  } else {
    printBtn.classList.add('hidden');
  }
}

document.getElementById('addComboForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('addComboError');
  errorEl.textContent = '';
  const form = event.target;
  const comboId = Number(form.querySelector('[name="comboId"]').value);
  const quantity = Number(form.querySelector('[name="quantity"]').value);
  if (!comboId) {
    errorEl.textContent = 'Vui lòng chọn combo giờ';
    return;
  }
  const response = await fetch(`/api/gio-xanh-sessions/${currentSession.id}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'gio_combo', sourceId: comboId, quantity }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi thêm combo giờ';
    return;
  }
  form.reset();
  form.querySelector('[name="quantity"]').value = 1;
  await loadSession(currentSession.id);
});

document.getElementById('addMenuItemForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('addMenuItemError');
  errorEl.textContent = '';
  const form = event.target;
  const menuItemId = Number(form.querySelector('[name="menuItemId"]').value);
  const quantity = Number(form.querySelector('[name="quantity"]').value);
  if (!menuItemId) {
    errorEl.textContent = 'Vui lòng chọn món';
    return;
  }
  const response = await fetch(`/api/gio-xanh-sessions/${currentSession.id}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'mon_an_uong', sourceId: menuItemId, quantity }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi thêm món';
    return;
  }
  form.reset();
  form.querySelector('[name="quantity"]').value = 1;
  await loadSession(currentSession.id);
});

async function voidItem(itemId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/gio-xanh-sessions/${currentSession.id}/items/${itemId}`, { method: 'PATCH' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi huỷ dòng';
    return;
  }
  await loadSession(currentSession.id);
}

document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    document.getElementById('closeBtn').disabled = false;
  });
});

document.getElementById('closeBtn').addEventListener('click', async () => {
  document.getElementById('closeBtn').disabled = true;
  const errorEl = document.getElementById('closeError');
  errorEl.textContent = '';
  const selected = document.querySelector('input[name="paymentMethod"]:checked');
  if (!selected) {
    errorEl.textContent = 'Vui lòng chọn hình thức thanh toán';
    document.getElementById('closeBtn').disabled = false;
    return;
  }
  const response = await fetch(`/api/gio-xanh-sessions/${currentSession.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentMethod: selected.value }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi chốt phiên';
    document.getElementById('closeBtn').disabled = false;
    return;
  }
  await loadSession(currentSession.id);
});

document.getElementById('voidBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('closeError');
  errorEl.textContent = '';
  const response = await fetch(`/api/gio-xanh-sessions/${currentSession.id}/void`, { method: 'POST' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi huỷ phiên';
    return;
  }
  window.location.href = '/admin/gio-xanh.html';
});

document.getElementById('printBtn').addEventListener('click', () => {
  window.open(`/admin/gio-xanh-print.html?sessionId=${currentSession.id}`, '_blank');
});
```

- [ ] **Step 3: Tạo trang in HTML**

Tạo `v4/admin/gio-xanh-print.html` (không có `nav-drawer.js`, áp dụng ngay `color: #111` cho cả `h2` lẫn `th`/`td`):

```html
<!-- v4/admin/gio-xanh-print.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Hoá đơn Giờ Xanh — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
  <style>
    .form-print { background: #fff; color: #111; padding: 32px; max-width: 700px; margin: 0 auto; font-family: 'Inter', sans-serif; }
    .form-print h2 { text-align: center; margin-bottom: 4px; color: #111; }
    .form-print .subtitle { text-align: center; margin-top: 0; margin-bottom: 24px; opacity: 0.7; }
    .form-print table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    .form-print th, .form-print td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; color: #111; white-space: normal; }
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
    <h1>In hoá đơn Giờ Xanh</h1>
    <p id="pageError" class="error"></p>
    <button type="button" id="printBtn">🖨 In</button>
  </div>

  <div id="formPrint" class="form-print"></div>

  <script src="/admin/gio-xanh-print.js"></script>
</body>
</html>
```

- [ ] **Step 4: Tạo trang in JS**

Tạo `v4/admin/gio-xanh-print.js`:

```js
// v4/admin/gio-xanh-print.js
function sessionIdFromQuery() {
  const params = new URLSearchParams(window.location.search);
  return params.get('sessionId');
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

  const sessionId = sessionIdFromQuery();
  if (!sessionId) {
    document.getElementById('pageError').textContent = 'Thiếu mã phiên';
    return;
  }

  await loadSession(sessionId);
})();

async function loadSession(sessionId) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/gio-xanh-sessions/${sessionId}`);
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải phiên';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải phiên';
    return;
  }
  const session = await response.json();
  renderInvoice(session);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('vi-VN');
}

function renderInvoice(session) {
  const el = document.getElementById('formPrint');
  el.innerHTML = '';

  const h2 = document.createElement('h2');
  h2.textContent = 'HOÁ ĐƠN GIỜ XANH HIỀN LÊ';
  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = 'Hiền Lê Garden';

  const dl = document.createElement('dl');
  const rows = [
    ['Phòng', session.roomName],
    ['Tên khách', session.guestName],
    ['Số điện thoại', session.phone || ''],
    ['Giờ mở', formatDateTime(session.openedAt)],
    ['Giờ chốt', session.closedAt ? formatDateTime(session.closedAt) : ''],
    ['Hình thức thanh toán', session.paymentMethod === 'cash' ? 'Tiền mặt' : session.paymentMethod === 'transfer' ? 'Chuyển khoản' : ''],
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
  thead.innerHTML = '<tr><th>Mục</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr>';
  const tbody = document.createElement('tbody');
  let total = 0;
  session.items.filter((i) => i.status === 'posted').forEach((item) => {
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

Từ `v4/`: `npx http-server . -p 8899 -s -c-1` (chạy nền). Mở trình duyệt thật (không chỉ curl/HTTP-status — kiểm tra Console không có lỗi JS) tới `http://localhost:8899/admin/gio-xanh-detail.html?sessionId=1` và `http://localhost:8899/admin/gio-xanh-print.html?sessionId=1` — cả hai sẽ chuyển hướng về `/admin` vì không có session thật (đúng như mong đợi, xác nhận code kiểm tra auth chạy không lỗi). Dừng server sau khi kiểm tra.

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/gio-xanh-detail.html admin/gio-xanh-detail.js admin/gio-xanh-print.html admin/gio-xanh-print.js
git commit -m "feat: add gio-xanh session detail page (combo giờ + món ăn, close, void) and print invoice

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: E2e coverage (outer repo)

**Files:**
- Create: `LandingPage/tests/e2e/gio-xanh-sessions.spec.js` (outer repo)

**Interfaces:**
- Consumes: DOM contract của `admin/gio-xanh-detail.html`/`.js` và `admin/gio-xanh-print.html`/`.js` (Task 6).

- [ ] **Step 1: Viết e2e test**

Tạo `tests/e2e/gio-xanh-sessions.spec.js` (outer repo):

```js
// tests/e2e/gio-xanh-sessions.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role }) }));
}

const CATALOG_ITEMS = [
  { id: 22, category: 'luu_tru', subgroup: 'Giờ Xanh Hiền Lê', name: 'Giờ Đầu Tiên', priceType: 'fixed', priceMin: 130000, priceMax: null, priceLabel: null, unitCapacity: '1 giờ', note: null, roomTypeKey: null, displayOrder: 7, isActive: true, isScheduled: false, termsAndConditions: null },
];

const MENU_ITEMS = [
  { id: 1, name: 'Cà phê đen', category: 'do_uong', price: 25000, displayOrder: 1, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z' },
];

function baseSession(overrides) {
  return {
    id: 42, roomId: 3, roomName: 'Circle House 1', guestName: 'Nguyễn Văn A', phone: '0900000001', status: 'open',
    openedBy: 'le_tan_a', openedAt: '2026-09-04T08:00:00Z',
    closedBy: null, closedAt: null, paymentMethod: null, totalAmount: null,
    items: [],
    ...overrides,
  };
}

test.describe('Gio-xanh session detail page', () => {
  test('adding a combo giờ line and a món ăn line updates the total together', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));

    let session = baseSession();
    let nextItemId = 1;
    await page.route('**/api/gio-xanh-sessions/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    });
    await page.route('**/api/gio-xanh-sessions/42/items', (route) => {
      const body = route.request().postDataJSON();
      const isCombo = body.source === 'gio_combo';
      const src = isCombo ? CATALOG_ITEMS.find((c) => c.id === body.sourceId) : MENU_ITEMS.find((m) => m.id === body.sourceId);
      const unitPrice = isCombo ? src.priceMin : src.price;
      const item = { id: nextItemId++, source: body.source, sourceId: body.sourceId, name: src.name, unitPrice, quantity: body.quantity, amount: unitPrice * body.quantity, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null };
      session = { ...session, items: [...session.items, item] };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: item.id, ok: true }) });
    });

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#pageTitle')).toContainText('Circle House 1');
    await expect(page.locator('#pageTitle')).toContainText('Nguyễn Văn A');

    await page.selectOption('select[name="comboId"]', '22');
    await page.fill('#addComboForm input[name="quantity"]', '1');
    await page.click('#addComboForm button[type="submit"]');
    await expect(page.locator('#sessionTotal')).toContainText('130.000');

    await page.selectOption('select[name="menuItemId"]', '1');
    await page.fill('#addMenuItemForm input[name="quantity"]', '1');
    await page.click('#addMenuItemForm button[type="submit"]');
    await expect(page.locator('#sessionTotal')).toContainText('155.000');
  });

  test('close button stays disabled until a payment method is chosen', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    const session = baseSession({ items: [{ id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/gio-xanh-sessions/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#closeBtn')).toBeDisabled();
    await page.check('input[name="paymentMethod"][value="cash"]');
    await expect(page.locator('#closeBtn')).toBeEnabled();
  });

  test('closing the session posts the chosen payment method and shows the print button', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    let session = baseSession({ items: [{ id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    let closedBody = null;
    await page.route('**/api/gio-xanh-sessions/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    });
    await page.route('**/api/gio-xanh-sessions/42/close', (route) => {
      closedBody = route.request().postDataJSON();
      session = { ...session, status: 'closed', paymentMethod: closedBody.paymentMethod, closedAt: '2026-09-04T09:00:00Z', totalAmount: 130000 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, totalAmount: 130000, financeTransactionId: 9 }) });
    });

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await page.check('input[name="paymentMethod"][value="transfer"]');
    await page.click('#closeBtn');

    await expect.poll(() => closedBody).toMatchObject({ paymentMethod: 'transfer' });
    await expect(page.locator('#printBtn')).toBeVisible();
  });

  test('observer sees no action controls', async ({ page }) => {
    await mockAuth(page, 'observer');
    const session = baseSession({ items: [{ id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/gio-xanh-sessions/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#addComboForm')).toBeHidden();
    await expect(page.locator('#addMenuItemForm')).toBeHidden();
    await expect(page.locator('#closeSection')).toBeHidden();
  });
});

test.describe('Gio-xanh invoice print page', () => {
  test('renders both combo giờ and món ăn lines and total, print button calls window.print()', async ({ page }) => {
    await mockAuth(page, 'reception');
    const session = baseSession({
      status: 'closed', paymentMethod: 'cash', closedAt: '2026-09-04T09:00:00Z', totalAmount: 155000,
      items: [
        { id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null },
        { id: 2, source: 'mon_an_uong', sourceId: 1, name: 'Cà phê đen', unitPrice: 25000, quantity: 1, amount: 25000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:06:00Z', voidedBy: null, voidedAt: null },
      ],
    });
    await page.route('**/api/gio-xanh-sessions/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto('/admin/gio-xanh-print.html?sessionId=42');
    await expect(page.locator('#formPrint')).toContainText('Giờ Đầu Tiên');
    await expect(page.locator('#formPrint')).toContainText('Cà phê đen');
    await expect(page.locator('#formPrint')).toContainText('155.000');
    await expect(page.locator('#formPrint')).toContainText('Nguyễn Văn A');

    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printBtn');
    const called = await page.evaluate(() => window.__printCalled);
    expect(called).toBe(true);
  });
});
```

- [ ] **Step 2: Chạy spec mới**

Từ `LandingPage/` (outer repo root): `npx playwright test tests/e2e/gio-xanh-sessions.spec.js --project=v4`
Expected: PASS — 5/5.

- [ ] **Step 3: Chạy toàn bộ project v4 để kiểm tra hồi quy**

`npx playwright test --project=v4`
Expected: PASS — toàn bộ test trong project v4, bao gồm spec mới và mọi spec trước đó.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/gio-xanh-sessions.spec.js
git commit -m "test: e2e coverage for gio-xanh hourly-rental sessions and invoice printing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0023 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), xác nhận Cloudflare Pages deploy thành công.
3. Push outer repo (thêm e2e test).
4. Smoke-test thực tế: đăng nhập reception/manager, vào "Giờ Xanh Hiền Lê", mở 1 phiên test (chọn phòng, nhập tên khách), thêm 1 combo giờ + 1 món ăn, huỷ 1 dòng, chốt (chọn hình thức thanh toán), xác nhận tổng đúng + xuất hiện dòng "Giờ xanh Hiền Lê" trong Sổ thu chi đúng số tiền (gồm cả combo giờ lẫn món ăn), in hoá đơn xem đúng nội dung. Dọn sạch dữ liệu test sau khi xong (xoá bản ghi test qua SQL trực tiếp).
