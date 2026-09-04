# Điều chỉnh Menu quán (nhóm, đơn vị, đặt trước, sắp xếp)

**Status:** Approved by user 2026-09-04, ready for implementation planning.

## 1. Goal

Điều chỉnh bảng `dine_in_menu_items` (đã lên production từ tính năng Order ăn uống) và trang quản lý "Menu quán" để khớp với thực đơn thật của quán: món/đồ uống có thể phân nhóm tự do (Hải sản, Món gà, Lẩu, Cà phê...), có đơn vị tính (đĩa/con/ống/ly...), món ăn có thêm cờ "Cần đặt trước", và admin sắp xếp được thứ tự món trong nhóm lẫn thứ tự giữa các nhóm.

## 2. Non-goals

- **Không đổi cách nhập giá theo size** — món có nhiều mức giá (ví dụ Lẩu Nhỏ/Lớn) được nhập thành 2 dòng riêng biệt trong menu (ví dụ "Lẩu cua đồng bắp bò (Nhỏ)" và "(Lớn)"), không thêm cơ chế nhiều giá trên 1 dòng — xác nhận rõ với người dùng.
- **Không đổi phân loại gốc `category` ('mon_an'/'do_uong')** — vẫn giữ CHECK constraint hiện có, chỉ khác: cả 2 loại giờ đều có `subgroup`/`unit`; riêng `requires_preorder` chỉ áp dụng cho `mon_an`.
- **Không xoá cứng món** — vẫn theo quy ước `is_active` như hiện tại.
- **Không dùng thư viện kéo-thả** — sắp xếp bằng nút ▲▼ đơn giản, khớp quy ước codebase (không dùng thư viện ngoài cho UI).

## 3. Architecture fit

Migration additive (thêm cột nullable/có default), không rebuild bảng. `category` vẫn quyết định `requires_preorder` có hiển thị/áp dụng hay không, nhưng `subgroup`/`unit` giờ dùng chung cho cả 2 loại. Tái dùng cột `display_order` sẵn có làm khoá sắp xếp liên tục — vị trí nhóm được suy ra từ khối liên tiếp các món cùng `subgroup` khi sắp theo `display_order`, không cần cột/bảng mới cho thứ tự nhóm.

**Ảnh hưởng tới các phần đã có/đang chờ triển khai** — đây là điểm quan trọng nhất của thay đổi này: `GET /api/dine-in-menu` đổi hình dạng response (thêm field), nên phải cập nhật lại **2 nơi** đang/sẽ tiêu thụ danh sách món:
1. `admin/dine-in-order-detail.js` (trang chọn món của tính năng Order ăn uống, đã chạy production) — đổi cách nhóm dropdown từ 2 nhóm cố định (Món ăn/Thức uống) sang nhóm theo `subgroup` động.
2. `docs/superpowers/plans/2026-09-04-gio-xanh-sessions.md` Task 6 (chưa triển khai) — sửa trực tiếp đoạn code trong file plan để khớp schema mới, trước khi dispatch task đó.

## 4. Data model

`migrations/0023_dine_in_menu_items_grouping.sql`:

```sql
ALTER TABLE dine_in_menu_items ADD COLUMN subgroup TEXT;
ALTER TABLE dine_in_menu_items ADD COLUMN unit TEXT;
ALTER TABLE dine_in_menu_items ADD COLUMN requires_preorder INTEGER NOT NULL DEFAULT 0;
```

- `subgroup`: chữ tự do, dùng cho cả `mon_an` lẫn `do_uong` (ví dụ "Hải sản", "Món gà", "Lẩu", "Cà phê", "Nước ngọt"). Có thể để trống (món chưa phân nhóm).
- `unit`: chữ tự do (đĩa/con/ống/phần/ly/chai...), tùy chọn, dùng cho cả 2 loại.
- `requires_preorder`: boolean, mặc định `0`. Chỉ có ý nghĩa với `category='mon_an'` — form nhập liệu của `do_uong` không hiển thị trường này (khi tạo/sửa món `do_uong`, giá trị này giữ nguyên `0`, không đọc từ request body).
- `display_order` (đã có sẵn): tiếp tục dùng làm thứ tự liên tục trong từng `category` — món cùng `subgroup` luôn liền kề nhau theo `display_order`.

## 5. API contract

### 5.1 Mở rộng endpoint hiện có

- **`GET /api/dine-in-menu`** — response mỗi món thêm `subgroup`, `unit`, `requiresPreorder` (camelCase). `ORDER BY` hiện tại (`category, display_order, id`) đã đúng, không cần đổi — vị trí món trong danh sách trả về đã tôn trọng đúng thứ tự admin sắp qua `display_order`, và món cùng `subgroup` sẽ tự nhiên liền kề nhau sau khi các endpoint sắp xếp ở §5.2 vận hành đúng.
- **`POST /api/dine-in-menu`** — body thêm `subgroup?`, `unit?`, `requiresPreorder?` (chỉ áp dụng khi `category='mon_an'`; nếu `category='do_uong'` mà body có `requiresPreorder=true` thì bỏ qua, luôn lưu `0`). `subgroup`/`unit` ≤100 ký tự nếu có.
- **`PATCH /api/dine-in-menu/:id`** — thêm khả năng sửa `subgroup?`, `unit?`, `requiresPreorder?` (cùng quy tắc bỏ qua `requiresPreorder` nếu món là `do_uong`). `category` vẫn bất biến sau khi tạo (theo đúng convention hiện có).

