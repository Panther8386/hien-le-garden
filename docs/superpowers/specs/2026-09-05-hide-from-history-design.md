# Ẩn khỏi lịch sử (Giờ Xanh, Order ăn uống, Đặt phòng)

**Status:** Approved by user 2026-09-05, ready for implementation planning.

## 1. Goal

Cho phép admin ẩn một bản ghi đã ở trạng thái kết thúc (phiên Giờ Xanh đã chốt/huỷ, bàn Order ăn uống đã chốt/huỷ, đặt phòng đã trả phòng/đã huỷ) khỏi các danh sách/lịch sử hiển thị hàng ngày — ví dụ dữ liệu test, đặt phòng nhầm, phiên thử nghiệm — mà không xoá dữ liệu. Chỉ admin mới thấy checkbox "Hiển thị các log đã ẩn" để xem lại khi cần.

## 2. Non-goals

- **Không xoá cứng** — "ẩn" chỉ là 1 cột trạng thái hiển thị (`is_hidden`), dữ liệu vẫn còn nguyên trong D1, đúng quy ước đã dùng xuyên suốt dự án.
- **Không cho ẩn bản ghi đang hoạt động** — chỉ được ẩn khi bản ghi đã ở trạng thái kết thúc (xem §4). Ẩn 1 phiên/bàn/đặt phòng đang xử lý dở có thể khiến lễ tân mất dấu công việc chưa xong — không cho phép.
- **Không đổi quyền xem dữ liệu hiện có** — reception/manager vẫn thấy đầy đủ như hiện tại (trừ phần bị ẩn theo mặc định); chỉ admin có thêm quyền ẩn/hiện + xem lại bản ghi đã ẩn.
- **Không xây trang lịch sử chung cho cả 3 hệ thống** — mỗi hệ thống giữ nguyên vị trí hiển thị hiện có của nó (xem §6), chỉ bổ sung khả năng ẩn/hiện.

## 3. Architecture fit

Áp dụng cùng 1 mẫu thiết kế nhỏ, lặp lại ở 3 bảng độc lập (`gio_xanh_sessions`, `dine_in_orders`, `bookings`): 1 cột `is_hidden` mới, GET endpoint hiện có lọc bỏ theo mặc định (thêm query param `includeHidden` chỉ admin dùng được), 1 endpoint `PATCH .../:id/hide` mới. Không đổi cấu trúc bảng khác, không đổi bất kỳ hành vi hiện có nào khi `is_hidden=0` (giá trị mặc định) — hoàn toàn additive.

## 4. Data model

`migrations/0025_hide_from_history.sql` (1 migration, thêm cột vào cả 3 bảng — đều là ALTER TABLE thuần, không đụng dữ liệu/cột hiện có):

```sql
ALTER TABLE gio_xanh_sessions ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dine_in_orders ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
```

**Trạng thái được phép ẩn** (kiểm tra ở server, không chỉ ở client):
- `gio_xanh_sessions`: `status IN ('closed', 'voided')`.
- `dine_in_orders`: `status IN ('closed', 'voided')`.
- `bookings`: `status IN ('checked_out', 'cancelled')`.

Cố ẩn 1 bản ghi không ở trạng thái trên → `400`.

## 5. API contract

Mẫu chung cho cả 3 endpoint GET hiện có (`GET /api/gio-xanh-sessions`, `GET /api/dine-in-orders`, `GET /api/bookings`):
- Mặc định thêm `WHERE ... AND is_hidden = 0` vào câu truy vấn hiện có (giữ nguyên toàn bộ điều kiện lọc theo `status`/`date`/`view` đã có).
- Nếu query có `includeHidden=1`: bỏ điều kiện `is_hidden = 0` — **chỉ áp dụng khi `auth.role === 'admin'`**; nếu role khác gửi `includeHidden=1` thì tham số này bị bỏ qua lặng lẽ (không lỗi, chỉ đơn giản không có tác dụng — tránh lộ thông tin qua thông báo lỗi).

