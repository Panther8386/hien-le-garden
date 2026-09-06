# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from docx_builder import *

IMG = os.path.join("docs", "user-guides", "screenshots", "m5-observer")
OUT = os.path.join("docs", "user-guides", "5-Huong-dan-Observer.docx")

doc = new_manual(
    "HƯỚNG DẪN SỬ DỤNG HỆ THỐNG QUẢN TRỊ",
    "Dành cho tài khoản Observer (Quan sát)",
    5,
    "Vai trò: OBSERVER — Chỉ xem, không có quyền chỉnh sửa",
)

add_h1(doc, "1. Vai trò Observer là gì?")
add_p(doc, "Tài khoản Observer dành cho người cần theo dõi tình hình vận hành, tài chính và khách hàng của Hiền Lê Garden mà không trực tiếp thao tác nghiệp vụ hằng ngày — ví dụ: chủ đầu tư, cố vấn, hoặc người giám sát từ xa.")
add_note(doc, "Observer có thể XEM hầu hết dữ liệu trong hệ thống, nhưng KHÔNG THỂ thêm/sửa/xoá bất kỳ dữ liệu nào (không xác nhận đặt phòng, không thêm dịch vụ, không ghi giao dịch thu chi, không sửa bảng giá...). Mọi nút thao tác chỉnh sửa sẽ tự động ẩn hoặc bị hệ thống từ chối nếu cố thực hiện.")

add_h1(doc, "2. Đăng nhập hệ thống")
add_image(doc, os.path.join(IMG, "01-trang-dang-nhap.png"), "Trang đăng nhập hệ thống quản trị")
add_steps(doc, [
    ("Truy cập trang đăng nhập", "Mở địa chỉ /admin trên trình duyệt."),
    ("Nhập tài khoản", "Nhập tên đăng nhập và mật khẩu được cấp bởi quản trị viên."),
    ("Vào hệ thống", "Bấm Đăng nhập — hệ thống sẽ đưa anh/chị vào trang Tổng quan số liệu."),
])
add_note(doc, "Nếu quên mật khẩu, liên hệ quản trị viên (Admin) để được đặt lại — Observer không tự đặt lại được mật khẩu của chính mình qua trang này (chỉ đổi được khi đã biết mật khẩu cũ, xem mục 8).")

add_h1(doc, "3. Menu điều hướng")
add_image(doc, os.path.join(IMG, "02-nav-drawer.png"), "Menu điều hướng (bấm biểu tượng ☰ ở góc phải để mở)")
add_p(doc, "Với vai trò Observer, menu hiển thị các mục: Tổng quan số liệu, Sổ thu chi, Vận hành hôm nay, Danh sách khách hàng, Bảng giá dịch vụ, Chính sách hoàn cọc, và Đổi mật khẩu.")

doc.add_page_break()
add_h1(doc, "4. Tổng quan số liệu")
add_image(doc, os.path.join(IMG, "03-tong-quan-so-lieu.png"), "Trang Tổng quan số liệu")
add_p(doc, "Trang này cho biết bức tranh tổng thể về vận hành:")
add_bullets(doc, [
    "Số liệu Hôm nay: số khách đến, số khách đi, số phòng đang có khách.",
    "Số liệu theo tháng: chọn tháng bất kỳ để xem lại — có thể đổi qua ô chọn tháng.",
    "Phễu trạng thái booking: số lượng đặt phòng ở từng trạng thái (chờ xử lý, đã xác nhận, đang ở, đã trả phòng, đã huỷ).",
    "Nguồn đặt phòng: tỉ lệ khách đến từ website, điện thoại, Zalo hay khách vãng lai.",
])

add_h1(doc, "5. Sổ thu chi (chỉ xem)")
add_image(doc, os.path.join(IMG, "04-so-thu-chi-readonly.png"), "Trang Sổ thu chi — Observer chỉ xem, không có form thêm giao dịch")
add_p(doc, "Observer xem được toàn bộ số liệu tài chính:")
add_bullets(doc, [
    "Thẻ số liệu cân đối theo tháng (số dư đầu kỳ, tổng thu, tổng chi, lợi nhuận, số dư cuối kỳ).",
    "Biểu đồ thu chi theo ngày/tuần/tháng.",
    "Danh sách toàn bộ giao dịch, có thể lọc theo ngày, loại, danh mục, trạng thái, từ khoá.",
])
add_note(doc, "Nút \"+ Thêm giao dịch\" (mở popup thêm giao dịch) và ô sửa số dư đầu kỳ sẽ KHÔNG xuất hiện với tài khoản Observer — đây là thiết kế có chủ đích, không phải lỗi hiển thị.")

