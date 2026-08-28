# Reception Reminders Dashboard Design

**Date:** 2026-08-28
**Status:** Approved
**Repo target:** `hien-le-garden-v4` (v4)

## Problem

Reception staff open `admin/reception.html` ("Bảng hôm nay") to run the day's
operations, but nothing on that page surfaces work that's falling through
the cracks: a pending request nobody has followed up on, today's arrivals
buried among every other confirmed booking, or a room that's sat dirty for
hours after checkout. All three answers already live in the database — this
feature surfaces them as an actionable reminders section at the top of the
ops board reception already uses every day.

## Goal

Add a "🔔 Nhắc việc hôm nay" section to the top of `reception.html` showing
three reminder lists, each computed from existing data plus one small piece
of new data the codebase doesn't currently track (see below):

1. **Booking chờ quá X giờ chưa có cọc** — pending bookings older than a
   configurable threshold with no deposit recorded.
2. **Khách sắp đến hôm nay** — confirmed bookings checking in today.
3. **Phòng chưa dọn quá X phút sau checkout** — rooms still flagged
   `needs_cleaning` longer than a configurable threshold.

The two thresholds (X hours, X minutes) are admin-configurable, defaulting
to 2 hours and 60 minutes, set via a new section on the existing
`admin/manager.html` config page.

## Schema

New migration `0013_reception_reminders.sql`:

```sql
ALTER TABLE rooms ADD COLUMN needs_cleaning_since TEXT;

CREATE TABLE reminder_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_deposit_hours INTEGER NOT NULL DEFAULT 2,
  cleaning_minutes INTEGER NOT NULL DEFAULT 60,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

INSERT INTO reminder_settings (pending_deposit_hours, cleaning_minutes, updated_at)
VALUES (2, 60, '2026-08-28T00:00:00Z');
```

`needs_cleaning_since` is nullable (no `CHECK`), matching the established
convention for `ALTER TABLE`-added columns in this codebase.
`reminder_settings` follows the same single-row, insert-a-new-row-on-update
pattern already used by `notification_settings` — reading the latest row
via `ORDER BY id DESC LIMIT 1` — rather than an in-place `UPDATE`, keeping a
lightweight history of threshold changes for free.

## `needs_cleaning_since` write sites

Exactly two existing sites currently write `rooms.needs_cleaning` (confirmed
by a repo-wide search — no other file touches this column):

- **`functions/api/bookings/[id]/check-out.js`**: when the batch sets
  `needs_cleaning = 1`, it now also sets `needs_cleaning_since = <now ISO
  timestamp>` in the same `UPDATE`.
- **`functions/api/rooms/[id]/clean.js`**: when it sets `needs_cleaning =
  0`, it now also sets `needs_cleaning_since = NULL` in the same `UPDATE`.

No other behavior in either endpoint changes.

## `lib/receptionReminders.js`

New module, structured like the existing `lib/dashboardMetrics.js`. Exports
one function:

```js
export async function getReminders(env)
```

Steps:

1. Read the current thresholds: `SELECT pending_deposit_hours,
   cleaning_minutes FROM reminder_settings ORDER BY id DESC LIMIT 1`. If no
   row exists (defensive — the migration always seeds one, but the code
   does not assume it), fall back to `{ pendingDepositHours: 2,
   cleaningMinutes: 60 }` in JS, matching this codebase's established
   defensive-fallback style (e.g. `getMonthSummary`'s 0%-refund fallback
   when `cancellation_policy_tier` is empty).
2. Compute `now = new Date()` and two cutoff ISO timestamps:
   `depositCutoff = new Date(now.getTime() - pendingDepositHours *
   3600000).toISOString()` and `cleaningCutoff = new Date(now.getTime() -
   cleaningMinutes * 60000).toISOString()`.
3. **`pendingNoDeposit`**:
   ```sql
   SELECT id, guest_name AS guestName, phone, created_at AS createdAt
   FROM bookings
   WHERE status = 'pending' AND deposit_amount = 0 AND created_at < ?
   ORDER BY created_at ASC
   ```
   bound to `depositCutoff`. Each row gets an added `hoursWaiting` field
   computed in JS: `Math.floor((now - Date.parse(createdAt)) / 3600000)`.
4. **`arrivingToday`**:
   ```sql
   SELECT id, guest_name AS guestName, phone, room_type AS roomType, check_in AS checkIn
   FROM bookings
   WHERE status = 'confirmed' AND check_in = ?
   ORDER BY guest_name ASC
   ```
   bound to today's date in `Asia/Ho_Chi_Minh`
   (`now.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' })`,
   matching `todayISO()`'s exact formatting already used in
   `admin/reception.js` and `getTodaySnapshot`).
