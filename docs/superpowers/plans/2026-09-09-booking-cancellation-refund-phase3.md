# Booking Cancellation Refund (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `confirmed` booking is cancelled, actually move the computed
refund into Sổ thu chi (`finance_transactions`) immediately, instead of only
computing a suggestion — closing the final gap in the 3-phase revenue
reconciliation roadmap (Phases 1 and 2 are shipped in production).

**Architecture:** Extend the existing `POST /api/bookings/:id/cancel`
endpoint rather than adding a new one — this is settlement of an existing
action, not a new resource. Follows the same "close/settle creates the
ledger entry in the same request" pattern Phase 2's checkout endpoint
already established, and reuses Phase 2's `hoan_coc` expense category.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS admin
frontend (no build step, no bundler — `admin/*.js` hand-duplicates small
formulas from server-side files, same pattern Phase 2 already used for
`ROOM_TYPE_PRICES`).

**Spec:** `docs/superpowers/specs/2026-09-09-booking-cancellation-refund-phase3-design.md`

## Global Constraints

- The refund percentage policy itself is unchanged — same
  `cancellation_policy_tier` lookup, same `daysBeforeCheckin` formula, same
  `Math.round(deposit_amount * refundPercentApplied / 100)`.
- The refund is recorded immediately when cancellation succeeds — no
  separate "confirm refund paid" step.
- Category: reuse `hoan_coc` ("Hoàn cọc", expense — already exists from
  Phase 2). Distinguish by note text only: `"Hoàn cọc huỷ đặt phòng — <guest_name>"`.
  No new category.
- `finance_transactions.amount` has `CHECK (amount > 0)` — a 0% refund
  creates no row at all.
- `confirmed → cancelled` needs the same race-guard shape as Phase 2's
  checkout: batch the status update conditioned on `status = 'confirmed'`,
  check `meta.changes === 0`, clean up any `finance_transactions` row
  already created in that request on a lost race, same cleanup in a catch
  block for any other failure.
- Services attached to the cancelled booking (paid or pending) are never
  touched by this plan — confirmed out of scope.
- Mandatory server-side permission checks; client-side gating is UX only.
  No new role — same `reception`/`manager`/`admin` access `cancel.js`
  already has.
- Both repos stay on `main` directly (no feature branch), matching this
  project's established convention.

---

### Task 1: Migration 0035 — new columns on `bookings`

**Files:**
- Create: `v4/migrations/0035_cancellation_refund.sql`
- Test: `v4/test/migrations.test.js` (append a new `describe` block)

**Interfaces:**
- Produces: `bookings.refund_finance_transaction_id` (INTEGER, nullable, FK
  to `finance_transactions.id`), `bookings.cancel_refund_payment_method`
  (TEXT, nullable). Both read/written by Task 2.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE bookings ADD COLUMN refund_finance_transaction_id INTEGER REFERENCES finance_transactions(id);
ALTER TABLE bookings ADD COLUMN cancel_refund_payment_method TEXT;
```

Save to `v4/migrations/0035_cancellation_refund.sql`.

- [ ] **Step 2: Write the failing test**

Append to `v4/test/migrations.test.js` (after the existing
`describe('migration 0034', ...)` block, following that block's exact
style):

```js
describe('migration 0035', () => {
  it('adds refund_finance_transaction_id to bookings, defaulting to NULL, linkable to a real transaction', async () => {
    const bookingInsertNoLink = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest M35', '0900000036', 'circle', '2026-09-09', '2026-09-10', 'confirmed', 'website', '2026-09-09T00:00:00Z')`
    ).run();
    const rowNoLink = await env.DB.prepare(`SELECT refund_finance_transaction_id FROM bookings WHERE id = ?`).bind(bookingInsertNoLink.meta.last_row_id).first();
    expect(rowNoLink.refund_finance_transaction_id).toBeNull();

    const txInsert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('expense', 'hoan_coc', 50000, '2026-09-09', 'confirmed', 'system', '2026-09-09T00:00:00Z')`
    ).run();
    const bookingInsertLinked = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at, refund_finance_transaction_id) VALUES ('Test Guest M35b', '0900000037', 'circle', '2026-09-09', '2026-09-10', 'cancelled', 'website', '2026-09-09T00:00:00Z', ?)`
    ).bind(txInsert.meta.last_row_id).run();
    const rowLinked = await env.DB.prepare(`SELECT refund_finance_transaction_id FROM bookings WHERE id = ?`).bind(bookingInsertLinked.meta.last_row_id).first();
    expect(rowLinked.refund_finance_transaction_id).toBe(txInsert.meta.last_row_id);
  });

  it('adds cancel_refund_payment_method to bookings, defaulting to NULL', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest M35c', '0900000038', 'circle', '2026-09-09', '2026-09-10', 'confirmed', 'website', '2026-09-09T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT cancel_refund_payment_method FROM bookings WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.cancel_refund_payment_method).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `v4/`): `npx vitest run test/migrations.test.js -t "migration 0035"`
