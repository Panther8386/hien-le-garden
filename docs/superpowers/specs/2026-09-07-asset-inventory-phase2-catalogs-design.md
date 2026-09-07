# Tài sản & Kho — Giai đoạn 2: Danh mục mở, Vị trí, Nguồn A/B, Hồ sơ nguồn

**Status:** Đang chờ user duyệt spec.

## 0. Bối cảnh chung (áp dụng cho toàn bộ phân hệ Tài sản & Kho)

Yêu cầu gốc của người dùng mô tả 1 phân hệ đầy đủ: Tài sản → Kho → Kiểm kê → Vận hành/bảo dưỡng → Báo hỏng/sửa chữa → Thay mới, chia làm 6 giai đoạn (đúng theo bản yêu cầu §12). Đây là spec cho **Giai đoạn 2** — nền tảng bắt buộc trước khi làm được bất kỳ giai đoạn nào sau. Giai đoạn 1 (khảo sát) đã hoàn tất — kết quả dưới đây.

### Khảo sát: tái sử dụng gì, thêm gì mới

**Tái sử dụng nguyên trạng, không tạo cơ chế thứ hai:**
- **Phân quyền**: 4 role có sẵn `admin`/`manager`/`reception`/`observer` (CHECK constraint tại `migrations/0007`, không có role thứ 5). Map cho phân hệ này: Admin→`admin`, Quản lý→`manager`, **Nhân viên (gồm cả lễ tân và buồng phòng) → `reception`** — role duy nhất hiện có cho nhân sự vận hành; hệ thống hiện tại không phân biệt lễ tân/buồng phòng ở tầng quyền, và bảng quyền người dùng cung cấp cũng gộp chung "Nhân viên" thành 1 tầng.
- **Phòng**: bảng `rooms` (16 phòng, `room_type` cố định qua CHECK: triangle/circle/ede_cozy/vip/bungalow/dormitory, định nghĩa nhãn tại `lib/roomTypes.js`). Dùng lại nguyên bảng này — không tạo danh mục phòng thứ hai.
- **Lưu ảnh**: R2 bucket `RECEIPTS` sẵn có (đang dùng cho hoá đơn tài chính) — dùng lại với prefix key riêng cho ảnh tài sản ở giai đoạn sau, không cần bucket mới.
- **Nhật ký thao tác**: bảng `audit_log` + quy ước đăng ký 3 nơi (`admin/audit-log.js`, `admin/audit-log.html`, `functions/api/audit-log/index.js`).
- **Lịch định kỳ (kiểm kê 3 tháng, bảo dưỡng)**: dự án không có cơ chế cron/scheduled job (Cloudflare Pages Functions không hỗ trợ), nhưng đã có sẵn đúng pattern cần dùng ở `lib/receptionReminders.js` — tính "đến hạn chưa" ngay lúc tải trang, không cần job nền. Giai đoạn 5 sẽ tái sử dụng pattern này.
- **Migration tiếp theo**: `0027` (mới nhất hiện có: `0026_finance_hide_from_history.sql`).

**Hoàn toàn mới (chưa có gì tương tự trong dự án):**
- Toàn bộ schema Tài sản/Kho — không có bảng nào liên quan tồn tại (đã grep xác nhận `gift_inventory` chỉ là 1 bộ đếm tồn cho 1 quà tặng khuyến mãi, không liên quan).
- Khái niệm "vị trí" ngoài phòng (kho, khu vực chung) — bảng mới, tham chiếu `rooms` khi là phòng chứ không nhân đôi danh mục phòng.
- Sinh mã QR — chưa có ở đâu trong dự án.

## 1. Mục tiêu Giai đoạn 2

Xây nền tảng dữ liệu mà mọi giai đoạn sau đều phụ thuộc:
1. Danh mục 2 tầng cho tài sản/vật tư (8 "cách quản lý" cố định + danh mục cụ thể mở, admin quản lý).
2. Bảng "vị trí" hợp nhất (phòng/kho/khu vực chung).
3. Khái niệm nguồn A/B dùng xuyên suốt các giai đoạn sau.
4. Nhập nguyên vẹn 64 dòng hồ sơ bàn giao (Phụ lục II) làm dữ liệu nguồn bất biến.
5. 1 màn hình cấu hình danh mục & vị trí, 1 màn hình xem hồ sơ nguồn.

## 2. Không làm trong giai đoạn này (Non-goals)

