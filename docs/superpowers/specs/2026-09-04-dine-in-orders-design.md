# Order ăn uống tại chỗ (khách không lưu trú)

**Status:** Approved by user 2026-09-04, ready for implementation planning.

## 1. Goal

Cho phép lễ tân/quản lý nhận order ăn uống của khách đến trực tiếp Hiền Lê Garden (dùng dịch vụ ăn uống, không thuê phòng): mở bàn, gọi món theo menu, huỷ dòng gọi nhầm, chốt và thu tiền, in hoá đơn — hoàn toàn độc lập với hệ thống đặt phòng/lưu trú.

## 2. Non-goals

- **Không đụng vào `bookings`/`booking_service_items`** — khách ăn uống tại chỗ không có bản ghi đặt phòng, và `bookings` bắt buộc `room_type`/`check_in`/`check_out` (NOT NULL, có CHECK enum phòng) nên không thể tái sử dụng mà không làm sai lệch báo cáo phòng/dashboard hiện có. Xây bộ bảng độc lập.
- **Không có sơ đồ bàn trực quan** — số bàn là text tự do (ví dụ "Bàn 3", "Khu vườn"), không có bản đồ/layout bàn kéo-thả.
- **Không có màn hình bếp (KDS)** — món gọi hiển thị ngay trên order, không có luồng "đang chuẩn bị/đã phục vụ" riêng cho bếp.
- **Không tách bút toán theo loại món** — dù menu phân loại món ăn/thức uống để hiển thị gọn hơn, khi chốt order chỉ tạo **1** bút toán Sổ thu chi duy nhất cho toàn bộ order, vào danh mục mới "Khách vãng lai" (xác nhận rõ với người dùng, không tách theo "Bếp Hiền Lê"/"Hiền Lê Drinks").
- **Không có xoá cứng** — huỷ món/huỷ bàn chỉ đổi trạng thái (`voided`), không xoá dữ liệu; món trong menu chỉ ẩn (`is_active=0`), không xoá cứng — nhất quán với mọi tính năng trước trong dự án.
- **Không yêu cầu số lượng khách trên order** — chỉ cần số bàn + ghi chú tự do (tuỳ chọn); không bắt buộc nhập số khách.

## 3. Architecture fit

Cùng stack với toàn bộ V4: Cloudflare Pages Functions + D1, admin frontend vanilla JS, không build step. 3 bảng D1 mới, độc lập với `bookings`. Endpoint theo đúng convention narrow-action-endpoint đã dùng xuyên suốt dự án (mỗi action một endpoint riêng: mở bàn, thêm món, huỷ dòng, huỷ bàn, chốt). Trang admin theo đúng pattern các trang cấu hình đã có (`finance-categories.html`) và trang in theo đúng pattern vừa xây (`stay-registration-print.html` — không có `nav-drawer.js`, `@media print` ẩn phần `.no-print`).

## 4. Data model

`migrations/0021_dine_in_orders.sql`:

```sql
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
```

`name`/`unit_price` trên `dine_in_order_items` là **snapshot** tại thời điểm gọi món — sửa giá menu sau này không ảnh hưởng order cũ đã chốt/đang mở.

`finance_transaction_id` trên `dine_in_orders` trỏ tới dòng Sổ thu chi được tạo khi chốt (để tra cứu ngược, không dùng để tính toán).

Migration cũng seed danh mục Sổ thu chi mới vào bảng `finance_categories` (đã admin-configurable từ tính năng trước):

```sql
INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at, updated_by, updated_at)
VALUES ('khach_vang_lai', 'Khách vãng lai', 'income', 1, 'system', '2026-09-04T00:00:00Z', 'system', '2026-09-04T00:00:00Z');
```

## 5. API contract

Tất cả endpoint dưới `functions/api/dine-in-menu/` và `functions/api/dine-in-orders/`.

### 5.1 Menu