Expected: FAIL — columns don't exist yet.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add migrations/0035_cancellation_refund.sql test/migrations.test.js
git commit -m "feat: add cancellation refund tracking columns to bookings"
```

---

### Task 2: `POST /api/bookings/:id/cancel` — record the refund into Sổ thu chi

**Files:**
- Modify: `v4/functions/api/bookings/[id]/cancel.js`
- Test: `v4/test/bookingLifecycle.test.js`

**Interfaces:**
- Consumes: `finance_categories` row `hoan_coc` (Phase 2, already exists);
  `bookings.refund_finance_transaction_id`/`.cancel_refund_payment_method`
  (Task 1).
- Produces: response shape unchanged — `{ ok: true, refundPercentApplied, refundAmount }`.
  Task 3's client never reads `refundFinanceTransactionId` back (nothing
  needs it, matching the same reasoning Phase 2 applied to its own
  analogous fields).

- [ ] **Step 1: Read the current files in full**

`v4/functions/api/bookings/[id]/cancel.js` and
`v4/functions/api/bookings/[id]/check-out.js` (the race-guard/cleanup
pattern this task follows, simplified to at most one finance row instead
of up to three) — confirm the exact current text before editing.

- [ ] **Step 2: Write the failing tests**

In `v4/test/bookingLifecycle.test.js`, the existing
`describe('POST /api/bookings/:id/cancel', ...)` block (lines ~326-491)
has 11 tests. **Two of them currently send no `paymentMethod` despite
having a nonzero `refundAmount`** and will start failing once the
payment-method requirement lands — fix both in place (do not replace the
whole block; the other 9 tests use a 0-deposit/0%-refund booking and are
unaffected):

Find this test (around line 354):
```js
  it('writes an audit_log row with the refund summary and reason', async () => {
    await confirmBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/confirm`, managerToken, { rooms: [{ roomType: 'circle', roomId: circleRoomId }] }), env, params: { id: String(pendingBookingId) } });
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (0, 50, 'seed', '2026-08-01T00:00:00Z')`).run();
    await env.DB.prepare(`UPDATE bookings SET deposit_amount = 100000 WHERE id = ?`).bind(pendingBookingId).run();

    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${pendingBookingId}/cancel`, managerToken, { reason: 'Khách đổi lịch' }),
      env,
      params: { id: String(pendingBookingId) },
    });
```
Change the `authedPost(...)` call's body to add `paymentMethod`:
```js
      request: authedPost(`https://x/api/bookings/${pendingBookingId}/cancel`, managerToken, { reason: 'Khách đổi lịch', paymentMethod: 'cash' }),
```
(Nothing else in this test changes — it still asserts `response.status).toBe(200)` and the `audit_log` row's content, which is unaffected by this plan.)

Find this test (around line 455):
```js
  it('applies the matching tier at the exact day-boundary', async () => {
    ...
    const booking = await createConfirmedBookingWithDeposit({ checkIn: checkInStr, depositAmount: 300000 });
    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken),
      env,
      params: { id: String(booking.id) },
    });
```
Change the `authedPost(...)` call to add a body:
```js
    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken, { paymentMethod: 'transfer' }),
      env,
      params: { id: String(booking.id) },
    });
```

Then append these new tests immediately before the describe block's
closing `});` (after the existing `'falls back to 0% below the smallest
configured tier'` test):

