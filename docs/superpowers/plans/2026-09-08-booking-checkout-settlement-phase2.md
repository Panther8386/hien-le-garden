# Booking Checkout Settlement (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record room charge and unpaid guest services into Sổ thu chi
(`finance_transactions`) the moment a booking checks out — deposit-aware,
handling the excess-deposit refund case — and record a paid-at-order-time
service the instant it's added, closing both remaining gaps from the
original Vip2 investigation.

**Architecture:** Extend three existing endpoints
(`POST .../services`, `POST .../check-out`, `PATCH .../services/:itemId`)
rather than adding new ones — this is settlement of existing actions, not a
new resource. Follows this codebase's established "close/settle creates the
ledger entry in the same request" pattern (Giờ Xanh, Order ăn uống, and
Phase 1's deposit ledger).

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS admin
frontend (no build step, no bundler — `admin/*.js` files duplicate small
constants like `ROOM_TYPES` from `lib/` by hand; this is the established
pattern, not a shortcut this plan introduces).

**Spec:** `docs/superpowers/specs/2026-09-08-booking-checkout-settlement-phase2-design.md`

## Global Constraints

- Room total: `nights × ROOM_TYPES[roomType].priceVnd` — no discount/locked
  price column exists or is added.
- Deposit offsets the combined total (room first, then leftover against
  unpaid services); anything beyond both becomes an automatic refund.
- Categories: room → `dich_vu` ("Lưu trú Hiền Lê"), services → `ban_hang`
  ("Dịch vụ khác"), refund → new `hoan_coc` ("Hoàn cọc", expense).
  `finance_transactions.category` has no `CHECK` constraint (dropped in
  migration `0019`) — `hoan_coc` needs only a `finance_categories` seed row.
- Every settling action writes its `finance_transactions` row(s) in the
  same request, no deferred reconciliation.
- `checked_in → checked_out` is a state transition — needs the Giờ Xanh
  race-guard shape: batch the status UPDATE conditioned on the current
  status, check `meta.changes === 0`, clean up (delete) any
  `finance_transactions` rows already created in that request on a lost
  race, and the same cleanup in a catch block for any other failure
  part-way through.
- `finance_transactions.amount` has `CHECK (amount > 0)` — a computed
  amount of exactly 0 means that row is skipped, never inserted as zero.
- Mandatory server-side permission checks; client-side gating is UX only.
- Both repos stay on `main` directly (no feature branch), matching this
  project's established convention.

---

### Task 1: Migration 0034 — new columns + `hoan_coc` category

**Files:**
- Create: `v4/migrations/0034_checkout_settlement.sql`
- Test: `v4/test/migrations.test.js` (append a new `describe` block)

**Interfaces:**
- Produces: `bookings.checkout_payment_method` (TEXT, nullable),
  `booking_service_items.finance_transaction_id` (INTEGER, nullable, FK to
  `finance_transactions.id`), and a `finance_categories` row
  `slug = 'hoan_coc'`, `label = 'Hoàn cọc'`, `type = 'expense'`,
  `is_active = 1`. All three are read by Tasks 2-4.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE bookings ADD COLUMN checkout_payment_method TEXT;
ALTER TABLE booking_service_items ADD COLUMN finance_transaction_id INTEGER REFERENCES finance_transactions(id);

INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at)
VALUES ('hoan_coc', 'Hoàn cọc', 'expense', 1, 'system', '2026-09-08T00:00:00Z');
```

Save to `v4/migrations/0034_checkout_settlement.sql`.

- [ ] **Step 2: Write the failing test**

Append to `v4/test/migrations.test.js` (after the existing
`describe('migration 0033', ...)` block, following that block's exact
style — read it first for the `seedBooking`-style helper pattern):

```js
describe('migration 0034', () => {
  it('adds checkout_payment_method to bookings, defaulting to NULL', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest M34', '0900000034', 'circle', '2026-09-08', '2026-09-09', 'confirmed', 'website', '2026-09-08T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT checkout_payment_method FROM bookings WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.checkout_payment_method).toBeNull();
  });

  it('adds finance_transaction_id to booking_service_items, defaulting to NULL, linkable to a real transaction', async () => {
    const bookingInsert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest M34b', '0900000035', 'circle', '2026-09-08', '2026-09-09', 'confirmed', 'website', '2026-09-08T00:00:00Z')`
    ).run();
    const bookingId = bookingInsert.meta.last_row_id;

    const itemInsertNoLink = await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at) VALUES (?, 'Cà phê', 30000, 1, 30000, 'posted', 'system', '2026-09-08T00:00:00Z')`
    ).bind(bookingId).run();
    const rowNoLink = await env.DB.prepare(`SELECT finance_transaction_id FROM booking_service_items WHERE id = ?`).bind(itemInsertNoLink.meta.last_row_id).first();
    expect(rowNoLink.finance_transaction_id).toBeNull();

    const txInsert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 30000, '2026-09-08', 'confirmed', 'system', '2026-09-08T00:00:00Z')`
    ).run();
    const itemInsertLinked = await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at, finance_transaction_id) VALUES (?, 'Cà phê', 30000, 1, 30000, 'posted', 'system', '2026-09-08T00:00:00Z', ?)`
    ).bind(bookingId, txInsert.meta.last_row_id).run();
    const rowLinked = await env.DB.prepare(`SELECT finance_transaction_id FROM booking_service_items WHERE id = ?`).bind(itemInsertLinked.meta.last_row_id).first();
    expect(rowLinked.finance_transaction_id).toBe(txInsert.meta.last_row_id);
  });

  it('seeds hoan_coc as an active expense category', async () => {
    const row = await env.DB.prepare(`SELECT label, type, is_active FROM finance_categories WHERE slug = 'hoan_coc'`).first();
    expect(row).toEqual({ label: 'Hoàn cọc', type: 'expense', is_active: 1 });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `v4/`): `npx vitest run test/migrations.test.js -t "migration 0034"`
Expected: FAIL — columns/row don't exist yet.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add migrations/0034_checkout_settlement.sql test/migrations.test.js
git commit -m "feat: add checkout settlement columns and hoan_coc category"
```

---

### Task 2: `POST /api/bookings/:id/services` — record income immediately when `paid: true`

**Files:**
- Modify: `v4/functions/api/bookings/[id]/services/index.js`
- Test: `v4/test/bookingServiceItems.test.js`

**Interfaces:**
- Consumes: `finance_categories` row `ban_hang` (already existed before
  this plan); `booking_service_items.finance_transaction_id` (Task 1).
