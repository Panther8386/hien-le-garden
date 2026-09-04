# Phiên Giờ Xanh Hiền Lê (thuê phòng theo giờ)

**Status:** Approved by user 2026-09-04, ready for implementation planning.

## 1. Goal

Cho phép lễ tân/quản lý mở một phiên thuê phòng theo giờ cho dịch vụ "Giờ Xanh Hiền Lê" — chọn phòng cụ thể, ghi tên khách, thêm combo giờ và/hoặc món ăn/thức uống trong lúc khách sử dụng, chốt và thu tiền, in hoá đơn. Toàn bộ doanh thu (combo giờ + món ăn thêm) gộp vào **một** danh mục Sổ thu chi duy nhất: "Giờ xanh Hiền Lê".

## 2. Non-goals

- **Không dùng form "Tạo đặt phòng mới" hiện có** — form đó kiến trúc hoàn toàn cho lưu trú qua đêm (từ chối check-out cùng ngày với check-in, không có khái niệm giờ trong schema). Xây luồng độc lập, không đụng `bookings`.
- **Không kiểm tra trùng với lịch đặt phòng qua đêm** — phòng chỉ bị chặn khi đang có 1 phiên Giờ Xanh khác chưa chốt trên đúng phòng đó; không đối chiếu với `bookings` (lễ tân tự cân đối, vì Giờ Xanh thường dùng ban ngày trước giờ khách lưu trú nhận phòng — xác nhận rõ với người dùng).
- **Không tách doanh thu theo loại dòng** — dù 1 phiên có cả combo giờ lẫn món ăn, khi chốt chỉ tạo **1** bút toán Thu duy nhất vào danh mục "Giờ xanh Hiền Lê" (không tách F&B ra danh mục khác).
- **Không xoá cứng** — huỷ dòng/huỷ phiên chỉ đổi trạng thái, không xoá dữ liệu.
- **Không có màn hình riêng quản lý combo giờ** — 3 combo giờ hiện có sẵn trong `service_catalog` (category `luu_tru`, subgroup `Giờ Xanh Hiền Lê`) đã được quản lý qua trang "Bảng giá dịch vụ" hiện có (`admin/catalog.html`), không cần trang cấu hình mới.

## 3. Architecture fit

Cùng stack V4 (Cloudflare Pages Functions + D1, vanilla JS, không build step). 2 bảng D1 mới, độc lập với `bookings`. Kiến trúc gần như giống hệt tính năng "Order ăn uống" vừa xây (mở phiên → thêm dòng → huỷ dòng/phiên → chốt & thu tiền), khác biệt duy nhất: (1) phiên gắn với 1 `room_id` thật từ bảng `rooms` thay vì `table_label` tự do; (2) dòng thêm vào phiên có thể đến từ **2 nguồn khác nhau** — combo giờ (`service_catalog`) hoặc món ăn/thức uống (`dine_in_menu_items`, đã xây ở tính năng trước) — phân biệt qua cột `source`. Endpoint theo đúng convention narrow-action-endpoint. Áp dụng ngay từ đầu cơ chế chống race-condition khi chốt phiên (bài học rút ra từ review cuối cùng của tính năng Order ăn uống).

## 4. Data model

`migrations/0022_gio_xanh_sessions.sql`:

