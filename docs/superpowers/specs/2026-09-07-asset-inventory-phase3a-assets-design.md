# Tài sản & Kho — Giai đoạn 3a: Hồ sơ tài sản vận hành (Lớp 3) & đối chiếu bàn giao

**Status:** Đang chờ user duyệt spec.

## 0. Bối cảnh chung

Đây là spec cho **Giai đoạn 3a**, phần đầu của Giai đoạn 3 ("Nhập dữ liệu bàn giao, thiết bị riêng lẻ và kiểm kê từng phòng" — bước 3 trong lộ trình 6 giai đoạn của yêu cầu gốc, §12). Giai đoạn 3 được tách làm 2 phần vì kiểm kê từng phòng (3b) phụ thuộc trực tiếp vào việc đã có tài sản vận hành thật để đối chiếu — 3a xây nền tảng đó trước.

**Đã có (Giai đoạn 2, hoàn tất)**: `asset_categories` (danh mục 2 tầng, 8 management_type cố định), `asset_locations` (phòng/kho/khu vực chung, tham chiếu `rooms.id` qua FK, không sửa bảng `rooms`), `asset_source_documents`/`asset_source_rows` (Lớp 1 — hồ sơ bàn giao gốc bất biến, đã nhập đủ 64 dòng Phụ lục II thật), 2 trang admin: `asset-config.html` (danh mục & vị trí) và `asset-source-data.html` (hồ sơ nguồn, chỉ xem).

**Giai đoạn 3a xây gì**: bảng tài sản vận hành thật (Lớp 3 theo mô hình 3 lớp), luồng đối chiếu 64 dòng nguồn → tài sản thật, hồ sơ thiết bị riêng lẻ có mã QR, và 1 trang quản lý tài sản mới.

**Giai đoạn 3b (spec riêng, sau)**: quy trình kiểm kê từng phòng (đợt kiểm kê, form chi tiết, chốt/điều chỉnh) — dùng bảng `assets` mà 3a tạo ra.

## 1. Mục tiêu Giai đoạn 3a

1. Bảng `assets` (Lớp 3) lưu tài sản vận hành thật — vị trí, người giữ, số lượng, tình trạng, nguồn A/B — tách biệt hoàn toàn khỏi Lớp 1 (`asset_source_rows`, không bao giờ bị sửa).
2. Luồng đối chiếu: admin/manager chọn từng dòng trong `asset_source_rows`, gán danh mục + tạo tài sản thật, không đếm trùng, không suy đoán vị trí/số lượng.
3. Hồ sơ thiết bị riêng lẻ đầy đủ theo §4 của yêu cầu gốc, có mã nội bộ tự sinh + mã QR hiển thị/tải về.
4. Ảnh đính kèm tài sản (tái sử dụng R2 bucket `RECEIPTS` đã có).
5. 1 trang quản lý tài sản mới (`admin/assets.html`) + mở rộng trang hồ sơ nguồn đã có với luồng đối chiếu.

## 2. Không làm trong giai đoạn này (Non-goals)

- **Không** tạo bản ghi cho các `management_type` thuộc phạm vi Giai đoạn 4 (`linen`, `consumable`, `spare_part`, `food_beverage`) — những loại này cần sổ kho nhập-xuất-tồn mới có ý nghĩa vận hành, tạo trước ở đây là dựng giao diện suông.
- **Không** xây quy trình kiểm kê từng phòng (đợt kiểm kê, form chi tiết, chốt) — đó là Giai đoạn 3b, spec riêng.
- **Không** xây luồng báo hỏng/sửa chữa/thay mới (Giai đoạn 5/6) — thiết bị chỉ có trạng thái tĩnh, chưa có quy trình xử lý sự cố.
- **Không** đổi bảng `asset_source_rows`/`asset_source_documents` — hoàn toàn chỉ đọc, không thêm cột, không PATCH/DELETE.
- **Không** tự động phân loại/gán danh mục cho từng dòng nguồn — admin phải chọn tay, vì việc phân loại đòi hỏi hiểu biết nghiệp vụ mà hệ thống không có.
- **Không** tự tạo lịch sử giả hoặc dữ liệu minh hoạ trộn lẫn với dữ liệu vận hành thật.

## 3. Kiến trúc dữ liệu

### 3.1 `assets` — Lớp 3, tài sản vận hành thật