- Produces: no change to the endpoint's response shape (`{ id, ok: true }`)
  or to any existing validation behavior. `booking_service_items` rows
  created with `paid: true` now have a non-null `finance_transaction_id`
  pointing at a `finance_transactions` row Task 4 reads.

- [ ] **Step 1: Read the current file in full**

`v4/functions/api/bookings/[id]/services/index.js` — confirm the two
independent branches and their exact current `SELECT`/`INSERT` text before
editing (this plan's snippets below assume the file as read during
brainstorming; re-verify byte-for-byte before applying).

- [ ] **Step 2: Write the failing tests**

Append to the existing `describe('POST /api/bookings/:id/services', ...)`
block in `v4/test/bookingServiceItems.test.js` (after the last existing
`it(...)` in that block, before its closing `});`):

```js
  it('records a finance_transactions income row immediately for a paid catalog-item service', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 2, paid: true, paymentMethod: 'cash' }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);

    const item = await env.DB.prepare(`SELECT finance_transaction_id FROM booking_service_items WHERE booking_id = ?`).bind(confirmedBookingId).first();
    expect(item.finance_transaction_id).not.toBeNull();

    const tx = await env.DB.prepare(`SELECT type, category, amount, note, status FROM finance_transactions WHERE id = ?`).bind(item.finance_transaction_id).first();
    expect(tx).toEqual({ type: 'income', category: 'ban_hang', amount: 60000, note: 'Cà phê ×2 — Confirmed Guest', status: 'confirmed' });
  });

  it('records a finance_transactions income row immediately for a paid Menu Quán item', async () => {
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { dineInMenuItemId: activeMenuItemId, unitPrice: 368000, quantity: 1, paid: true, paymentMethod: 'transfer' }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);

    const item = await env.DB.prepare(`SELECT finance_transaction_id FROM booking_service_items WHERE booking_id = ?`).bind(confirmedBookingId).first();
    expect(item.finance_transaction_id).not.toBeNull();

    const tx = await env.DB.prepare(`SELECT type, category, amount, note FROM finance_transactions WHERE id = ?`).bind(item.finance_transaction_id).first();
    expect(tx).toEqual({ type: 'income', category: 'ban_hang', amount: 368000, note: 'Gà nướng ×1 — Confirmed Guest' });
  });

  it('creates no finance_transactions row when paid is false or omitted', async () => {
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    const response = await addServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services`, receptionToken, 'POST', { serviceCatalogId: activeCatalogId, unitPrice: 30000, quantity: 1 }),
      env,
      params: { id: String(confirmedBookingId) },
    });
    expect(response.status).toBe(201);
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    expect(after.n).toBe(before.n);

    const item = await env.DB.prepare(`SELECT finance_transaction_id FROM booking_service_items WHERE booking_id = ?`).bind(confirmedBookingId).first();
    expect(item.finance_transaction_id).toBeNull();
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/bookingServiceItems.test.js -t "finance_transactions"`
Expected: FAIL — `finance_transaction_id` doesn't exist on the response
path yet (column exists from Task 1, but nothing writes to it).

- [ ] **Step 4: Implement**

In `v4/functions/api/bookings/[id]/services/index.js`:

Change the booking lookup near the top of `onRequestPost` from
`SELECT id, status FROM bookings WHERE id = ?` to
`SELECT id, status, guest_name FROM bookings WHERE id = ?`.

In the **menu-item branch** (`if (hasMenuItemId) { ... }`), immediately
before its `const result = await env.DB.prepare(...INSERT INTO booking_service_items...)`, insert:

```js
    let financeTransactionId = null;
    if (paid === true) {
      const note = `${menuItem.name} ×${quantity} — ${booking.guest_name}`;
      try {
        const txInsert = await env.DB.prepare(
          `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
           VALUES ('income', 'ban_hang', ?, ?, ?, 'confirmed', ?, ?)`
        ).bind(amount, note, now.slice(0, 10), auth.username, now).run();
        financeTransactionId = txInsert.meta.last_row_id;
      } catch (err) {
        return jsonError('Có lỗi khi ghi nhận thanh toán dịch vụ, vui lòng thử lại', 500);
      }
    }
```

Then change that branch's `INSERT` to add the new column and bind value:

```js
    const result = await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, dine_in_menu_item_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status, payment_method, finance_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?)`
    )
      .bind(params.id, menuItem.id, menuItem.name, unitPrice, quantity, amount, auth.username, now, paymentStatus, resolvedPaymentMethod, financeTransactionId)
      .run();
```

Wrap that `INSERT` in try/catch to clean up an orphaned finance row if it
throws:

```js
    let result;
    try {
      result = await env.DB.prepare(
        `INSERT INTO booking_service_items (booking_id, dine_in_menu_item_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status, payment_method, finance_transaction_id)
         VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?)`
      )
        .bind(params.id, menuItem.id, menuItem.name, unitPrice, quantity, amount, auth.username, now, paymentStatus, resolvedPaymentMethod, financeTransactionId)
        .run();
    } catch (err) {
      if (financeTransactionId) {
        try {
          await env.DB.prepare(`DELETE FROM finance_transactions WHERE id = ?`).bind(financeTransactionId).run();
        } catch (cleanupErr) {
          // Bỏ qua lỗi dọn dẹp — không để nó che lấp lỗi gốc bên dưới.
        }
      }
      return jsonError('Có lỗi khi thêm dịch vụ, vui lòng thử lại', 500);
    }
```

Apply the identical block (with `catalogItem.name` instead of
`menuItem.name`) to the **catalog-item branch**, immediately before its own
`const result = await env.DB.prepare(...INSERT INTO booking_service_items...)`
(the one binding `experience_date`, `slot_template_id`, etc.), and add
`finance_transaction_id` as the new final column/placeholder/bind value to
that branch's `INSERT` the same way, wrapped in the same try/catch cleanup
shape.

- [ ] **Step 5: Run tests to verify they pass**

