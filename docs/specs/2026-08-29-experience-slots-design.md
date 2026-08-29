# Farm Experience Slots & Capacity Design

**Date:** 2026-08-29
**Status:** Approved
**Repo target:** `hien-le-garden-v4` (v4)

## Problem

The service catalog (`service_catalog` / `booking_service_items`, built in an
earlier phase) treats every add-on the same way: reception picks an item,
types a price and quantity, done. That works for a coffee or a BBQ plate,
but it's wrong for farm experiences with a real physical limit — a campfire
night, a fruit-picking round, an overnight camping slot — where the
farmstay can only host so many people at a given time. Today nothing stops
reception from registering 80 guests for a 30-person campfire, and nothing
tells them Saturday 19:00 is full while Saturday 20:00 still has room.

## Goal

Let admin mark specific catalog items as "scheduled" and define a recurring
weekly time-slot schedule with a capacity for each. When reception adds
such an item to a booking, they pick a date and a slot, see live remaining
capacity, and the system blocks the registration if the party won't fit —
offering nearby alternative slots instead of a dead end.

Scope, explicitly confirmed during brainstorming:
- **Staff-assisted only.** Reception adds this on behalf of a guest,
  through the existing "+ Thêm dịch vụ" flow on the ops board. No public
  self-service booking widget in this iteration.
- **Recurring weekly schedule, configured once.** Admin defines a slot as
  "which days of the week, what time, what capacity" — not one row per
  calendar date.
- **Capacity counted in guests (quantity), not registrations.** A
  30-capacity slot can take one booking of 30 or ten bookings of 3.
- **The "how far ahead to search" and "how many alternatives to show"
  numbers are themselves admin-configurable**, not hardcoded — the same
  pattern this codebase already uses for `reminder_settings`.

## Schema

New migration `0014_experience_slots.sql`:

```sql
ALTER TABLE service_catalog ADD COLUMN is_scheduled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE service_slot_template (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_catalog_id INTEGER NOT NULL REFERENCES service_catalog(id),
  label TEXT,
  days_of_week TEXT NOT NULL,
  start_time TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_service_slot_template_catalog ON service_slot_template(service_catalog_id, is_active);

CREATE TABLE experience_booking_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suggestion_window_days INTEGER NOT NULL DEFAULT 14,
  max_suggestions INTEGER NOT NULL DEFAULT 5,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO experience_booking_settings (suggestion_window_days, max_suggestions, updated_at)
VALUES (14, 5, '2026-08-29T00:00:00Z');

ALTER TABLE booking_service_items ADD COLUMN experience_date TEXT;
ALTER TABLE booking_service_items ADD COLUMN slot_template_id INTEGER REFERENCES service_slot_template(id);
ALTER TABLE booking_service_items ADD COLUMN experience_slot_label TEXT;
ALTER TABLE booking_service_items ADD COLUMN experience_start_time TEXT;
```

No `CHECK` constraints on any `ALTER TABLE`-added column, matching this
codebase's established convention — validation lives in the API layer.
`is_scheduled` and `is_active` are plain 0/1 integers, same as every other
boolean flag in this schema.

