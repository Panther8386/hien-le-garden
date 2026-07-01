# Hiền Lê Garden — Landing Page Design Spec
**Date:** 2026-07-01  
**Status:** Approved  
**Output path:** `/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/`

---

## Overview

A premium dark-theme landing page for **Hiền Lê Garden Farmstay**, styled like a $10,000 agency build. Single HTML file with embedded CSS and vanilla JS. No framework dependency — deploys immediately by opening in browser or uploading to any host.

---

## Brand

| Token | Value |
|---|---|
| Name | Hiền Lê Garden |
| Tagline (VI) | Bình Yên Giữa Lòng Thành Phố |
| Tagline (EN) | Serenity at the Heart of the City |
| Sub-tagline | Check-in thiên nhiên — View hồ cực chill |
| Hotline | **0968 987 311** |
| Language | Bilingual — Vietnamese primary, English secondary |
| Facebook | https://www.facebook.com/p/Hiền-Lê-Garden-61556329706262/ |

---

## Design System

### Colors
```
--bg-primary:    #0D1F13   /* deep forest dark */
--bg-secondary:  #111D15   /* card / section alternates */
--bg-surface:    #172A1C   /* elevated cards */
--accent-gold:   #C9A84C   /* primary accent — headings, borders */
--accent-gold-lt:#E8C96A   /* hover states */
--accent-emerald:#10B981   /* CTA buttons, icons */
--text-primary:  #F5F5EF   /* body text */
--text-muted:    #9CA3AF   /* captions, labels */
--overlay:       rgba(0,0,0,0.45) /* hero image overlay */
```

### Typography
- **Headings:** Cormorant Garamond (Google Fonts) — italic, high contrast
- **Body / UI:** Inter (Google Fonts) — clean, readable
- **Scale:** 12 / 14 / 16 / 20 / 28 / 40 / 56 / 72px

### Animations
- Hero text: stagger fade-in-up per line (0.2s delay each)
- Feature cards: fade-in on scroll (IntersectionObserver)
- Nav: blur backdrop activates after 80px scroll
- Room cards: translateY(-8px) on hover with box-shadow
- Pricing tabs: smooth opacity/height transition
- Stats counter: count-up animation on scroll into view

---

## Page Sections

### 1. Sticky Navigation
- **Left:** Logo `HIỀN LÊ GARDEN` — Cormorant Garamond italic, gold `#C9A84C`
- **Center:** Links — Tổng Quan · Phòng · Trải Nghiệm · Bảng Giá · Liên Hệ
- **Right:** CTA `ĐẶT PHÒNG NGAY` — emerald border, fills on hover
- **Scroll behaviour:** `backdrop-filter: blur(12px)` + semi-transparent bg after 80px
- **Mobile:** Hamburger → full-screen overlay menu

### 2. Hero Section (100vh)
- **Background:** Aerial/drone photo with hồ panorama — dark overlay
- **Animation sequence:**
  1. Fade-in: `FARMSTAY · BUÔN MA THUỘT` (small caps, letter-spacing 6px)
  2. Stagger: `BÌNH YÊN` / `GIỮA LÒNG` / `THÀNH PHỐ` — large display type
  3. Fade-in: sub-tagline italic
  4. Fade-in: 2 CTA buttons
- **Scroll cue:** animated chevron at bottom
- **Parallax:** subtle background-attachment fixed on desktop

### 3. Stats Bar
Full-width dark stripe `#111D15` with gold top/bottom border lines.

| Stat | Label (VI) | Label (EN) |
|---|---|---|
| 5+ | Kiểu Phòng Độc Đáo | Unique Room Styles |
| 10ha | Khuôn Viên Tự Nhiên | Natural Grounds |
| 20–100 | Khách Sự Kiện | Event Capacity |
| 2km | Từ Trung Tâm TP | From City Center |

Counter animates up when scrolled into view.

### 4. Feature Grid (3×3)
Dark cards with SVG icon + title + 1-line description. Cards fade-in staggered.