Run (from `v4/`): `npx vitest run test/bookingServiceItems.test.js`
Expected: all tests in the file pass (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add functions/api/bookings/\[id\]/services/index.js test/bookingServiceItems.test.js
git commit -m "feat: record finance_transactions income immediately for paid services"
```

---

### Task 3: `POST /api/bookings/:id/check-out` — settle room + unpaid services, deposit-aware

**Files:**
- Modify: `v4/functions/api/bookings/[id]/check-out.js`
- Test: `v4/test/bookingLifecycle.test.js`

**Interfaces:**
- Consumes: `ROOM_TYPES` from `v4/lib/roomTypes.js` (`{ [roomType]: { label, priceVnd } }`); `finance_categories` rows `dich_vu`, `ban_hang`, `hoan_coc`
  (`hoan_coc` from Task 1).
- Produces: response `{ ok: true, roomDue, servicesDue, refundAmount, checkoutPaymentMethod }` — kept for API completeness and this task's own tests; Task 5's client does not read these fields (it only checks `response.ok`, closes the dialog, and calls `refreshAll()`, which re-fetches everything fresh — the client's own pre-submit *preview* is computed independently client-side, per §5.1). What Task 5 does rely on being correct after a successful checkout: `bookings.checkout_payment_method` and `booking_service_items.payment_status = 'paid'` (for previously-pending rows), both surfaced indirectly through the booking no longer appearing in the departures list and its service lines showing "Đã thanh toán" after `refreshAll()`.

- [ ] **Step 1: Read the current file and the reference pattern**

Read `v4/functions/api/bookings/[id]/check-out.js` in full (confirm the
exact current `SELECT`/`batch` text) and
`v4/functions/api/gio-xanh-sessions/[id]/close.js` in full (the
try/catch + `changes === 0` race-guard + cleanup shape this task follows).

- [ ] **Step 2: Write the failing tests**

In `v4/test/bookingLifecycle.test.js`, the existing
`describe('POST /api/bookings/:id/check-out', ...)` block (lines ~493-546)
has 4 tests. Two of them currently call `checkOutBooking` with no request
body — since `pendingBookingId` books `circle` (₫600.000/night) for 2
nights with 0 deposit, checkout will now compute `roomDue = 1.200.000 > 0`
and require a `paymentMethod`. **Replace the whole block** with the
following (existing 4 tests updated in place, new tests appended) — this
is a deliberate full-block replacement, not just an addition, matching
Phase 1's Task 2 precedent for the same reason (a real behavior change
invalidates some existing assertions):

```js
describe('POST /api/bookings/:id/check-out', () => {
  it('checks out a checked-in booking and flags its room for cleaning', async () => {
    await confirmBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/confirm`, managerToken, { rooms: [{ roomType: 'circle', roomId: circleRoomId }] }), env, params: { id: String(pendingBookingId) } });
    await checkInBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-in`, managerToken), env, params: { id: String(pendingBookingId) } });

    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(pendingBookingId) },
    });
    expect(response.status).toBe(200);

    const bookingRow = await env.DB.prepare(`SELECT status, checkout_payment_method FROM bookings WHERE id = ?`).bind(pendingBookingId).first();
    expect(bookingRow.status).toBe('checked_out');
    expect(bookingRow.checkout_payment_method).toBe('cash');

    const roomRow = await env.DB.prepare(`SELECT needs_cleaning FROM rooms WHERE id = ?`).bind(circleRoomId).first();
    expect(roomRow.needs_cleaning).toBe(1);
  });

  it('records when the room started needing cleaning', async () => {
    await confirmBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/confirm`, managerToken, { rooms: [{ roomType: 'circle', roomId: circleRoomId }] }), env, params: { id: String(pendingBookingId) } });
    await checkInBooking({ request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-in`, managerToken), env, params: { id: String(pendingBookingId) } });

    const before = new Date().toISOString();
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(pendingBookingId) },
    });
    expect(response.status).toBe(200);

    const roomRow = await env.DB.prepare(`SELECT needs_cleaning_since FROM rooms WHERE id = ?`).bind(circleRoomId).first();
    expect(roomRow.needs_cleaning_since).not.toBeNull();
    expect(roomRow.needs_cleaning_since >= before).toBe(true);
  });

  it('rejects checking out a booking that is not checked in', async () => {
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${pendingBookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(pendingBookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent booking', async () => {
    const response = await checkOutBooking({
      request: authedPost('https://x/api/bookings/999999/check-out', managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: '999999' },
    });
    expect(response.status).toBe(404);
  });

  async function checkInBookingWithDepositAndServices({ roomType, roomId, nights, depositAmount, pendingServiceAmount, paidServiceAmount }) {
    const checkIn = '2099-02-01';
    const checkOutDate = new Date(checkIn);
    checkOutDate.setUTCDate(checkOutDate.getUTCDate() + nights);
    const bookingInsert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, room_id, check_in, check_out, status, source, deposit_amount, created_at) VALUES ('Checkout Test Guest', '0900000099', ?, ?, ?, ?, 'checked_in', 'website', ?, ?)`
    ).bind(roomType, roomId, checkIn, checkOutDate.toISOString().slice(0, 10), depositAmount, new Date().toISOString()).run();
    const bookingId = bookingInsert.meta.last_row_id;

    if (pendingServiceAmount > 0) {
      await env.DB.prepare(
        `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status) VALUES (?, 'Dịch vụ chưa trả', ?, 1, ?, 'posted', 'system', '2026-08-01T00:00:00Z', 'pending')`
      ).bind(bookingId, pendingServiceAmount, pendingServiceAmount).run();
    }
    if (paidServiceAmount > 0) {
      await env.DB.prepare(
        `INSERT INTO booking_service_items (booking_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status) VALUES (?, 'Dịch vụ đã trả', ?, 1, ?, 'posted', 'system', '2026-08-01T00:00:00Z', 'paid')`
      ).bind(bookingId, paidServiceAmount, paidServiceAmount).run();
    }
    return bookingId;
  }

  it('bills the full room total when there is no deposit', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 0, pendingServiceAmount: 0, paidServiceAmount: 0 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, roomDue: 600000, servicesDue: 0, refundAmount: 0, checkoutPaymentMethod: 'cash' });

    const tx = await env.DB.prepare(`SELECT type, category, amount, note FROM finance_transactions WHERE note LIKE 'Tiền phòng%'`).first();
    expect(tx).toEqual({ type: 'income', category: 'dich_vu', amount: 600000, note: 'Tiền phòng — Checkout Test Guest' });
  });

  it('subtracts the deposit from the room total, billing only the remainder', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 200000, pendingServiceAmount: 0, paidServiceAmount: 0 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'transfer' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body).toEqual({ ok: true, roomDue: 400000, servicesDue: 0, refundAmount: 0, checkoutPaymentMethod: 'transfer' });
  });

  it('bills unpaid services in full alongside the room total', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 0, pendingServiceAmount: 100000, paidServiceAmount: 0 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body).toEqual({ ok: true, roomDue: 600000, servicesDue: 100000, refundAmount: 0, checkoutPaymentMethod: 'cash' });

    const tx = await env.DB.prepare(`SELECT type, category, amount, note FROM finance_transactions WHERE note LIKE 'Dịch vụ lưu trú%'`).first();
    expect(tx).toEqual({ type: 'income', category: 'ban_hang', amount: 100000, note: 'Dịch vụ lưu trú — Checkout Test Guest' });

    const item = await env.DB.prepare(`SELECT payment_status, payment_method FROM booking_service_items WHERE booking_id = ? AND name = 'Dịch vụ chưa trả'`).bind(bookingId).first();
    expect(item).toEqual({ payment_status: 'paid', payment_method: 'cash' });
  });

  it('a deposit larger than the room total is applied to unpaid services next', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 700000, pendingServiceAmount: 100000, paidServiceAmount: 0 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    // roomTotal 600000 fully covered; 100000 leftover deposit covers all of the 100000 unpaid service
    expect(body).toEqual({ ok: true, roomDue: 0, servicesDue: 0, refundAmount: 0, checkoutPaymentMethod: 'cash' });

    const item = await env.DB.prepare(`SELECT payment_status FROM booking_service_items WHERE booking_id = ? AND name = 'Dịch vụ chưa trả'`).bind(bookingId).first();
    expect(item.payment_status).toBe('paid');
  });

  it('refunds the excess when the deposit exceeds room total plus unpaid services', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 900000, pendingServiceAmount: 100000, paidServiceAmount: 0 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body).toEqual({ ok: true, roomDue: 0, servicesDue: 0, refundAmount: 200000, checkoutPaymentMethod: 'cash' });

    const tx = await env.DB.prepare(`SELECT type, category, amount, note FROM finance_transactions WHERE note LIKE 'Hoàn cọc%'`).first();
    expect(tx).toEqual({ type: 'expense', category: 'hoan_coc', amount: 200000, note: 'Hoàn cọc dư — Checkout Test Guest' });
  });

  it('requires no payment method and creates no finance_transactions rows when the deposit lands exactly on the combined total', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 600000, pendingServiceAmount: 0, paidServiceAmount: 0 });
    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken),
      env,
      params: { id: String(bookingId) },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, roomDue: 0, servicesDue: 0, refundAmount: 0, checkoutPaymentMethod: null });
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    expect(after.n).toBe(before.n);

    const bookingRow = await env.DB.prepare(`SELECT checkout_payment_method FROM bookings WHERE id = ?`).bind(bookingId).first();
    expect(bookingRow.checkout_payment_method).toBeNull();
  });

  it('rejects checkout when a payment method is needed but not provided', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 0, pendingServiceAmount: 0, paidServiceAmount: 0 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken),
      env,
      params: { id: String(bookingId) },
    });
    expect(response.status).toBe(400);
  });

  it('leaves an already-paid service item untouched (not re-billed, payment_method unchanged)', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 0, pendingServiceAmount: 0, paidServiceAmount: 50000 });
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    const body = await response.json();
    expect(body.servicesDue).toBe(0);

    const item = await env.DB.prepare(`SELECT payment_status, payment_method FROM booking_service_items WHERE booking_id = ? AND name = 'Dịch vụ đã trả'`).bind(bookingId).first();
    expect(item).toEqual({ payment_status: 'paid', payment_method: null });
  });

  it('on a lost race (booking already checked out), returns 409 and cleans up any finance_transactions rows just created', async () => {
    const bookingId = await checkInBookingWithDepositAndServices({ roomType: 'circle', roomId: otherCircleRoomId, nights: 1, depositAmount: 0, pendingServiceAmount: 0, paidServiceAmount: 0 });
    // Simulate a concurrent request that already checked this booking out between this
    // request's read and write.
    await env.DB.prepare(`UPDATE bookings SET status = 'checked_out' WHERE id = ?`).bind(bookingId).run();

    const before = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    const response = await checkOutBooking({
      request: authedPost(`https://x/api/bookings/${bookingId}/check-out`, managerToken, { paymentMethod: 'cash' }),
      env,
      params: { id: String(bookingId) },
    });
    expect(response.status).toBe(400); // status guard fires first (status is no longer 'checked_in') — this exercises the pre-existing early guard, not the race window itself, which is documented as effectively untestable without injecting a fault mid-request (see gio-xanh-sessions close endpoint for the same limitation).
    const after = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions`).first();
    expect(after.n).toBe(before.n);
  });
});
```