- **`GET /api/dine-in-menu`** — roles `reception, manager, admin, observer`. Trả về toàn bộ món (kể cả `is_active=0`, để trang quản lý menu hiển thị được cả món đã ẩn); client tự lọc `is_active=1` khi hiển thị picker gọi món.
- **`POST /api/dine-in-menu`** — role `admin`. Body `{ name, category, price }`. Tạo món mới, `is_active=1` mặc định.
- **`PATCH /api/dine-in-menu/:id`** — role `admin`. Body chỉ nhận `{ name?, price?, isActive? }` (bỏ qua `category` sau khi tạo — đổi loại món coi như tạo món mới, tránh làm rối dữ liệu lịch sử).

### 5.2 Orders

- **`POST /api/dine-in-orders`** — roles `reception, manager, admin`. Body `{ tableLabel, note? }`. `tableLabel` bắt buộc, tối đa 100 ký tự. Tạo order `status='open'`.
- **`GET /api/dine-in-orders?status=open`** — roles `reception, manager, admin, observer`. Danh sách order theo status (mặc định `open` nếu không truyền), sắp theo `opened_at` tăng dần.
- **`GET /api/dine-in-orders/:id`** — roles `reception, manager, admin, observer`. Chi tiết order + toàn bộ dòng món (bao gồm cả `voided`, hiển thị gạch ngang trên UI).
- **`POST /api/dine-in-orders/:id/items`** — roles `reception, manager, admin`. Body `{ menuItemId, quantity }`. Chỉ cho phép khi order `status='open'`. Snapshot `name`/`unit_price` từ `dine_in_menu_items` tại thời điểm gọi (item phải `is_active=1`).
- **`PATCH /api/dine-in-orders/:id/items/:itemId`** — roles `reception, manager, admin`. Huỷ 1 dòng (`status='voided'`), chỉ khi order còn `open`. Ghi `audit_log`: `action_type='service_void'` (tái dùng nhãn "Huỷ dịch vụ" đã có), `entity_type='dine_in_order_item'`, `entity_label='{item.name} ×{item.quantity} — {tableLabel}'` (theo đúng format `${name} ×${quantity} — ${...}` đã dùng ở `functions/api/bookings/[id]/services/[itemId].js`, chỉ thay `guestName` bằng `tableLabel` vì không có khách gắn với order).
- **`POST /api/dine-in-orders/:id/void`** — roles `reception, manager, admin`. Huỷ cả bàn khi còn `open` (không tạo bút toán). Ghi `audit_log`: `action_type='dine_in_order_void'` (đăng ký mới ở cả 3 registry), `entity_type='dine_in_order'`, `entity_label='{tableLabel} — {n} món, {tổng tạm tính}đ'` (n và tổng tính trên các dòng `posted` tại thời điểm huỷ).
- **`POST /api/dine-in-orders/:id/close`** — roles `reception, manager, admin`. Body `{ paymentMethod }` (`'cash'` hoặc `'transfer'`, bắt buộc). Chỉ khi order `status='open'` và có ít nhất 1 dòng `posted`. Tính `total_amount = SUM(amount) WHERE status='posted'`. Vì D1 `batch()` không trả lại `last_row_id` của một câu để dùng ngay trong câu tiếp theo cùng batch, thực hiện 2 bước tuần tự: (1) `INSERT INTO finance_transactions (...) VALUES (...)` — lấy `result.meta.last_row_id`; (2) `UPDATE dine_in_orders SET status='closed', closed_by=?, closed_at=?, payment_method=?, total_amount=?, finance_transaction_id=? WHERE id=?` dùng id vừa tạo ở bước 1. `finance_transactions` insert dùng `type='income', category='khach_vang_lai', amount=total_amount, note='Order {tableLabel} — {n} món', created_by=actor, created_at=now, status='confirmed'`.

## 6. Client

### 6.1 `admin/dine-in-menu.html`/`.js` (admin-only)

Cấu trúc y hệt `admin/finance-categories.html`: bảng món (tên, loại, giá, trạng thái hoạt động), nút sửa tên/giá (`window.prompt`, theo đúng pattern `catalog.js`), nút ẩn/hiện, form thêm món mới (tên, loại — chọn radio Món ăn/Thức uống, giá).