5. **`roomsNotCleaned`**:
   ```sql
   SELECT id, name, room_type AS roomType, needs_cleaning_since AS needsCleaningSince
   FROM rooms
   WHERE is_active = 1 AND needs_cleaning = 1 AND needs_cleaning_since IS NOT NULL AND needs_cleaning_since < ?
   ORDER BY needs_cleaning_since ASC
   ```
   bound to `cleaningCutoff`. Each row gets an added `minutesWaiting` field:
   `Math.floor((now - Date.parse(needsCleaningSince)) / 60000)`.
6. Return:
   ```js
   { pendingNoDeposit, arrivingToday, roomsNotCleaned,
     thresholds: { pendingDepositHours, cleaningMinutes } }
   ```

The `needs_cleaning_since IS NOT NULL` guard in step 5 exists because a room
can theoretically have `needs_cleaning = 1` with a `NULL`
`needs_cleaning_since` if it was flagged before this migration ran (a
one-time historical gap) — such a room is simply never flagged by this
reminder rather than crashing on a null-date comparison; it still shows up
in the existing room-status grid as needing cleaning.

## Endpoints

### `GET /api/reception/reminders`

New file `functions/api/reception/reminders.js`.
`requireAuth(request, env, ['reception', 'manager', 'admin', 'observer'])`
— same viewer set as the rest of the reception ops board. Calls
`getReminders(env)` and returns its result as JSON, `200`.

### `GET /api/reminder-settings`

New file `functions/api/reminder-settings.js`, `onRequestGet`.
`requireAuth(request, env, ['reception', 'manager', 'admin', 'observer'])`.
Returns the latest `reminder_settings` row as
`{ pendingDepositHours, cleaningMinutes, updatedAt }` (falling back to the
same `{2, 60}` default as `getReminders` if the table is ever empty, with
`updatedAt: null` in that case).

### `PATCH /api/reminder-settings`

Same file, `onRequestPatch`. `requireAuth(request, env, ['admin'])` —
matches this codebase's established convention for admin-config writes
(`catalog`, `cancellation-policy`). Body: `{ pendingDepositHours,
cleaningMinutes }`, both required, each validated as
`Number.isInteger(x) && x > 0` (400 `"Số giờ/phút phải là số nguyên dương"`
otherwise — one combined message is fine since both fields share the same
rule). On success, inserts a new row (not an `UPDATE`) with
`updated_by = auth.username`, `updated_at = now`, then returns
`{ ok: true }`, `200`.

## Frontend

### `admin/reception.html` / `admin/reception.js`

New markup right after the existing `<p id="opsError">` and before the "+
Tạo đặt phòng mới" section:

```html
<h2>🔔 Nhắc việc hôm nay</h2>
<div id="remindersSection"></div>
```

`admin/reception.js`:
- `loadReminders()` fetches `/api/reception/reminders` and renders into
  `#remindersSection`. Added to `refreshAll()`'s existing `Promise.all([...])`
  alongside the other loaders, so reminders refresh whenever bookings or
  rooms change (a deposit gets recorded, a room gets marked cleaned, a
  booking gets confirmed).
- Rendering: three sub-lists, each with a heading showing its count (e.g.
  "Chờ cọc quá 2 giờ (3)") and a short line per item:
  - Pending-no-deposit: `<guestName> — <phone> — chờ <hoursWaiting> giờ`
  - Arriving today: `<guestName> — <phone> — <roomTypeLabel>` (reusing the
    existing `ROOM_TYPE_LABELS` map already defined in `reception.js`)
  - Rooms not cleaned: `<name> — <roomTypeLabel> — <minutesWaiting> phút`
  - A sub-list with zero items is omitted entirely (no empty heading).
  - When all three lists are empty, `#remindersSection` shows one line:
    "✅ Không có việc cần nhắc."
- No action buttons on these reminder rows in this iteration — they are
  informational only; reception acts on the existing booking/room cards
  further down the page. (Explicitly out of scope, see below.)

### `admin/manager.html` / `admin/manager.js`

New section, added after the existing `notifySettingsSection` div:

```html
<div id="reminderSettingsSection" class="hidden">
  <h2>Ngưỡng nhắc việc</h2>
  <form id="reminderSettingsForm">
    <label>Booking chờ quá (giờ) chưa có cọc
      <input type="number" name="pendingDepositHours" min="1" required />
    </label>
    <label>Phòng chưa dọn quá (phút) sau checkout
      <input type="number" name="cleaningMinutes" min="1" required />
    </label>
    <button type="submit">Lưu ngưỡng</button>
    <p id="reminderSettingsError" class="error"></p>
  </form>
</div>
```