Mẫu chung cho endpoint ẩn/hiện mới (1 endpoint mới mỗi hệ thống):
- **`PATCH /api/gio-xanh-sessions/:id/hide`**
- **`PATCH /api/dine-in-orders/:id/hide`**
- **`PATCH /api/bookings/:id/hide`**

Cả 3: role `admin` only. Body `{ hidden: true | false }` (bắt buộc là boolean). 404 nếu không tìm thấy id. 400 nếu bản ghi chưa ở trạng thái kết thúc (xem §4). Thành công: `UPDATE ... SET is_hidden = ? WHERE id = ?`, ghi 1 dòng `audit_log` (tái dùng 1 action_type mới duy nhất cho cả 3 hệ thống — xem §7), trả về `200 { ok: true }`.

## 6. Client

Mẫu chung: nút "Ẩn"/"Hiện" (admin-only) trên mỗi dòng/thẻ đã ở trạng thái kết thúc; checkbox "Hiển thị các log đã ẩn" (admin-only) — khi tick, mọi lần tải lại danh sách sẽ gửi kèm `includeHidden=1`.

### 6.1 `admin/gio-xanh.js`/`.html`
Thêm khu vực mới "Lịch sử phiên" bên dưới danh sách phiên đang mở hiện có: checkbox "Hiển thị các log đã ẩn" (admin-only) + danh sách phiên `status=closed` và `status=voided` (gộp, sắp theo thời gian mới nhất trước), mỗi dòng có nút Ẩn/Hiện (admin-only) và bấm vào dòng thì mở lại trang chi tiết/in hoá đơn như phiên đang mở.

### 6.2 `admin/dine-in-orders.js`/`.html`
Y hệt cấu trúc 6.1 — thêm khu vực "Lịch sử" cho bàn `status=closed`/`voided`.

### 6.3 `admin/reception.js`/`.html`
Không thêm khu vực mới. Thêm 1 checkbox "Hiển thị các log đã ẩn" (admin-only) ở đầu trang — khi đổi trạng thái, tải lại toàn bộ các danh sách đang hiển thị (chờ duyệt, đến hôm nay, đã xác nhận, trả phòng hôm nay, đang ở) kèm `includeHidden=1`. Nút Ẩn/Hiện (admin-only) chỉ xuất hiện trên thẻ đặt phòng có `status IN ('checked_out','cancelled')`.

## 7. Audit log

Đăng ký 1 action_type mới dùng chung cho cả 3 hệ thống: `record_hide`. `entity_type` phân biệt theo hệ thống (`gio_xanh_session` / `dine_in_order` / `booking`, tái dùng đúng tên đã dùng ở các audit_log hiện có của từng hệ thống). `old_value`/`new_value` ghi `'hiện'`/`'ẩn'` (hoặc ngược lại). Đăng ký `record_hide` ở cả 3 nơi bắt buộc: `admin/audit-log.js`, `admin/audit-log.html`, `functions/api/audit-log/index.js`.

## 8. Testing

- `test/migrations.test.js` — cột `is_hidden` mặc định 0 ở cả 3 bảng, nhận giá trị 1.
- `test/gioXanhSessions.test.js`, `test/dineInOrders.test.js` — mở rộng: GET mặc định loại bỏ `is_hidden=1`; `includeHidden=1` chỉ có tác dụng với role admin; endpoint `.../hide` — 401/403 đúng vai trò, 404 sai id, 400 khi bản ghi chưa ở trạng thái kết thúc, thành công ghi đúng `is_hidden` + đúng audit_log.
- `test/bookingsEndpoints.test.js` (file test hiện có cho `GET /api/bookings`, khác với `bookingsStaffEndpoint.test.js` — file đó test `bookings/staff.js`, một endpoint riêng) — tương tự cho `bookings`.
- `tests/e2e/*.spec.js` (repo ngoài) — mỗi trang: checkbox chỉ hiện với admin; tick checkbox thì gọi lại API kèm `includeHidden=1`; nút Ẩn/Hiện gọi đúng endpoint.
