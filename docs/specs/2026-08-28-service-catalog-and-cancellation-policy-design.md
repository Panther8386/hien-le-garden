# Service Catalog & Cancellation Policy — Design

**Date:** 2026-08-28
**Repo:** `hien-le-garden-v4` (`v4/` in this monorepo checkout)
**Status:** Approved by user, ready for implementation planning

## Problem

Prices for Hiền Lê Garden's three business lines — Lưu Trú (accommodation),
F&B & Hoạt Động (F&B and activities), and Sự Kiện & Team Building (events)
— currently live as hardcoded text duplicated across `bang-gia/index.html`,
`index.html` (room cards, booking select, FAQ chatbot answer), and
`v4/lib/roomTypes.js`. This is exactly the bug class fixed earlier the same
day for the Ê Đê Cozy room (price updated in one place, stale everywhere
else, plus a stray `.jpg` deletion caught only by the e2e link-check test).
The user wants:

1. A single admin-managed catalog covering all three business lines, with
   real data seeded from what's already published on `/bang-gia` — not
   invented numbers.
2. Price shown as a two-column range ("Giá A" to "Giá B"), since most rows
   already are ranges (e.g. `30.000–80.000 đ`) — plus a way to represent
   fixed single prices and non-numeric labels (`Miễn phí`,
   `Theo giá thị trường`) without forcing them into fake numbers.
3. Write access (add/edit/delete) restricted to the `admin` role only —
   narrower than the `manager`+`admin` convention used elsewhere in this
   app, a deliberate exception confirmed by the user.
4. Editing this catalog to propagate everywhere the price is shown on the
   public site, not just `/bang-gia`.
5. (Added mid-brainstorm) An admin UI to configure a deposit-refund policy
   tiered by days-before-check-in, wired into the existing cancel-booking
   flow.

## Part A — Service Catalog

### Data model

New table `service_catalog`:

```sql
CREATE TABLE service_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN ('luu_tru', 'fnb_hoat_dong', 'su_kien_team_building')),
  subgroup TEXT,
  name TEXT NOT NULL,
  price_type TEXT NOT NULL CHECK (price_type IN ('range', 'fixed', 'label')),
  price_min INTEGER,
  price_max INTEGER,
  price_label TEXT,
  unit_capacity TEXT,
  note TEXT,
  room_type_key TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_service_catalog_category ON service_catalog(category, is_active, display_order);
```

`price_type` determines which price fields are populated and how the row
renders:

| `price_type` | Required fields | Rendered as |
|---|---|---|
| `range` | `price_min`, `price_max` (both non-negative integers, `price_max >= price_min`) | `30.000–80.000 đ` |
| `fixed` | `price_min` only | `300.000 đ` |
| `label` | `price_label` (non-empty string) | the label text verbatim, e.g. `Miễn phí` |

`subgroup` is a free-text sub-heading used only within `luu_tru` today
(`Lưu Trú Theo Đêm` vs `Thuê Theo Giờ`), mirroring `/bang-gia`'s existing
`.pricing-divider` sections. Null for the other two categories.

`room_type_key` is an **optional** link from a `luu_tru` row to one of the
six keys in `v4/lib/roomTypes.js`'s `ROOM_TYPES` (`triangle`, `circle`,
`ede_cozy`, `vip`, `bungalow`, `dormitory`) — this is how public-site
surfaces that need to show a price next to a *specific bookable room type*
(the booking select, the room cards) find the right catalog row, without
creating a hard foreign-key dependency on the booking engine. The catalog
stays fully independent of the booking system per the user's choice: an
admin can freely add, edit, or delete any `service_catalog` row, including
ones with a `room_type_key` set, without touching `rooms`, `bookings`, or
`lib/roomTypes.js` in any way. If a linked row is deleted or its link
cleared, the affected public-site element just stops showing a price
hint next to that room type — it does not break booking.

Validation (enforced in the API, not the DB): a `room_type_key`, when
provided, must be one of the six valid keys, and at most one **active**
row may claim a given key at a time (reject the write with 400 otherwise)
— this keeps the public-site lookup deterministic.

### Seed data (migration)

The migration inserts exactly the 20 rows already published on
`/bang-gia`, unchanged in wording and amounts:

