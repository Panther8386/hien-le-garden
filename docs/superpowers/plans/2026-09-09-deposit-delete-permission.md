# Booking Deposit Delete Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin grant selected accounts permission to delete a
mistaken deposit entry, correctly reversing both the running total and the
Sổ thu chi income row it created — never a hard SQL delete.

**Architecture:** Mirrors the existing "Xoá tài sản" (asset delete)
permission feature exactly for the permission-toggle half (new
`staff_accounts` column, admin-only PATCH endpoint, checkbox in Quản lý
người dùng). The deletion itself is new: unlike an asset, a deposit has
already moved money into `finance_transactions` the instant it was
created, so deleting one must void that linked row and decrement the
booking's running total — both inside the same request, with a race-guard
shape adapted from the checkout/cancel endpoints' own established pattern.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), vanilla JS admin
frontend (no build step).

**Spec:** `docs/superpowers/specs/2026-09-09-deposit-delete-permission-design.md`

## Global Constraints

- Never a hard SQL `DELETE` — voiding only (`voided_by`/`voided_at`
  columns), matching every other "xoá"/"huỷ" action in this codebase.
- Voiding a deposit must directly void its own linked `finance_transactions` row — never create a new offsetting expense entry.
- A deposit may only be deleted while its booking's status is `pending`,
  `confirmed`, or `checked_in` — never `checked_out` or `cancelled`.
- The permission check on the delete endpoint must check both the flag
  AND `role !== 'observer'` explicitly — the asset-delete endpoint
  originally shipped without the second check and had to be fixed;  do
  not repeat that gap here.
- **The guarded void of `booking_deposits` must run as its own standalone
  statement, checked for `changes === 0`, BEFORE the `deposit_amount`
  decrement and the other statements are sent as a batch.** D1's
  `env.DB.batch([...])` runs every statement in the array regardless of
  whether an earlier one matched zero rows — it does not stop or roll
  back partway. Putting the guarded void in the same batch as the
  decrement would let a race-losing request still execute the decrement,
  subtracting the same amount twice. (This is different from the
  checkout/cancel endpoints' own batches, which are safe to group only
  because every other statement in *those* batches is naturally
  idempotent — a decrement is not.)
- Mandatory server-side permission checks; client-side gating is UX only.
- Both repos stay on `main` directly (no feature branch), matching this
  project's established convention.

---

### Task 1: Migration 0036 — new columns

**Files:**
- Create: `v4/migrations/0036_deposit_delete_permission.sql`
- Test: `v4/test/migrations.test.js` (append a new `describe` block)

