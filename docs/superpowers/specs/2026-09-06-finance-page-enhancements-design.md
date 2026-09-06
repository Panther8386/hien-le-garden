# Nâng cấp trang Sổ thu chi (finance.html)

**Status:** Đang chờ user duyệt spec.

## 1. Goal

Bổ sung 6 nâng cấp cho trang `admin/finance.html`, gom vào 1 spec vì tất cả cùng chạm `GET /api/finance/transactions` và `admin/finance.js`:

1. Ẩn/hiện giao dịch khỏi lịch sử (admin-only), lặp lại pattern đã dùng cho Giờ Xanh/Order ăn uống/Đặt phòng.
2. Ô "Tổng doanh thu" theo bộ lọc đang áp dụng (danh mục + khoảng thời gian).
3. 2 biểu đồ tròn: Thu theo danh mục, Chi theo danh mục.
4. Phân trang danh sách giao dịch, cho chọn số mục/trang.
5. Gộp gọn nút Sửa/Huỷ thành icon.
6. Gộp "Thêm giao dịch" + "Sửa giao dịch" vào chung 1 popup; "Huỷ" luôn có xác nhận.

## 2. Non-goals

- Không đổi cấu trúc `GET /api/finance/summary` (Cân đối theo tháng) — đây là view độc lập, không liên quan tới bộ lọc Giao dịch.
- Không cho ẩn giao dịch còn hiệu lực (draft/đã xác nhận/đã thanh toán, `voided_at IS NULL`) — chỉ giao dịch **đã huỷ** mới ẩn được (xem §4).
- Không đổi hành vi `GET /api/finance/categories`, `/api/finance/opening-balance`, `/api/finance/receipts-usage`.
- Không xây dựng lại toàn bộ UI trang — chỉ các phần nêu ở §1.

## 3. Kiến trúc tổng quan

`GET /api/finance/transactions` đổi từ trả về mảng thuần sang 1 object bao gồm: danh sách đã phân trang (đầy đủ field, cho bảng/card), cùng với tổng/tổng-theo-danh-mục/dữ-liệu-vẽ-biểu-đồ-theo-thời-gian tính trên **toàn bộ tập đã lọc** (không bị cắt bởi phân trang) — vì "Tổng doanh thu", 2 biểu đồ tròn, và biểu đồ theo thời gian đã có sẵn đều cần nhìn thấy toàn bộ kết quả lọc, không chỉ 1 trang. Đây là thay đổi phá vỡ tương thích response cũ — an toàn vì `admin/finance.js` là nơi duy nhất gọi endpoint này (xác nhận bằng cách grep toàn repo).

## 4. Data model — Ẩn khỏi lịch sử

`migrations/0026_finance_hide_from_history.sql`:
```sql
ALTER TABLE finance_transactions ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
```

**Điều kiện được ẩn:** `voided_at IS NOT NULL` (đã huỷ). Khác với Giờ Xanh/Order ăn uống/Đặt phòng (ẩn được khi ở trạng thái *kết thúc*), ở đây "draft/đã xác nhận/đã thanh toán" đều là số liệu tài chính thật đang có hiệu lực — không cho ẩn dù đang lọc/tìm kiếm. Chỉ giao dịch đã huỷ (thường do nhập nhầm/dữ liệu test — đúng tình huống ban đầu sinh ra tính năng này) mới ẩn được. Cố ẩn 1 giao dịch chưa huỷ → `400`.

## 5. API contract

### `GET /api/finance/transactions` (đổi shape response)

Query params hiện có giữ nguyên (`from`, `to`, `type`, `category`, `status`, `q`), thêm:
- `page` (mặc định 1), `pageSize` (mặc định 25; chỉ nhận 10/25/50/100, giá trị khác → `400`).
- `includeHidden=1`: bỏ điều kiện `is_hidden = 0` — **chỉ áp dụng khi `auth.role === 'admin'`**, vai trò khác gửi thì bị bỏ qua lặng lẽ (đúng pattern đã dùng ở plan trước).