**`luu_tru` / `Lưu Trú Theo Đêm`** (order 1–6, `room_type_key` set):
1. Triangle House (Tiêu Chuẩn) — fixed 300.000 — `2–3 người` — View vườn, giường đôi — `triangle`
2. Circle House — Superior — fixed 600.000 — `2–4 người` — View hồ, tiện nghi cao cấp hơn — `circle`
3. E Đê Cozy — Deluxe — fixed 600.000 — `2–4 người` — Bao gồm bữa sáng — `ede_cozy`
4. VIP House — Premium Garden View — fixed 900.000 — `3–5 người` — Sân hiên riêng, view tốt nhất — `vip`
5. Bungalow Gia Đình — fixed 700.000 — `4–6 người` — Phòng rộng, full amenities — `bungalow`
6. Phòng Tập Thể — fixed 1.200.000 — `4–8 người` — Giá trọn phòng theo đêm, giường tầng — `dormitory`

**`luu_tru` / `Thuê Theo Giờ`** (order 7–9, no `room_type_key`):
7. Giờ Đầu Tiên — fixed 130.000 — `1 giờ` — Áp dụng toàn bộ loại phòng
8. Combo 2 Giờ — fixed 200.000 — `2 giờ` — Tiết kiệm hơn giờ lẻ
9. Giờ Phát Sinh Thêm — fixed 60.000 — `/ giờ thêm` — Sau combo 2H

**`fnb_hoat_dong`** (order 1–8, no subgroup):
1. Cà phê & Nước uống — range 30.000–80.000 — `/ phần` — Quán cà phê tại chỗ
2. Ăn uống theo yêu cầu — range 120.000–300.000 — `/ người / bữa` — Đặt trước 24h
3. Đốt lửa trại (Campfire) — range 500.000–1.000.000 — `/ buổi nhóm` — Bao gồm củi, setup, 10–50 người
4. Hái trái cây tại vườn — range 50.000–100.000 — `/ người` — Theo mùa
5. Chụp ảnh / Check-in — range 200.000–500.000 — `/ buổi` — Sử dụng cảnh quan nông trại
6. Cắm trại qua đêm — range 200.000–400.000 — `/ đêm / người` — Lều tự mang hoặc thuê
7. Nông nghiệp trải nghiệm — range 100.000–200.000 — `/ người` — Trồng rau, chăm sóc cây
8. Khu vui chơi trẻ em — label `Miễn phí` — `—` — Tiện ích kèm theo

**`su_kien_team_building`** (order 1–3, no subgroup):
1. Team Building / Sự kiện nhỏ — range 3.000.000–5.000.000 — `20–50 người` — Cần đặt trước, tùy chỉnh theo yêu cầu
2. Sự kiện doanh nghiệp lớn — range 5.000.000–10.000.000 — `50–100 người` — Setup đầy đủ, tùy chỉnh theo công ty
3. Bán nông sản & sản phẩm — label `Theo giá thị trường` — `—` — Cà phê, rau củ, trái cây tươi

### API

`functions/api/catalog/index.js`:
- `GET /api/catalog` — **no auth** (public; consumed by anonymous visitors
  on `/bang-gia` and the homepage). Returns only `is_active = 1` rows,
  ordered by `category, subgroup, display_order`.
- `GET /api/catalog?all=1` — requires auth
  (`['reception', 'manager', 'admin', 'observer']`). Returns every row
  including inactive ones, for the admin page.
- `POST /api/catalog` — requires auth (`['admin']` only). Creates a row;
  validates `price_type`-specific required fields and `room_type_key`
  per the rules above.

`functions/api/catalog/[id].js`:
- `PATCH /api/catalog/:id` — `['admin']` only. Same validation as POST;
  partial updates allowed but a changed `price_type` must still leave the
  row internally consistent (e.g. switching to `label` clears
  `price_min`/`price_max` server-side).
- `DELETE /api/catalog/:id` — `['admin']` only. Hard delete (no soft-delete
  needed beyond the existing `is_active` toggle, which `PATCH` already
  covers for "hide without losing data").

### Admin UI

New `admin/catalog.html` + `admin/catalog.js`, added to `nav-drawer.js`
under "Cấu hình & Quản trị" as `{ page: 'catalog.html', label: 'Bảng giá
dịch vụ', icon: '💰', roles: ['reception', 'manager', 'admin', 'observer'] }`
(view open to all four roles, matching that this data is public information
anyway; write gated separately). New `_redirects` rows:
`/manager/catalog`, `/reception/catalog`, `/observer/catalog` →
`/admin/catalog` (200), following the existing extensionless-target
convention.