**Interfaces:**
- Produces: `staff_accounts.can_delete_deposit` (INTEGER, `NOT NULL DEFAULT 0`), `booking_deposits.voided_by` (TEXT, nullable),
  `booking_deposits.voided_at` (TEXT, nullable). All three read/written by
  Tasks 2-3.

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE staff_accounts ADD COLUMN can_delete_deposit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE booking_deposits ADD COLUMN voided_by TEXT;
ALTER TABLE booking_deposits ADD COLUMN voided_at TEXT;
```

Save to `v4/migrations/0036_deposit_delete_permission.sql`.

- [ ] **Step 2: Write the failing test**

Append to `v4/test/migrations.test.js` (after the existing
`describe('migration 0035', ...)` block, following that block's exact
style):

```js
describe('migration 0036', () => {
  it('adds can_delete_deposit to staff_accounts, defaulting to 0', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('mig0036_default', 'x', 'reception', '2026-09-09T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT can_delete_deposit FROM staff_accounts WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.can_delete_deposit).toBe(0);
  });

  it('adds voided_by and voided_at to booking_deposits, defaulting to NULL', async () => {
    const bookingInsert = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at) VALUES ('Test Guest M36', '0900000039', 'circle', '2026-09-09', '2026-09-10', 'confirmed', 'website', '2026-09-09T00:00:00Z')`
    ).run();
    const depositInsert = await env.DB.prepare(
      `INSERT INTO booking_deposits (booking_id, amount, payment_method, created_by, created_at) VALUES (?, 100000, 'cash', 'system', '2026-09-09T00:00:00Z')`
    ).bind(bookingInsert.meta.last_row_id).run();
    const row = await env.DB.prepare(`SELECT voided_by, voided_at FROM booking_deposits WHERE id = ?`).bind(depositInsert.meta.last_row_id).first();
    expect(row).toEqual({ voided_by: null, voided_at: null });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run (from `v4/`): `npx vitest run test/migrations.test.js -t "migration 0036"`
Expected: FAIL — columns don't exist yet.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add migrations/0036_deposit_delete_permission.sql test/migrations.test.js
git commit -m "feat: add deposit delete permission and void columns"
```

---

### Task 2: Permission propagation + `PATCH /api/users/:id/deposit-delete-access`

**Files:**
- Modify: `v4/lib/auth.js`
- Modify: `v4/functions/api/auth/me.js`
- Modify: `v4/functions/api/users/index.js`
- Create: `v4/functions/api/users/[id]/deposit-delete-access.js`
- Modify: `v4/test/auth.test.js`
- Modify: `v4/test/authMeEndpoint.test.js`
- Test: `v4/test/userManagement.test.js`

**Interfaces:**
- Consumes: `staff_accounts.can_delete_deposit` (Task 1).
- Produces: `session.canDeleteDeposit` (boolean) — available on every
  `auth` object `requireAuth` returns, consumed by Task 3's delete
  endpoint (`auth.canDeleteDeposit`) and by Task 4's client (via
  `GET /api/auth/me`'s `canDeleteDeposit` field, and
  `GET /api/users`'s per-row `canDeleteDeposit` field).

- [ ] **Step 1: Read the current files in full**

`v4/lib/auth.js`, `v4/functions/api/auth/me.js`,
`v4/functions/api/users/index.js`,
`v4/functions/api/users/[id]/asset-delete-access.js` (the template this
task's new endpoint copies) — confirm exact current text before editing.

- [ ] **Step 2: Write the failing tests**

In `v4/test/auth.test.js`, change line 32 from:
```js
    expect(session).toEqual({ staffId: 1, username: 'le_tan_a', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false });
```
to:
```js
    expect(session).toEqual({ staffId: 1, username: 'le_tan_a', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false });
```

In `v4/test/authMeEndpoint.test.js`, change all three `toEqual({...})`
calls (lines 50, 67, 84) the same way — add `, canDeleteDeposit: false` as
the last field to each of these three exact objects:
```js
    expect(await response.json()).toEqual({ username: 'quan_ly_a', role: 'manager', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false });
    expect(await response.json()).toEqual({ username: 'le_tan_b', role: 'reception', canManageRoomLayout: true, canAddFinanceTransaction: false, canDeleteAsset: false });
    expect(await response.json()).toEqual({ username: 'le_tan_c', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: true, canDeleteAsset: false });
```
become (respectively):
```js
    expect(await response.json()).toEqual({ username: 'quan_ly_a', role: 'manager', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false });
    expect(await response.json()).toEqual({ username: 'le_tan_b', role: 'reception', canManageRoomLayout: true, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false });
    expect(await response.json()).toEqual({ username: 'le_tan_c', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: true, canDeleteAsset: false, canDeleteDeposit: false });
```

In `v4/test/userManagement.test.js`, add the import (alongside the
existing `assetDeleteAccess` import, near the top of the file):
```js
import { onRequestPatch as depositDeleteAccess } from '../functions/api/users/[id]/deposit-delete-access.js';
```
Then append this new `describe` block after the existing
`describe('PATCH /api/users/:id/asset-delete-access', ...)` block:

```js
describe('PATCH /api/users/:id/deposit-delete-access', () => {
  it('lets admin grant the permission', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/deposit-delete-access`, adminToken, 'PATCH', { canDeleteDeposit: true });
    const response = await depositDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT can_delete_deposit FROM staff_accounts WHERE id = ?`).bind(receptionId).first();
    expect(row.can_delete_deposit).toBe(1);
  });

  it('lets admin revoke the permission', async () => {
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_deposit = 1 WHERE id = ?`).bind(receptionId).run();
    const request = authedRequest(`https://x/api/users/${receptionId}/deposit-delete-access`, adminToken, 'PATCH', { canDeleteDeposit: false });
    const response = await depositDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT can_delete_deposit FROM staff_accounts WHERE id = ?`).bind(receptionId).first();
    expect(row.can_delete_deposit).toBe(0);
  });

  it('rejects a manager (403) -- only admin grants this one', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/deposit-delete-access`, managerAToken, 'PATCH', { canDeleteDeposit: true });
    const response = await depositDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(403);
  });

  it('rejects a reception account (403)', async () => {
    const request = authedRequest(`https://x/api/users/${managerBId}/deposit-delete-access`, receptionToken, 'PATCH', { canDeleteDeposit: true });
    const response = await depositDeleteAccess({ request, env, params: { id: String(managerBId) } });
    expect(response.status).toBe(403);
  });

  it('rejects granting to an observer target (400)', async () => {
    const request = authedRequest(`https://x/api/users/${observerId}/deposit-delete-access`, adminToken, 'PATCH', { canDeleteDeposit: true });
    const response = await depositDeleteAccess({ request, env, params: { id: String(observerId) } });
    expect(response.status).toBe(400);
    const row = await env.DB.prepare(`SELECT can_delete_deposit FROM staff_accounts WHERE id = ?`).bind(observerId).first();
    expect(row.can_delete_deposit).toBe(0);
  });

  it('rejects a non-boolean value (400)', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/deposit-delete-access`, adminToken, 'PATCH', { canDeleteDeposit: 'yes' });
    const response = await depositDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent account', async () => {
    const request = authedRequest('https://x/api/users/999999/deposit-delete-access', adminToken, 'PATCH', { canDeleteDeposit: true });
    const response = await depositDeleteAccess({ request, env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('writes an account_permission_change audit_log row', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/deposit-delete-access`, adminToken, 'PATCH', { canDeleteDeposit: true });
    await depositDeleteAccess({ request, env, params: { id: String(receptionId) } });
    const row = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'account_permission_change' AND entity_id = ? ORDER BY id DESC LIMIT 1`).bind(receptionId).first();
    expect(row.entity_type).toBe('staff_account');
    expect(row.entity_label).toBe('le_tan_a');
    expect(row.old_value).toBe('Tắt');
    expect(row.new_value).toBe('Bật');
    expect(row.actor).toBe('admin_a');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/auth.test.js test/authMeEndpoint.test.js test/userManagement.test.js`