- **Không** tạo bản ghi tài sản/thiết bị vận hành thật (Lớp 3 theo §3 của yêu cầu gốc) — đó là việc của Giai đoạn 3. Giai đoạn này chỉ lưu dữ liệu nguồn (Lớp 1) và danh mục chuẩn hoá (khung của Lớp 2), chưa đối chiếu/gán từng dòng nguồn vào 1 tài sản cụ thể.
- **Không** xây bảng đơn vị tính (unit-of-measure) có quy đổi — `default_unit` của danh mục là text tự do; quy đổi thùng/hộp→chai/gói là việc của Giai đoạn 4 (kho) khi thực sự cần.
- **Không** đổi schema bảng `rooms` hiện có (không thêm cột "mã phòng" vào `rooms`) — mã phòng cho mục đích tài sản nằm ở `asset_locations.code`, một lớp bọc ngoài không đụng vào bảng gốc đang được nhiều luồng nghiệp vụ khác phụ thuộc (đặt phòng, Giờ Xanh, order ăn uống).
- **Không** xây form tạo mới "hồ sơ nguồn" (hợp đồng/phụ lục) trong Giai đoạn 2 — hiện chỉ có đúng 1 hồ sơ nguồn (Phụ lục II), nhập qua script 1 lần. API đọc (GET) vẫn mở sẵn cho giai đoạn sau, nhưng chưa cần UI tạo mới (YAGNI).
- Không xử lý lại số hợp đồng/ngày ký/số phụ lục còn thiếu trong văn bản gốc — giữ nguyên dạng text tự do, không validate.

## 3. Kiến trúc dữ liệu

### 3.1 `asset_categories` — danh mục 2 tầng

```sql
CREATE TABLE asset_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  management_type TEXT NOT NULL CHECK (management_type IN (
    'infrastructure',       -- Công trình & hạ tầng
    'individual_device',    -- Thiết bị riêng lẻ
    'device_set',           -- Bộ thiết bị
    'durable_goods',        -- Đồ dùng bền theo số lượng
    'linen',                -- Đồ vải luân chuyển
    'consumable',           -- Vật tư tiêu hao
    'spare_part',           -- Phụ tùng
    'food_beverage'         -- Thực phẩm, thức uống
  )),
  name TEXT NOT NULL,
  default_unit TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
```

`management_type` là **cố định** (8 giá trị, quyết định cơ chế theo dõi khác nhau ở các giai đoạn sau — VD "thiết bị riêng lẻ" có mã QR/lịch sử điều chuyển, "vật tư tiêu hao" có sổ nhập-xuất-tồn). Thêm 1 cách quản lý mới cần code mới, nên đây **không phải** danh mục admin tự thêm được — chỉ `name`/`default_unit`/`note`/`is_active` trong từng `management_type` mới mở cho admin.

### 3.2 `asset_locations` — vị trí hợp nhất

```sql
CREATE TABLE asset_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_type TEXT NOT NULL CHECK (location_type IN ('room', 'warehouse', 'common_area')),
  room_id INTEGER REFERENCES rooms(id),
  code TEXT,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  CHECK (
    (location_type = 'room' AND room_id IS NOT NULL) OR
    (location_type != 'room' AND room_id IS NULL)
  )
);
CREATE UNIQUE INDEX idx_asset_locations_room_id ON asset_locations(room_id) WHERE room_id IS NOT NULL;
```

- **`location_type='room'`**: 1 dòng cho mỗi `rooms.id` hiện có, tạo tự động khi chạy migration/script khởi tạo (xem §5) — **không sửa bảng `rooms`**, chỉ bọc thêm `code` (mã phòng tự sinh, VD `P01`..`P16` theo `display_order`/`id`) và cho phép đổi `name` hiển thị riêng cho mục đích tài sản mà không ảnh hưởng `rooms.name` (tên phòng dùng cho đặt phòng/Giờ Xanh vẫn là `rooms.name`, không đổi).
- **`location_type='warehouse'`**: seed sẵn 5 dòng gợi ý theo mã BP/TB/DK/TP/NB (Buồng phòng, Thiết bị & vật tư phụ, Đồ khô & thức uống, Thực phẩm tươi sống, Đồ dùng nhà bếp & phục vụ) — **chỉ là seed ban đầu**, sửa/thêm/ngừng dùng tự do, không khẳng định có đúng 5 kho vật lý.
- **`location_type='common_area'`**: seed từ Phụ lục I (Khu đốt lửa trại, Quán cà phê, Sân vườn ăn trái, Khu tiểu cảnh, Hạ tầng kỹ thuật).
- Đổi `name` không mất liên kết — các bảng tham chiếu sau này luôn dùng `asset_locations.id`, không dùng tên.

### 3.3 `asset_source_documents` — hồ sơ nguồn