### 6.2 `admin/dine-in-orders.html`/`.js`

Board các bàn đang mở, dạng thẻ: số bàn, giờ mở, tổng tạm tính (SUM các dòng `posted`). Nút "➕ Mở bàn mới" mở form nhập `tableLabel` + `note` tuỳ chọn. Click 1 thẻ → điều hướng `dine-in-order-detail.html?orderId={id}`.

### 6.3 `admin/dine-in-order-detail.html`/`.js`

Danh sách món đã gọi (dòng `voided` hiển thị gạch ngang, mờ). Form thêm món: dropdown món từ menu đang active (nhóm theo Món ăn/Thức uống) + số lượng. Tổng tiền cập nhật theo dòng `posted`. Nút huỷ trên mỗi dòng `posted` (xác nhận trước khi gọi API).

**Khu vực chốt thanh toán**: radio bắt buộc chọn **"💵 Tiền mặt"** hoặc **"🏦 Chuyển khoản"** trước khi nút "✅ Chốt & Thanh toán" được bấm được (disable nếu chưa chọn) — cùng UX pattern đã dùng ở phần thêm dịch vụ cho khách lưu trú. Sau khi chốt thành công, chuyển sang trạng thái đọc-only + hiện nút "🖨 In hoá đơn".

Nút "❌ Huỷ bàn" (chỉ hiện khi order còn `open`), có xác nhận trước khi gọi API.

### 6.4 `admin/dine-in-order-print.html`/`.js` (không có `nav-drawer.js`)

Theo đúng pattern `stay-registration-print.html`: `.no-print`/`.form-print` + `@media print`. Nội dung in: tên cơ sở, số bàn, giờ mở/đóng, danh sách món (tên, SL, đơn giá, thành tiền), tổng cộng, hình thức thanh toán.

### 6.5 `admin/nav-drawer.js`

Thêm 2 mục vào nhóm "Vận hành": `{ page: 'dine-in-orders.html', label: 'Order ăn uống', icon: '🍽️', roles: ['reception','manager','admin','observer'] }`; và vào nhóm "Cấu hình & Quản trị": `{ page: 'dine-in-menu.html', label: 'Menu quán', icon: '📋', roles: ['admin'] }`. `dine-in-order-detail.html` không cần mục nav riêng (chỉ truy cập qua click từ board).

## 7. Audit log

Đăng ký `dine_in_order_void` ở cả 3 nơi bắt buộc (`admin/audit-log.js`, `admin/audit-log.html`, `functions/api/audit-log/index.js`) trong cùng task tạo endpoint `/void`. Tái dùng `action_type='service_void'` có sẵn cho việc huỷ 1 dòng món (không cần đăng ký mới, chỉ khác `entity_type`). Việc chốt order **không** ghi audit_log riêng — bản thân dòng `finance_transactions` mới tạo đã là bằng chứng, nhất quán với việc mọi giao dịch Sổ thu chi khác không có audit_log riêng cho hành vi tạo.

## 8. Testing

- `test/migrations.test.js` — 3 bảng mới + seed danh mục `khach_vang_lai`.
- `test/dineInMenu.test.js` (mới) — CRUD menu: role gate, tạo/sửa/ẩn, PATCH bỏ qua `category`.
- `test/dineInOrders.test.js` (mới) — mở bàn, thêm món (snapshot giá đúng), huỷ dòng (audit_log), huỷ bàn (audit_log, không tạo finance_transactions), chốt bàn (tính đúng tổng, tạo đúng 1 dòng finance_transactions với category đúng, không cho chốt khi thiếu paymentMethod, không cho thao tác trên order đã `closed`/`voided`).
- `tests/e2e/dine-in-orders.spec.js` (outer repo, mới) — luồng đầy đủ: mở bàn → gọi 2 món → huỷ 1 dòng → chốt bàn (chọn tiền mặt) → xác nhận tổng đúng, nút in xuất hiện; test riêng: không cho chốt khi chưa chọn hình thức thanh toán (nút disable).