Expected: FAIL — `canDeleteDeposit` doesn't exist anywhere yet, the new
endpoint file doesn't exist (import error).

- [ ] **Step 4: Implement**

In `v4/lib/auth.js`'s `getSession`, change the `SELECT` from:
```js
      `SELECT s.staff_id AS staffId, a.username, a.role, a.can_manage_room_layout AS canManageRoomLayout, a.can_add_finance_transaction AS canAddFinanceTransaction, a.can_delete_asset AS canDeleteAsset FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
```
to:
```js
      `SELECT s.staff_id AS staffId, a.username, a.role, a.can_manage_room_layout AS canManageRoomLayout, a.can_add_finance_transaction AS canAddFinanceTransaction, a.can_delete_asset AS canDeleteAsset, a.can_delete_deposit AS canDeleteDeposit FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
```
and change the returned object from:
```js
  return { staffId: row.staffId, username: row.username, role: row.role, canManageRoomLayout: !!row.canManageRoomLayout, canAddFinanceTransaction: !!row.canAddFinanceTransaction, canDeleteAsset: !!row.canDeleteAsset };
```
to:
```js
  return { staffId: row.staffId, username: row.username, role: row.role, canManageRoomLayout: !!row.canManageRoomLayout, canAddFinanceTransaction: !!row.canAddFinanceTransaction, canDeleteAsset: !!row.canDeleteAsset, canDeleteDeposit: !!row.canDeleteDeposit };
```

In `v4/functions/api/auth/me.js`, change:
```js
  return new Response(JSON.stringify({ username: auth.username, role: auth.role, canManageRoomLayout: auth.canManageRoomLayout, canAddFinanceTransaction: auth.canAddFinanceTransaction, canDeleteAsset: auth.canDeleteAsset }), {
```
to:
```js
  return new Response(JSON.stringify({ username: auth.username, role: auth.role, canManageRoomLayout: auth.canManageRoomLayout, canAddFinanceTransaction: auth.canAddFinanceTransaction, canDeleteAsset: auth.canDeleteAsset, canDeleteDeposit: auth.canDeleteDeposit }), {
```

In `v4/functions/api/users/index.js`, change the list `SELECT` from:
```js
    `SELECT id, username, role, can_manage_room_layout AS canManageRoomLayout, can_add_finance_transaction AS canAddFinanceTransaction, can_delete_asset AS canDeleteAsset, created_at AS createdAt FROM staff_accounts ORDER BY username`
```
to:
```js
    `SELECT id, username, role, can_manage_room_layout AS canManageRoomLayout, can_add_finance_transaction AS canAddFinanceTransaction, can_delete_asset AS canDeleteAsset, can_delete_deposit AS canDeleteDeposit, created_at AS createdAt FROM staff_accounts ORDER BY username`
```