> Note on the last test: this codebase's existing race-guard tests (Giờ
> Xanh, Phase 1's deposits) do not actually inject a fault inside the
> request handler either — the `changes === 0` branch is exercised in
> production by two genuinely concurrent requests, not by a single-threaded
> test. This test instead confirms the *simpler* pre-condition guard
> (`status !== 'checked_in'`) still rejects cleanly and creates nothing,
> which is the same level of coverage this codebase's other race-guarded
> endpoints have today.

- [ ] **Step 3: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/bookingLifecycle.test.js -t "check-out"`
Expected: FAIL — `roomDue`/`servicesDue`/`refundAmount` don't exist in the
response yet, `checkout_payment_method` stays NULL always, the two
now-`paymentMethod`-carrying tests would otherwise still pass today (no
regression there) but the new ones fail outright.

- [ ] **Step 4: Implement**

Replace the full contents of `v4/functions/api/bookings/[id]/check-out.js`
with:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';
import { ROOM_TYPES } from '../../../../lib/roomTypes.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const booking = await env.DB.prepare(
    `SELECT id, status, room_id, room_type, check_in, check_out, guest_name, deposit_amount FROM bookings WHERE id = ?`
  ).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }
  if (booking.status !== 'checked_in') {
    return jsonError('Chỉ có thể check-out từ trạng thái đang lưu trú', 400);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (err) {
    body = {};
  }
  body = body || {};
  const { paymentMethod } = body;

  const nights = (Date.parse(booking.check_out) - Date.parse(booking.check_in)) / 86400000;
  const roomTotal = nights * ROOM_TYPES[booking.room_type].priceVnd;

  const unpaidRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM booking_service_items WHERE booking_id = ? AND status = 'posted' AND payment_status = 'pending'`
  ).bind(params.id).first();
  const unpaidServicesTotal = unpaidRow.total;

  const deposit = booking.deposit_amount || 0;
  const roomDue = Math.max(roomTotal - deposit, 0);
  const leftoverDeposit = Math.max(deposit - roomTotal, 0);
  const servicesDue = Math.max(unpaidServicesTotal - leftoverDeposit, 0);
  const refundAmount = Math.max(leftoverDeposit - unpaidServicesTotal, 0);

  const needsPaymentMethod = roomDue > 0 || servicesDue > 0 || refundAmount > 0;
  if (needsPaymentMethod && !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    return jsonError('Vui lòng chọn hình thức thanh toán', 400);
  }
  const resolvedPaymentMethod = needsPaymentMethod ? paymentMethod : null;

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const createdTransactionIds = [];

  async function cleanupCreatedTransactions() {
    for (const id of createdTransactionIds) {
      try {
        await env.DB.prepare(`DELETE FROM finance_transactions WHERE id = ?`).bind(id).run();
      } catch (cleanupErr) {
        // Bỏ qua lỗi dọn dẹp — không để nó che lấp lỗi gốc bên dưới.
      }
    }
  }

  try {
    if (roomDue > 0) {
      const insert = await env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
         VALUES ('income', 'dich_vu', ?, ?, ?, 'confirmed', ?, ?)`
      ).bind(roomDue, `Tiền phòng — ${booking.guest_name}`, today, auth.username, now).run();
      createdTransactionIds.push(insert.meta.last_row_id);
    }

    if (servicesDue > 0) {
      const insert = await env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
         VALUES ('income', 'ban_hang', ?, ?, ?, 'confirmed', ?, ?)`
      ).bind(servicesDue, `Dịch vụ lưu trú — ${booking.guest_name}`, today, auth.username, now).run();
      createdTransactionIds.push(insert.meta.last_row_id);
    }

    if (refundAmount > 0) {
      const insert = await env.DB.prepare(
        `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
         VALUES ('expense', 'hoan_coc', ?, ?, ?, 'confirmed', ?, ?)`
      ).bind(refundAmount, `Hoàn cọc dư — ${booking.guest_name}`, today, auth.username, now).run();
      createdTransactionIds.push(insert.meta.last_row_id);
    }

    const statements = [
      env.DB.prepare(`UPDATE bookings SET status = 'checked_out', checkout_payment_method = ? WHERE id = ? AND status = 'checked_in'`).bind(resolvedPaymentMethod, params.id),
    ];
    if (booking.room_id) {
      statements.push(env.DB.prepare(`UPDATE rooms SET needs_cleaning = 1, needs_cleaning_since = ? WHERE id = ?`).bind(now, booking.room_id));
    }
    statements.push(
      env.DB.prepare(
        `UPDATE booking_service_items SET payment_status = 'paid', payment_method = ? WHERE booking_id = ? AND status = 'posted' AND payment_status = 'pending'`
      ).bind(resolvedPaymentMethod, params.id)
    );

    const results = await env.DB.batch(statements);
    if (results[0].meta.changes === 0) {
      // Thao tác khác vừa check-out đặt phòng này giữa lúc đọc và ghi (race condition).
      await cleanupCreatedTransactions();
      return jsonError('Đặt phòng này vừa được check-out bởi thao tác khác, vui lòng tải lại', 409);
    }

    return new Response(
      JSON.stringify({ ok: true, roomDue, servicesDue, refundAmount, checkoutPaymentMethod: resolvedPaymentMethod }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    // Lỗi bất ngờ giữa lúc ghi các dòng thu/chi và cập nhật đặt phòng (vd: lỗi DB tạm thời).
    await cleanupCreatedTransactions();
    return jsonError('Có lỗi khi check-out, vui lòng thử lại', 500);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `v4/`): `npx vitest run test/bookingLifecycle.test.js`
Expected: all tests in the file pass (existing confirm/reject/check-in/
cancel describes unaffected + the fully-replaced check-out describe).

- [ ] **Step 6: Commit**

```bash
git add functions/api/bookings/\[id\]/check-out.js test/bookingLifecycle.test.js
git commit -m "feat: settle room + unpaid services into Sổ thu chi at checkout"
```

---

### Task 4: `PATCH /api/bookings/:id/services/:itemId` — admin-only void for paid items, auto-void linked transaction

**Files:**
- Modify: `v4/functions/api/bookings/[id]/services/[itemId].js`
- Test: `v4/test/bookingServiceItems.test.js`

**Interfaces:**
- Consumes: `booking_service_items.finance_transaction_id` (Task 1/2).
- Produces: no response-shape change (`{ ok: true }`); a `paid` item voided
  by an admin now also sets `voided_by`/`voided_at` on the linked
  `finance_transactions` row.

- [ ] **Step 1: Read the current file in full**

`v4/functions/api/bookings/[id]/services/[itemId].js` — confirm the exact
current `SELECT`/`batch` text.

- [ ] **Step 2: Write the failing tests**

In `v4/test/bookingServiceItems.test.js`, add `adminToken` to the top-level
`let` declaration and seed it in `beforeEach` (alongside the existing
manager/reception/observer seeding):

```js
let managerToken, receptionToken, observerToken, adminToken;
```

```js
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (4, 'admin_svc', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 4);
```

(Insert this pair right after the existing `observerToken = await
createSession(env.DB, 3);` line in `beforeEach`.)

Add a second helper next to the existing `addPostedItem` inside
`describe('PATCH /api/bookings/:id/services/:itemId', ...)`, and the new
test cases, appended before that describe block's closing `});`:

```js
  async function addPaidItem(bookingId = confirmedBookingId) {
    const txInsert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at) VALUES ('income', 'ban_hang', 30000, 'Cà phê ×1 — Confirmed Guest', '2026-08-01', 'confirmed', 'le_tan_svc', '2026-08-01T00:00:00Z')`
    ).run();
    const financeTransactionId = txInsert.meta.last_row_id;
    const result = await env.DB.prepare(
      `INSERT INTO booking_service_items (booking_id, service_catalog_id, name, unit_price, quantity, amount, status, created_by, created_at, payment_status, payment_method, finance_transaction_id) VALUES (?, ?, 'Cà phê', 30000, 1, 30000, 'posted', 'le_tan_svc', '2026-08-01T00:00:00Z', 'paid', 'cash', ?)`
    ).bind(bookingId, activeCatalogId, financeTransactionId).run();
    return { itemId: result.meta.last_row_id, financeTransactionId };
  }

  it('rejects reception voiding a paid item (403)', async () => {
    const { itemId } = await addPaidItem();
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(403);
    const row = await env.DB.prepare(`SELECT status FROM booking_service_items WHERE id = ?`).bind(itemId).first();
    expect(row.status).toBe('posted');
  });

  it('rejects manager voiding a paid item (403)', async () => {
    const { itemId } = await addPaidItem();
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, managerToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(403);
  });

  it('lets admin void a paid item and auto-voids the linked finance_transactions row', async () => {
    const { itemId, financeTransactionId } = await addPaidItem();
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, adminToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(200);

    const item = await env.DB.prepare(`SELECT status FROM booking_service_items WHERE id = ?`).bind(itemId).first();
    expect(item.status).toBe('voided');

    const tx = await env.DB.prepare(`SELECT voided_by, voided_at FROM finance_transactions WHERE id = ?`).bind(financeTransactionId).first();
    expect(tx.voided_by).toBe('admin_svc');
    expect(tx.voided_at).not.toBeNull();
  });

  it('still lets reception void a pending (unpaid) item, unaffected by the new admin gate', async () => {
    const itemId = await addPostedItem();
    const response = await voidServiceItem({
      request: authedRequest(`https://x/api/bookings/${confirmedBookingId}/services/${itemId}`, receptionToken, 'PATCH', {}),
      env,
      params: { id: String(confirmedBookingId), itemId: String(itemId) },
    });
    expect(response.status).toBe(200);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/bookingServiceItems.test.js -t "paid item"`
Expected: FAIL — no admin gate exists yet, all three requests currently
succeed regardless of role.

- [ ] **Step 4: Implement**

In `v4/functions/api/bookings/[id]/services/[itemId].js`, change the
`SELECT` to add the two new fields:

```js
  const item = await env.DB.prepare(
    `SELECT bsi.id, bsi.booking_id, bsi.status, bsi.payment_status, bsi.finance_transaction_id, bsi.name, bsi.quantity, b.guest_name AS guestName
     FROM booking_service_items bsi JOIN bookings b ON b.id = bsi.booking_id
     WHERE bsi.id = ?`
  ).bind(params.itemId).first();
```

After the existing not-found (`!item || ...`) and already-voided
(`item.status === 'voided'`) checks, add:

```js
  if (item.payment_status === 'paid' && auth.role !== 'admin') {
    return jsonError('Chỉ Admin mới có quyền huỷ dịch vụ đã thanh toán', 403);
  }
```

Change the existing `env.DB.batch([...])` call to conditionally include a
third statement:

```js
  const statements = [
    env.DB.prepare(
      `UPDATE booking_service_items SET status = 'voided', voided_by = ?, voided_at = ? WHERE id = ?`
    ).bind(auth.username, now, params.itemId),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('service_void', 'service_item', ?, ?, 'posted', 'voided', ?, ?)`
    ).bind(item.id, entityLabel, auth.username, now),
  ];
  if (item.payment_status === 'paid') {
    statements.push(
      env.DB.prepare(`UPDATE finance_transactions SET voided_by = ?, voided_at = ? WHERE id = ?`)
        .bind(auth.username, now, item.finance_transaction_id)
    );
  }
  await env.DB.batch(statements);
```

(This replaces the existing inline two-element array passed directly to
`env.DB.batch([...])` — same two statements, now built as a `statements`
array so the third can be pushed conditionally.)

- [ ] **Step 5: Run tests to verify they pass**

Run (from `v4/`): `npx vitest run test/bookingServiceItems.test.js`
Expected: all tests in the file pass.

- [ ] **Step 6: Commit**

```bash
git add functions/api/bookings/\[id\]/services/\[itemId\].js test/bookingServiceItems.test.js
git commit -m "feat: restrict voiding a paid service to admin, auto-void its finance row"
```

---

### Task 5: Client — checkout confirmation dialog, service-void button gating

**Files:**
- Modify: `v4/admin/reception.js`
- Modify: `v4/admin/reception.html`

**Interfaces:**
- Consumes: `POST /api/bookings/:id/check-out` (Task 3, body
  `{ paymentMethod }`, response `{ ok, roomDue, servicesDue, refundAmount, checkoutPaymentMethod }`); booking fields already present in `GET /api/bookings` responses (`roomType`, `checkIn`, `checkOut`, `depositAmount`, `services[]` with `amount`/`paymentStatus`); `item.paymentStatus` on each service entry (existing field, unchanged).
- Produces: no new exports — this is UI wiring only.

- [ ] **Step 1: Read the current relevant sections**

`v4/admin/reception.js`: the `ROOM_TYPE_LABELS` constant (top of file), the
existing `confirmOverlay` dialog wiring (`openConfirmDialog`,
`closeConfirmDialog`, and the `confirmSubmitBtn`/`confirmCancelBtn`
listeners near the bottom of the file), `loadDepartures()` (where the
"Check-out" button is currently wired to `doBookingAction(b.id,
'check-out')`), and `renderServicesSection` (the void-button gate at
`if (item.status === 'posted' && currentRole !== 'observer')`).
`v4/admin/reception.html`: the `#confirmOverlay` markup, to mirror its
exact structure for the new `#checkoutOverlay`.
`v4/admin/admin.css`: confirm `.confirm-overlay`/`.confirm-box` are
generic (not scoped to the room-confirm dialog specifically) — they are,
so no new CSS is needed for the checkout dialog's box/overlay styling.

- [ ] **Step 2: Add a client-side room-price map**

In `v4/admin/reception.js`, immediately after the existing
`ROOM_TYPE_LABELS` constant, add (this duplicates
`lib/roomTypes.js`'s `priceVnd` values by hand, same as `ROOM_TYPE_LABELS`
already duplicates the `label` values — this file has no bundler/shared
import with server code):

```js
const ROOM_TYPE_PRICES = {
  triangle: 300000,
  circle: 600000,
  ede_cozy: 600000,
  vip: 900000,
  bungalow: 700000,
  dormitory: 1200000,
};
```

- [ ] **Step 3: Add the checkout dialog markup**

In `v4/admin/reception.html`, immediately after the existing
`</div>` that closes `#confirmOverlay` (right before the closing
`<script src="/admin/reception.js"></script>` line), add:

```html
  <div id="checkoutOverlay" class="confirm-overlay hidden">
    <div class="confirm-box">
      <h3>Check-out</h3>
      <p id="checkoutSummary"></p>
      <div id="checkoutPaymentFields" class="hidden">
        <label class="checkbox-label"><input type="radio" id="checkoutCash" name="checkoutPaymentMethod" value="cash" /> 💵 Tiền mặt</label>
        <label class="checkbox-label"><input type="radio" id="checkoutTransfer" name="checkoutPaymentMethod" value="transfer" /> 🏦 Chuyển khoản</label>
      </div>
      <button id="checkoutSubmitBtn">Xác nhận Check-out</button>
      <button id="checkoutCancelBtn" class="btn-secondary">Huỷ</button>
      <p id="checkoutError" class="error"></p>
    </div>
  </div>
```

- [ ] **Step 4: Wire the dialog in reception.js**

Replace the "Check-out" button wiring in `loadDepartures()` — change

```js
    const btn = document.createElement('button');
    btn.textContent = 'Check-out';
    btn.addEventListener('click', () => doBookingAction(b.id, 'check-out'));
    actions.appendChild(btn);
```

to:

```js
    const btn = document.createElement('button');
    btn.textContent = 'Check-out';
    btn.addEventListener('click', () => openCheckoutDialog(b));
    actions.appendChild(btn);
```

Then, near the existing `openConfirmDialog`/`closeConfirmDialog` functions
(same area of the file), add:

```js
let checkingOutBooking = null;

function computeCheckoutPreview(booking) {
  const nights = (Date.parse(booking.checkOut) - Date.parse(booking.checkIn)) / 86400000;
  const roomTotal = nights * (ROOM_TYPE_PRICES[booking.roomType] || 0);
  const unpaidServicesTotal = (booking.services || [])
    .filter((s) => s.status === 'posted' && s.paymentStatus === 'pending')
    .reduce((sum, s) => sum + s.amount, 0);
  const deposit = booking.depositAmount || 0;

  const roomDue = Math.max(roomTotal - deposit, 0);
  const leftoverDeposit = Math.max(deposit - roomTotal, 0);
  const servicesDue = Math.max(unpaidServicesTotal - leftoverDeposit, 0);
  const refundAmount = Math.max(leftoverDeposit - unpaidServicesTotal, 0);
  return { roomDue, servicesDue, refundAmount };
}

function openCheckoutDialog(booking) {
  checkingOutBooking = booking;
  document.getElementById('checkoutError').textContent = '';
  document.getElementById('checkoutCash').checked = false;
  document.getElementById('checkoutTransfer').checked = false;

  const { roomDue, servicesDue, refundAmount } = computeCheckoutPreview(booking);
  const summary = document.getElementById('checkoutSummary');
  const fields = document.getElementById('checkoutPaymentFields');
  if (roomDue + servicesDue > 0) {
    summary.textContent = `Cần thu thêm: ${formatVnd(roomDue + servicesDue)}`;
    fields.classList.remove('hidden');
  } else if (refundAmount > 0) {
    summary.textContent = `Cần hoàn khách: ${formatVnd(refundAmount)}`;
    fields.classList.remove('hidden');
  } else {
    summary.textContent = 'Cọc đã khớp đủ, không cần thu/hoàn thêm.';
    fields.classList.add('hidden');
  }

  document.getElementById('checkoutOverlay').classList.remove('hidden');
}

function closeCheckoutDialog() {
  checkingOutBooking = null;
  document.getElementById('checkoutOverlay').classList.add('hidden');
}

document.getElementById('checkoutCancelBtn').addEventListener('click', closeCheckoutDialog);

document.getElementById('checkoutSubmitBtn').addEventListener('click', async () => {
  const errorEl = document.getElementById('checkoutError');
  errorEl.textContent = '';

  const fieldsVisible = !document.getElementById('checkoutPaymentFields').classList.contains('hidden');
  let paymentMethod = null;
  if (fieldsVisible) {
    paymentMethod = document.getElementById('checkoutCash').checked ? 'cash' : (document.getElementById('checkoutTransfer').checked ? 'transfer' : null);
    if (!paymentMethod) {
      errorEl.textContent = 'Vui lòng chọn hình thức thanh toán';
      return;
    }
  }

  let response;
  try {
    response = await fetch(`/api/bookings/${checkingOutBooking.id}/check-out`, {
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
  closeCheckoutDialog();
  showOpsError('');
  await refreshAll();
});
```

- [ ] **Step 5: Gate the "Huỷ dịch vụ" button for paid items**

In `renderServicesSection`, change:

```js
    if (item.status === 'posted' && currentRole !== 'observer') {
```

to:

```js
    if (item.status === 'posted' && currentRole !== 'observer' && (item.paymentStatus !== 'paid' || currentRole === 'admin')) {
```

- [ ] **Step 6: Manual verification**

Run the local dev server (however this project normally previews `admin/`
— check `v4/BACKEND.md` if unsure) and confirm: a departure with no
deposit/services shows "Cần thu thêm" and requires a payment method before
submitting; a departure whose deposit exceeds its total shows "Cần hoàn
khách"; a departure whose deposit matches its total shows no radios and
submits directly; a paid service's "Huỷ" button is gone for a
reception/manager login and present for admin.

- [ ] **Step 7: Commit**

```bash
git add admin/reception.js admin/reception.html
git commit -m "feat: checkout confirmation dialog with room/service settlement"
```

---

### Task 6: E2e coverage (repo ngoài)

**Files:**
- Modify: `tests/e2e/reception-ops-board.spec.js`

**Interfaces:**
- Consumes: `#checkoutOverlay`, `#checkoutSummary`, `#checkoutPaymentFields`, `#checkoutCash`, `#checkoutTransfer`, `#checkoutSubmitBtn`, `#checkoutError` (Task 5); `POST /api/bookings/:id/check-out` (Task 3).

- [ ] **Step 1: Read the current file's mocking conventions**

Read `tests/e2e/reception-ops-board.spec.js` in full first, to confirm the
snippets below still match the file's current state before applying them
— this plan was written against the file as it stood on 2026-09-08. Key
conventions this task follows: no shared `beforeEach`/helper at module
level (each `test()` sets up its own routes inline, or via a small
function defined once and called per-test, as `loadDeparturesTestData`
below does); `status=confirmed*`/`status=checked_out*`/`status=cancelled*`
etc. all use a trailing `*` wildcard since `fetchBookings()` always appends
query params; `/api/rooms?**` (not the bare `/api/rooms`) is the correct
pattern because `loadRooms()` always calls `fetch('/api/rooms?date=...')`
— every request carries a query string (the file has some older, effectively-dead `/api/rooms` bare-pattern mocks from before this was well understood; don't copy those, use `**`-suffixed patterns for every route that can carry a query string, matching the fix already applied to `tests/e2e/asset-inventory.spec.js` for the identical class of bug).

- [ ] **Step 2: Write the new tests**

Append to the file, inside a new `test.describe('Checkout settlement (Phase 2)', () => { ... })` block:

```js
test.describe('Checkout settlement (Phase 2)', () => {
  function mockReceptionShell(page, { username = 'hienle', role = 'reception' } = {}) {
    return Promise.all([
      page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username, role }) })),
      page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
      page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
      page.route('**/api/bookings?status=checked_out*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
      page.route('**/api/bookings?status=cancelled*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
      page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
      page.route('**/api/rooms/layout-log*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
      page.route('**/api/reception/reminders', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingDeposits: [], cleaningNeeded: [] }) })),
      page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
    ]);
  }

  function mockDeparturesBooking(page, booking) {
    return page.route('**/api/bookings?status=checked_in*', (route) => {
      const isDepartures = route.request().url().includes('view=departures');
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(isDepartures ? [booking] : []) });
    });
  }

  test('checking out a booking with an unpaid balance shows the breakdown and requires a payment method', async ({ page }) => {
    await mockReceptionShell(page);
    await mockDeparturesBooking(page, {
      id: 50, guestName: 'Khách Checkout A', phone: '0900000050', roomType: 'circle',
      checkIn: '2099-06-01', checkOut: '2099-06-02', status: 'checked_in', depositAmount: 0, services: [],
    });
    let posted = null;
    await page.route('**/api/bookings/50/check-out', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, roomDue: 600000, servicesDue: 0, refundAmount: 0, checkoutPaymentMethod: 'cash' }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#departuresList')).toContainText('Khách Checkout A');
    await page.locator('#departuresList button', { hasText: 'Check-out' }).click();

    await expect(page.locator('#checkoutOverlay')).toBeVisible();
    await expect(page.locator('#checkoutSummary')).toContainText('Cần thu thêm: 600.000');
    await expect(page.locator('#checkoutPaymentFields')).toBeVisible();

    await page.click('#checkoutSubmitBtn');
    await expect(page.locator('#checkoutError')).toHaveText('Vui lòng chọn hình thức thanh toán');
    expect(posted).toBeNull();

    await page.check('#checkoutCash');
    await page.click('#checkoutSubmitBtn');
    await expect(page.locator('#checkoutOverlay')).toBeHidden();
    expect(posted).toEqual({ paymentMethod: 'cash' });
  });

  test('checking out a booking whose deposit exceeds the total shows the refund amount', async ({ page }) => {
    await mockReceptionShell(page);
    await mockDeparturesBooking(page, {
      id: 51, guestName: 'Khách Checkout B', phone: '0900000051', roomType: 'circle',
      checkIn: '2099-06-01', checkOut: '2099-06-02', status: 'checked_in', depositAmount: 900000, services: [],
    });
    await page.route('**/api/bookings/51/check-out', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, roomDue: 0, servicesDue: 0, refundAmount: 300000, checkoutPaymentMethod: 'cash' }) })
    );

    await page.goto('/admin/reception.html');
    await expect(page.locator('#departuresList')).toContainText('Khách Checkout B');
    await page.locator('#departuresList button', { hasText: 'Check-out' }).click();

    await expect(page.locator('#checkoutSummary')).toContainText('Cần hoàn khách: 300.000');
    await expect(page.locator('#checkoutPaymentFields')).toBeVisible();
  });

  test('checking out a booking whose deposit exactly matches the total submits directly, no payment method needed', async ({ page }) => {
    await mockReceptionShell(page);
    await mockDeparturesBooking(page, {
      id: 52, guestName: 'Khách Checkout C', phone: '0900000052', roomType: 'circle',
      checkIn: '2099-06-01', checkOut: '2099-06-02', status: 'checked_in', depositAmount: 600000, services: [],
    });
    let posted = null;
    await page.route('**/api/bookings/52/check-out', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, roomDue: 0, servicesDue: 0, refundAmount: 0, checkoutPaymentMethod: null }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#departuresList')).toContainText('Khách Checkout C');
    await page.locator('#departuresList button', { hasText: 'Check-out' }).click();

    await expect(page.locator('#checkoutSummary')).toContainText('Cọc đã khớp đủ');
    await expect(page.locator('#checkoutPaymentFields')).toBeHidden();

    await page.click('#checkoutSubmitBtn');
    await expect(page.locator('#checkoutOverlay')).toBeHidden();
    expect(posted).toEqual({ paymentMethod: null });
  });

  test('a paid service item hides "Huỷ" for reception', async ({ page }) => {
    await mockReceptionShell(page, { username: 'hienle', role: 'reception' });
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          id: 60, guestName: 'Khách Dịch Vụ Paid', phone: '0900000060', roomType: 'circle', checkIn: '2099-06-01', checkOut: '2099-06-03', status: 'confirmed',
          services: [{ id: 70, bookingId: 60, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: 'posted', paymentStatus: 'paid', paymentMethod: 'cash', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }],
        }]),
      })
    );
    await mockDeparturesBooking(page, { id: 999, guestName: 'unused', phone: '0', roomType: 'circle', checkIn: '2099-01-01', checkOut: '2099-01-02', status: 'checked_in', depositAmount: 0, services: [] });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Khách Dịch Vụ Paid');
    await expect(page.locator('#upcomingConfirmedList .service-line button', { hasText: 'Huỷ' })).toHaveCount(0);
  });

  test('a paid service item still shows "Huỷ" for admin', async ({ page }) => {
    await mockReceptionShell(page, { username: 'admin_a', role: 'admin' });
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{
          id: 61, guestName: 'Khách Dịch Vụ Paid Admin', phone: '0900000061', roomType: 'circle', checkIn: '2099-06-01', checkOut: '2099-06-03', status: 'confirmed',
          services: [{ id: 71, bookingId: 61, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: 'posted', paymentStatus: 'paid', paymentMethod: 'cash', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }],
        }]),
      })
    );
    await mockDeparturesBooking(page, { id: 999, guestName: 'unused', phone: '0', roomType: 'circle', checkIn: '2099-01-01', checkOut: '2099-01-02', status: 'checked_in', depositAmount: 0, services: [] });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Khách Dịch Vụ Paid Admin');
    await expect(page.locator('#upcomingConfirmedList .service-line button', { hasText: 'Huỷ' })).toHaveCount(1);
  });
});
```

- [ ] **Step 3: Run the new tests**

Run (from the outer repo root):
`npx playwright test tests/e2e/reception-ops-board.spec.js --project=v4`
Expected: all 5 new tests pass; the one pre-existing unrelated failure
documented in this project's history (`cancelling a booking with a
deposit shows the computed refund suggestion`) may still appear and is not
this task's concern — do not attempt to fix it here.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/reception-ops-board.spec.js
git commit -m "test: e2e coverage for checkout settlement and paid-service void gating"
```