### 5.2 Endpoint sắp xếp (mới)

- **`PATCH /api/dine-in-menu/:id/move`** — role `admin`. Body `{ direction: 'up' | 'down' }`. Đổi chỗ `display_order` với món liền kề cùng `category` VÀ cùng `subgroup` (kể cả `subgroup` đều là `NULL`/rỗng — coi là "cùng nhóm chưa phân loại"). Không đổi gì (vẫn trả `200 { ok: true }`) nếu món đã ở đầu/cuối nhóm.
- **`POST /api/dine-in-menu/move-group`** — role `admin`. Body `{ category, subgroup, direction: 'up' | 'down' }`. Xác định danh sách các nhóm phân biệt trong `category` đó (sắp theo `display_order` nhỏ nhất của mỗi nhóm), tìm nhóm liền kề theo hướng yêu cầu, đổi chỗ toàn bộ khối `display_order` của 2 nhóm (giữ nguyên thứ tự nội bộ từng nhóm). Không đổi gì nếu nhóm đã ở đầu/cuối.

## 6. Client

### 6.1 `admin/dine-in-menu.html`/`.js`

Cả 2 bảng (Món ăn, Thức uống) đổi cấu trúc: nhóm theo `subgroup` (tiêu đề phụ + nút ▲▼ đổi thứ tự nhóm), mỗi dòng món có nút ▲▼ đổi thứ tự trong nhóm, giá hiển thị kèm đơn vị nếu có ("179.000đ/đĩa"), badge "⚠ Đặt trước" cho món ăn có cờ.

Form thêm/sửa:
- **Món ăn**: Tên, Nhóm (input text + `<datalist>` gợi ý các nhóm món ăn đã dùng), Giá, Đơn vị (tùy chọn), checkbox "Cần đặt trước".
- **Thức uống**: Tên, Nhóm (input text + `<datalist>` gợi ý các nhóm thức uống đã dùng — datalist riêng, không lẫn gợi ý từ nhóm món ăn), Giá, Đơn vị (tùy chọn). Không có checkbox đặt trước.

### 6.2 Retrofit `admin/dine-in-order-detail.js` (Order ăn uống, đã chạy production)

Đổi `populateMenuSelect()`: thay vì 2 `<optgroup>` cố định (Món ăn/Thức uống), nhóm động theo `subgroup` trong từng `category` (món ăn trước, đồ uống sau — hoặc theo thứ tự `display_order` xuất hiện tự nhiên). Label mỗi `<option>` đổi thành `"{tên} — {giá}đ/{đơn vị}"` (bỏ phần `/{đơn vị}` nếu không có `unit`), thêm hậu tố `" ⚠ Đặt trước"` nếu `requiresPreorder=true`.

### 6.3 Sửa file plan Giờ Xanh (chưa triển khai)

Sửa trực tiếp `docs/superpowers/plans/2026-09-04-gio-xanh-sessions.md` Task 6: đoạn code `populateMenuSelect()` trong `gio-xanh-detail.js` đổi giống hệt 6.2 (nhóm động theo `subgroup`, label kèm đơn vị + cảnh báo đặt trước). Việc sửa này làm trực tiếp trên file plan (chưa có task nào của Giờ Xanh được dispatch), không phải một task riêng của plan này.

## 7. Testing

- `test/migrations.test.js` — 3 cột mới, giá trị mặc định `requires_preorder=0`.
- `test/dineInMenu.test.js` (mở rộng) — POST/PATCH nhận `subgroup`/`unit`/`requiresPreorder`; `requiresPreorder` bị bỏ qua khi `category='do_uong'`; `category` vẫn bất biến qua PATCH.
- `test/dineInMenuReorder.test.js` (mới) — `PATCH .../move`: đổi chỗ đúng 2 món cùng nhóm liền kề, không đổi gì ở biên nhóm, không đổi món khác nhóm dù `display_order` liền kề về số. `POST .../move-group`: đổi đúng toàn bộ khối 2 nhóm liền kề (kiểm tra thứ tự nội bộ giữ nguyên), không đổi gì ở biên.
- `tests/e2e/dine-in-menu-groups.spec.js` (outer repo, mới) — trang Menu quán hiển thị đúng nhóm cho cả 2 bảng, nút ▲▼ hoạt động (gọi đúng API, cập nhật lại danh sách); trang Order ăn uống hiển thị dropdown chọn món nhóm theo `subgroup`, hiển thị đơn vị + cảnh báo đặt trước đúng.