```js
  it('creates a finance_transactions expense row and links it on the booking when refundAmount > 0', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (0, 50, 'seed', '2026-08-01T00:00:00Z')`).run();
    const booking = await createConfirmedBookingWithDeposit({ checkIn: '2099-01-15', depositAmount: 200000 });

    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(booking.id) },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.refundAmount).toBe(100000);

    const row = await env.DB.prepare(`SELECT refund_finance_transaction_id, cancel_refund_payment_method FROM bookings WHERE id = ?`).bind(booking.id).first();
    expect(row.refund_finance_transaction_id).not.toBeNull();
    expect(row.cancel_refund_payment_method).toBe('cash');

    const tx = await env.DB.prepare(`SELECT type, category, amount, note FROM finance_transactions WHERE id = ?`).bind(row.refund_finance_transaction_id).first();
    expect(tx).toEqual({ type: 'expense', category: 'hoan_coc', amount: 100000, note: 'Hoàn cọc huỷ đặt phòng — Refund Test Guest' });
  });

  it('creates no finance_transactions row and leaves the new columns NULL when refundAmount is 0', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    const booking = await createConfirmedBookingWithDeposit({ checkIn: '2099-01-15', depositAmount: 200000 });
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();

    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken),
      env,
      params: { id: String(booking.id) },
    });
    expect(response.status).toBe(200);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    expect(after.n).toBe(before.n);

    const row = await env.DB.prepare(`SELECT refund_finance_transaction_id, cancel_refund_payment_method FROM bookings WHERE id = ?`).bind(booking.id).first();
    expect(row.refund_finance_transaction_id).toBeNull();
    expect(row.cancel_refund_payment_method).toBeNull();
  });

  it('rejects cancellation needing a payment method when none is supplied (400)', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (0, 50, 'seed', '2026-08-01T00:00:00Z')`).run();
    const booking = await createConfirmedBookingWithDeposit({ checkIn: '2099-01-15', depositAmount: 200000 });

    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken),
      env,
      params: { id: String(booking.id) },
    });
    expect(response.status).toBe(400);

    const row = await env.DB.prepare(`SELECT status FROM bookings WHERE id = ?`).bind(booking.id).first();
    expect(row.status).toBe('confirmed');
  });

  it('on a lost race (booking already cancelled), returns 400 and creates no finance_transactions row', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    await env.DB.prepare(`INSERT INTO cancellation_policy_tier (min_days_before_checkin, refund_percent, updated_by, updated_at) VALUES (0, 50, 'seed', '2026-08-01T00:00:00Z')`).run();
    const booking = await createConfirmedBookingWithDeposit({ checkIn: '2099-01-15', depositAmount: 200000 });
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(booking.id).run();

    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(booking.id) },
    });
    expect(response.status).toBe(400); // status guard fires first — same documented limitation as Phase 2's checkout race test; a genuinely concurrent race is exercised in production, not by a single-threaded test
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    expect(after.n).toBe(before.n);
  });

  it('leaves a service item on the cancelled booking untouched, paid or pending', async () => {
    await env.DB.exec('DELETE FROM cancellation_policy_tier');
    const booking = await createConfirmedBookingWithDeposit({ checkIn: '2099-01-15', depositAmount: 0 });
    await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status) VALUES (?, 'Dịch vụ pending', 50000, 1, 50000, 'posted', 'system', '2026-08-01T00:00:00Z', 'pending')`
    ).bind(booking.id).run();
    await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status) VALUES (?, 'Dịch vụ paid', 30000, 1, 30000, 'posted', 'system', '2026-08-01T00:00:00Z', 'paid')`
    ).bind(booking.id).run();

    const response = await cancelBooking({
      request: authedPost(`https://x/api/bookings/${booking.id}/cancel`, receptionToken),
      env,
      params: { id: String(booking.id) },
    });
    expect(response.status).toBe(200);

    const rows = await env.DB.prepare(`SELECT name, status, payment_status FROM booking_service_items WHERE booking_id = ? ORDER BY id`).bind(booking.id).all();
    expect(rows.results).toEqual([
      { name: 'Dịch vụ pending', status: 'posted', payment_status: 'pending' },
      { name: 'Dịch vụ paid', status: 'posted', payment_status: 'paid' },
    ]);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/bookingLifecycle.test.js -t "cancel"`
Expected: FAIL — the two fixed-in-place tests fail with 400 (no
`paymentMethod` support exists yet, this pre-check doesn't exist), the new
tests fail because none of the new columns/behavior exist yet.

- [ ] **Step 4: Implement**

Replace the full contents of `v4/functions/api/bookings/[id]/cancel.js`
with:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

function daysBeforeCheckin(checkIn) {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [y, m, d] = checkIn.split('-').map(Number);
  const checkInUTC = Date.UTC(y, m - 1, d);
  return Math.floor((checkInUTC - todayUTC) / 86400000);
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    body = {};
  }
  body = body || {};
  const { reason, paymentMethod } = body;

  const booking = await env.DB.prepare(`SELECT id, status, check_in, deposit_amount, guest_name FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }
  if (booking.status !== 'confirmed') {
    return jsonError('Chỉ có thể huỷ đặt phòng đã xác nhận', 400);
  }

  const daysBefore = daysBeforeCheckin(booking.check_in);
  const tier = await env.DB.prepare(
    `SELECT refund_percent FROM cancellation_policy_tier WHERE min_days_before_checkin <= ? ORDER BY min_days_before_checkin DESC LIMIT 1`
  ).bind(daysBefore).first();
  const refundPercentApplied = tier ? tier.refund_percent : 0;
  const refundAmount = Math.round((booking.deposit_amount || 0) * refundPercentApplied / 100);

  if (refundAmount > 0 && !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    return jsonError('Vui lòng chọn hình thức thanh toán', 400);
  }
  const resolvedPaymentMethod = refundAmount > 0 ? paymentMethod : null;

  let newValue = `cancelled — hoàn ${refundPercentApplied}% (${refundAmount} đ)`;
  if (reason) newValue += ` — Lý do: ${reason}`;
  const now = new Date().toISOString();

  let refundFinanceTransactionId = null;
  try {
    if (refundAmount > 0) {
      const insert = await env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
         VALUES ('expense', 'hoan_coc', ?, ?, ?, 'confirmed', ?, ?)`
      ).bind(refundAmount, `Hoàn cọc huỷ đặt phòng — ${booking.guest_name}`, now.slice(0, 10), auth.username, now).run();
      refundFinanceTransactionId = insert.meta.last_row_id;
    }

    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE bookings SET status = 'cancelled', cancel_reason = ?, refund_percent_applied = ?, refund_finance_transaction_id = ?, cancel_refund_payment_method = ? WHERE id = ? AND status = 'confirmed'`
      ).bind(reason || null, refundPercentApplied, refundFinanceTransactionId, resolvedPaymentMethod, params.id),
      env.DB.prepare(
        `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
         VALUES ('booking_cancel', 'booking', ?, ?, 'confirmed', ?, ?, ?)`
      ).bind(booking.id, booking.guest_name, newValue, auth.username, now),
    ]);

    if (results[0].meta.changes === 0) {
      // Thao tác khác vừa xử lý đặt phòng này giữa lúc đọc và ghi (race condition).
      if (refundFinanceTransactionId) {
        await env.DB.prepare(`DELETE FROM finance_transactions WHERE id = ?`).bind(refundFinanceTransactionId).run();
      }
      return jsonError('Đặt phòng này vừa được xử lý bởi thao tác khác, vui lòng tải lại', 409);
    }

    return new Response(
      JSON.stringify({ ok: true, refundPercentApplied, refundAmount }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Lỗi bất ngờ giữa lúc ghi dòng hoàn cọc và cập nhật đặt phòng (vd: lỗi DB tạm thời).
    if (refundFinanceTransactionId) {
      try {
        await env.DB.prepare(`DELETE FROM finance_transactions WHERE id = ?`).bind(refundFinanceTransactionId).run();
      } catch (cleanupErr) {
        // Bỏ qua lỗi dọn dẹp — không để nó che lấp lỗi gốc bên dưới.
      }
    }
    return jsonError('Có lỗi khi huỷ đặt phòng, vui lòng thử lại', 500);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `v4/`): `npx vitest run test/bookingLifecycle.test.js`
Expected: all tests in the file pass (existing confirm/reject/check-in/
check-out describes unaffected; the extended cancel describe's 16 tests —
11 existing, 2 fixed in place, 5 new — all pass).

- [ ] **Step 6: Commit**

```bash
git add functions/api/bookings/\[id\]/cancel.js test/bookingLifecycle.test.js
git commit -m "feat: record cancellation refund into Sổ thu chi immediately"
```

---

### Task 3: Client — cancellation confirmation dialog

**Files:**
- Modify: `v4/admin/reception.js`
- Modify: `v4/admin/reception.html`

**Interfaces:**
- Consumes: `GET /api/cancellation-policy` (existing endpoint, returns
  `[{id, minDaysBeforeCheckin, refundPercent, label, displayOrder}]`
  ordered `min_days_before_checkin DESC`); `POST /api/bookings/:id/cancel`
  (Task 2, body `{ paymentMethod }`, response `{ok, refundPercentApplied, refundAmount}` — unused by the client, matching Phase 2's own client not
  reading its analogous checkout response fields); booking fields already
  present from `GET /api/bookings` (`checkIn`, `depositAmount`).
- Produces: no new exports — UI wiring only.

- [ ] **Step 1: Read the current relevant sections**

`v4/admin/reception.js`: `loadArrivals()` (~line 774) and
`loadUpcomingConfirmed()` (~line 786-793) — both currently wire "Hủy đặt
phòng" directly to `cancelBooking(b.id)`; the existing `cancelBooking(id)`
function (~line 853-873, to be removed); `openCheckoutDialog`/
`closeCheckoutDialog`/`computeCheckoutPreview` and their two event
listeners (~line 875-963, Phase 2 — the template this task mirrors).
`v4/admin/reception.html`: the `#checkoutOverlay` markup (~line 162-174) —
mirror its exact structure for the new `#cancelOverlay`, inserted right
after it, before the `<script src="/admin/reception.js">` line.

- [ ] **Step 2: Add the cancel dialog markup**

In `v4/admin/reception.html`, immediately after the `</div>` that closes
`#checkoutOverlay` (before `<script src="/admin/reception.js"></script>`),
add:

```html
  <div id="cancelOverlay" class="confirm-overlay hidden">
    <div class="confirm-box">
      <h3>Huỷ đặt phòng</h3>
      <p id="cancelSummary"></p>
      <div id="cancelPaymentFields" class="hidden">
        <label class="checkbox-label"><input type="radio" id="cancelCash" name="cancelPaymentMethod" value="cash" /> 💵 Tiền mặt</label>
        <label class="checkbox-label"><input type="radio" id="cancelTransfer" name="cancelPaymentMethod" value="transfer" /> 🏦 Chuyển khoản</label>
      </div>
      <button id="cancelSubmitBtn">Xác nhận Huỷ</button>
      <button id="cancelCancelBtn" class="btn-secondary">Đóng</button>
      <p id="cancelError" class="error"></p>
    </div>
  </div>
```

- [ ] **Step 3: Replace the old `cancelBooking` function with the dialog logic**

In `v4/admin/reception.js`, delete the existing:

```js
async function cancelBooking(id) {
  let response;
  try {
    response = await fetch(`/api/bookings/${id}/cancel`, { method: 'POST' });
  } catch (err) {
    showOpsError('Có lỗi xảy ra');
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    showOpsError(body.error || 'Có lỗi xảy ra');
    return;
  }
  const result = await response.json().catch(() => ({}));
  if (result.refundAmount > 0) {
    showOpsError(`Đã huỷ đặt phòng. Hoàn cọc đề xuất: ${result.refundPercentApplied}% (~${result.refundAmount.toLocaleString('vi-VN')} đ)`);
  } else {
    showOpsError('');
  }
  await refreshAll();
}
```

and replace it with:

```js
function daysBeforeCheckin(checkIn) {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [y, m, d] = checkIn.split('-').map(Number);
  const checkInUTC = Date.UTC(y, m - 1, d);
  return Math.floor((checkInUTC - todayUTC) / 86400000);
}

let cancellingBooking = null;
let cachedCancellationTiers = null;

async function loadCancellationTiers() {
  if (cachedCancellationTiers) return cachedCancellationTiers;
  try {
    const response = await fetch('/api/cancellation-policy');
    cachedCancellationTiers = response.ok ? await response.json() : [];
  } catch (err) {
    cachedCancellationTiers = [];
  }
  return cachedCancellationTiers;
}

function findRefundPercent(tiers, daysBefore) {
  const match = tiers.find((t) => t.minDaysBeforeCheckin <= daysBefore);
  return match ? match.refundPercent : 0;
}

async function openCancelDialog(booking) {
  cancellingBooking = booking;
  document.getElementById('cancelError').textContent = '';
  document.getElementById('cancelCash').checked = false;
  document.getElementById('cancelTransfer').checked = false;

  const tiers = await loadCancellationTiers();
  const daysBefore = daysBeforeCheckin(booking.checkIn);
  const refundPercent = findRefundPercent(tiers, daysBefore);
  const refundAmount = Math.round((booking.depositAmount || 0) * refundPercent / 100);

  const summary = document.getElementById('cancelSummary');
  const fields = document.getElementById('cancelPaymentFields');
  if (refundAmount > 0) {
    summary.textContent = `Hoàn cọc: ${refundPercent}% (${formatVnd(refundAmount)})`;
    fields.classList.remove('hidden');
  } else {
    summary.textContent = 'Không hoàn cọc (theo chính sách huỷ hiện tại).';
    fields.classList.add('hidden');
  }

  document.getElementById('cancelOverlay').classList.remove('hidden');
}

function closeCancelDialog() {
  cancellingBooking = null;
  document.getElementById('cancelOverlay').classList.add('hidden');
}

document.getElementById('cancelCancelBtn').addEventListener('click', closeCancelDialog);

document.getElementById('cancelSubmitBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('cancelError');
  errorEl.textContent = '';

  const fieldsVisible = !document.getElementById('cancelPaymentFields').classList.contains('hidden');
  let paymentMethod = null;
  if (fieldsVisible) {
    paymentMethod = document.getElementById('cancelCash').checked ? 'cash' : (document.getElementById('cancelTransfer').checked ? 'transfer' : null);
    if (!paymentMethod) {
      errorEl.textContent = 'Vui lòng chọn hình thức thanh toán';
      return;
    }
  }

  let response;
  try {
    response = await fetch(`/api/bookings/${cancellingBooking.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentMethod }),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi xảy ra';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi xảy ra';
    return;
  }
  closeCancelDialog();
  showOpsError('');
  await refreshAll();
});
```

- [ ] **Step 4: Rewire both "Hủy đặt phòng" buttons**

In `loadArrivals()`, change:
```js
    cancelBtn.addEventListener('click', () => cancelBooking(b.id));