`admin/manager.js`:
- The IIFE that currently gates `policyForm` /  `giftInventorySection` /
  `notifySettingsSection` visibility behind `currentRole === 'manager'`
  is **not** modified — that pre-existing manager-only gating is unrelated
  to this feature and out of scope to fix here. This new section gets its
  own independent gate: `if (currentRole === 'admin') { show
  reminderSettingsSection; loadReminderSettings(); }`, matching its
  endpoint's actual `['admin']`-only write access (showing the form to a
  non-admin would only produce a 403 on submit).
- `loadReminderSettings()`: `GET /api/reminder-settings`, populates the two
  number inputs with the current values.
- Form submit handler: `PATCH /api/reminder-settings` with the two number
  values (`Number(...)` from the form), shows
  `body.error` in `#reminderSettingsError` on failure, otherwise re-runs
  `loadReminderSettings()` to reflect the saved values.

## Testing

New `test/receptionReminders.test.js` (mirrors
`test/dashboardMetrics.test.js`'s structure) covering `getReminders`:

- Empty state: no bookings, no rooms needing cleaning → all three arrays
  empty.
- `pendingNoDeposit`: a pending booking older than the threshold with
  `deposit_amount = 0` appears; one younger than the threshold does not; one
  with a nonzero `deposit_amount` does not, even if old; a `confirmed`
  booking (not `pending`) does not, regardless of deposit or age.
- `arrivingToday`: a `confirmed` booking with `check_in` = today appears; a
  `confirmed` booking checking in tomorrow does not; a `pending` booking
  checking in today does not (not yet confirmed).
- `roomsNotCleaned`: a room with `needs_cleaning = 1` and
  `needs_cleaning_since` older than the threshold appears; one younger than
  the threshold does not; one with `needs_cleaning = 0` does not regardless
  of `needs_cleaning_since`; one with `needs_cleaning = 1` and a `NULL`
  `needs_cleaning_since` does not (the historical-gap guard).
- Threshold respect: changing `reminder_settings` (insert a new row with
  different values) changes which rows the same fixture data produces —
  proves the function reads the configured thresholds, not hardcoded ones.
- Fallback: with `reminder_settings` deliberately emptied
  (`DELETE FROM reminder_settings`), `getReminders` still runs using the
  `{2, 60}` JS-level default rather than erroring.

New `test/receptionRemindersEndpoint.test.js` covering
`GET /api/reception/reminders`: auth roles (200 for
reception/manager/admin/observer, 401 unauthenticated), and that the
response shape matches `getReminders`'s return value.

New `test/reminderSettings.test.js` covering
`GET`/`PATCH /api/reminder-settings`:
- `GET` returns the seeded defaults (2, 60) with no prior writes; 200 for
  all four roles; 401 unauthenticated.
- `PATCH` as admin updates the values, and a subsequent `GET` reflects
  them; 403 for manager/reception/observer; 401 unauthenticated; 400 for a
  non-integer or non-positive value in either field; a successful `PATCH`
  inserts a new row rather than mutating the seeded one (row count grows).

Extend the existing check-out/clean test coverage
(`test/bookingLifecycle.test.js` for check-out,
`test/roomsEndpoints.test.js` for clean) with one assertion each confirming
`needs_cleaning_since` is set/cleared alongside `needs_cleaning`.

Playwright: one new `tests/e2e/reception-reminders.spec.js` in the outer
repo mocking `/api/reception/reminders` and asserting the three reminder
lists render on `reception.html`, plus the empty-state message when all
three are empty. One new test appended to the existing manager-dashboard-
adjacent config coverage (or a small addition to
`tests/e2e/manager-dashboard.spec.js` if it already covers `manager.html`
— otherwise a new small spec) covering the admin-only reminder-settings
form: visible and editable for admin, absent for manager/reception.

## Out of scope

- Any action buttons on the reminder rows themselves (e.g. a "call now" or
  "mark cleaned" shortcut directly from the reminder list) — reception
  already has those actions on the existing cards/grid further down the
  page; this feature is a summary/pointer, not a new action surface.
- Notification delivery (push, Telegram, email) when a reminder threshold
  is crossed — this is a passive on-page summary only, refreshed the same
  way the rest of the ops board refreshes (on load and after mutations).
- Historical/audit trail of past reminder-threshold breaches.
- Any change to the pre-existing `currentRole === 'manager'`-only gating of
  the other sections on `manager.html` — that gap (excluding `admin` from
  those existing sections) is unrelated to this feature and untouched.
