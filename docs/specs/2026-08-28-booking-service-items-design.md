# Booking Service Items (Dịch Vụ Phát Sinh) — Design

**Date:** 2026-08-28
**Repo:** `hien-le-garden-v4` (`v4/` in this monorepo checkout)
**Status:** Approved by user, ready for implementation planning

## Problem

Ancillary charges during a guest's stay (breakfast, campfire, an extra
activity) currently have nowhere to live in this system — reception has to
track them off-system and total them up by hand at checkout, which is
exactly the revenue-loss pattern the roadmap's core problem #2
("thất thoát doanh thu dịch vụ") describes. The `service_catalog` table
built earlier today (name + price for all three business lines) already
gives reception a real, priced menu to pick from; this feature adds the
missing piece — attaching a chosen catalog item, at a real agreed price,
to a specific booking, and totaling it.

## Data model

New table `booking_service_items`:

```sql
CREATE TABLE booking_service_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  service_catalog_id INTEGER REFERENCES service_catalog(id),
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('posted', 'voided')) DEFAULT 'posted',
  created_by TEXT,
  created_at TEXT NOT NULL,
  voided_by TEXT,
  voided_at TEXT
);
CREATE INDEX idx_booking_service_items_booking ON booking_service_items(booking_id, status);
```

`name` and `unit_price` are a **snapshot** taken at the moment the line is
added — not a live join to `service_catalog` — so a later catalog price
edit or deletion never rewrites a booking's historical charges.
`service_catalog_id` is kept purely for traceability (which catalog row
this line originated from); nothing re-reads it after creation.

Voiding a line is a **soft delete**: `status` flips to `'voided'` and
`voided_by`/`voided_at` are recorded. The row is never physically removed
— consistent with the audit-trail emphasis already established for
deposits and cancellations earlier today. No void reason is required
(kept minimal, matching the roadmap's "bản tối giản" framing for this
item); a voided line stays visible in the UI, struck through, rather than
disappearing, so a wrong add is still traceable to who made it and who
undid it.

No `total_amount` column is added to `bookings` — this system has never
stored a computed booking total (room price itself is display-time only,
per `lib/roomTypes.js`), and this feature doesn't change that. The
service total is computed at read time (`SUM(amount) WHERE status =
'posted'`) and shown per-booking; it is not persisted.

## Scope: which catalog items, which bookings, who

- **Catalog scope**: any `service_catalog` row with `is_active = 1`, from
  any of the three categories (not just F&B & Hoạt Động) — confirmed by
  the user as the more flexible option.
- **Booking scope**: addable only when `bookings.status` is `'confirmed'`
  or `'checked_in'` — a room/stay context must exist. Not addable to
  `pending` (no room assigned yet), `checked_out`, or `cancelled` bookings.
- **Price entry**: the unit price is **always editable** at add time,
  pre-filled from the catalog row's `price_min` as a starting suggestion
  (blank if the catalog row is `price_type: 'label'`, since there's no
  numeric starting point). This is how range-priced and label-priced
  catalog items (`Đốt lửa trại 500.000–1.000.000 đ`, `Bán nông sản...
  Theo giá thị trường`) still work through this flow — reception enters
  whatever was actually agreed with the guest.
- **Who can add/void**: `['reception', 'manager', 'admin']` — matches the
  existing convention for every other booking-mutating action in this
  app (confirm, check-in, check-out, cancel, deposit). `observer` can view
  the list and the total (read-only), matching its access to every other
  part of the reception ops board.

## API

`functions/api/bookings/[id]/services/index.js`:
- `POST` — `['reception', 'manager', 'admin']`. Body: `{ serviceCatalogId,
  unitPrice, quantity }`. Validates: the target booking exists and its
  `status` is `'confirmed'` or `'checked_in'` (else 400); `serviceCatalogId`
  references an existing, **active** `service_catalog` row (else 400) —
  `name` is derived server-side from that row, never taken from the
  client, so the catalog stays the one source of truth for what a line is
  *called* even though its *price* is freely overridden; `unitPrice` is a
  non-negative integer; `quantity` is a positive integer. `amount =
  unitPrice * quantity`, computed server-side. Inserts with
  `status = 'posted'`, `created_by = auth.username`.