Response `200`:
```json
{
  "transactions": [ /* đã phân trang, đầy đủ field như hiện tại + isHidden */ ],
  "total": 137,
  "page": 1,
  "pageSize": 25,
  "sumIncome": 45000000,
  "sumExpense": 12000000,
  "categoryTotals": { "ban_hang": { "income": 30000000, "expense": 0 }, "vat_tu": { "income": 0, "expense": 8000000 }, "...": "..." },
  "chartRows": [ { "transactionDate": "2026-08-10", "type": "income", "amount": 2000000 }, "..." ]
}
```
- `total`/`sumIncome`/`sumExpense`/`categoryTotals`/`chartRows` tính trên **toàn bộ tập đã lọc** (cùng WHERE clause với `transactions`, không có LIMIT/OFFSET) — `transactions` là 1 trang cắt theo `page`/`pageSize`.
- `chartRows` chỉ giữ 5 field (`transactionDate`, `type`, `amount`, `status`, `voidedAt`) — không kèm note/người tạo/chứng từ... Dùng để vẽ lại đúng biểu đồ theo thời gian hiện có, client tự bucket theo ngày/tuần/tháng như code cũ; những 2 field bổ sung (`status`, `voidedAt`) là cần thiết vì biểu đồ thời gian hiện hữu dùng chúng để lọc: chỉ ghi nhận giao dịch có `status IN ('confirmed','paid') AND voided_at IS NULL` (replicate logic server-side), tách khỏi `transactions` để không nhân đôi payload.
- Toàn bộ 5 field tổng hợp đều tôn trọng bộ lọc `is_hidden` giống `transactions` (ẩn thì không tính vào tổng, trừ khi admin bật `includeHidden=1`).

### `PATCH /api/finance/transactions/:id/hide` (mới)

Admin-only. Body `{ hidden: true | false }` (bắt buộc boolean). 404 nếu không tìm thấy. 400 nếu `voided_at IS NULL`. Thành công: `UPDATE finance_transactions SET is_hidden = ?`, ghi `audit_log` tái dùng `record_hide` (đã đăng ký sẵn, không đăng ký lại) với `entity_type = 'finance_transaction'`, `entity_label` dùng đúng hàm `summarize(row, categoryMeta)` đã có (khớp quy ước `void.js` dùng), trả `200 { ok: true }`.

## 6. Client (`admin/finance.html`/`.js`)

### 6.1 Popup gộp Thêm + Sửa giao dịch
Xoá khối `#addTransactionSection` cố định ở đầu trang, thay bằng 1 nút nhỏ **"+ Thêm giao dịch"** (chỉ hiện với manager/admin, giữ nguyên logic hiện có). Bấm nút này hoặc nút "Sửa" trên 1 dòng đều mở cùng 1 popup (`.confirm-overlay`/`.confirm-box`, đúng pattern `#confirmOverlay` đã dùng trong `reception.html`), chứa nguyên `#financeForm` hiện có (không đổi field/logic submit) — chỉ khác nơi hiển thị. Popup có nút đóng (X hoặc "Huỷ", tái dùng `#financeCancelEditBtn` đổi label ngữ cảnh phù hợp). `openEditTransaction(t)` giờ vừa populate form vừa mở popup; nút "+ Thêm giao dịch" gọi `resetFinanceForm()` rồi mở popup ở chế độ tạo mới.

### 6.2 Gộp gọn nút Sửa/Huỷ
Thay 2 nút chữ bằng 2 icon nhỏ trong cột Actions: `✏️` (title="Sửa") và `🗑` (title="Huỷ") — theo đúng ngôn ngữ icon đã dùng trong app (🖨, 📎, 🧹). Admin thấy thêm icon Ẩn/Hiện (`🙈`/`👁️`, title tương ứng) trên các dòng đã huỷ.

### 6.3 Xác nhận khi Huỷ
Bấm `🗑` mở 1 confirm-popup (dùng lại `.confirm-overlay`/`.confirm-box`) hỏi "Xác nhận huỷ giao dịch [tóm tắt]?" với 2 nút Huỷ giao dịch/Đóng — chỉ khi bấm "Huỷ giao dịch" mới gọi `voidTransaction(id)` thật.