doc.add_page_break()
add_h1(doc, "6. Vận hành hôm nay (chỉ xem)")
add_image(doc, os.path.join(IMG, "05-van-hanh-hom-nay.png"), "Bảng vận hành hôm nay — Observer xem được toàn bộ danh sách nhưng không có nút thao tác")
add_p(doc, "Đây là trang tổng hợp toàn bộ hoạt động lễ tân trong ngày. Observer xem được đầy đủ:")
add_bullets(doc, [
    "Danh sách booking Chờ xử lý, Đã xác nhận, Đang ở.",
    "Khách đến hôm nay / Khách đi hôm nay.",
    "Chi tiết dịch vụ đã đăng ký cho từng booking (tên dịch vụ, số lượng, thành tiền, trạng thái thanh toán).",
    "Bảng trạng thái phòng theo ngày (phòng trống / đang có khách / cần dọn).",
    "Mục Nhắc việc hôm nay (nếu có việc cần lễ tân xử lý).",
])
add_note(doc, "Các nút \"Xác nhận\", \"Nhận phòng\", \"Trả phòng\", \"Thêm dịch vụ\", \"Huỷ\" — vốn dành cho lễ tân/quản lý thao tác — sẽ không xuất hiện trên giao diện của Observer.")

add_h1(doc, "7. Danh sách khách hàng")
add_image(doc, os.path.join(IMG, "06-danh-sach-khach-hang.png"), "Trang Danh sách khách hàng")
add_p(doc, "Xem lịch sử lưu trú, thông tin liên hệ và các nhãn phân loại (khách mới, khách thân thiết, VIP...) của từng khách hàng đã từng đặt phòng.")

add_h1(doc, "8. Bảng giá dịch vụ & Chính sách hoàn cọc (chỉ xem)")
add_image(doc, os.path.join(IMG, "07-bang-gia-dich-vu-readonly.png"), "Trang Bảng giá dịch vụ — chỉ xem")
add_image(doc, os.path.join(IMG, "08-chinh-sach-hoan-coc-readonly.png"), "Trang Chính sách hoàn cọc — chỉ xem")
add_p(doc, "Observer xem được toàn bộ bảng giá phòng/dịch vụ hiện hành và chính sách hoàn cọc đang áp dụng, nhưng không có nút Sửa/Xoá — các nút này chỉ hiển thị cho Quản trị viên (Admin).")

doc.add_page_break()
add_h1(doc, "9. Đổi mật khẩu")
add_image(doc, os.path.join(IMG, "09-doi-mat-khau.png"), "Trang Đổi mật khẩu")
add_steps(doc, [
    ("Mở trang Đổi mật khẩu", "Chọn mục \"Đổi mật khẩu\" ở cuối menu điều hướng."),
    ("Nhập mật khẩu hiện tại", "Bắt buộc để xác thực chính chủ tài khoản."),
    ("Nhập mật khẩu mới", "Nhập 2 lần để xác nhận không gõ nhầm."),
    ("Lưu thay đổi", "Bấm nút lưu — lần đăng nhập kế tiếp sẽ dùng mật khẩu mới."),
])

add_h1(doc, "10. Tóm tắt quyền hạn")
add_table_simple(doc, ["Trang / Chức năng", "Observer"], [
    ("Tổng quan số liệu", "✅ Xem"),
    ("Sổ thu chi", "✅ Xem — ❌ Không thêm/sửa/xoá"),
    ("Vận hành hôm nay", "✅ Xem — ❌ Không thao tác booking/dịch vụ"),
    ("Danh sách khách hàng", "✅ Xem"),
    ("Bảng giá dịch vụ", "✅ Xem — ❌ Không sửa"),
    ("Chính sách hoàn cọc", "✅ Xem — ❌ Không sửa"),
    ("Nhật ký thao tác", "❌ Không truy cập"),
    ("Quản lý tài khoản người dùng", "❌ Không truy cập"),
    ("Đổi mật khẩu (của chính mình)", "✅ Có"),
])

save(doc, OUT)