`functions/api/bookings/[id]/services/[itemId].js`:
- `PATCH` — `['reception', 'manager', 'admin']`. Void action (no body
  needed beyond an empty JSON object). 404 if the item doesn't exist or
  doesn't belong to the booking in the URL (protects against an
  itemId/bookingId mismatch). 400 if already voided (`'Dòng dịch vụ này
  đã được huỷ trước đó'`). Sets `status = 'voided'`, `voided_by =
  auth.username`, `voided_at = now`.

`functions/api/bookings/index.js`'s existing `GET` (already used by every
list on the reception ops board — pending, arrivals, upcoming confirmed,
in-house, departures, all through the same `fetchBookings()` helper in
`admin/reception.js`) gains one additive change: after fetching the
primary booking rows, one extra query (`SELECT ... FROM
booking_service_items WHERE booking_id IN (...)`, skipped entirely when
the primary result set is empty) fetches every service line for the
returned bookings in a single round trip, grouped in JS and attached as
`services: [...]` on each booking object — no N+1 requests, and every
existing consumer of this endpoint that ignores the new field is
unaffected. `observer`'s existing phone/email redaction on this endpoint
is untouched; `services` is not redacted (it carries no guest PII).

## UI

`admin/reception.js`'s `renderBookingCard(b)` — the single shared card
renderer already used by every list on this page — gains a new section,
shown whenever `b.status` is `'confirmed'` or `'checked_in'`, placed
after the existing deposit block:

- Each **posted** line renders as a compact row: `{name} ×{quantity} —
  {amount đ}`, with a "Huỷ" button (`reception`/`manager`/`admin` only).
- Each **voided** line renders the same way but struck through
  (`text-decoration: line-through`) and dimmed, with no button — visible
  for traceability, not actionable further.
- A "Tổng dịch vụ: {sum of posted amounts} đ" line appears whenever there
  is at least one line (posted or voided) — always visible to everyone
  including `observer`.
- A "+ Thêm dịch vụ" button (`reception`/`manager`/`admin` only) reveals
  an inline mini-form: a `<select>` populated from a one-time
  `GET /api/catalog` fetch done at page load (already active-only, so no
  extra filtering needed), a price `<input type="number">` that
  pre-fills from the selected item's `priceMin` on change (blank for
  `label`-type items), a quantity `<input type="number">` defaulting to
  `1`, and "Thêm"/"Huỷ" buttons — matching the existing inline-reveal
  pattern already used for admin/users.js's password-reset row and this
  same file's deposit input, rather than introducing a modal.

## Testing

- New `test/bookingServiceItems.test.js`: `POST` (happy path posts a
  line with server-derived name and client-provided price/quantity;
  rejects a `pending`/`checked_out`/`cancelled`/nonexistent booking;
  rejects an inactive or nonexistent `serviceCatalogId`; rejects a
  negative/zero/non-integer price or quantity; allows
  reception/manager/admin, rejects `observer` with 403); `PATCH` void
  (happy path; 404 for a mismatched booking/item pair; 400 for
  double-void; rejects `observer` 403).
- Extend `test/bookingLifecycle.test.js` (or wherever `GET
  /api/bookings` is already covered — verify current location before
  writing, per this session's established habit of checking rather than
  assuming file locations) with a case confirming `services` is attached
  correctly, grouped per booking, and empty (`[]`) for a booking with no
  lines — not omitted or `null`.
- Playwright: extend `tests/e2e/reception-ops-board.spec.js` — adding a
  service line updates the card's total and item list; voiding a line
  strikes it through and removes it from the total; a `pending` booking's
  card never shows the "+ Thêm dịch vụ" control; `observer` sees the list
  and total but no add/void controls.