```sql
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

- `internal_code`: dạng `TS000123` (`TS` + id 6 chữ số), sinh tự động **chỉ khi** danh mục thuộc `individual_device`/`device_set` (loại có định danh cá thể, dán được QR lên 1 món đồ cụ thể) — `durable_goods`/`infrastructure` để `NULL` vì không có ý nghĩa gắn mã cho 1 đơn vị cụ thể khi tài sản được theo dõi theo số lượng gộp.
- `quantity`: `NULL` = "Chưa xác định" (không bao giờ ép thành 0). Với `individual_device`/`device_set`, luôn set `= 1` khi tạo (mỗi dòng là chính xác 1 hiện vật, không có khái niệm "chưa xác định" ở đây). Với `durable_goods`/`infrastructure`, giữ nguyên `NULL` nếu chưa biết.
- `location_id = NULL` = "Chưa phân bổ vị trí" — không bao giờ đoán.
- `category_id` không đổi được qua PATCH sau khi tạo (400 nếu request có field này) — giống quy tắc `asset_categories`/`asset_locations` ở Giai đoạn 2.
- `acquired_date`/`purchase_price` = `NULL` nếu chưa biết, không dùng 0.
- `source_row_id`: liên kết dòng `asset_source_rows` gốc nếu tài sản đến từ đối chiếu bàn giao. **Không thêm bất kỳ cột nào lên bảng `asset_source_rows`** — trạng thái "đã đối chiếu bao nhiêu tài sản từ dòng này" luôn được tính bằng `COUNT(*) FROM assets WHERE source_row_id = ?`, không lưu cache.
- Lịch sử sửa/điều chuyển: tái sử dụng `audit_log` sẵn có (không tạo bảng lịch sử riêng) — 2 action_type mới: `asset_create`, `asset_update`.
- Ảnh: tái sử dụng R2 bucket `RECEIPTS` đã có (đang dùng cho hoá đơn tài chính), key theo mẫu `asset-photos/<assetId>/<timestamp>-<filename>`, đúng cơ chế `functions/api/finance/transactions/[id]/attachment.js` đã có (POST/GET/DELETE), chỉ đổi bảng đích và tiền tố key.

## 4. API contract

Tất cả theo đúng pattern `requireAuth(request, env, roles)` đã dùng xuyên suốt.

### Tài sản
- `GET /api/assets` — roles `admin, manager, reception, observer`. Query: `?categoryId=`, `?locationId=`, `?sourceType=`, `?managementType=`, `?q=` (tìm theo name/internalCode/serialNumber). Response mỗi dòng: `{id, categoryId, managementType, internalCode, name, brand, serialNumber, sourceType, sourceRowId, acquiredDate, purchasePrice, locationId, holder, quantity, physicalCondition, operationalStatus, lifecycleStatus, photoKey, photoFilename, note, createdBy, createdAt, updatedBy, updatedAt}` (`managementType` join từ `asset_categories` để client không phải gọi thêm API).
- `POST /api/assets` — roles `admin, manager`. Body `{categoryId, name, brand?, serialNumber?, sourceType, acquiredDate?, purchasePrice?, locationId?, holder?, quantity?, note?}`. Validate: `categoryId` tồn tại; nếu `managementType` của category thuộc `individual_device`/`device_set` → tự sinh `internalCode`, ép `quantity = 1` (bỏ qua giá trị client gửi nếu có); nếu thuộc `durable_goods`/`infrastructure` → `internalCode = NULL`, `quantity` lấy từ body (cho phép `NULL`). Ghi `audit_log` action `asset_create`.
- `PATCH /api/assets/:id` — roles `admin, manager`. Body có thể gồm mọi field trừ `categoryId` (400 nếu request có field này). Ghi `audit_log` action `asset_update` với `old_value`/`new_value` là tên tài sản trước/sau (giống quy ước `asset_category_update`).
- `POST /api/assets/:id/photo`, `GET /api/assets/:id/photo`, `DELETE /api/assets/:id/photo` — roles `admin, manager` cho POST/DELETE, `admin, manager, reception, observer` cho GET — sao chép nguyên logic `functions/api/finance/transactions/[id]/attachment.js` (giới hạn loại file JPG/PNG/WebP/PDF, tối đa 10MB, xoá ảnh cũ khi thay ảnh mới).

### Đối chiếu bàn giao
- `GET /api/asset-source-rows?documentId=X` (đã có, Giai đoạn 2) — **mở rộng thêm field** `reconciledCount` (số nguyên = `COUNT(*) FROM assets WHERE source_row_id = row.id`) vào mỗi dòng trả về. Không đổi role/tham số hiện có.
- `POST /api/asset-source-rows/:id/reconcile` (mới) — roles `admin, manager`. Body `{categoryId, locationId?, count?}` cho danh mục `individual_device`/`device_set` (tạo `count` tài sản riêng biệt, mỗi cái `internalCode` tự sinh, `quantity=1`, `locationId` giống nhau nếu có truyền — mặc định `NULL`; `count` mặc định `1` nếu không truyền, phải là số nguyên dương); hoặc `{categoryId, locationId?, quantity?}` cho `durable_goods`/`infrastructure` (tạo đúng 1 tài sản; `quantity` mặc định `NULL` — "Chưa xác định" — nếu không truyền). Mọi tài sản tạo qua endpoint này tự động `sourceType = 'handover_a'`, `sourceRowId = :id` — client không truyền 2 field này.
  - 400 nếu dòng nguồn (`raw_quantity`) là số dương đã biết và tổng `reconciledCount` hiện có cộng `count`/`1` sẽ **vượt quá** `raw_quantity` — chặn đếm trùng bàn giao. Không áp dụng giới hạn này khi `raw_quantity` là `NULL` (chưa xác định — không có gì để so sánh).
  - 404 nếu không tìm thấy dòng nguồn; 400 nếu `categoryId` không tồn tại.

## 5. Client

### 5.1 `admin/assets.html`/`.js` (mới) — "Danh mục tài sản"
Bảng/danh sách có bộ lọc (danh mục, vị trí, nguồn A/B, trạng thái hoạt động) + ô tìm kiếm. Mỗi dòng bấm vào mở popup (`.confirm-overlay`/`.confirm-box`) hiển thị đầy đủ chi tiết + ảnh + **mã QR** (chỉ hiện với `individual_device`/`device_set` — dòng có `internalCode`), có nút tải QR về dạng ảnh để in dán lên thiết bị. Popup này cũng là form sửa (admin/manager), ẩn hẳn field `categoryId` sau khi tạo. Reception/observer xem được toàn bộ, không có nút Thêm/Sửa.

**Mã QR**: vendor 1 thư viện JS tự chứa, không phụ thuộc mạng khi trang chạy thật (`davidshimjs/qrcodejs`, MIT license, ~15KB, sinh QR trực tiếp trên trình duyệt từ chuỗi `internalCode`) — tải về 1 lần lúc code, lưu thành file tĩnh `admin/lib/qrcode.min.js`, phục vụ từ chính origin của dự án như mọi script admin khác. Trang chạy thật không gọi bất kỳ CDN/dịch vụ ngoài nào.

### 5.2 Mở rộng `admin/asset-source-data.html`/`.js` (đã có)
Mỗi dòng trong bảng 64 dòng, admin/manager thấy thêm: nhãn "Đã tạo X/N tài sản" (hoặc "Đã tạo X tài sản" nếu N chưa xác định) + nút "Tạo tài sản" mở popup chọn danh mục (dropdown từ `asset_categories` đang active) + vị trí (tuỳ chọn) + số lượng cần tạo (chỉ hiện field này khi danh mục chọn thuộc loại cá thể). Reception/observer thấy y hệt hiện tại — chỉ xem, không có nút này.

## 6. Audit log

2 action_type mới, đăng ký đúng 3 nơi bắt buộc (`functions/api/audit-log/index.js`, `admin/audit-log.js`, `admin/audit-log.html`): `asset_create`, `asset_update`. `entity_type = 'asset'`, `entity_label` = tên tài sản tại thời điểm ghi.

## 7. Testing

- Migration test: đúng schema `assets`, đúng CHECK constraint (`source_type`, 3 trạng thái tách biệt), FK tới `asset_categories`/`asset_locations`/`asset_source_rows` không lỗi.
- API test: role-gating từng endpoint; `internalCode` tự sinh đúng điều kiện theo `managementType`; `quantity` ép `=1` cho loại cá thể; không cho đổi `categoryId` qua PATCH; endpoint đối chiếu chặn đúng khi vượt `raw_quantity` đã biết, không chặn khi `raw_quantity = NULL`; `GET /api/asset-source-rows` trả đúng `reconciledCount`.
- E2e (repo ngoài): trang `assets.html` hiển thị đúng theo role, lọc/tìm hoạt động, popup chi tiết hiện đúng QR cho loại cá thể và ẩn với loại số lượng; trang hồ sơ nguồn hiện đúng "Đã tạo X/N" và luồng tạo tài sản qua popup.

## 8. Bàn giao cho Giai đoạn 3b

Giai đoạn 3b (kiểm kê từng phòng) sẽ đọc bảng `assets` này để: hiển thị "số lượng trên sổ" theo từng vị trí, cho phép cập nhật `quantity`/`location_id`/`physical_condition` khi chốt kiểm kê (viết `audit_log` action mới, ví dụ `asset_inventory_adjustment`, không phải sửa trực tiếp không lịch sử). Giai đoạn 3a không tạo sẵn cơ chế "đợt kiểm kê" — đó hoàn toàn là việc của 3b.
