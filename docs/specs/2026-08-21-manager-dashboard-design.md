# Manager Dashboard (Tổng quan số liệu) — Design Spec

**Repo:** `hien-le-garden-v4` (unified frontend + backend, see `BACKEND.md`)
**Builds on:** `docs/specs/2026-08-21-booking-and-daily-ops-design.md` (the
`bookings`/`rooms` tables this spec reads from — no schema changes)

## Problem

`admin/manager.html` exists today, but despite its name it is only the
promo-policy configuration screen (discount %, validity window, gift
inventory) — there is no page anywhere that answers a manager's basic
operating questions: how full are we right now, how full were we this
month, roughly how much revenue did confirmed stays represent, and where
are bookings coming from. That information only exists by manually
reading through the reception ops board's raw lists or querying D1
directly.

This spec adds a single new manager-only page, `admin/dashboard.html`,
backed by one new aggregation endpoint. `admin/manager.html` (promo
config) is untouched — the dashboard is a separate page linked from the
admin nav, not a replacement.

## Scope

In scope: room-operations metrics only — occupancy, estimated revenue,
booking status funnel, booking source breakdown, today's snapshot. Other
metric families considered and deferred (see "Out of scope").

## Permissions

| Capability | manager | reception | public |
|---|---|---|---|
| View the dashboard | ✅ | ❌ | ❌ |

Manager-only, unlike the ops board (`reception` + `manager`) — this is
business-level reporting, not a task staff need to act on day-to-day.
Enforced via `requireAuth(request, env, ['manager'])`, the same pattern
already used by `functions/api/policy.js` and `functions/api/gift-
inventory.js`.

## "This month" scope: overlap-based, not creation-based

Every monthly figure on the dashboard is computed over the same set of
bookings: those that **overlap** the selected month's date range —
`check_in < month_end AND check_out > month_start` — regardless of when
the booking was created or which month `check_in` itself falls in. A
stay from 2026-07-30 to 2026-08-02 is included in both July's and
August's figures.

- **Occupancy and revenue** count only the nights that actually fall
  inside the selected month (a cross-month stay contributes 2 nights to
  July, 2 to August — not 4 to either).
- **Status funnel and source breakdown** count the whole booking once
  per overlapping month (the same cross-month stay above appears once
  in July's counts and once in August's) — a manager reading "August"
  wants to know every booking active in August, not only ones that
  started there.

This was chosen over anchoring everything to `check_in`'s month, which
is simpler SQL but silently drops a cross-month stay's tail from the
month it actually occupies, undercounting real occupancy.

## Endpoint

`GET /api/dashboard/summary?month=YYYY-MM` — manager-only.

- `month` optional, defaults to the current month computed in
  `Asia/Ho_Chi_Minh` (not UTC — the same timezone bug fixed in
  `admin/reception.js`'s `todayISO()` during the previous plan must not
  be reintroduced here). Malformed `month` (doesn't match `YYYY-MM`) →
  `400` with a Vietnamese error message, following the `jsonError`
  convention used throughout `functions/api/`.
- Response shape:

```json
{
  "month": "2026-08",
  "today": {
    "roomsOccupied": 9,
    "roomsNeedCleaning": 2,
    "roomsEmpty": 5,
    "arrivalsToday": 3,
    "departuresToday": 2
  },
  "monthSummary": {
    "occupancyRate": 0.62,
    "estimatedRevenueVnd": 18400000,
    "statusFunnel": {
      "pending": 4,
      "confirmed": 6,
      "checked_in": 3,
      "checked_out": 20,
      "cancelled": 2
    },
    "sourceBreakdown": {
      "website": 14,
      "phone": 9,
      "zalo": 8,
      "walk_in": 4
    }
  }
}
```

- `today.roomsOccupied` / `roomsNeedCleaning` / `roomsEmpty` reuse the
  exact same per-room status computation already implemented in
  `functions/api/rooms/index.js` (`needs_cleaning` > `occupied` >
  `empty`), summed into counts rather than returned per-room — no new
  status logic, just an aggregation over the existing one.
- `arrivalsToday` / `departuresToday` reuse the same date filters as the
  ops board's own "Hôm nay" section (`check_in = today` for arrivals,
  `check_out <= today AND status = 'checked_in'` for departures — the
  latter using the `<=` fix from the previous plan's final review so an
  overdue departure still counts).
- `occupancyRate` = (sum of in-month nights across overlapping
  `confirmed`/`checked_in`/`checked_out` bookings) ÷ (count of active
  rooms × days in the selected month). `pending` and `cancelled`
  bookings never occupy a room, so they're excluded from the numerator
  — matching `getAvailability`'s existing precedent for what counts as
  "actually booked" (`lib/bookingAvailability.js`).