### 6.4 Checkbox "Hiển thị các log đã ẩn" + icon Ẩn/Hiện
Đặt cạnh bộ lọc `#financeFilters`, admin-only, tick thì `loadTransactions()` gửi kèm `includeHidden=1`. Icon Ẩn/Hiện (§6.2) gọi `PATCH /api/finance/transactions/:id/hide`.

### 6.5 "Tổng doanh thu (theo bộ lọc)" + phân trang
1 `.stat-card` mới ngay trên bảng Giao dịch, giá trị = `response.sumIncome` (định dạng `formatVnd`), nhãn rõ ràng để phân biệt với "Tổng thu" ở khối Cân đối theo tháng phía trên (khác nguồn: 1 cái theo bộ lọc Giao dịch, 1 cái theo tháng chọn ở Cân đối). Dưới bảng: control phân trang (chọn `pageSize` 10/25/50/100 qua `<select>`, nút Trước/Sau + số trang tính từ `total`/`pageSize`) — dùng chung cho cả bảng (`#financeTable`) lẫn danh sách dạng thẻ mobile (`#financeCardList`), vì cả 2 đều render từ cùng mảng `transactions` đã phân trang như code hiện tại.

### 6.6 2 biểu đồ tròn theo danh mục
Thêm 1 nút gạt trong khu vực "Biểu đồ" hiện có (cạnh nút Ngày/Tuần/Tháng): **"Theo thời gian"** (biểu đồ cột hiện tại, không đổi) / **"Theo danh mục"** (2 SVG pie chart mới, tự vẽ tay giống phong cách biểu đồ cột hiện có — không thêm thư viện ngoài, đúng quy ước dự án không build step). Dữ liệu lấy từ `response.categoryTotals`, 1 pie cho Thu (lọc `income > 0`), 1 pie cho Chi (lọc `expense > 0`), mỗi lát cắt là 1 danh mục, màu theo `categoryMeta`, chú thích danh mục + % bên cạnh mỗi pie.

## 7. Testing

- `test/migrations.test.js` — cột `is_hidden` mặc định 0, nhận giá trị 1, đúng bảng `finance_transactions`.
- `test/financeTransactions.test.js` — mở rộng: response shape mới (`transactions`/`total`/`page`/`pageSize`/`sumIncome`/`sumExpense`/`categoryTotals`/`chartRows`), phân trang đúng (page 2 trả đúng offset, `pageSize` không hợp lệ → 400), `is_hidden` mặc định lọc, `includeHidden=1` chỉ admin dùng được, endpoint `.../hide` — 401/403 đúng vai trò, 404 sai id, 400 khi chưa huỷ, thành công ghi đúng `is_hidden` + `audit_log` dùng `summarize()`.
- `tests/e2e/finance-dashboard.spec.js` (repo ngoài) — popup gộp Thêm/Sửa mở đúng ngữ cảnh, xác nhận Huỷ chặn được thao tác nếu bấm Đóng, phân trang đổi `pageSize` gọi lại API đúng tham số, checkbox admin-only, 2 pie chart render đúng khi gạt sang "Theo danh mục".

## 8. Ghi chú triển khai

Việc đổi response shape của `GET /api/finance/transactions` là thay đổi lớn nhất về rủi ro hồi quy — cần rà kỹ mọi nơi gọi endpoint này (đã xác nhận qua grep: chỉ `admin/finance.js` và các file test liên quan, không có consumer nào khác trong 2 repo).

**Giới hạn về quy mô (không chặn, ghi nhận để biết trước):** `total`/`sumIncome`/`sumExpense`/`categoryTotals`/`chartRows` tính trên toàn bộ tập đã lọc mỗi lần gọi — ở quy mô hiện tại của Hiền Lê Garden (vài chục đến vài trăm giao dịch/tháng) là rẻ; nếu về sau khối lượng giao dịch tăng rất lớn (nhiều năm tích luỹ, hàng chục nghìn dòng) thì truy vấn tổng hợp này sẽ cần đánh index/tối ưu riêng — không phải vấn đề ở quy mô hiện tại nên không xử lý trong plan này.
