# Booking Deposit Ledger Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single overwritable `bookings.deposit_amount` write path with an append-only history of individual deposit payments, each immediately recorded into Sổ thu chi (`finance_transactions`) at the moment it's collected.

**Architecture:** A new `booking_deposits` table is an immutable history layer alongside `bookings.deposit_amount`, which keeps its current meaning as the live running total (same 2-layer shape as Phase 3a's `asset_source_rows`-plus-`assets`). A new `POST /api/bookings/:id/deposits` endpoint is the normal reception-usable "record a payment" action (creates a `finance_transactions` row + a `booking_deposits` row + increments the total, in one request, no optimistic-lock needed since the total update is a single atomic SQL increment). The existing `PATCH /api/bookings/:id/deposit` is narrowed to admin-only and becomes purely a manual-correction tool that never touches Sổ thu chi.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS admin frontend, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-08-booking-deposit-ledger-phase1-design.md`

## Global Constraints

- `bookings.deposit_amount` keeps its current meaning and every existing read site (`functions/api/rooms/index.js`'s room-status check, `lib/receptionReminders.js`'s reminder, `functions/api/bookings/[id]/cancel.js`'s refund calculation) unchanged — this plan only ever increments it, never restructures it.
- `booking_deposits` is append-only — nothing in this plan updates or deletes a row in it.
- Every deposit recorded through `POST /api/bookings/:id/deposits` immediately creates a `finance_transactions` income row (category `dich_vu`) in the same request — no batching, no deferred reconciliation.
- No audit_log entry for the deposit-add action itself (the `finance_transactions` row plus the `booking_deposits` row are the record), matching the existing Giờ Xanh/Order-ăn-uống-close precedent.
- Mandatory server-side permission checks — client-side gating is UX only.
- `PATCH /api/bookings/:id/deposit` is narrowed to `admin`-only and never touches `finance_transactions` or `booking_deposits`.

---

### Task 1: Migration 0033 — `booking_deposits` table

**Files:**
- Create: `v4/migrations/0033_booking_deposits.sql`
- Test: `v4/test/migrations.test.js` (append)

**Interfaces:**
- Produces: `booking_deposits` (`id, booking_id, amount, payment_method, note, finance_transaction_id, created_by, created_at`).

- [ ] **Step 1: Write the failing tests**

Append to `v4/test/migrations.test.js`:

```js
describe('migration 0033', () => {
  async function seedBooking() {
    const insert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest M33', '0900000033', 'circle', '2026-09-08', '2026-09-09', 'confirmed', 'website', '2026-09-08T00:00:00Z')`
    ).run();
    return insert.meta.last_row_id;
  }

  it('creates booking_deposits with a working relationship to a real booking', async () => {
    const bookingId = await seedBooking();
    const insert = await env.DB.prepare(
      `INSERT INTO booking_deposits (booking_id, amount, payment_method, created_by, created_at) VALUES (?, 200000, 'cash', 'system', '2026-09-08T00:00:00Z')`
    ).bind(bookingId).run();
    const row = await env.DB.prepare(`SELECT booking_id, amount, payment_method, note, finance_transaction_id FROM booking_deposits WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row).toEqual({ booking_id: bookingId, amount: 200000, payment_method: 'cash', note: null, finance_transaction_id: null });
  });

  it('rejects a non-positive amount', async () => {
    const bookingId = await seedBooking();
    await expect(
      env.DB.prepare(
        `INSERT INTO booking_deposits (booking_id, amount, payment_method, created_by, created_at) VALUES (?, 0, 'cash', 'system', '2026-09-08T00:00:00Z')`
      ).bind(bookingId).run()
    ).rejects.toThrow();
  });

  it('rejects an invalid payment_method', async () => {
    const bookingId = await seedBooking();
    await expect(
      env.DB.prepare(
        `INSERT INTO booking_deposits (booking_id, amount, payment_method, created_by, created_at) VALUES (?, 100000, 'bogus', 'system', '2026-09-08T00:00:00Z')`
      ).bind(bookingId).run()
    ).rejects.toThrow();
  });

  it('links to a real finance_transactions row via finance_transaction_id', async () => {
    const bookingId = await seedBooking();
    const txInsert = await env.DB.prepare(
      `INSERT INTO finance_transactions (type, category, amount, transaction_date, status, created_by, created_at) VALUES ('income', 'dich_vu', 200000, '2026-09-08', 'confirmed', 'system', '2026-09-08T00:00:00Z')`
    ).run();
    const insert = await env.DB.prepare(
      `INSERT INTO booking_deposits (booking_id, amount, payment_method, finance_transaction_id, created_by, created_at) VALUES (?, 200000, 'transfer', ?, 'system', '2026-09-08T00:00:00Z')`
    ).bind(bookingId, txInsert.meta.last_row_id).run();
    const row = await env.DB.prepare(`SELECT finance_transaction_id FROM booking_deposits WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.finance_transaction_id).toBe(txInsert.meta.last_row_id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/migrations.test.js -t "migration 0033"`
Expected: FAIL — `no such table: booking_deposits`.

- [ ] **Step 3: Write the migration**

Create `v4/migrations/0033_booking_deposits.sql`:

```sql
-- v4/migrations/0033_booking_deposits.sql

CREATE TABLE booking_deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'transfer')),
  note TEXT,
  finance_transaction_id INTEGER REFERENCES finance_transactions(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_booking_deposits_booking ON booking_deposits(booking_id);
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v4 && npx vitest run test/migrations.test.js -t "migration 0033"`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
cd v4
git add migrations/0033_booking_deposits.sql test/migrations.test.js
git commit -m "feat: add booking_deposits table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `POST /api/bookings/:id/deposits` + narrow `PATCH /api/bookings/:id/deposit` to admin-only

**Files:**
- Create: `v4/functions/api/bookings/[id]/deposits/index.js`
- Modify: `v4/functions/api/bookings/[id]/deposit.js`
- Test: `v4/test/bookingsEndpoints.test.js` (modify existing `describe('PATCH /api/bookings/:id/deposit', ...)` block, add new `describe('POST /api/bookings/:id/deposits', ...)` block)

**Interfaces:**
- Consumes: `requireAuth` from `v4/lib/requireAuth.js` (4-level import path, same depth as the existing sibling `v4/functions/api/bookings/[id]/services/index.js`).
- Produces: `POST /api/bookings/:id/deposits` → `201` `{ ok: true, depositId, financeTransactionId, newTotal }`. Task 4's client relies on this exact response shape.

- [ ] **Step 1: Write the failing tests**

In `v4/test/bookingsEndpoints.test.js`, add this import alongside the existing ones at the top of the file:

```js
import { onRequestPost as addDeposit } from '../functions/api/bookings/[id]/deposits/index.js';
```

Replace the ENTIRE existing `describe('PATCH /api/bookings/:id/deposit', ...)` block (currently starting at "lets reception set a deposit amount" and ending after "rejects unauthenticated requests") with:

```js
describe('PATCH /api/bookings/:id/deposit', () => {
  it('lets admin correct a deposit amount directly', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 200000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(row.deposit_amount).toBe(200000);
  });

  it('writes an audit_log row on deposit change', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, deposit_amount, created_at)
       VALUES ('Deposit Audit Guest', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', 50000, '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 200000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'deposit_change' AND entity_id = ?`).bind(id).first();
    expect(row.entity_type).toBe('booking');
    expect(row.entity_label).toBe('Deposit Audit Guest');
    expect(row.old_value).toBe('50000');
    expect(row.new_value).toBe('200000');
  });

  it('never writes to finance_transactions or booking_deposits', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit No Ledger', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 150000 }),
    });
    await setDeposit({ request, env, params: { id: String(id) } });

    const tx = await env.DB.prepare(`SELECT COUNT(*) AS n FROM finance_transactions WHERE note LIKE '%Deposit No Ledger%'`).first();
    expect(tx.n).toBe(0);
    const deposits = await env.DB.prepare(`SELECT COUNT(*) AS n FROM booking_deposits WHERE booking_id = ?`).bind(id).first();
    expect(deposits.n).toBe(0);
  });

  it('rejects a negative depositAmount (400)', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test 2', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: -1 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent booking', async () => {
    const request = new Request('https://x/api/bookings/999999/deposit', {
      method: 'PATCH',
      headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects a manager (403)', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test Manager', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${managerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('rejects a reception account (403)', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test Reception', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('rejects an observer (403)', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Test 3', '090', 'circle', '2026-09-01', '2026-09-02', 'pending', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const request = new Request(`https://x/api/bookings/${id}/deposit`, {
      method: 'PATCH',
      headers: { Cookie: `session=${observerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('rejects unauthenticated requests', async () => {
    const request = new Request('https://x/api/bookings/1/deposit', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ depositAmount: 100000 }),
    });
    const response = await setDeposit({ request, env, params: { id: '1' } });
    expect(response.status).toBe(401);
  });
});

describe('POST /api/bookings/:id/deposits', () => {
  async function seedBooking(status = 'confirmed') {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Ledger Guest', '090', 'circle', '2026-09-01', '2026-09-02', ?, 'website', '2026-08-27T00:00:00Z')`
    ).bind(status).run();
    return created.meta.last_row_id;
  }

  it('creates a finance_transactions row, a booking_deposits row, and increments deposit_amount', async () => {
    const id = await seedBooking();
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 200000, paymentMethod: 'transfer' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.newTotal).toBe(200000);

    const bookingRow = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(bookingRow.deposit_amount).toBe(200000);

    const depositRow = await env.DB.prepare(`SELECT booking_id, amount, payment_method, finance_transaction_id FROM booking_deposits WHERE id = ?`).bind(body.depositId).first();
    expect(depositRow).toEqual({ booking_id: id, amount: 200000, payment_method: 'transfer', finance_transaction_id: body.financeTransactionId });

    const txRow = await env.DB.prepare(`SELECT type, category, amount, status FROM finance_transactions WHERE id = ?`).bind(body.financeTransactionId).first();
    expect(txRow).toEqual({ type: 'income', category: 'dich_vu', amount: 200000, status: 'confirmed' });
  });

  it('accumulates the total across two separate deposits, not overwriting it', async () => {
    const id = await seedBooking();
    await addDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits`, { method: 'POST', headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 200000, paymentMethod: 'cash' }) }),
      env,
      params: { id: String(id) },
    });
    const second = await addDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits`, { method: 'POST', headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 150000, paymentMethod: 'transfer' }) }),
      env,
      params: { id: String(id) },
    });
    const body = await second.json();
    expect(body.newTotal).toBe(350000);

    const bookingRow = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(bookingRow.deposit_amount).toBe(350000);

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM booking_deposits WHERE booking_id = ?`).bind(id).first();
    expect(count.n).toBe(2);
  });

  it('lets a manager and an admin add a deposit too', async () => {
    const id = await seedBooking();
    const managerResponse = await addDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits`, { method: 'POST', headers: { Cookie: `session=${managerToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }) }),
      env,
      params: { id: String(id) },
    });
    expect(managerResponse.status).toBe(201);
    const adminResponse = await addDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits`, { method: 'POST', headers: { Cookie: `session=${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }) }),
      env,
      params: { id: String(id) },
    });
    expect(adminResponse.status).toBe(201);
  });

  it('rejects an observer (403)', async () => {
    const id = await seedBooking();
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${observerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('rejects a non-positive amount (400)', async () => {
    const id = await seedBooking();
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 0, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid paymentMethod (400)', async () => {
    const id = await seedBooking();
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'bitcoin' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent booking', async () => {
    const request = new Request('https://x/api/bookings/999999/deposits', {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects a cancelled booking (400)', async () => {
    const id = await seedBooking('cancelled');
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('rejects a checked_out booking (400)', async () => {
    const id = await seedBooking('checked_out');
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('allows a checked_in booking', async () => {
    const id = await seedBooking('checked_in');
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(201);
  });

  it('rejects unauthenticated requests', async () => {
    const id = await seedBooking();
    const request = new Request(`https://x/api/bookings/${id}/deposits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }),
    });
    const response = await addDeposit({ request, env, params: { id: String(id) } });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js -t "deposit"`
Expected: FAIL — `addDeposit is not a function` (module doesn't exist yet) and the narrowed-role tests fail against the still-unmodified `deposit.js` (manager/reception currently succeed, test expects 403).

- [ ] **Step 3: Narrow `PATCH /api/bookings/:id/deposit` to admin-only**

In `v4/functions/api/bookings/[id]/deposit.js`, change:

```js
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
```

to:

```js
  const auth = await requireAuth(request, env, ['admin']);
```

No other line in this file changes.

- [ ] **Step 4: Create `functions/api/bookings/[id]/deposits/index.js`**

```js
// v4/functions/api/bookings/[id]/deposits/index.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_PAYMENT_METHODS = ['cash', 'transfer'];

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;

  const booking = await env.DB.prepare(`SELECT id, status, guest_name FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }
  if (booking.status === 'cancelled' || booking.status === 'checked_out') {
    return jsonError('Không thể thêm cọc cho đặt phòng đã huỷ hoặc đã trả phòng', 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { amount, paymentMethod, note } = body || {};

  if (!Number.isInteger(amount) || amount <= 0) {
    return jsonError('Số tiền cọc phải là số nguyên dương', 400);
  }
  if (!VALID_PAYMENT_METHODS.includes(paymentMethod)) {
    return jsonError('Vui lòng chọn hình thức thanh toán', 400);
  }

  const now = new Date().toISOString();
  const txNote = note ? `Cọc — ${booking.guest_name} — ${note}` : `Cọc — ${booking.guest_name}`;

  const txInsert = await env.DB.prepare(
    `INSERT INTO finance_transactions (type, category, amount, note, transaction_date, status, created_by, created_at)
     VALUES ('income', 'dich_vu', ?, ?, ?, 'confirmed', ?, ?)`
  ).bind(amount, txNote, now.slice(0, 10), auth.username, now).run();
  const financeTransactionId = txInsert.meta.last_row_id;

  const depositInsert = await env.DB.prepare(
    `INSERT INTO booking_deposits (booking_id, amount, payment_method, note, finance_transaction_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(params.id, amount, paymentMethod, note || null, financeTransactionId, auth.username, now).run();
  const depositId = depositInsert.meta.last_row_id;

  await env.DB.prepare(`UPDATE bookings SET deposit_amount = deposit_amount + ? WHERE id = ?`).bind(amount, params.id).run();

  const updated = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(params.id).first();

  return new Response(
    JSON.stringify({ ok: true, depositId, financeTransactionId, newTotal: updated.deposit_amount }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: PASS, all tests in the file including the new and modified deposit blocks.

- [ ] **Step 6: Commit**

```bash
cd v4
git add functions/api/bookings/[id]/deposit.js functions/api/bookings/[id]/deposits/index.js test/bookingsEndpoints.test.js
git commit -m "feat: add POST /api/bookings/:id/deposits, narrow PATCH deposit to admin-only

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Expose deposit history on `GET /api/bookings`

**Files:**
- Modify: `v4/functions/api/bookings/index.js`
- Test: `v4/test/bookingsEndpoints.test.js` (append)

**Interfaces:**
- Consumes: `booking_deposits` table (Task 1).
- Produces: each booking in `GET /api/bookings`'s response array gains `deposits: [{id, bookingId, amount, paymentMethod, note, createdBy, createdAt}]`, ordered oldest-first — Task 4's client relies on this exact shape and ordering.

- [ ] **Step 1: Write the failing test**

Append to `v4/test/bookingsEndpoints.test.js`:

```js
describe('GET /api/bookings — deposits', () => {
  it('includes a deposits array reflecting multiple entries in creation order', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit History Guest', '090', 'circle', '2026-09-01', '2026-09-02', 'confirmed', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    await addDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits`, { method: 'POST', headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 100000, paymentMethod: 'cash' }) }),
      env,
      params: { id: String(id) },
    });
    await addDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits`, { method: 'POST', headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: 50000, paymentMethod: 'transfer' }) }),
      env,
      params: { id: String(id) },
    });

    const response = await listBookings({ request: authedRequest(`https://x/api/bookings?status=confirmed`, managerToken), env });
    const body = await response.json();
    const booking = body.find((b) => b.id === id);
    expect(booking.deposits).toHaveLength(2);
    expect(booking.deposits[0]).toMatchObject({ amount: 100000, paymentMethod: 'cash' });
    expect(booking.deposits[1]).toMatchObject({ amount: 50000, paymentMethod: 'transfer' });
  });

  it('defaults deposits to an empty array when none exist', async () => {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('No Deposit Guest', '090', 'circle', '2026-09-01', '2026-09-02', 'confirmed', 'website', '2026-08-27T00:00:00Z')`
    ).run();
    const id = created.meta.last_row_id;

    const response = await listBookings({ request: authedRequest(`https://x/api/bookings?status=confirmed`, managerToken), env });
    const body = await response.json();
    const booking = body.find((b) => b.id === id);
    expect(booking.deposits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js -t "deposits"`
Expected: FAIL — `booking.deposits` is `undefined`.

- [ ] **Step 3: Extend the GET handler**

In `v4/functions/api/bookings/index.js`, right after the existing services-assembly block (the one ending with `results.forEach((r) => { r.services = byBooking[r.id] || []; });` and its closing `}`), add:

```js

  results.forEach((r) => {
    r.deposits = [];
  });
  if (results.length > 0) {
    const { results: depositRows } = await env.DB.prepare(
      `SELECT id, booking_id AS bookingId, amount, payment_method AS paymentMethod, note,
              created_by AS createdBy, created_at AS createdAt
       FROM booking_deposits
       WHERE booking_id IN (SELECT id FROM bookings ${where})
       ORDER BY created_at ASC, id ASC`
    ).bind(...params).all();

    const depositsByBooking = {};
    depositRows.forEach((row) => {
      if (!depositsByBooking[row.bookingId]) depositsByBooking[row.bookingId] = [];
      depositsByBooking[row.bookingId].push(row);
    });
    results.forEach((r) => {
      r.deposits = depositsByBooking[r.id] || [];
    });
  }
```

This is the exact same shape as the existing `services` assembly right above it — same `where`/`params` reuse, same per-booking grouping pattern.

- [ ] **Step 4: Run to verify it passes**

Run: `cd v4 && npx vitest run test/bookingsEndpoints.test.js`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/bookings/index.js test/bookingsEndpoints.test.js
git commit -m "feat: include deposit history in GET /api/bookings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Client — deposit history list + "+ Thêm cọc" form

**Files:**
- Modify: `v4/admin/reception.js`
- Modify: `v4/admin/admin.css`

**Interfaces:**
- Consumes: `POST /api/bookings/:id/deposits` and the extended `GET /api/bookings` (Tasks 2-3).

No dedicated backend test — pure client code, exercised by Task 5's e2e suite. `admin/reception.html` needs no changes: this section of the booking card, like the rest of `renderBookingCard`, is built entirely in JS.

- [ ] **Step 1: Replace the deposit block in `renderBookingCard`**

In `v4/admin/reception.js`, replace this entire block:

```js
  if ((b.status === 'pending' || b.status === 'confirmed') && currentRole !== 'observer') {
    const depositLine = document.createElement('p');
    const depositInput = document.createElement('input');
    depositInput.type = 'number';
    depositInput.min = '0';
    depositInput.step = '1000';
    depositInput.value = b.depositAmount || 0;
    depositInput.style.width = '120px';
    const depositBtn = document.createElement('button');
    depositBtn.type = 'button';
    depositBtn.textContent = 'Lưu cọc';
    depositBtn.className = 'btn-secondary';
    depositBtn.addEventListener('click', async () => {
      if (depositInput.value.trim() === '') {
        showOpsError('Vui lòng nhập số tiền cọc');
        return;
      }
      const amount = Number(depositInput.value);
      if (!Number.isInteger(amount) || amount < 0) {
        showOpsError('Số tiền cọc phải là số nguyên không âm');
        return;
      }
      let response;
      try {
        response = await fetch(`/api/bookings/${b.id}/deposit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depositAmount: amount }),
        });
      } catch (err) {
        showOpsError('Có lỗi khi lưu tiền cọc');
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showOpsError(body.error || 'Có lỗi khi lưu tiền cọc');
        return;
      }
      showOpsError('');
      await loadRooms();
    });
    depositLine.appendChild(document.createTextNode('Cọc: '));
    depositLine.appendChild(depositInput);
    depositLine.appendChild(document.createTextNode(' đ '));
    depositLine.appendChild(depositBtn);
    card.appendChild(depositLine);
  }
```

with:

```js
  if ((b.status === 'pending' || b.status === 'confirmed' || b.status === 'checked_in') && currentRole !== 'observer') {
    const depositTotalLine = document.createElement('p');
    const depositTotalStrong = document.createElement('strong');
    depositTotalStrong.textContent = `Cọc: ${formatVnd(b.depositAmount || 0)}`;
    depositTotalLine.appendChild(depositTotalStrong);
    card.appendChild(depositTotalLine);

    const deposits = b.deposits || [];
    if (deposits.length > 0) {
      const historyList = document.createElement('div');
      historyList.className = 'deposit-history';
      const methodLabels = { cash: 'Tiền mặt', transfer: 'Chuyển khoản' };
      deposits.forEach((d) => {
        const line = document.createElement('p');
        line.textContent = `${formatVnd(d.amount)} · ${methodLabels[d.paymentMethod] || d.paymentMethod} · ${formatDate(d.createdAt)}`;
        historyList.appendChild(line);
      });
      card.appendChild(historyList);
    }

    const addDepositForm = document.createElement('div');
    addDepositForm.className = 'add-deposit-form';

    const amountInput = document.createElement('input');
    amountInput.type = 'number';
    amountInput.min = '0';
    amountInput.step = '1000';
    amountInput.placeholder = 'Số tiền cọc';
    amountInput.style.width = '140px';

    const cashLabel = document.createElement('label');
    cashLabel.className = 'checkbox-label';
    const cashRadio = document.createElement('input');
    cashRadio.type = 'radio';
    cashRadio.name = `depositMethod-${b.id}`;
    cashRadio.value = 'cash';
    cashLabel.append(cashRadio, ' 💵 Tiền mặt');

    const transferLabel = document.createElement('label');
    transferLabel.className = 'checkbox-label';
    const transferRadio = document.createElement('input');
    transferRadio.type = 'radio';
    transferRadio.name = `depositMethod-${b.id}`;
    transferRadio.value = 'transfer';
    transferLabel.append(transferRadio, ' 🏦 Chuyển khoản');

    const addDepositBtn = document.createElement('button');
    addDepositBtn.type = 'button';
    addDepositBtn.textContent = 'Lưu cọc';
    addDepositBtn.className = 'btn-secondary';
    addDepositBtn.addEventListener('click', async () => {
      if (amountInput.value.trim() === '') {
        showOpsError('Vui lòng nhập số tiền cọc');
        return;
      }
      const amount = Number(amountInput.value);
      if (!Number.isInteger(amount) || amount <= 0) {
        showOpsError('Số tiền cọc phải là số nguyên dương');
        return;
      }
      const paymentMethod = cashRadio.checked ? 'cash' : (transferRadio.checked ? 'transfer' : null);
      if (!paymentMethod) {
        showOpsError('Vui lòng chọn hình thức thanh toán');
        return;
      }
      let response;
      try {
        response = await fetch(`/api/bookings/${b.id}/deposits`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount, paymentMethod }),
        });
      } catch (err) {
        showOpsError('Có lỗi khi lưu tiền cọc');
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        showOpsError(body.error || 'Có lỗi khi lưu tiền cọc');
        return;
      }
      showOpsError('');
      await refreshAll();
    });

    addDepositForm.append(amountInput, cashLabel, transferLabel, addDepositBtn);
    card.appendChild(addDepositForm);
  }
```

- [ ] **Step 2: Add CSS for the new elements**

`.add-service-form`'s existing rules don't apply here (this form has its own, simpler flat layout — 1 input + 2 radios + 1 button, no grid needed). In `v4/admin/admin.css`, add these rules right after the existing `.add-service-form > button { width: auto; margin-right: 8px; }` line:

```css
.add-deposit-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.add-deposit-form input[type="number"] { width: auto; margin-top: 0; }
.add-deposit-form .checkbox-label { display: inline-flex; align-items: center; gap: 4px; width: auto; white-space: nowrap; margin-bottom: 0; }
.deposit-history { margin-top: 4px; font-size: 0.85rem; color: var(--text-muted); }
.deposit-history p { margin: 2px 0; }
```

- [ ] **Step 3: Commit**

```bash
cd v4
git add admin/reception.js admin/admin.css
git commit -m "feat: replace single deposit input with deposit history + Thêm cọc form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: E2e coverage (outer repo)

**Files:**
- Modify: `tests/e2e/reception-ops-board.spec.js`

**Interfaces:**
- Consumes: every DOM structure from Task 4, and the API contracts from Tasks 2-3.

- [ ] **Step 1: Write the failing tests**

Add these tests at the end of `tests/e2e/reception-ops-board.spec.js`'s `test.describe('Reception daily ops board', ...)` block (right before its closing `});`), reusing the file's existing `mockAuth`-via-`page.route` idiom already shown throughout the file:

```js
  test('adding a deposit renders it in the history list and updates the running total', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let depositAdded = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 50, guestName: 'Khách Cọc A', phone: '0900000050', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          depositAmount: depositAdded ? 200000 : 0,
          deposits: depositAdded ? [{ id: 1, bookingId: 50, amount: 200000, paymentMethod: 'transfer', note: null, createdBy: 'hienle', createdAt: '2026-09-08T00:00:00Z' }] : [],
          services: [],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let posted = null;
    await page.route('**/api/bookings/50/deposits', (route) => {
      posted = route.request().postDataJSON();
      depositAdded = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, depositId: 1, financeTransactionId: 9, newTotal: 200000 }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Khách Cọc A');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cọc: 0 đ');

    await page.locator('#upcomingConfirmedList .add-deposit-form input[type="number"]').fill('200000');
    await page.locator('#upcomingConfirmedList .add-deposit-form input[value="transfer"]').check();
    await page.locator('#upcomingConfirmedList .add-deposit-form button', { hasText: 'Lưu cọc' }).click();

    await expect.poll(() => posted).toMatchObject({ amount: 200000, paymentMethod: 'transfer' });
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cọc: 200.000 đ');
    await expect(page.locator('#upcomingConfirmedList .deposit-history')).toContainText('200.000 đ · Chuyển khoản');
  });

  test('the "Lưu cọc" button requires a payment method before submitting', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 51, guestName: 'Khách Cọc B', phone: '0900000051', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', depositAmount: 0, deposits: [], services: [] }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let postCalled = false;
    await page.route('**/api/bookings/51/deposits', (route) => {
      postCalled = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, depositId: 1, financeTransactionId: 9, newTotal: 100000 }) });
    });

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList .add-deposit-form input[type="number"]').fill('100000');
    await page.locator('#upcomingConfirmedList .add-deposit-form button', { hasText: 'Lưu cọc' }).click();

    await expect(page.locator('#opsError')).toContainText('Vui lòng chọn hình thức thanh toán');
    expect(postCalled).toBe(false);
  });

  test('observer never sees the deposit history or the add-deposit form', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer' }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 52, guestName: 'Khách Cọc C', phone: '0900000052', roomType: 'circle', checkIn: '2099-05-01', checkOut: '2099-05-03', status: 'confirmed', depositAmount: 100000, deposits: [{ id: 1, bookingId: 52, amount: 100000, paymentMethod: 'cash', note: null, createdBy: 'hienle', createdAt: '2026-09-08T00:00:00Z' }], services: [] }]),
      })
    );
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Khách Cọc C');
    await expect(page.locator('#upcomingConfirmedList .deposit-history')).toHaveCount(0);
    await expect(page.locator('#upcomingConfirmedList .add-deposit-form')).toHaveCount(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/e2e/reception-ops-board.spec.js --project=v4`
Expected: FAIL — `.add-deposit-form`/`.deposit-history` don't exist yet (Task 4 not applied) — if Task 4 is already applied when this task runs, expect PASS instead; either way this is the gate before Step 3.

- [ ] **Step 3: Run to verify it passes**

Run: `npx playwright test tests/e2e/reception-ops-board.spec.js --project=v4`
Expected: PASS, all tests in the file (this file already has extensive coverage from earlier work this session — confirm the total count only grows by 3, nothing else regresses).

- [ ] **Step 4: Run the full v4 project to confirm no regressions**

Run: `npx playwright test --project=v4 --list` first to confirm the current baseline count, then `npx playwright test --project=v4`.
Expected: PASS, baseline + 3 new. This project has one known, pre-existing, unrelated flaky test that only fails under full-suite parallel load (`reception-ops-board.spec.js`'s "cancelling a booking with a deposit" test) — if you see exactly that one failure and everything else passes, that's expected and not something to fix; any other failure is a real regression to investigate.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reception-ops-board.spec.js
git commit -m "test: e2e coverage for the deposit history + Thêm cọc form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
