# V3 Restructure — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Restructure `v3/index.html` (and add one new page) so the site matches this target architecture:

```
Trang chủ
├── Hero của Version 3
├── Form gọn của Version 2
├── About Us của Version 2
├── Card phòng của Version 2
├── Timeline trải nghiệm
├── Gallery + video thật
├── Review có nguồn thật
├── 3 card cẩm nang
├── FAQ
├── Bản đồ
└── CTA cuối trang

Trang bảng giá
└── Nội dung chi tiết của Version 1

Trang cẩm nang
├── 10 điểm check-in Gia Nghĩa
├── Ăn gì ở Gia Nghĩa
└── Mùa đẹp nhất Tây Nguyên

Trang sự kiện
└── Chỉ tạo khi có lịch và dữ liệu thật
```

Scope is **v3 only**. v1 and v2 are untouched (they remain independent GitHub repos: `hien-le-garden-v2`, `hien-le-garden-v3`).

## Current-state facts (verified before writing this spec)

- v2 and v3's `#about` sections are byte-identical.
- v2 and v3's `#rooms` sections are structurally identical; only 3 small copy diffs exist (room-desc wording, one EN name, one meta tag).
- v3's `#booking` section additionally carries a fake "check availability" simulation (`availCheckBtn` → `checkAvailability()` → random fake `#availStatus` message with an artificial 900ms delay) that v2 does not have. v2's inline booking button calls `handleBooking()` (builds a message, opens the Facebook page) — no modal, no fake availability check. This is the "form gọn" to restore.
- Both v2 and v3 separately also have a booking **modal** (`#bmOverlay` / `bm-submit` → `submitBooking()`) opened from the navbar's "Đặt phòng" button — this modal already matches between v2 and v3 and is unaffected by the "form gọn" swap (its button label was already updated to "Gửi Yêu Cầu Kiểm Tra Phòng →" in a prior change).
- v3's `#reviews` section has real platform badges and real outbound links (Facebook page, Google Maps place), but the names/quotes/star-ratings/dates attached to each card are invented placeholder text, not real customer reviews.
- v1's `#pricing` section (lines ~1636–1852) is a 3-tab pricing table (Lưu Trú / F&B & Hoạt Động / Sự Kiện & Team Building) with already-corrected prices (matches recent v1 pricing fix commits). This content doesn't exist in v2/v3 today.
- v3's cẩm nang subpages already match the requested 3 topics exactly: `cam-nang/10-diem-check-in` (10 điểm check-in), `cam-nang/am-thuc-gia-nghia` (ăn gì), `cam-nang/du-lich-gia-nghia` (title/H1 = "Mùa Đẹp Nhất Để Đến Tây Nguyên"). The homepage's `#blog` section already renders exactly 3 cards linking to these.
- v3's `#events` section renders from a hardcoded `EVENTS` JS array (recurring weekend BBQ, farm day, coffee workshop, seasonal Dã Quỳ tour) with computed-but-fake "next date" logic — not a real calendar.
- v3's `#ota` section is already present but hidden via `style="display:none"`.
- Cẩm nang subpages use a lightweight, self-contained page pattern: a simple `sub-nav` (logo + "← Trang chủ" back link), breadcrumb, own `<style>` block (matching V3 fonts/colors), and a footer with contact info — distinct from the homepage's full mega-navbar.
- Existing docs (`2026-07-01-*.md`) describe only the original pre-v1/v2/v3 single-page build; they say nothing about the v1/v2/v3 split or multi-page routing, so this spec establishes that precedent fresh.

## Decisions (confirmed with user)

1. **Reviews**: keep the existing 3-card grid layout/platform badges, but remove invented names/quotes/star-ratings/dates. Replace each card's body with an honest short line inviting the visitor to view real reviews on that platform, keeping the existing real outbound link per card (Facebook / Google Maps / Zalo). The bottom CTA row (already real links) is untouched.
2. **Events**: not real data yet → hide the section on the homepage the same way `#ota` is hidden (`style="display:none"`), keep the code in the file for future use. No `/su-kien/` page is created now.
3. **Cẩm nang**: no new hub/index page. Homepage's existing 3 cards continue to link directly to the 3 existing subpages.
4. **Trang bảng giá**: new page at `v3/bang-gia/index.html`, built with the same lightweight sub-nav/breadcrumb/footer pattern as the cẩm nang subpages (not the full mega-navbar), containing v1's pricing tab content (markup + tab-switching JS + table styles) ported as-is (prices already correct in v1). The homepage's main navbar (desktop `.nav-links` + mobile `.nav-mobile-overlay`) gets a new "Bảng Giá" entry linking to `bang-gia/`.
5. **Amenities section** (`#amenities`, the Tiện Ích cards e.g. "Vườn Hoa Cỏ May"): removed entirely from the homepage — covered already by the cẩm nang cards. Remove its nav link ("Tiện Ích") from both desktop and mobile nav too.
6. **Direct-booking-offer banner**: kept, unchanged, in its current position (right after the booking form).
7. **Rooms section copy**: sync v3's 3 minor copy diffs to match v2 exactly, so "card phòng của Version 2" is a literal match, not just structurally similar.

## Target homepage (`v3/index.html`) section order

1. Hero (unchanged)
2. Booking — replaced with V2's compact version (remove `availCheckBtn`, `checkAvailability()`, `#availStatus`; restore `handleBooking()` flow)
3. Direct-booking-offer banner (unchanged)
4. About (unchanged)
5. Rooms (copy synced to V2)
6. ~~Amenities~~ (removed)
7. Timeline (unchanged)
8. Gallery + drone-video (unchanged)
9. Reviews (copy redesigned per Decision 1)
10. ~~Events~~ (hidden via `display:none`, code retained)
11. OTA (unchanged, already hidden)
12. Blog / 3 cẩm nang cards (unchanged)
13. FAQ (unchanged)
14. Map (unchanged)
15. Closing CTA (unchanged)

Navbar (desktop + mobile): remove "Tiện Ích" link, add "Bảng Giá" link → `bang-gia/`.

## New page: `v3/bang-gia/index.html`

- Structure: `<head>` with same Google Fonts + a self-contained `<style>` block reusing V3's CSS custom properties (colors/fonts) plus v1's `.pricing-*` CSS classes (tabs, panels, table, divider) adapted to those variables.
- Header: `sub-nav` (logo linking to `../`, "← Trang chủ" back link) + breadcrumb (`Trang chủ / Bảng giá`), matching the cẩm nang subpage pattern.
- Body: v1's 3-tab pricing content verbatim (Lưu Trú / F&B & Hoạt Động / Sự Kiện & Team Building) with its tab-switching JS.
- Footer: same contact-info footer pattern as cẩm nang subpages (address, phone, back-to-home link).

## Out of scope

- No changes to v1 or v2.
- No `/su-kien/` (events) page.
- No cẩm nang hub/index page.
- No real review content is fabricated — only real, verifiable links are added.

## Self-review notes

- No placeholders/TBDs remain; all 7 decisions are concrete and actionable.
- Section-order table and "Decisions" list are consistent with each other (amenities removal and events hiding appear in both).
- Scope is bounded to a single implementation plan (one page restructure + one new page) — no further decomposition needed.