```
to:
```js
    cancelBtn.addEventListener('click', () => openCancelDialog(b));
```

In `loadUpcomingConfirmed()`, change the identical line the same way.

- [ ] **Step 5: Self-consistency check**

Re-read both edited files in full. Confirm: every `document.getElementById('cancel*')` call in the new JS has a matching id in the HTML edit and
vice versa; no remaining reference to `cancelBooking(` anywhere in the
file (`grep -n "cancelBooking(" admin/reception.js` should return nothing);
no id collision with `#confirmOverlay`'s or `#checkoutOverlay`'s ids.
There is no automated test harness for `admin/*.js` in this repo (no build
step, no jsdom) — this static re-read is the correct verification method
here, matching Phase 2's Task 5.

- [ ] **Step 6: Commit**

```bash
git add admin/reception.js admin/reception.html
git commit -m "feat: cancellation confirmation dialog with refund settlement"
```

---

### Task 4: E2e coverage (repo ngoài)

**Files:**
- Modify: `tests/e2e/reception-ops-board.spec.js`

**Interfaces:**
- Consumes: `#cancelOverlay`, `#cancelSummary`, `#cancelPaymentFields`,
  `#cancelCash`, `#cancelTransfer`, `#cancelSubmitBtn`, `#cancelError`
  (Task 3); `GET /api/cancellation-policy`, `POST /api/bookings/:id/cancel`
  (Task 2).

- [ ] **Step 1: Read the current test's exact content**

Read `tests/e2e/reception-ops-board.spec.js` in full, specifically the
test `'cancelling a booking with a deposit shows the computed refund
suggestion'` (around line 140) — confirm its current exact text before
replacing it (this plan was written against the file as it stood when
Phase 2 shipped; re-verify nothing else changed it since).

- [ ] **Step 2: Replace the existing test**

This test currently drives the *old* immediate-fire flow (click → fire →
read `#opsError`) and mocks a booking with no `depositAmount` field and no
`/api/cancellation-policy` route — none of that works against the new
dialog. Replace the entire test (same name, same file location) with:

```js
  test('cancelling a booking with a deposit shows the computed refund suggestion', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, guestName: 'Trần Thị B', phone: '0900000009', roomType: 'circle', checkIn: '2099-02-01', checkOut: '2099-02-03', status: 'confirmed', depositAmount: 300000 }]) })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/cancellation-policy', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: null, displayOrder: 0 }, { id: 2, minDaysBeforeCheckin: 0, refundPercent: 0, label: null, displayOrder: 1 }]) })
    );
    let posted = null;
    await page.route('**/api/bookings/9/cancel', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, refundPercentApplied: 100, refundAmount: 300000 }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trần Thị B');
    await page.click('#upcomingConfirmedList >> text=Hủy đặt phòng');

    await expect(page.locator('#cancelOverlay')).toBeVisible();
    await expect(page.locator('#cancelSummary')).toContainText('Hoàn cọc: 100%');
    await expect(page.locator('#cancelPaymentFields')).toBeVisible();

    await page.click('#cancelSubmitBtn');
    await expect(page.locator('#cancelError')).toHaveText('Vui lòng chọn hình thức thanh toán');
    expect(posted).toBeNull();

    await page.check('#cancelCash');
    await page.click('#cancelSubmitBtn');
    await expect(page.locator('#cancelOverlay')).toBeHidden();
    expect(posted).toEqual({ paymentMethod: 'cash' });
  });
```

(`checkIn: '2099-02-01'` is far enough in the future that `daysBefore` always exceeds the 7-day tier threshold regardless of when this test runs — matches this file's existing convention of using fixed far-future dates for cases where the exact gap doesn't matter, only that it's "far".)

- [ ] **Step 3: Add a new test for the 0%-tier direct-submit case**

Immediately after the test from Step 2, add:

```js
  test('cancelling a booking under the 0%-refund tier submits directly, no payment method needed', async ({ page }) => {
    const nearCheckIn = new Date();
    nearCheckIn.setUTCDate(nearCheckIn.getUTCDate() + 1);
    const checkInStr = nearCheckIn.toISOString().slice(0, 10);

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 10, guestName: 'Lê Văn C', phone: '0900000010', roomType: 'circle', checkIn: checkInStr, checkOut: '2099-02-03', status: 'confirmed', depositAmount: 200000 }]) })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/cancellation-policy', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: null, displayOrder: 0 }, { id: 2, minDaysBeforeCheckin: 0, refundPercent: 0, label: null, displayOrder: 1 }]) })
    );
    let posted = null;
    await page.route('**/api/bookings/10/cancel', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, refundPercentApplied: 0, refundAmount: 0 }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Lê Văn C');
    await page.click('#upcomingConfirmedList >> text=Hủy đặt phòng');

    await expect(page.locator('#cancelSummary')).toContainText('Không hoàn cọc');
    await expect(page.locator('#cancelPaymentFields')).toBeHidden();

    await page.click('#cancelSubmitBtn');
    await expect(page.locator('#cancelOverlay')).toBeHidden();
    expect(posted).toEqual({ paymentMethod: null });
  });
```

- [ ] **Step 4: Run the tests**

Run (from the outer repo root):
`npx playwright test tests/e2e/reception-ops-board.spec.js --project=v4`
Expected: both cancellation tests pass. Any other pre-existing failures in
this file are out of scope for this task (none are expected to be
introduced by this change, since only the one cancellation test's
mocking/assertions changed and one new test was added — nothing else in
the file references `#cancelOverlay` or the old `cancelBooking` flow).

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reception-ops-board.spec.js
git commit -m "test: e2e coverage for cancellation refund settlement dialog"
```
