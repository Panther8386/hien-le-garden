# Định danh khách & Phiếu đăng ký lưu trú

**Status:** Approved by user 2026-09-04, ready for implementation planning.

## 1. Goal

Capture the lead guest's ID number (CCCD/hộ chiếu) and nationality on a booking, and let reception print a standard "Phiếu đăng ký lưu trú" (stay registration form) for that guest, printable on demand at or after check-in.

## 2. Non-goals

- No per-guest records for an entire party — this captures identity for the single lead guest already stored on each `bookings` row (`guest_name`/`phone`), not a roster of every person staying. Confirmed with the user as the MVP scope.
- No format validation on the ID number beyond a length cap — CCCD (12-digit), older CMND (9-digit), and foreign passports (alphanumeric) all have different shapes; free text avoids rejecting a legitimate real-world value.
- No requirement to enter ID info before check-in — the "Check-in" action and the "In phiếu" action are independent; a guest can check in first and hand over their ID later.
- No nationality dropdown/country list — free text, matching how every other free-text field in this codebase (notes, guest name) is handled; YAGNI unless requested.
- No edit history/audit trail specific to these two fields — they follow the same update-in-place pattern as every other booking field (no dedicated audit_log entries for this, consistent with the fact that no general booking-edit endpoint has one today either).
- No existing "edit booking" form is being extended, because none exists — the app currently has no general-purpose booking-detail edit UI, only narrow single-purpose action endpoints (`/confirm`, `/check-in`, `/deposit`, etc.). This feature adds its own narrow endpoint in that same style, not a new general edit form.

## 3. Architecture fit

Same stack as the rest of V4: Cloudflare Pages Functions + D1, vanilla-JS admin frontend, no build step. Two new columns on the existing `bookings` table (a plain `ALTER TABLE ADD COLUMN`, no CHECK constraint involved, so no rebuild-and-rename migration needed this time — unlike the finance-transactions CHECK-constraint changes earlier this session). Two new endpoints follow the codebase's existing narrow-action-endpoint convention exactly (`functions/api/bookings/[id]/confirm.js`, `/check-in.js`, `/deposit.js`, etc. are the precedent). One new standalone page for printing — the app's first print-oriented page; it deliberately does not load `nav-drawer.js` or the shared admin chrome, since a printed page should show only the form.

## 4. Data model

`migrations/0020_bookings_identity.sql`:

```sql
ALTER TABLE bookings ADD COLUMN id_number TEXT;
ALTER TABLE bookings ADD COLUMN nationality TEXT;
```

Both columns are nullable, no default, no constraint — matches the "optional, can be filled in after check-in" requirement directly at the schema level.

## 5. API contract

### 5.1. `GET /api/bookings/:id` (new — `functions/api/bookings/[id]/index.js`)

Roles: `reception`, `manager`, `admin` (matches every other reception-facing booking endpoint; no `observer` — this page is an operational tool, not a reporting view). 404 if the booking doesn't exist.

Returns the single booking's full detail, including a joined room name (the print page is a standalone tab with no other app state loaded, so it needs everything in one response — unlike `reception.js`'s in-memory list rendering, which resolves room names from a separately-fetched rooms list already in memory):

```json
{
  "id": 42, "guestName": "...", "phone": "...", "email": "...",
  "roomType": "triangle", "roomId": 3, "roomName": "Triangle House 2",
  "checkIn": "2026-09-10", "checkOut": "2026-09-12", "guestsCount": 2,
  "notes": "...", "status": "checked_in",
  "idNumber": null, "nationality": null
}
```

### 5.2. `PATCH /api/bookings/:id/identity` (new — `functions/api/bookings/[id]/identity.js`)

Roles: `reception`, `manager`, `admin`. Body `{ idNumber, nationality }`, both optional/nullable. `400` if either is present but not a string, or over 200 characters (matching the existing length-cap convention already used for `guestName`/`phone` in `functions/api/bookings/staff.js`). `404` if the booking doesn't exist. On success: `UPDATE`, both values trimmed, empty string stored as `NULL`. Returns `{ ok: true }`.

## 6. Client

### 6.1. `admin/reception.js` — "In phiếu" button

A new "🖨 In phiếu" button appears in the action row for both **arrivals** (`loadArrivals()` — confirmed, not yet checked in) and **in-house** (`loadInhouse()` — already checked in, which currently has no action buttons at all) booking lists, alongside the existing Check-in/Huỷ buttons. Clicking it opens `admin/stay-registration-print.html?bookingId={id}` in a new tab (`window.open(..., '_blank')`) — it never blocks or gates the Check-in action.

### 6.2. `admin/stay-registration-print.html` + `.js` (new)

A standalone page, structurally similar to other admin pages (same `<head>` boilerplate, `admin.css` for the on-screen editing chrome) but **without** `nav-drawer.js` — a printed page has no reason to carry the app's navigation drawer.

On load: reads `bookingId` from the query string, fetches it via §5.1, and renders two things:

1. **An editable identity form** (screen-only, hidden when printing): inputs for "Số CCCD/hộ chiếu" and "Quốc tịch", pre-filled from the fetched booking, with a "Lưu" button that calls §5.2 and refreshes the preview below.
2. **The stay-registration form itself** (the printable content): a formatted "PHIẾU ĐĂNG KÝ LƯU TRÚ" document —
   - Tên cơ sở lưu trú: "Hiền Lê Garden"
   - Họ và tên khách, Số điện thoại
   - Quốc tịch, Số CCCD/hộ chiếu
   - Phòng: `{roomName}`, Số khách: `{guestsCount}`
   - Ngày đến: `{checkIn}`, Ngày đi: `{checkOut}`
   - Hai dòng chữ ký: "Khách lưu trú" và "Lễ tân"

A "🖨 In" button calls `window.print()`. `@media print` CSS hides the identity-editing form and every button, so only the stay-registration document itself prints.

## 7. Testing

- `test/migrations.test.js` — new `describe('migration 0020', ...)` block: both columns exist, default to `NULL`, accept a value.
- `test/bookingIdentity.test.js` (new) — `GET /api/bookings/:id`: role gates, 404 for a nonexistent id, correct field shape including the joined `roomName`. `PATCH /api/bookings/:id/identity`: role gates, 404, length-cap validation, correct save (including empty-string-becomes-null), does not touch any other booking field.
- `tests/e2e/stay-registration-print.spec.js` (outer repo, new) — the print page loads a booking's details, filling and saving the identity form updates the on-page preview, the printable content shows the expected fields (guest name, room, dates), and the print button exists and is clickable (Playwright cannot verify actual OS print output, only that `window.print()` is invoked — stub it and assert the call).