Create `v4/functions/api/users/[id]/deposit-delete-access.js` (direct copy
of `asset-delete-access.js`'s structure, field names renamed):

```js
// v4/functions/api/users/[id]/deposit-delete-access.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { canDeleteDeposit } = body || {};

  if (typeof canDeleteDeposit !== 'boolean') {
    return jsonError('Giá trị không hợp lệ', 400);
  }

  const target = await env.DB.prepare(`SELECT id, username, role, can_delete_deposit FROM staff_accounts WHERE id = ?`).bind(params.id).first();
  if (!target) {
    return jsonError('Không tìm thấy tài khoản', 404);
  }

  if (canDeleteDeposit && target.role === 'observer') {
    return jsonError('Không thể cấp quyền xoá cọc cho tài khoản người quan sát', 400);
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_accounts SET can_delete_deposit = ? WHERE id = ?`).bind(canDeleteDeposit ? 1 : 0, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('account_permission_change', 'staff_account', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, target.username, target.can_delete_deposit ? 'Bật' : 'Tắt', canDeleteDeposit ? 'Bật' : 'Tắt', auth.username, now),
  ]);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `v4/`): `npx vitest run test/auth.test.js test/authMeEndpoint.test.js test/userManagement.test.js`
Expected: all tests in all three files pass.

- [ ] **Step 6: Commit**

```bash
git add lib/auth.js functions/api/auth/me.js functions/api/users/index.js functions/api/users/\[id\]/deposit-delete-access.js test/auth.test.js test/authMeEndpoint.test.js test/userManagement.test.js
git commit -m "feat: propagate canDeleteDeposit permission, add grant endpoint"
```

---

### Task 3: `DELETE /api/bookings/:id/deposits/:depositId`

**Files:**
- Create: `v4/functions/api/bookings/[id]/deposits/[depositId].js`
- Test: `v4/test/bookingsEndpoints.test.js`

**Interfaces:**
- Consumes: `auth.canDeleteDeposit` (Task 2); `booking_deposits.voided_by`/`.voided_at` (Task 1).
- Produces: response `{ ok: true }`. Task 4's client only checks
  `response.ok`, does not read the body.

- [ ] **Step 1: Read the current files in full**

`v4/functions/api/bookings/[id]/deposits/index.js` (the sibling file in
the same directory — confirms the exact 5-level import path
`'../../../../../lib/requireAuth.js'` this new file must also use),
`v4/functions/api/assets/[id].js` (its `onRequestDelete`, the permission-check shape to copy), `v4/functions/api/bookings/[id]/services/[itemId].js`
(the belongs-to-this-booking 404-check shape to copy).

- [ ] **Step 2: Write the failing tests**

In `v4/test/bookingsEndpoints.test.js`, add the import near the top
(alongside the existing `addDeposit` import):
```js
import { onRequestDelete as deleteDeposit } from '../functions/api/bookings/[id]/deposits/[depositId].js';
```
Then append this new `describe` block after the existing
`describe('POST /api/bookings/:id/deposits', ...)` block (after its
closing `});`):