Three tabs matching the exact category labels used on `/bang-gia` today
("Lưu Trú", "F&B & Hoạt Động", "Sự Kiện & Team Building"). Each tab lists
its rows (grouped by `subgroup` where present) in a table with columns
Tên · Đơn Giá (rendered per `price_type`) · Đơn vị/Sức chứa · Ghi chú, plus
Sửa/Xoá buttons **rendered only when the logged-in account's role is
`admin`** (checked from the cached `/api/auth/me` response already used
elsewhere in the admin app). A "+ Thêm dịch vụ" button (admin-only) opens
a form: `category` is preset from the active tab (hidden field), `subgroup`
is a free-text input, `name` required, a `price_type` selector that swaps
between two number inputs (range), one number input (fixed), or one text
input (label), plus `unit_capacity` and `note` text inputs. When
`category === 'luu_tru'`, an extra `room_type_key` `<select>` appears
(6 room types + "Không liên kết"). Non-admin roles see the same tables
read-only, with no form and no action buttons — this is enforced by the
API regardless of what the client renders.

### Public-site sync

**`bang-gia/index.html`** becomes fully data-driven: the four
`<table class="pricing-table">` bodies are emptied and rebuilt at load
time from `GET /api/catalog`, grouped into the same `subgroup` dividers
the page already has, using the exact same CSS classes (`.price`,
`.capacity`, `.note`) so the page looks identical to today when the data
matches. Since this page **is** the canonical price page, there is no
static fallback text — on fetch failure it shows a short inline message
("Không tải được bảng giá, vui lòng gọi hotline") rather than risk showing
stale numbers on the one page whose entire job is being accurate.

**`index.html`** keeps its existing static numbers as a fallback baked
into the HTML (progressive enhancement — this page's job is broader than
pricing, so a stale-but-present number beats an error state) and overwrites
them on a successful fetch, via one shared catalog-fetch block added near
the top of the page:
- The priced `<select>` around line 2682–2688: for each `<option
  value="X">` whose `X` matches a `room_type_key`, append the live price to
  the option text.
- The six `.room-price-tag` spans on room cards: each card gains a
  `data-room-type="X"` attribute; on fetch success the tag's text is
  replaced with the live price + `/đêm`.
- The FAQ chatbot's giá answer and its separate hoàn-tiền/huỷ answer
  (currently two literal template strings evaluated once at module-load
  time, stored in the chatbot's `KB` array — the huỷ answer already
  publishes a concrete-looking cancellation policy today, "hủy trước 3
  ngày hoàn 100%..." — discovered during implementation planning; per the
  user's confirmation, `cancellation_policy_tier` is still seeded empty
  rather than backfilled from that copy, but the chatbot answer is made
  to read from the real (initially empty) table going forward, same as
  the price answer). Both entries are overwritten in place on the shared
  `KB` array once the page-load fetch (`/api/catalog` and
  `/api/cancellation-policy?public=1`) resolves — the giá answer rebuilt
  from catalog data, the hoàn-tiền answer rebuilt from policy tiers (or a
  neutral "đang được cập nhật" message when no tiers are configured yet)
  — falling back to today's literal strings if the fetch fails or hasn't
  resolved by the time the visitor asks.

## Part B — Cancellation / Deposit-Refund Policy

### Data model

New table `cancellation_policy_tier`:

```sql
CREATE TABLE cancellation_policy_tier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  min_days_before_checkin INTEGER NOT NULL CHECK (min_days_before_checkin >= 0),
  refund_percent INTEGER NOT NULL CHECK (refund_percent >= 0 AND refund_percent <= 100),
  label TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_cancellation_policy_days ON cancellation_policy_tier(min_days_before_checkin);
```

Plus `ALTER TABLE bookings ADD COLUMN refund_percent_applied INTEGER;`
(nullable — populated only at the moment a booking is actually cancelled).

The user has not yet decided the real percentages (this was flagged as an
open question in the prior roadmap artifact) — the migration seeds **no
rows**, not invented numbers. With zero tiers configured, the cancel flow
below deterministically resolves to a 0% refund, and the admin UI shows an
explicit empty state rather than silently doing nothing.

### API

`functions/api/cancellation-policy/index.js`:
- `GET /api/cancellation-policy` — `['reception', 'manager', 'admin']`
  (observer excluded, matching the existing `promo_policy` convention in
  `functions/api/policy.js`). Returns all tiers ordered by
  `min_days_before_checkin DESC`.