```sql
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

`source_id` trỏ tới `service_catalog.id` (khi `source='gio_combo'`) hoặc `dine_in_menu_items.id` (khi `source='mon_an_uong'`) — không có FK constraint chính thức vì cột này có thể tham chiếu 1 trong 2 bảng khác nhau tuỳ giá trị `source` (SQLite không hỗ trợ FK điều kiện). `name`/`unit_price` là snapshot tại thời điểm thêm dòng, giống hệt quy ước đã dùng ở Order ăn uống.

## 5. API contract

Tất cả endpoint dưới `functions/api/gio-xanh-sessions/`.

### 5.1 Phiên

- **`POST /api/gio-xanh-sessions`** — roles `reception, manager, admin`. Body `{ roomId, guestName, phone? }`. `roomId` phải tồn tại và `is_active=1` trong bảng `rooms` (400 nếu không). `guestName` bắt buộc, tối đa 200 ký tự. Nếu phòng đó đang có 1 phiên `status='open'` khác → 400 "Phòng này đang có phiên Giờ Xanh khác chưa chốt". Tạo phiên `status='open'`.
- **`GET /api/gio-xanh-sessions?status=open`** — roles `reception, manager, admin, observer`. Danh sách phiên theo status (mặc định `open`), JOIN lấy `room.name`, kèm `currentTotal` (SUM các dòng `posted`).
- **`GET /api/gio-xanh-sessions/:id`** — roles như trên. Chi tiết phiên + toàn bộ dòng (kể cả `voided`).

### 5.2 Dòng trong phiên

- **`POST /api/gio-xanh-sessions/:id/items`** — roles `reception, manager, admin`. Body `{ source, sourceId, quantity }`. `quantity` phải là số nguyên từ 1 đến 999 (giới hạn trên giống Order ăn uống — rút kinh nghiệm từ lỗi thiếu giới hạn bị bắt ở review cuối tính năng đó). Chỉ khi phiên `status='open'`. Nếu `source='gio_combo'`: `sourceId` phải khớp `service_catalog WHERE id = ? AND category = 'luu_tru' AND subgroup = 'Giờ Xanh Hiền Lê' AND is_active = 1` (400 nếu không khớp — chặn chọn nhầm dịch vụ khác). Nếu `source='mon_an_uong'`: `sourceId` phải khớp `dine_in_menu_items WHERE id = ? AND is_active = 1`. Snapshot `name`/giá tại thời điểm thêm; `amount = unitPrice * quantity`.
- **`PATCH /api/gio-xanh-sessions/:id/items/:itemId`** — roles như trên. Huỷ 1 dòng (`status='voided'`), chỉ khi phiên còn `open`. Ghi `audit_log`: `action_type='service_void'` (tái dùng), `entity_type='gio_xanh_session_item'`, `entity_label='{name} ×{quantity} — {guestName}'`.

### 5.3 Huỷ phiên / Chốt & thanh toán

- **`POST /api/gio-xanh-sessions/:id/void`** — roles `reception, manager, admin`. Huỷ cả phiên khi còn `open` (không tạo bút toán). Ghi `audit_log`: `action_type='gio_xanh_session_void'` (đăng ký mới ở cả 3 registry), `entity_type='gio_xanh_session'`, `entity_label='{guestName} — {roomName} — {n} dòng, {tổng tạm tính}đ'`.
- **`POST /api/gio-xanh-sessions/:id/close`** — roles `reception, manager, admin`. Body `{ paymentMethod }` (`'cash'` hoặc `'transfer'`, bắt buộc). Chỉ khi phiên `status='open'` và có ít nhất 1 dòng `posted`. Tổng = SUM các dòng `posted` (cả `gio_combo` lẫn `mon_an_uong` cộng chung). Theo đúng thứ tự 2 bước tuần tự đã dùng ở Order ăn uống: (1) INSERT `finance_transactions` (`type='income', category='gio_xanh_hien_le', amount=tổng, note='Giờ Xanh — Phòng {roomName} — {guestName}', status='confirmed'`); (2) UPDATE `gio_xanh_sessions SET status='closed', ... WHERE id=? AND status='open'` — **kiểm tra `meta.changes`, nếu bằng 0 (race condition — phiên vừa bị đóng/huỷ bởi thao tác khác) thì xoá dòng `finance_transactions` vừa tạo và trả về 409**. Đây là cơ chế đã phải vá bổ sung cho Order ăn uống ở review cuối; áp dụng đúng ngay từ đầu ở tính năng này.

## 6. Client

### 6.1 `admin/gio-xanh.html`/`.js`

Board các phiên đang mở, dạng thẻ: tên phòng, tên khách, giờ mở, tổng tạm tính. Nút "➕ Mở phiên mới": dropdown chọn phòng (lấy từ `GET /api/rooms`, loại trừ phòng đang có phiên `open` — lấy song song từ `GET /api/gio-xanh-sessions?status=open` rồi lọc client-side, không sửa endpoint `/api/rooms` hiện có), input tên khách (bắt buộc) + SĐT (tuỳ chọn). Click thẻ → điều hướng `gio-xanh-detail.html?sessionId={id}`.

### 6.2 `admin/gio-xanh-detail.html`/`.js`

Danh sách dòng đã thêm (dòng `voided` gạch ngang), phân biệt trực quan combo giờ / món ăn (ví dụ prefix icon). **2 form thêm dòng riêng biệt**: "➕ Thêm combo giờ" (dropdown 3 mục từ `service_catalog` lọc đúng subgroup) và "➕ Thêm món ăn/thức uống" (dropdown từ `GET /api/dine-in-menu`, nhóm theo Món ăn/Thức uống — tái dùng y hệt cách đã làm ở trang chi tiết Order ăn uống). Tổng tiền cập nhật theo dòng `posted`. Khu vực chốt: radio bắt buộc **Tiền mặt / Chuyển khoản** (nút "Chốt & Thanh toán" vô hiệu hoá cho đến khi chọn — đúng yêu cầu gốc của bạn), nút "Huỷ phiên". Sau khi chốt: hiện nút "🖨 In hoá đơn". Không có `window.confirm()` ở bất kỳ đâu (đúng quy ước codebase).

### 6.3 `admin/gio-xanh-print.html`/`.js` (không có `nav-drawer.js`)

Theo đúng pattern `.no-print`/`.form-print`/`@media print` đã dùng — bao gồm áp dụng ngay từ đầu `color: #111` cho cả `h2` lẫn `th`/`td` (rút kinh nghiệm từ 2 lần phải vá lỗi màu chữ trước đó). Nội dung: tên cơ sở, phòng, tên khách, giờ mở/chốt, hình thức thanh toán, bảng liệt kê TẤT CẢ dòng (cả combo giờ lẫn món ăn) với tên/SL/đơn giá/thành tiền, tổng cộng.