```js
describe('DELETE /api/bookings/:id/deposits/:depositId', () => {
  async function seedBooking(status = 'confirmed') {
    const created = await env.DB.prepare(
      `INSERT INTO bookings (guest_name, phone, room_type, check_in, check_out, status, source, created_at)
       VALUES ('Deposit Delete Guest', '090', 'circle', '2026-09-01', '2026-09-02', ?, 'website', '2026-08-27T00:00:00Z')`
    ).bind(status).run();
    return created.meta.last_row_id;
  }

  async function grantDeleteDeposit(staffId) {
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_deposit = 1 WHERE id = ?`).bind(staffId).run();
  }

  async function addDepositAndReturn(bookingId, amount, paymentMethod = 'cash') {
    const response = await addDeposit({
      request: new Request(`https://x/api/bookings/${bookingId}/deposits`, { method: 'POST', headers: { Cookie: `session=${receptionToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, paymentMethod }) }),
      env,
      params: { id: String(bookingId) },
    });
    return response.json();
  }

  it('voids the deposit and its finance_transactions row, decrementing deposit_amount', async () => {
    await grantDeleteDeposit(3); // receptionToken belongs to staff id 3, seeded in beforeEach
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000, 'transfer');

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(200);

    const depositRow = await env.DB.prepare(`SELECT voided_by, voided_at FROM booking_deposits WHERE id = ?`).bind(created.depositId).first();
    expect(depositRow.voided_by).toBe('le_tan_a');
    expect(depositRow.voided_at).not.toBeNull();

    const bookingRow = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(bookingRow.deposit_amount).toBe(0);

    const txRow = await env.DB.prepare(`SELECT voided_by, voided_at FROM finance_transactions WHERE id = ?`).bind(created.financeTransactionId).first();
    expect(txRow.voided_by).toBe('le_tan_a');
    expect(txRow.voided_at).not.toBeNull();
  });

  it('deleting one of two deposits only reduces deposit_amount by that one amount', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking();
    const first = await addDepositAndReturn(id, 200000);
    await addDepositAndReturn(id, 150000);

    await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${first.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(first.depositId) },
    });

    const bookingRow = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(bookingRow.deposit_amount).toBe(150000);
  });

  it('writes a deposit_delete audit_log row', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);

    await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });

    const row = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'deposit_delete' AND entity_id = ?`).bind(created.depositId).first();
    expect(row.entity_type).toBe('booking_deposit');
    expect(row.entity_label).toBe('Deposit Delete Guest');
    expect(row.old_value).toBe('200000');
    expect(row.new_value).toBeNull();
    expect(row.actor).toBe('le_tan_a');
  });

  it('rejects an account without the flag (403)', async () => {
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(403);

    const bookingRow = await env.DB.prepare(`SELECT deposit_amount FROM bookings WHERE id = ?`).bind(id).first();
    expect(bookingRow.deposit_amount).toBe(200000);
  });

  it('rejects an observer even if the flag were somehow set (403)', async () => {
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_deposit = 1 WHERE id = ?`).bind(2).run(); // observerToken belongs to staff id 2
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${observerToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(403);
  });

  it('rejects deleting on a checked_out booking (400), touches nothing', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);
    await env.DB.prepare(`UPDATE bookings SET status = 'checked_out' WHERE id = ?`).bind(id).run();

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(400);

    const depositRow = await env.DB.prepare(`SELECT voided_at FROM booking_deposits WHERE id = ?`).bind(created.depositId).first();
    expect(depositRow.voided_at).toBeNull();
  });

  it('rejects deleting on a cancelled booking (400)', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(id).run();

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(400);
  });

  it('allows deleting on a checked_in booking', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking('checked_in');
    const created = await addDepositAndReturn(id, 200000);

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(200);
  });

  it('rejects double-deleting the same deposit (400)', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);
    await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 when the deposit does not belong to the booking in the URL', async () => {
    await grantDeleteDeposit(3);
    const idA = await seedBooking();
    const idB = await seedBooking();
    const created = await addDepositAndReturn(idA, 200000);

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${idB}/deposits/${created.depositId}`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(idB), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(404);
  });

  it('returns 404 for a nonexistent deposit id', async () => {
    await grantDeleteDeposit(3);
    const id = await seedBooking();

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/999999`, { method: 'DELETE', headers: { Cookie: `session=${receptionToken}` } }),
      env,
      params: { id: String(id), depositId: '999999' },
    });
    expect(response.status).toBe(404);
  });

  it('rejects unauthenticated requests', async () => {
    const id = await seedBooking();
    const created = await addDepositAndReturn(id, 200000);

    const response = await deleteDeposit({
      request: new Request(`https://x/api/bookings/${id}/deposits/${created.depositId}`, { method: 'DELETE' }),
      env,
      params: { id: String(id), depositId: String(created.depositId) },
    });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `v4/`): `npx vitest run test/bookingsEndpoints.test.js -t "DELETE /api/bookings/:id/deposits"`
Expected: FAIL — the endpoint file doesn't exist yet (import error).

- [ ] **Step 4: Implement**

Create `v4/functions/api/bookings/[id]/deposits/[depositId].js`:

```js
import { requireAuth } from '../../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, null);
  if (auth instanceof Response) return auth;
  if (!auth.canDeleteDeposit || auth.role === 'observer') {
    return jsonError('Tài khoản không có quyền xoá cọc', 403);
  }

  const deposit = await env.DB.prepare(
    `SELECT id, booking_id, amount, finance_transaction_id, voided_at FROM booking_deposits WHERE id = ?`
  ).bind(params.depositId).first();
  if (!deposit || String(deposit.booking_id) !== String(params.id)) {
    return jsonError('Không tìm thấy dòng cọc', 404);
  }
  if (deposit.voided_at) {
    return jsonError('Dòng cọc này đã bị xoá trước đó', 400);
  }

  const booking = await env.DB.prepare(`SELECT status, guest_name FROM bookings WHERE id = ?`).bind(params.id).first();
  if (!booking) {
    return jsonError('Không tìm thấy đặt phòng', 404);
  }
  if (booking.status === 'checked_out' || booking.status === 'cancelled') {
    return jsonError('Chỉ có thể xoá cọc khi đặt phòng còn đang chờ, đã xác nhận, hoặc đang lưu trú', 400);
  }

  const now = new Date().toISOString();

  // Standalone, guarded — must NOT be batched with the statements below.
  // env.DB.batch() runs every statement regardless of whether an earlier
  // one matched zero rows, so a race-losing request could otherwise still
  // execute the deposit_amount decrement a second time.
  const voidResult = await env.DB.prepare(
    `UPDATE booking_deposits SET voided_by = ?, voided_at = ? WHERE id = ? AND voided_at IS NULL`
  ).bind(auth.username, now, params.depositId).run();

  if (voidResult.meta.changes === 0) {
    return jsonError('Dòng cọc này vừa được xử lý bởi thao tác khác, vui lòng tải lại', 409);
  }

  const statements = [
    env.DB.prepare(`UPDATE bookings SET deposit_amount = deposit_amount - ? WHERE id = ?`).bind(deposit.amount, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('deposit_delete', 'booking_deposit', ?, ?, ?, NULL, ?, ?)`
    ).bind(deposit.id, booking.guest_name, String(deposit.amount), auth.username, now),
  ];
  if (deposit.finance_transaction_id) {
    statements.push(
      env.DB.prepare(`UPDATE finance_transactions SET voided_by = ?, voided_at = ? WHERE id = ? AND voided_at IS NULL`)
        .bind(auth.username, now, deposit.finance_transaction_id)
    );
  }
  await env.DB.batch(statements);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `v4/`): `npx vitest run test/bookingsEndpoints.test.js`