- `estimatedRevenueVnd` = sum, over the same booking set as
  `occupancyRate`, of (in-month nights × `ROOM_TYPES[booking.room_type]
  .priceVnd`) — reuses the existing `lib/roomTypes.js` price table
  verbatim, no new pricing data. Explicitly an estimate: this codebase
  has no payment/invoice table, so it is nights actually stayed ×
  list price, not a record of money collected. The dashboard UI labels
  it "Doanh thu ước tính" (estimated), never plain "Doanh thu", so it is
  never mistaken for bookkeeping.
- `statusFunnel` counts every overlapping booking (all 5 statuses,
  including `pending`/`cancelled`) grouped by `status` — the one figure
  on this dashboard that intentionally includes non-occupying bookings,
  because its purpose is showing the manager the full demand picture,
  not just realized occupancy.
- `sourceBreakdown` counts overlapping bookings grouped by `source`,
  excluding `cancelled` (a cancelled booking's original source isn't a
  useful signal for "where is business coming from").

## `admin/dashboard.html`

New page, manager-only (redirects to `login.html` on `401`, matching
every other admin page's existing pattern — see `admin/reception.js`'s
auth-check block for the pattern to copy). Linked from the nav on every
existing admin page (`reception.html`, `manager.html`, `customers.html`,
`templates.html`, `users.html`), and itself links back to
`manager.html` (Cấu hình) and `reception.html` (Vận hành hôm nay),
matching the existing ad hoc two-link nav convention already used
between those pages.

Layout, top to bottom:

1. **Hôm nay** — five small stat cards: Đang có khách / Cần dọn / Còn
   trống / Khách đến hôm nay / Khách đi hôm nay.
2. **Tháng [tên tháng]** — a month `<input type="month">` control
   (defaults to current month, refetches on change) above:
   - Tỷ lệ lấp đầy, shown as a percentage.
   - Doanh thu ước tính, formatted as VND (reusing whatever VND
     formatting helper already exists in `admin/reception.js` for
     price display, not a new one).
   - Phễu trạng thái — a simple 5-row table (status label → count),
     Vietnamese labels reusing the same status→label mapping already
     established in `admin/reception.js`.
   - Nguồn đặt phòng — a simple 4-row table (source label → count).
3. No charts, no client-side date-range picker beyond the single month
   input — first version stays table/number-card based, matching this
   admin section's existing plain-HTML-table aesthetic (`admin/
   customers.html`, `admin/reception.html`) rather than introducing a
   charting dependency for one page.

On fetch failure (network error or non-`200`), show an inline error
message and no stale/partial numbers — same try/catch-wrapped-fetch
convention established for `admin/reception.js` and the booking modal
during the previous plan's final-review fix wave.

## Testing

`test/dashboardEndpoint.test.js` — Vitest + `@cloudflare/vitest-pool-
workers`, following this backend's existing per-endpoint test-file
convention. Explicit coverage for:

- Today snapshot numbers against seeded rooms/bookings fixtures.
- A booking spanning two months, asserting nights split correctly
  between the two months' `occupancyRate`/`estimatedRevenueVnd`, and
  that it's counted once in each month's `statusFunnel`/
  `sourceBreakdown`.
- `pending` and `cancelled` bookings excluded from `occupancyRate`/
  `estimatedRevenueVnd` but present in `statusFunnel`.
- `cancelled` excluded from `sourceBreakdown`.
- Malformed `month` → `400`; omitted `month` → defaults to current
  Vietnam-timezone month.
- `401` for `reception`-role and unauthenticated requests (manager-only,
  unlike every other booking/room endpoint from the previous plan).

`admin/dashboard.html`/`.js` gets one Playwright e2e spec (sibling
`hien-le-garden-landing` repo, mocking `GET /api/dashboard/summary` via
`page.route()`, following the `reception-ops-board.spec.js` pattern) —
renders the mocked numbers correctly, and redirects to `login.html` when
the auth check fails — matching every other admin page's existing e2e
coverage.

## Out of scope (explicitly deferred)

- Charts/graphs, trend-over-time views, custom date-range picker beyond
  a single month — noted in "Layout" above.
- Guest/satisfaction metrics (avg rating, promo redemption rate, repeat
  guests) and staff-activity metrics (messages sent, who's handling
  what) — both considered during brainstorming and explicitly declined
  in favor of room-operations metrics only for this iteration. Natural
  candidates for a later, additive dashboard section.
- Real revenue/payment tracking — this codebase has no payment or
  invoice table; `estimatedRevenueVnd` remains list-price × nights
  stayed, not collected money, until a payments feature exists.
- A cancel endpoint for `confirmed` bookings (flagged as a gap by the
  previous plan's final review, still open) — unrelated to this
  dashboard, tracked separately.