| Icon | Title (VI) | Title (EN) |
|---|---|---|
| 🏔️ | View Hồ Panorama | Lake Panorama View |
| 🏠 | Triangle House Độc Đáo | Iconic Triangle Cabins |
| ⭕ | Circle House Nghệ Thuật | Artistic Circle Houses |
| 🌸 | Vườn Hoa Cỏ May | Wildflower Garden |
| 🔥 | Campfire & Glamping | Campfire & Glamping |
| ☕ | Cà Phê Giữa Vườn | Garden Café |
| 👥 | Team Building | Team Building Events |
| 📸 | Check-in Sống Ảo | Photo & Check-in Spots |
| 🌱 | Nông Nghiệm Trải Nghiệm | Farm Experience |

### 5. Room Showcase
Horizontal scroll on mobile, 3-column grid on desktop. Each card:
- Full-bleed room photo (real images embedded as base64 or linked)
- Room name badge (top-left)
- Price badge (bottom-right, gold)
- Capacity icon + number
- Brief description
- "Xem Thêm" hover reveal

| Room | Price | Capacity | Note |
|---|---|---|---|
| Triangle House | 300,000 đ/đêm | 2–3 người | View vườn, giường đôi |
| Circle House (Superior) | 600,000 đ/đêm | 2–4 người | View hồ, tiện nghi cao cấp |
| E Đê Cozy House (Deluxe) | 700,000 đ/đêm | 2–4 người | Bao gồm bữa sáng |
| VIP House (Premium) | 900,000 đ/đêm | 3–5 người | Sân hiên riêng, view đẹp nhất |
| Bungalow Gia Đình | 1,200,000 đ/đêm | 4–6 người | Full amenities |
| Phòng Tập Thể | 150,000 đ/người | 10–20 người | Giường tầng |

### 6. Pricing Table
3 tabs — smooth transition between tabs.

**Tab 1: Lưu Trú (Overnight)**
- Per-night table (6 room types above)
- Hourly sub-section: Giờ đầu 120k · Combo 2h 200k · Giờ thêm 50k/h

**Tab 2: F&B & Hoạt Động**
| Service | Price |
|---|---|
| Cà phê & nước uống | 30,000–80,000 đ |
| Ăn uống theo yêu cầu | 120,000–300,000 đ/người |
| Campfire | 500,000–1,000,000 đ/nhóm |
| Hái trái cây | 50,000–100,000 đ/người |
| Chụp ảnh / Check-in | 200,000–500,000 đ/buổi |
| Cắm trại qua đêm | 200,000–400,000 đ/đêm |
| Nông nghiệp trải nghiệm | 100,000–200,000 đ/người |
| Khu vui chơi trẻ em | Miễn phí |

**Tab 3: Sự Kiện & Team Building**
- 3,000,000–10,000,000 đ/sự kiện
- 20–100 người
- Ghi chú: cần đặt trước, tùy chỉnh theo yêu cầu

Below all tabs: hotline CTA block — `Hotline: 0968 987 311`

### 7. Gallery Masonry
- CSS masonry 3-column layout (desktop) / 2-col (tablet) / 1-col (mobile)
- 8–10 photos: aerial, flower fields, Triangle Houses, interior luxury rooms, entrance gate
- Hover: image scale 1.05 + dark overlay + "Xem Ảnh" label
- Lightbox on click (vanilla JS)

### 8. Final CTA Section
- Background: dark + subtle cosmos flower image at low opacity
- Large heading: `Bắt đầu hành trình của bạn`
- Sub: `Begin Your Journey`
- 2 buttons: `ĐẶT PHÒNG NGAY` (gold filled) · `📞 0968 987 311` (outline)

### 9. Footer
- Logo + tagline
- 3 columns: Liên hệ | Dịch vụ | Kết nối
- Hotline: 0968 987 311
- Facebook link
- Copyright © 2026 Hiền Lê Garden

---

## Image Strategy
All real photos provided by client (Facebook album). Images will be referenced via CSS `background-image` URLs using the photo data provided. Key hero image: aerial drone view showing hồ panorama. Room photos mapped to each card by room type.

---

## Technical Spec
- **Output:** Single `index.html` file with all CSS/JS inline
- **No build step** — opens directly in browser
- **Fonts:** Google Fonts CDN (Cormorant Garamond + Inter)
- **Icons:** Inline SVG or emoji fallback
- **Responsive:** Mobile-first, breakpoints at 768px and 1280px
- **Performance:** Images lazy-loaded, CSS animations GPU-accelerated (transform/opacity only)
- **No external JS libraries** — vanilla JS for all interactions

---

## Hotline
All instances of hotline throughout the page: **0968 987 311** (single number, no alternatives)