- `GET /api/cancellation-policy?public=1` — **no auth**. Same shape as
  above. Added so the homepage FAQ chatbot (an anonymous-visitor surface,
  see the updated Public-site sync note under Part A, extended to this
  policy's FAQ answer too) can read the configured tiers without a staff
  session — added during implementation planning once the FAQ-sync
  requirement below was confirmed with the user.
- `POST /api/cancellation-policy` — `['admin']` only.

`functions/api/cancellation-policy/[id].js`:
- `PATCH` / `DELETE /api/cancellation-policy/:id` — `['admin']` only.

### Wiring into the cancel-booking flow

`functions/api/bookings/[id]/cancel.js` gains, between the existing status
check and the `UPDATE`:
1. Compute `daysBefore` as the whole-day difference between today (UTC
   midnight) and the booking's `check_in` (UTC midnight) —
   `Math.floor((checkInUTC - todayUTC) / 86400000)`, never negative-clamped
   silently; a booking cancelled after its check‑in date yields a negative
   value, which correctly matches no tier (0% refund) since every tier's
   `min_days_before_checkin >= 0`.
2. Query tiers `ORDER BY min_days_before_checkin DESC`, pick the first
   whose `min_days_before_checkin <= daysBefore`. No match (including the
   zero-tiers case) → `refundPercent = 0`.
3. `refundAmount = Math.round(booking.deposit_amount * refundPercent / 100)`.
4. `UPDATE bookings SET status = 'cancelled', cancel_reason = ?,
   refund_percent_applied = ? WHERE id = ?`.
5. Response becomes `{ ok: true, refundPercentApplied, refundAmount }` —
   additive change, existing callers that ignore the extra fields are
   unaffected.

No money actually moves automatically — there is no payment gateway in
this system today. This is a computed, audited reference number for the
reception staff member to act on manually (e.g. bank transfer outside the
system), not an automated refund.

### Admin UI

New `admin/cancellation-policy.html` + `.js`, added to `nav-drawer.js`
next to the catalog entry (`{ page: 'cancellation-policy.html', label:
'Chính sách hoàn cọc', icon: '🔄', roles: ['reception', 'manager', 'admin',
'observer'] }`), same `_redirects` pattern
(`/manager/cancellation-policy`, `/reception/cancellation-policy`,
`/observer/cancellation-policy` → `/admin/cancellation-policy`). A single
table (Số ngày tối thiểu trước check-in · % Hoàn cọc · Ghi chú · Sửa/Xoá)
with an admin-only "+ Thêm bậc" form. Empty state text: "Chưa cấu hình
chính sách hoàn cọc — mặc định không hoàn cọc khi huỷ." Non-admin roles
(reception, manager, observer) see the list read-only — reception in
particular needs to reference the current tiers when explaining the
policy to a guest over the phone.

### Reception cancel-flow UI change

`admin/reception.js`'s existing `cancelBooking(id)` is a direct one-click
action today — there is no confirm dialog to attach a "before" preview to
(checked during implementation planning; an earlier draft of this spec
assumed one existed). Simplified accordingly: the cancel call's response
now includes `refundPercentApplied`/`refundAmount` (server-computed,
authoritative), and on success the existing `showOpsError(...)` status
line — already used for both errors and cleared-on-success messages
elsewhere in this file — displays "Đã huỷ đặt phòng. Hoàn cọc đề xuất: X%
(~Y đ)" when the computed amount is greater than zero, or clears as
before otherwise. No new dialog or UI chrome is added.

## Testing

- New `test/serviceCatalogEndpoints.test.js`: `GET` (public, active-only
  by default; `?all=1` requires auth and returns inactive rows too),
  `POST`/`PATCH`/`DELETE` role-gated to `admin` only (403 for
  reception/manager/observer), `price_type` validation for all three
  types (missing required field per type → 400), `room_type_key`
  validation (invalid key → 400; duplicate active key → 400; clearing a
  link succeeds).
- New `test/cancellationPolicyEndpoints.test.js`: `GET` role list matches
  `promo_policy`'s existing convention, `POST`/`PATCH`/`DELETE` admin-only,
  `refund_percent` bounds validation (negative or over 100 → 400).
- Extend `test/bookingsEndpoints.test.js`'s cancel-booking describe block:
  refund computed correctly at a tier boundary (exactly
  `min_days_before_checkin` days out), below the smallest configured tier
  (0%), with zero tiers configured (0%), and confirms
  `refund_percent_applied` persists on the booking row afterward.
- Playwright: extend `tests/e2e/crm-*` conventions with a new
  `admin-catalog.spec.js` (admin sees Sửa/Xoá controls and can add a row;
  a non-admin role sees the same data read-only, no controls) and a new
  `admin-cancellation-policy.spec.js` (same admin-only-write pattern).
  Extend `tests/seo/links.spec.js`'s coverage implicitly by adding a
  `bang-gia` catalog-rendering check to `tests/e2e/` (mocked
  `/api/catalog` response renders the expected rows into the page) so a
  regression here is caught the same way the stray deleted `.jpg` was
  caught earlier today. A further homepage e2e test mocks both
  `/api/catalog` and `/api/cancellation-policy?public=1` and confirms the
  booking select, room card price tags, and both FAQ chatbot answers (giá
  and hoàn tiền, including its empty-tiers fallback message) all update
  accordingly.