### 6.4 `admin/nav-drawer.js`

Thêm vào nhóm "Vận hành": `{ page: 'gio-xanh.html', label: 'Giờ Xanh Hiền Lê', icon: '🌿', roles: ['reception','manager','admin','observer'] }`. `gio-xanh-detail.html`/`gio-xanh-print.html` không cần mục nav riêng (chỉ truy cập qua điều hướng từ board/nút in).

## 7. Audit log

Đăng ký `gio_xanh_session_void` ở cả 3 nơi bắt buộc trong cùng task tạo endpoint `/void`. Tái dùng `action_type='service_void'` cho huỷ dòng (không đăng ký mới). Chốt phiên không ghi audit_log riêng — dòng `finance_transactions` mới tạo là bằng chứng, nhất quán với Order ăn uống.

## 8. Testing

- `test/migrations.test.js` — 2 bảng mới, quan hệ, CHECK constraints.
- `test/gioXanhSessions.test.js` (mới) — mở phiên (chặn trùng phòng), danh sách/chi tiết, thêm dòng (cả 2 nguồn, snapshot đúng, chặn nguồn/id không hợp lệ), huỷ dòng (audit_log), huỷ phiên (audit_log, không tạo finance_transactions), chốt phiên (tổng đúng gồm cả 2 loại dòng, tạo đúng 1 finance_transactions, race-condition test giống Order ăn uống — chốt 2 lần chỉ tạo 1 bút toán).
- `tests/e2e/gio-xanh-sessions.spec.js` (outer repo, mới) — mở phiên → thêm 1 combo giờ + 1 món ăn → huỷ 1 dòng → chốt (chọn hình thức thanh toán) → xác nhận tổng đúng, hoá đơn hiển thị đúng cả 2 loại dòng.