Expected: all tests in the file pass (existing `POST /api/bookings/:id/deposits` describe unaffected + the new `DELETE` describe's 12 tests).

- [ ] **Step 6: Commit**

```bash
git add functions/api/bookings/\[id\]/deposits/\[depositId\].js test/bookingsEndpoints.test.js
git commit -m "feat: add DELETE /api/bookings/:id/deposits/:depositId"
```

---

### Task 4: Client — checkbox in Quản lý người dùng, delete button in reception's deposit history

**Files:**
- Modify: `v4/admin/users.html`
- Modify: `v4/admin/users.js`
- Modify: `v4/admin/reception.js`

**Interfaces:**
- Consumes: `GET /api/users`'s per-row `canDeleteDeposit` field;
  `PATCH /api/users/:id/deposit-delete-access` (Task 2);
  `GET /api/auth/me`'s `canDeleteDeposit` field (Task 2);
  `DELETE /api/bookings/:id/deposits/:depositId` (Task 3).
- Produces: no new exports — UI wiring only.

- [ ] **Step 1: Read the current files in full**

`v4/admin/users.html`, `v4/admin/users.js`, `v4/admin/reception.js` —
confirm exact current line content before editing (both files have
changed across multiple prior plans this session; re-verify rather than
trusting the line numbers below literally).

- [ ] **Step 2: Add the "Xoá cọc" column header**

In `v4/admin/users.html`, change:
```html
        <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Bố cục phòng</th><th>Thêm giao dịch</th><th id="deleteAssetColumnHeader">Xoá tài sản</th><th>Ngày tạo</th><th></th></tr></thead>
```
to:
```html
        <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Bố cục phòng</th><th>Thêm giao dịch</th><th id="deleteAssetColumnHeader">Xoá tài sản</th><th id="deleteDepositColumnHeader">Xoá cọc</th><th>Ngày tạo</th><th></th></tr></thead>
```

- [ ] **Step 3: Hide the header for non-admin, add the checkbox cell**

In `v4/admin/users.js`, change:
```js
  if (window.__currentRole !== 'admin') {
    document.getElementById('deleteAssetColumnHeader').style.display = 'none';
  }
```
to:
```js
  if (window.__currentRole !== 'admin') {
    document.getElementById('deleteAssetColumnHeader').style.display = 'none';
    document.getElementById('deleteDepositColumnHeader').style.display = 'none';
  }
```

Immediately after the existing `tdDeleteAsset` block (ending at
`if (window.__currentRole !== 'admin') tdDeleteAsset.style.display = 'none';`, right before `const tdCreated = ...`), add:

```js
    const tdDeleteDeposit = document.createElement('td');
    tdDeleteDeposit.className = 'delete-deposit-cell';
    if (window.__currentRole === 'admin') {
      const deleteDepositCheckbox = document.createElement('input');
      deleteDepositCheckbox.type = 'checkbox';
      deleteDepositCheckbox.checked = !!u.canDeleteDeposit;
      deleteDepositCheckbox.title = 'Xoá cọc trong lịch sử cọc của đặt phòng';
      deleteDepositCheckbox.addEventListener('change', async () => {
        const response = await fetch(`/api/users/${u.id}/deposit-delete-access`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canDeleteDeposit: deleteDepositCheckbox.checked }),
        });
        const listError = document.getElementById('listError');
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          listError.textContent = body.error || 'Có lỗi khi cập nhật quyền xoá cọc';
          deleteDepositCheckbox.checked = !deleteDepositCheckbox.checked;
          return;
        }
        listError.textContent = '';
      });
      tdDeleteDeposit.appendChild(deleteDepositCheckbox);
    }
    if (window.__currentRole !== 'admin') tdDeleteDeposit.style.display = 'none';
```

Then change the final row-append line from:
```js
    tr.append(tdName, tdRole, tdLayout, tdFinanceTx, tdDeleteAsset, tdCreated, tdActions);
```
to:
```js
    tr.append(tdName, tdRole, tdLayout, tdFinanceTx, tdDeleteAsset, tdDeleteDeposit, tdCreated, tdActions);
```

- [ ] **Step 4: Add `canDeleteDeposit` and the delete button in reception.js**

Add a new module-level variable next to the existing
`let canManageRoomLayout = false;`:
```js
let canDeleteDeposit = false;
```

In the module's startup `(async () => { ... })()` block, change:
```js
  const { role, canManageRoomLayout: layoutFlag } = await res.json();
  currentRole = role;
  canManageRoomLayout = !!layoutFlag;
```
to:
```js
  const { role, canManageRoomLayout: layoutFlag, canDeleteDeposit: deleteDepositFlag } = await res.json();
  currentRole = role;
  canManageRoomLayout = !!layoutFlag;
  canDeleteDeposit = !!deleteDepositFlag;
```

In `renderBookingCard`, change the deposit-history rendering block from:
```js
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
```
to:
```js
    const deposits = b.deposits || [];
    if (deposits.length > 0) {
      const historyList = document.createElement('div');
      historyList.className = 'deposit-history';
      const methodLabels = { cash: 'Tiền mặt', transfer: 'Chuyển khoản' };
      deposits.forEach((d) => {
        const line = document.createElement('p');
        const text = document.createElement('span');
        text.textContent = `${formatVnd(d.amount)} · ${methodLabels[d.paymentMethod] || d.paymentMethod} · ${formatDate(d.createdAt)}`;
        line.appendChild(text);
        if (canDeleteDeposit && currentRole !== 'observer') {
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'btn-secondary';
          deleteBtn.textContent = 'Xoá';
          deleteBtn.addEventListener('click', async () => {
            if (!confirm('Xoá dòng cọc này?')) return;
            let response;
            try {
              response = await fetch(`/api/bookings/${b.id}/deposits/${d.id}`, { method: 'DELETE' });
            } catch (err) {
              showOpsError('Có lỗi khi xoá cọc');
              return;
            }
            if (!response.ok) {
              const errBody = await response.json().catch(() => ({}));
              showOpsError(errBody.error || 'Có lỗi khi xoá cọc');
              return;
            }
            showOpsError('');
            await refreshAll();
          });
          line.appendChild(deleteBtn);
        }
        historyList.appendChild(line);
      });
      card.appendChild(historyList);
    }
```

- [ ] **Step 5: Self-consistency check**

Re-read all three edited files in full. Confirm: `document.getElementById('deleteDepositColumnHeader')` matches the id added to `users.html`;
`tdDeleteDeposit` is appended in `tr.append(...)` in the right position;
`canDeleteDeposit` (reception.js's module-level variable) is declared once
and referenced consistently; no leftover reference to the old
`line.textContent = ...` single-assignment form. There is no automated
test harness for `admin/*.js` in this repo (no build step, no jsdom) —
this static re-read is the correct verification method here, matching
every prior client-only task in this session's earlier plans.

- [ ] **Step 6: Commit**

```bash
git add admin/users.html admin/users.js admin/reception.js
git commit -m "feat: deposit-delete permission checkbox and delete button"
```

---

### Task 5: E2e coverage (repo ngoài)

**Files:**
- Modify: `tests/e2e/reception-ops-board.spec.js`
- Modify: `tests/e2e/crm-users.spec.js` (already covers the "Xoá tài sản"
  checkbox in `admin/users.html`, at
  `test('the "Xoá tài sản" checkbox column exists only for an admin viewer', ...)` and `test('toggling "Xoá tài sản" PATCHes asset-delete-access', ...)`, lines ~129-175 — confirmed by reading the file
  during plan authoring)

**Interfaces:**
- Consumes: `.deposit-history button` (the "Xoá" button, Task 4);
  `#deleteDepositColumnHeader`, `.delete-deposit-cell input[type="checkbox"]` (Task 4); `DELETE /api/bookings/:id/deposits/:depositId`,
  `PATCH /api/users/:id/deposit-delete-access` (Task 3, Task 2).

- [ ] **Step 1: Read the current files' conventions**

Read `tests/e2e/reception-ops-board.spec.js` in full, specifically the
existing `'adding a deposit renders it in the history list and updates
the running total'` test (around line 785) — its mocking style (the
booking object shape, `depositAdded`/`posted` closures) is the template
for this task's new tests. Also read `tests/e2e/crm-users.spec.js` in
full, specifically the two tests named in this task's Files section
(~lines 129-175) — they are the exact template Step 3 below copies.

- [ ] **Step 2: Add deposit-deletion tests to `reception-ops-board.spec.js`**

Append these two tests after the existing `'observer never sees the
deposit history or the add-deposit form'` test (same
`test.describe` block that test lives in):

```js
  test('deleting a deposit removes it from the history and reduces the total', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false, canDeleteDeposit: true }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let deleted = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 55, guestName: 'Khách Cọc D', phone: '0900000055', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          depositAmount: deleted ? 0 : 200000,
          deposits: deleted ? [] : [{ id: 7, bookingId: 55, amount: 200000, paymentMethod: 'cash', note: null, createdBy: 'hienle', createdAt: '2026-09-09T00:00:00Z' }],
          services: [],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/55/deposits/7', (route) => {
      deleted = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    page.on('dialog', (dialog) => dialog.accept());

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cọc: 200.000 đ');
    await page.locator('#upcomingConfirmedList .deposit-history button', { hasText: 'Xoá' }).click();

    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cọc: 0 đ');
    await expect(page.locator('#upcomingConfirmedList .deposit-history')).toHaveCount(0);
  });

  test('the deposit delete button is hidden without the permission flag', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false, canDeleteDeposit: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 56, guestName: 'Khách Cọc E', phone: '0900000056', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          depositAmount: 200000,
          deposits: [{ id: 8, bookingId: 56, amount: 200000, paymentMethod: 'cash', note: null, createdBy: 'hienle', createdAt: '2026-09-09T00:00:00Z' }],
          services: [],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cọc: 200.000 đ');
    await expect(page.locator('#upcomingConfirmedList .deposit-history button', { hasText: 'Xoá' })).toHaveCount(0);
  });
```

- [ ] **Step 3: Add the checkbox tests to `crm-users.spec.js`**

Append these two tests after the existing `test('toggling "Xoá tài sản"
PATCHes asset-delete-access', ...)` test (same `test.describe` block,
before its closing `});`):

```js
  test('the "Xoá cọc" checkbox column exists only for an admin viewer', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, username: 'admin_a', role: 'admin', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false, createdAt: '2026-08-01T00:00:00Z' },
          { id: 2, username: 'hienle', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false, createdAt: '2026-08-20T00:00:00Z' },
        ]),
      })
    );

    await page.goto('/admin/users.html');
    await expect(page.locator('#deleteDepositColumnHeader')).toBeVisible();
    const targetRow = page.locator('#userTable tbody tr', { hasText: 'hienle' });
    await expect(targetRow.locator('input[title="Xoá cọc trong lịch sử cọc của đặt phòng"]')).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_ly_a', role: 'manager' }) }));
    await page.reload();
    await expect(page.locator('#deleteDepositColumnHeader')).toBeHidden();
  });

  test('toggling "Xoá cọc" PATCHes deposit-delete-access', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, username: 'admin_a', role: 'admin', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false, createdAt: '2026-08-01T00:00:00Z' },
          { id: 2, username: 'hienle', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, canDeleteDeposit: false, createdAt: '2026-08-20T00:00:00Z' },
        ]),
      })
    );
    let lastPayload = null;
    await page.route('**/api/users/2/deposit-delete-access', (route) => {
      lastPayload = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/users.html');
    const targetRow = page.locator('#userTable tbody tr', { hasText: 'hienle' });
    await targetRow.locator('input[title="Xoá cọc trong lịch sử cọc của đặt phòng"]').check();
    await expect.poll(() => lastPayload).toEqual({ canDeleteDeposit: true });
  });
```

- [ ] **Step 4: Run the tests**

Run (from the outer repo root):
`npx playwright test tests/e2e/reception-ops-board.spec.js --project=v4`
and separately
`npx playwright test tests/e2e/crm-users.spec.js --project=v4`.
Expected: all new tests pass. Any pre-existing unrelated failures already
documented earlier in this project's history are not this task's concern.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/reception-ops-board.spec.js tests/e2e/crm-users.spec.js
git commit -m "test: e2e coverage for deposit delete permission and action"
```