```sql
CREATE TABLE asset_source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  contract_ref TEXT,
  document_date TEXT,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`contract_ref`/`document_date` là text tự do, cho phép để trống (văn bản gốc có số hợp đồng/ngày ký chưa điền đầy đủ) — không validate định dạng, không coi thiếu thông tin này là lỗi chặn.

### 3.4 `asset_source_rows` — Lớp 1, hồ sơ bàn giao gốc (bất biến)

```sql
CREATE TABLE asset_source_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_document_id INTEGER NOT NULL REFERENCES asset_source_documents(id),
  source_group_label TEXT NOT NULL,
  stt INTEGER NOT NULL,
  raw_name TEXT NOT NULL,
  raw_unit TEXT,
  raw_quantity TEXT,
  raw_condition TEXT,
  raw_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source_document_id, stt)
);
```

- `raw_quantity` lưu dạng **TEXT**, không phải số — văn bản gốc có dòng ghi "01" (số 0 ở đầu) và nhiều dòng để trống hoàn toàn; giữ nguyên chuỗi gốc thay vì ép kiểu để không đánh mất định dạng nguồn khi cần đối chiếu pháp lý sau này. Dòng trống → `NULL` (không phải `"0"` hay `"1"`).
- `source_group_label` giữ nguyên tiêu đề nhóm gốc trong bảng (VD `"A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG"`) — không tự ánh xạ sang `management_type` ở bước này (việc đó thuộc Giai đoạn 3 khi tạo tài sản thật từ từng dòng).
- Bảng này **không có cột `updated_at`/`updated_by`** — đây là dữ liệu bất biến theo đúng yêu cầu "không ghi đè hồ sơ bàn giao." Không có API `PATCH`/`DELETE` cho bảng này ở bất kỳ giai đoạn nào.

## 4. API contract

Tất cả endpoint dưới đây theo đúng pattern `requireAuth(request, env, roles)` đã dùng xuyên suốt dự án.

### Danh mục
- `GET /api/asset-categories` — roles `admin, manager, reception, observer` (không nhạy cảm như doanh thu, mở cho mọi role đọc). Query `?includeInactive=1` để thấy cả danh mục đã ngừng dùng (không cần giới hạn role — chỉ là hiển thị thêm, không phải dữ liệu nhạy cảm).
- `POST /api/asset-categories` — role `admin` only. Body `{managementType, name, defaultUnit, note}`.
- `PATCH /api/asset-categories/:id` — role `admin` only. Body có thể gồm `{name, defaultUnit, note, isActive}` — không cho đổi `managementType` sau khi tạo (đổi cách quản lý của 1 danh mục đã có dữ liệu là thay đổi cấu trúc, để tránh rủi ro cho Giai đoạn 3+, chặn ở đây bằng 400 nếu request có field này).

### Vị trí
- `GET /api/asset-locations` — roles `admin, manager, reception, observer`. Query `?type=room|warehouse|common_area`, `?includeInactive=1`.
- `POST /api/asset-locations` — role `admin` only. Body `{locationType, roomId (bắt buộc nếu locationType='room'), code, name, note}`. 400 nếu `roomId` đã có `asset_locations` khác tham chiếu (UNIQUE), hoặc nếu `locationType='room'` mà thiếu `roomId`, hoặc `locationType!='room'` mà có `roomId`.
- `PATCH /api/asset-locations/:id` — role `admin` only. Body `{code, name, note, isActive}` — không cho đổi `locationType`/`roomId` sau khi tạo (đổi 1 vị trí phòng thành kho là thay đổi cấu trúc; nếu quản lý gõ nhầm, xoá và tạo lại — dữ liệu vận hành thật chưa gắn vào bảng này ở Giai đoạn 2 nên không mất gì).

### Hồ sơ nguồn
- `GET /api/asset-source-documents` — roles `admin, manager, reception, observer`.
- `GET /api/asset-source-rows?documentId=X` — roles `admin, manager, reception, observer`. Trả nguyên toàn bộ dòng của 1 hồ sơ nguồn, sắp theo `stt`.

## 5. Khởi tạo dữ liệu (idempotent)

Script `v4/scripts/import-asset-source-data.js` (theo đúng pattern `scripts/seed-manager.js` đã có — in ra SQL để chạy qua `wrangler d1 execute`, không tự kết nối DB):

1. Tạo `asset_locations` cho mỗi phòng hiện có trong `rooms` (mỗi lần chạy: `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM asset_locations WHERE room_id = ?)` — không tạo trùng nếu chạy lại).
2. Seed 5 dòng `warehouse` (BP/TB/DK/TP/NB) và 5 dòng `common_area` (từ Phụ lục I) — cùng cơ chế `WHERE NOT EXISTS` theo `code`.
3. Seed 8 dòng `asset_categories` gốc tương ứng 8 `management_type` làm ví dụ khởi đầu (VD "Điều hoà" thuộc `individual_device`, "Ga giường" thuộc `linen`...) — admin có thể sửa/xoá/thêm ngay sau đó, đây chỉ là dữ liệu mẫu để màn hình không trống hoàn toàn.
4. Insert 1 dòng `asset_source_documents` (title "Phụ lục II — Danh mục tài sản hiện tại của Bên A", `contract_ref` "0107/HĐHTKD-HLG/2026") — kiểm tra tồn tại theo `title` trước khi insert.
5. Insert 64 dòng `asset_source_rows` (dữ liệu chính xác trích từ file Word, đã trích xuất đầy đủ trong quá trình viết spec này) — `INSERT OR IGNORE` dựa trên `UNIQUE(source_document_id, stt)`.

Chạy lại toàn bộ script nhiều lần không tạo trùng bất kỳ dòng nào ở cả 4 bảng — đáp ứng đúng yêu cầu "tác vụ nhập/khởi tạo chạy lại không được tạo trùng."

## 6. Client — 2 màn hình mới

Thêm nhóm nav mới **"Tài sản & Kho"** trong `admin/nav-drawer.js` (nhóm riêng, vì đây là khởi đầu 1 phân hệ lớn, không gộp vào nhóm "Vận hành" hiện có).

### 6.1 `admin/asset-config.html`/`.js` — "Danh mục & vị trí"
2 khối trên cùng 1 trang:
- **Danh mục tài sản**: liệt kê theo từng `management_type` (8 nhóm cố định, mỗi nhóm là 1 `<h2>`), mỗi dòng có tên/đơn vị/ghi chú/nút Sửa (admin) + toggle Ngừng dùng/Dùng lại (admin). Form thêm mới chọn `management_type` từ 8 giá trị cố định.
- **Vị trí**: 3 tab hoặc 3 khối (Phòng/Kho/Khu vực chung). Khối "Phòng" hiển thị readonly `rooms.name` cạnh `asset_locations.code`/`name` (2 tên tách biệt: tên phòng gốc dùng cho đặt phòng, tên hiển thị riêng cho tài sản — admin đổi cái sau, không đổi cái trước qua màn hình này). Khối Kho/Khu vực chung có form thêm/sửa/ngừng dùng đầy đủ.
- Role reception/manager/observer: xem được cả 2 khối, không thấy nút Sửa/Thêm/Ngừng dùng.

### 6.2 `admin/asset-source-data.html`/`.js` — "Hồ sơ nguồn" (chỉ xem)
Bảng hiển thị 64 dòng đã nhập, nhóm theo `source_group_label`, đủ 6 cột gốc (STT/Tên/ĐVT/Số lượng/Tình trạng/Ghi chú) — dòng trống số lượng hiện chữ **"Chưa xác định"** (không phải ô trắng, không phải "0"). Có dòng chú thích đầu trang: "Đây là hồ sơ gốc đã ký giữa hai bên, không thể chỉnh sửa tại đây — sẽ được dùng để tạo tài sản vận hành ở bước tiếp theo."

## 7. Audit log

4 action_type mới, đăng ký đúng 3 nơi bắt buộc:
- `asset_category_create`, `asset_category_update`
- `asset_location_create`, `asset_location_update`

`entity_type` tương ứng `'asset_category'` / `'asset_location'`. `entity_label` = tên danh mục/vị trí tại thời điểm ghi.

## 8. Testing

- Migration test: đúng schema, đúng CHECK constraint (`management_type`, `location_type`, ràng buộc `room_id`), `UNIQUE` trên `(source_document_id, stt)` và trên `room_id`.
- API test: role-gating cho từng endpoint (admin write, 4 role đọc), 400 khi vi phạm ràng buộc `location_type`/`roomId`, `includeInactive` hoạt động đúng, không cho đổi `managementType`/`locationType` qua PATCH.
- Script nhập dữ liệu: chạy 2 lần liên tiếp, xác nhận số dòng ở cả 4 bảng không đổi sau lần chạy thứ 2.
- E2e (repo ngoài): trang cấu hình hiển thị đúng theo role, thêm/sửa danh mục và vị trí qua UI, trang hồ sơ nguồn hiển thị đủ 64 dòng và đúng "Chưa xác định" cho dòng thiếu số lượng.

## 9. Bàn giao cho Giai đoạn 3

Giai đoạn 3 ("Nhập dữ liệu bàn giao, thiết bị riêng lẻ và kiểm kê từng phòng") sẽ đọc `asset_source_rows` + `asset_categories` + `asset_locations` để tạo bảng tài sản vận hành thật (Lớp 3) — chưa thiết kế ở đây, chỉ đảm bảo Giai đoạn 2 cung cấp đủ nền: danh mục có sẵn để gán, vị trí có sẵn để gán. "Chưa phân bổ vị trí" **không** cần 1 dòng đặc biệt trong `asset_locations` — Giai đoạn 3 tự quyết định biểu diễn (nhiều khả năng là cột vị trí ở bảng tài sản cho phép `NULL` = chưa phân bổ), không phải việc của Giai đoạn 2 tạo sẵn.