`days_of_week` is a CSV of integers 0-6 (Sunday=0 … Saturday=6, matching
JavaScript's `Date.getUTCDay()`, which this codebase already relies on
elsewhere — see `lib/dashboardMetrics.js`'s date-boundary math). E.g.
`"5,6,0"` means Friday, Saturday, Sunday.

`experience_booking_settings` follows the exact insert-a-new-row-on-update
pattern already established for `reminder_settings`/`notification_settings`
— reading the latest row via `ORDER BY id DESC LIMIT 1`, never an in-place
`UPDATE`.

### Why `booking_service_items` snapshots the slot's label and time

`slot_template_id` is kept as a live FK — needed to group registrations by
occurrence when computing remaining capacity (see below). But
`experience_slot_label` and `experience_start_time` are captured at
add-time and never re-read from `service_slot_template` afterward, exactly
matching the snapshot-pricing pattern this codebase already established for
`booking_service_items.name`/`unit_price` (which never re-read
`service_catalog` either). This means a slot template can be edited,
deactivated, or even deleted later without corrupting how a past
booking's service line displays — the same audit-trail-preserving
principle already applied to pricing now covers scheduling too.

Because display no longer depends on the live template row,
`service_slot_template` never needs a hard-delete endpoint — admin removes
a slot from the future schedule by toggling `isActive` off via the same
`PATCH` that edits its other fields. A deactivated template simply stops
appearing in the availability picker; nothing referencing it historically
breaks.

## Admin: configuring scheduled experiences (`catalog.html`)

The existing catalog form gains one new checkbox, placed after the
"Dùng nhãn tự do" checkbox and before the price fields:

```html
<label class="checkbox"><input type="checkbox" name="isScheduled" /> Có khung giờ + sức chứa (trải nghiệm)</label>
```

Submitting the form includes `isScheduled: boolean` in the payload to
`POST`/`PATCH /api/catalog`(`/:id`) alongside the existing fields.

When editing an existing item (`openEditForm`) whose `isScheduled` is
`true`, a new section appears below the form (only reachable from the edit
flow, since slot templates need a real `service_catalog_id`):

```html
<div id="slotTemplatesSection" class="hidden">
  <h3>Khung giờ &amp; sức chứa</h3>
  <p id="slotTemplatesError" class="error"></p>
  <div class="table-scroll">
    <table id="slotTemplatesTable">
      <thead><tr><th>Nhãn</th><th>Ngày trong tuần</th><th>Giờ bắt đầu</th><th>Sức chứa</th><th>Trạng thái</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <form id="slotTemplateForm">
    <input type="hidden" name="id" />
    <label>Nhãn (tuỳ chọn) <input type="text" name="label" placeholder="VD: Suất tối" /></label>
    <fieldset>
      <legend>Ngày trong tuần</legend>
      <label class="checkbox"><input type="checkbox" name="dow" value="1" /> T2</label>
      <label class="checkbox"><input type="checkbox" name="dow" value="2" /> T3</label>
      <label class="checkbox"><input type="checkbox" name="dow" value="3" /> T4</label>
      <label class="checkbox"><input type="checkbox" name="dow" value="4" /> T5</label>
      <label class="checkbox"><input type="checkbox" name="dow" value="5" /> T6</label>
      <label class="checkbox"><input type="checkbox" name="dow" value="6" /> T7</label>
      <label class="checkbox"><input type="checkbox" name="dow" value="0" /> CN</label>
    </fieldset>
    <label>Giờ bắt đầu <input type="time" name="startTime" required /></label>
    <label>Sức chứa (số khách) <input type="number" name="capacity" min="1" required /></label>
    <button type="submit" id="slotTemplateSubmitBtn">Thêm khung giờ</button>
    <button type="button" id="slotTemplateCancelBtn" class="btn-secondary">Huỷ</button>
  </form>
  <button type="button" id="addSlotTemplateBtn">+ Thêm khung giờ</button>
</div>
```

This section, and its create/edit controls, are gated the same way the
rest of `catalog.html`'s admin controls already are — visible only when
`currentRole === 'admin'` (the same check that currently shows
`addServiceBtn`).

### New endpoints for slot templates

`functions/api/catalog/[id]/slot-templates/index.js`:
- `GET` — `requireAuth(['reception','manager','admin','observer'])`
  (broad read, matching `GET /api/catalog`'s own broad-read convention).
  Returns all slot templates (active and inactive) for that catalog id, so
  the admin edit UI can show/toggle inactive ones too:
  ```sql
  SELECT id, service_catalog_id AS serviceCatalogId, label, days_of_week AS daysOfWeek,
         start_time AS startTime, capacity, is_active AS isActive
  FROM service_slot_template WHERE service_catalog_id = ? ORDER BY start_time
  ```
  `daysOfWeek` is returned as the raw CSV string; the frontend splits it.
- `POST` — `requireAuth(['admin'])`. Body: `{ label, daysOfWeek: number[],
  startTime, capacity }`. Validates: `daysOfWeek` is a non-empty array of
  integers each in `0..6` with no duplicates (400 `"Vui lòng chọn ít nhất
  một ngày trong tuần"` if empty, `"Ngày trong tuần không hợp lệ"` for
  anything out of range or duplicated); `startTime` matches
  `/^([01]\d|2[0-3]):[0-5]\d$/` (400 `"Giờ bắt đầu không hợp lệ"`);
  `capacity` is `Number.isInteger(x) && x > 0` (400 `"Sức chứa phải là số
  nguyên dương"`). Also verifies the parent `service_catalog_id` exists and
  has `is_scheduled = 1` (400 `"Dịch vụ này chưa bật chế độ khung giờ"` —
  guards against creating orphaned slot config for a non-scheduled item).
  On success, `INSERT`s with `days_of_week` joined back to CSV
  (`daysOfWeek.join(',')`), `created_by = auth.username`, returns
  `{ id, ok: true }`, `201`.

`functions/api/catalog/[id]/slot-templates/[templateId].js`:
- `PATCH` — `requireAuth(['admin'])`. Same field set as `POST` plus
  `isActive: boolean`, same validation, partial-update semantics matching
  `PATCH /api/catalog/:id` (each field falls back to the existing row's
  value when omitted from the body). 404 if the template id doesn't exist
  or doesn't belong to the `:id` in the URL. Returns `{ ok: true }`, `200`.

### New endpoint: live availability for the picker

`functions/api/catalog/[id]/slot-availability.js`, `GET`:
`requireAuth(['reception','manager','admin','observer'])`. Query param
`date` (required, `YYYY-MM-DD`, 400 `"Ngày không hợp lệ"` if malformed).

```js
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
```

Returns every active slot template for that catalog id whose
`days_of_week` CSV includes that date's weekday, each with remaining
capacity computed against **posted** (non-voided) `booking_service_items`
sharing that `(slot_template_id, experience_date)` pair:

```sql
SELECT st.id, st.label, st.start_time AS startTime, st.capacity,
       COALESCE(SUM(bsi.quantity), 0) AS booked
FROM service_slot_template st
LEFT JOIN booking_service_items bsi
  ON bsi.slot_template_id = st.id AND bsi.experience_date = ? AND bsi.status = 'posted'
WHERE st.service_catalog_id = ? AND st.is_active = 1
GROUP BY st.id
ORDER BY st.start_time
```
(bound `[date, catalogId]`, day-of-week filtering happens in JS after the
query since SQLite has no day-of-week function — the template rows for
this one catalog id are few, so filtering in JS is simpler and cheaper
than a CASE-heavy SQL expression). Response:
```json
[{ "id": 3, "label": "Suất tối", "startTime": "19:00", "capacity": 30, "booked": 18, "remaining": 12 }]
```

## Reception: adding a scheduled experience (`reception.js`)

In `openAddServiceForm`, after the existing `select` (catalog item picker)
gains a `change` listener behavior addition: when the selected option's
backing catalog item has `isScheduled === true` (the `catalogItems` array
already loaded at page init needs `isScheduled` included in its shape —
see below), two new fields appear that don't exist for a normal item:

```html
<input type="date" id="experienceDateInput" />
<select id="slotTemplateSelect">
  <option value="">-- Chọn ngày trước --</option>
</select>
```

- Changing the date (or first selecting a scheduled catalog item) triggers
  `GET /api/catalog/:id/slot-availability?date=...` and repopulates the
  slot `<select>`: each option's label is `"${startTime} — còn
  ${remaining}/${capacity} chỗ"` (or `"${startTime} — Hết chỗ"`, `disabled`,
  when `remaining <= 0`), `value` is the template id.
- The existing `priceInput` still auto-fills from the catalog item's
  `priceMin` as it already does — scheduling doesn't change pricing.
- The existing `qtyInput` ("Số lượng") now doubles as "Số khách" for a
  scheduled item — no new field, same input, its label text becomes "Số
  khách" instead of the generic quantity label when a scheduled item is
  selected (a one-line conditional on `qtyInput`'s associated `<label>`
  text node).
- On submit, when the selected item `isScheduled`, `experienceDateInput`
  and `slotTemplateSelect` must both be filled (400-equivalent client-side
  check: `"Vui lòng chọn ngày và khung giờ"` in `errorEl`, mirroring the
  existing client-side validation style in this function) before the
  `fetch` fires. The POST body gains `experienceDate` and `slotTemplateId`
  when applicable.

`catalogItems` (populated once at page load via `GET /api/catalog`, already
existing) needs no shape change on the frontend side — `GET /api/catalog`
already returns every column via `SELECT *`-equivalent aliasing; this spec
adds `is_scheduled AS isScheduled` to that existing `SELECT` list in
`functions/api/catalog/index.js` (both the `all=1` and public list
variants) so the frontend can branch on it without an extra request.

## `POST /api/bookings/:id/services`: capacity enforcement

Body gains two optional fields: `experienceDate` (string `YYYY-MM-DD`),
`slotTemplateId` (integer). After the existing `unitPrice`/`quantity`
validation and the existing `catalogItem` lookup:

```js
if (catalogItem.isScheduled) {
  if (typeof experienceDate !== 'string' || !DATE_FORMAT.test(experienceDate)) {
    return jsonError('Vui lòng chọn ngày hợp lệ', 400);
  }
  if (!Number.isInteger(slotTemplateId)) {
    return jsonError('Vui lòng chọn khung giờ', 400);
  }

  const template = await env.DB.prepare(
    `SELECT id, label, start_time, capacity, days_of_week FROM service_slot_template WHERE id = ? AND service_catalog_id = ? AND is_active = 1`
  ).bind(slotTemplateId, catalogItem.id).first();
  if (!template) {
    return jsonError('Khung giờ không hợp lệ hoặc đã ngừng áp dụng', 400);
  }

  const weekday = weekdayOf(experienceDate); // same helper as slot-availability.js, duplicated locally in this file too
  if (!template.days_of_week.split(',').map(Number).includes(weekday)) {
    return jsonError('Khung giờ này không áp dụng cho ngày đã chọn', 400);
  }

  const bookedRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS booked FROM booking_service_items
     WHERE slot_template_id = ? AND experience_date = ? AND status = 'posted'`
  ).bind(slotTemplateId, experienceDate).first();
  const remaining = template.capacity - bookedRow.booked;

  if (quantity > remaining) {
    const alternatives = await findAlternativeSlots(env, catalogItem.id, experienceDate, quantity);
    return new Response(
      JSON.stringify({ error: `Suất này chỉ còn ${remaining} chỗ, không đủ cho ${quantity} khách`, alternatives }),
      { status: 409, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
```

`DATE_FORMAT` here is the same `/^\d{4}-\d{2}-\d{2}$/` regex already
defined in `functions/api/bookings/index.js` — duplicated locally in this
file rather than newly shared, matching how this codebase already
tolerates small constant duplication across endpoint files (e.g. each
endpoint file defines its own local `jsonError`) rather than introducing a
new shared-lib import for a one-line regex.

`catalogItem`'s lookup query gains `is_scheduled AS isScheduled` to its
existing `SELECT id, name FROM service_catalog WHERE id = ? AND is_active =
1` (becomes `SELECT id, name, is_scheduled AS isScheduled FROM
service_catalog ...`).

The final `INSERT` gains four bound values for the four new
`booking_service_items` columns — `experience_date`, `slot_template_id`,
`experience_slot_label` (bound from `template.label`), `experience_start_time`
(bound from `template.start_time`) — all `NULL` when the item isn't
scheduled.

### `findAlternativeSlots(env, catalogId, fromDate, requiredQuantity)`

New helper, colocated in the same endpoint file (mirrors this codebase's
convention of keeping small single-use helpers local to the file that
needs them, e.g. `nightsInRange`/`monthBounds` living inside
`lib/dashboardMetrics.js` rather than a separate utility module — this one
stays local since only this endpoint calls it).

1. Reads `suggestion_window_days`/`max_suggestions` from
   `experience_booking_settings` (`ORDER BY id DESC LIMIT 1`), falling
   back to `{ suggestionWindowDays: 14, maxSuggestions: 5 }` in JS if the
   table is ever empty — same defensive-fallback convention already
   established for `reminder_settings`.
2. Loads every active slot template for `catalogId`.
3. Iterates `fromDate` through `fromDate + suggestionWindowDays` days
   inclusive; for each date, for each template whose `days_of_week`
   includes that date's weekday, computes `remaining` the same way the
   caller just did (one `SUM` query per (date, template) pair that
   actually applies — bounded by `suggestionWindowDays × template count`,
   which is small: a handful of templates times at most a few dozen days).
4. Keeps only `(date, template)` pairs where `remaining >= requiredQuantity`
   — an alternative that can't fit the party isn't a useful suggestion.
5. Sorts by date ascending, then `start_time` ascending; returns the first
   `maxSuggestions` as
   `[{ date, slotTemplateId, label, startTime, remaining }]`.
6. The very slot that was just rejected (same `slotTemplateId` +
   `experienceDate`) is naturally excluded since its `remaining <
   requiredQuantity` by construction — no special-case filtering needed.

## `GET`/`PATCH /api/experience-booking-settings`

New file `functions/api/experience-booking-settings.js`, mirroring
`functions/api/reminder-settings.js` exactly in structure:

- `GET`: `requireAuth(['reception','manager','admin','observer'])`. Returns
  `{ suggestionWindowDays, maxSuggestions, updatedAt }` from the latest row,
  or the `{14, 5, null}` default if the table is empty.
- `PATCH`: `requireAuth(['admin'])`. Body `{ suggestionWindowDays,
  maxSuggestions }`, both required, each validated
  `Number.isInteger(x) && x > 0 && x <= <ceiling>` — reusing the exact
  overflow-safety lesson from the reminder-settings fix earlier this
  session: `suggestionWindowDays` capped at `365` (a year is already an
  absurdly generous search window and keeps the per-request query count in
  `findAlternativeSlots` bounded), `maxSuggestions` capped at `50` (far
  more than any reception UI would usefully render). 400
  `"Số ngày/số gợi ý phải là số nguyên dương và trong giới hạn cho phép"`
  otherwise. On success, `INSERT`s a new row (never `UPDATE`s, same
  pattern), returns `{ ok: true }`, `200`.

## Admin: configuring the search-window settings (`catalog.html`)

New small section, admin-only (same `currentRole === 'admin'` gate),
placed above the category tabs since it's a page-wide setting rather than
a per-item one:

```html
<div id="experienceSettingsSection" class="hidden">
  <h2>Cấu hình gợi ý khung giờ</h2>
  <form id="experienceSettingsForm">
    <label>Số ngày tìm gợi ý (khi hết chỗ) <input type="number" name="suggestionWindowDays" min="1" max="365" required /></label>
    <label>Số gợi ý tối đa hiển thị <input type="number" name="maxSuggestions" min="1" max="50" required /></label>
    <button type="submit">Lưu cấu hình</button>
    <p id="experienceSettingsError" class="error"></p>
  </form>
</div>
```

`admin/catalog.js` gains `loadExperienceSettings()` (`GET`, populates the
two inputs) and a submit handler (`PATCH`, re-loads on success, shows
`body.error` on failure) — structurally identical to
`loadReminderSettings()`/its submit handler in `admin/manager.js` from the
prior plan.

## Reception: showing "khung giờ hết chỗ" and its suggestions

When the `POST /api/bookings/:id/services` call in `openAddServiceForm`'s
submit handler returns `409`, the existing `errorEl.textContent = body.error
|| ...` line already surfaces the message. This spec adds one more step
directly after that assignment: if `body.alternatives` is a non-empty
array, render each as a small clickable suggestion line below `errorEl`
(reusing the form's existing `errorEl`-adjacent DOM area — a new
`<div id="slotAlternatives">` appended once, cleared and repopulated on
each 409):

```
Suất này chỉ còn 3 chỗ, không đủ cho 10 khách
Gợi ý khung giờ khác:
· 30/08 — 20:00 (còn 25 chỗ)   [chọn]
· 31/08 — 19:00 (còn 30 chỗ)   [chọn]
```
Clicking `[chọn]` on a suggestion sets `experienceDateInput.value` and
`slotTemplateSelect`'s value to that suggestion's date/template (triggering
the same `change` handler that repopulates the select with live
availability for that date, so the picked option is confirmed against
fresh data rather than the now-possibly-stale suggestion), clears the
alternatives list, and leaves the reception member to hit "Thêm" again
themselves — no auto-resubmit, since the suggestion's `remaining` count is
already a few hundred milliseconds stale by the time it's rendered and a
silent auto-submit could itself race into a second capacity conflict.

## Testing

New `test/experienceSlots.test.js` covering `service_slot_template` CRUD
(`GET`/`POST`/`PATCH`) and `slot-availability`:
- Create/list/edit a slot template; role gates (admin-only write, broad
  read); validation (empty `daysOfWeek`, out-of-range day, malformed
  `startTime`, non-positive `capacity`); creating a template for a
  non-scheduled catalog item is rejected.
- `slot-availability` returns only templates matching the requested date's
  weekday; `remaining` correctly subtracts posted (not voided) bookings for
  that exact `(template, date)` pair; a booking for a *different* date on
  the same template doesn't affect `remaining`; an inactive template is
  excluded.

Extend `test/bookingServiceItems.test.js`'s existing
`describe('POST /api/bookings/:id/services', ...)` block: adding a
scheduled item without `experienceDate`/`slotTemplateId` is rejected (400);
an invalid/mismatched weekday is rejected (400); a request that exceeds
remaining capacity is rejected (409) with a non-empty `alternatives` array
containing only slots with `remaining >= requiredQuantity`; a request
within capacity succeeds and the inserted row's `experience_slot_label`/
`experience_start_time` match the template's values at insert time (not a
live join); voiding a posted registration frees its capacity for a
subsequent request in the same slot.

New `test/experienceBookingSettings.test.js` covering
`GET`/`PATCH /api/experience-booking-settings`, structurally identical to
`test/reminderSettings.test.js` (defaults, seeded values, admin-only
write, insert-not-update, upper-bound validation).

Playwright: extend the existing service-item coverage in
`tests/e2e/reception-ops-board.spec.js` (outer repo) with one test
selecting a scheduled catalog item, confirming the date/slot fields
appear and the slot `<select>` populates from a mocked
`slot-availability` response; one test for the 409-with-suggestions path,
confirming a suggestion renders and clicking `[chọn]` fills the date/slot
fields. A new small `tests/e2e/experience-settings.spec.js` for the
admin-only settings form on `catalog.html`, matching the shape of the
prior plan's `manager-reminder-settings.spec.js`.

## Out of scope

- Public self-service booking for experiences — staff-assisted only, per
  the confirmed brainstorming decision.
- A roster/attendee-list view per slot occurrence (e.g. "who's coming to
  Saturday's campfire") — genuinely useful as a follow-up, but not asked
  for in this iteration; noted here so it isn't silently forgotten.
- Constraining `experienceDate` to the guest's own `check_in`/`check_out`
  range — deliberately left unconstrained (beyond not being in the past,
  enforced client-side by the `<input type="date">`'s natural browser
  behavior plus the existing booking-status gate that already requires the
  parent booking to be `confirmed`/`checked_in`).
- Any notification (Telegram/Zalo/email) when a slot fills up or frees a
  spot — this feature is synchronous, request-time capacity checking only.
- Editing or voiding an existing scheduled registration's date/slot after
  the fact (e.g. "move this guest from Saturday to Sunday") — the existing
  void-and-re-add flow already covers this without new code, since voiding
  frees capacity and a fresh add re-runs the same validation.
