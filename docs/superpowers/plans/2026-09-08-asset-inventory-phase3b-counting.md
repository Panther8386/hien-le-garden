# Asset & Inventory Phase 3b: Room-by-Room Counting + Asset Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-location inventory-counting workflow (batches → lines → close-time reconciliation) on top of Phase 3a's `assets` table, plus a soft-delete capability for `assets` gated by its own admin-only-grantable permission.

**Architecture:** Two new D1 tables (`asset_inventory_batches`, `asset_inventory_lines`) drive a 4-state batch workflow; closing a batch writes corrections back into `assets.quantity` for bulk-tracked assets only, via `audit_log`. A new `assets.is_deleted` column plus a new `staff_accounts.can_delete_asset` permission column add a reversible-by-database-only delete path, independent of the existing admin/manager write role. One new admin page (`asset-inventory.html`) and small additions to two existing ones (`assets.html`, `users.html`) provide the UI. Every write endpoint enforces its own role/permission check server-side.

**Tech Stack:** Cloudflare Pages Functions, D1 (SQLite), R2 (existing `RECEIPTS` bucket, new key prefixes), vanilla JS admin frontend, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-08-asset-inventory-phase3b-counting-design.md`

## Global Constraints

- Never write to `asset_source_rows`/`asset_source_documents` (Layer 1, immutable) anywhere in this plan.
- `assets.category_id` stays immutable via PATCH (Phase 3a rule, unchanged).
- `assets.quantity` stays forced to 1 for `individual_device`/`device_set` (Phase 3a rule) — the closing-reconciliation logic in Task 3 never overrides this.
- Never coerce an unknown quantity to 0/1; never guess an unknown location.
- Reuse the existing 4 roles (admin/manager/reception/observer) and the existing `rooms`/`asset_locations`/`assets` tables — no second room, user, or permission system.
- Mandatory server-side permission checks on every write endpoint — never trust client-side role gating alone.
- `asset_inventory_lines.actual_quantity IS NULL` means "not yet counted" and must never be treated the same as `0` ("counted, confirmed absent") anywhere reconciliation logic reads it.
- A closed batch (`asset_inventory_batches.status = 'closed'`) is terminal — no code path may write to its lines again, by any role.
- `staff_accounts.can_delete_asset` defaults to `0` for every account including existing admin/manager accounts — delete access is never inherited from role.
- Only `admin` may grant/revoke `can_delete_asset` (differs from the existing `can_manage_room_layout`/`can_add_finance_transaction` precedent, which manager+admin can both grant — explicit product decision for this one permission).
- `DELETE /api/assets/:id` is gated purely on `auth.canDeleteAsset`, independent of role.

---

### Task 1: Migration 0031 — inventory tables + `assets.is_deleted`

**Files:**
- Create: `v4/migrations/0031_asset_inventory_counting.sql`
- Test: `v4/test/migrations.test.js` (append)

**Interfaces:**
- Produces: `asset_inventory_batches` (`id, location_id, label, status, note, created_by, created_at, closed_by, closed_at`), `asset_inventory_lines` (`id, batch_id, asset_id, book_quantity, actual_quantity, condition_found, photo_key, photo_filename, photo_uploaded_at, note, suggested_action, updated_by, updated_at`, `UNIQUE(batch_id, asset_id)`), `assets.is_deleted` (INTEGER NOT NULL DEFAULT 0).

- [ ] **Step 1: Write the failing tests**

Append to `v4/test/migrations.test.js`:

```js
describe('migration 0031', () => {
  async function seedCategory(managementType) {
    const insert = await env.DB.prepare(
      `INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES (?, 'Test Category M31', 'cái', 'system', '2026-09-08T00:00:00Z')`
    ).bind(managementType).run();
    return insert.meta.last_row_id;
  }

  async function seedLocation() {
    const insert = await env.DB.prepare(
      `INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('common_area', 'Test Location M31', 'system', '2026-09-08T00:00:00Z')`
    ).run();
    return insert.meta.last_row_id;
  }

  async function seedAsset(categoryId) {
    const insert = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, created_by, created_at) VALUES (?, 'Test Asset M31', 'handover_a', 'system', '2026-09-08T00:00:00Z')`
    ).bind(categoryId).run();
    return insert.meta.last_row_id;
  }

  it('creates asset_inventory_batches defaulting status to draft', async () => {
    const locationId = await seedLocation();
    const insert = await env.DB.prepare(
      `INSERT INTO asset_inventory_batches (location_id, label, created_by, created_at) VALUES (?, 'Test Batch', 'system', '2026-09-08T00:00:00Z')`
    ).bind(locationId).run();
    const row = await env.DB.prepare(`SELECT status FROM asset_inventory_batches WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.status).toBe('draft');
  });

  it('creates asset_inventory_lines with a working relationship to a batch and an asset', async () => {
    const locationId = await seedLocation();
    const categoryId = await seedCategory('durable_goods');
    const assetId = await seedAsset(categoryId);
    const batchInsert = await env.DB.prepare(
      `INSERT INTO asset_inventory_batches (location_id, label, created_by, created_at) VALUES (?, 'Test Batch', 'system', '2026-09-08T00:00:00Z')`
    ).bind(locationId).run();
    const batchId = batchInsert.meta.last_row_id;

    const lineInsert = await env.DB.prepare(
      `INSERT INTO asset_inventory_lines (batch_id, asset_id, book_quantity) VALUES (?, ?, 5)`
    ).bind(batchId, assetId).run();
    const row = await env.DB.prepare(`SELECT batch_id, asset_id, book_quantity, actual_quantity FROM asset_inventory_lines WHERE id = ?`).bind(lineInsert.meta.last_row_id).first();
    expect(row).toEqual({ batch_id: batchId, asset_id: assetId, book_quantity: 5, actual_quantity: null });
  });

  it('rejects a duplicate (batch_id, asset_id) pair', async () => {
    const locationId = await seedLocation();
    const categoryId = await seedCategory('durable_goods');
    const assetId = await seedAsset(categoryId);
    const batchInsert = await env.DB.prepare(
      `INSERT INTO asset_inventory_batches (location_id, label, created_by, created_at) VALUES (?, 'Test Batch', 'system', '2026-09-08T00:00:00Z')`
    ).bind(locationId).run();
    const batchId = batchInsert.meta.last_row_id;
    await env.DB.prepare(`INSERT INTO asset_inventory_lines (batch_id, asset_id) VALUES (?, ?)`).bind(batchId, assetId).run();
    await expect(
      env.DB.prepare(`INSERT INTO asset_inventory_lines (batch_id, asset_id) VALUES (?, ?)`).bind(batchId, assetId).run()
    ).rejects.toThrow();
  });

  it('rejects an invalid batch status', async () => {
    const locationId = await seedLocation();
    await expect(
      env.DB.prepare(
        `INSERT INTO asset_inventory_batches (location_id, label, status, created_by, created_at) VALUES (?, 'Test Batch', 'bogus', 'system', '2026-09-08T00:00:00Z')`
      ).bind(locationId).run()
    ).rejects.toThrow();
  });

  it('adds assets.is_deleted, defaulting to 0', async () => {
    const categoryId = await seedCategory('durable_goods');
    const assetId = await seedAsset(categoryId);
    const row = await env.DB.prepare(`SELECT is_deleted FROM assets WHERE id = ?`).bind(assetId).first();
    expect(row.is_deleted).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/migrations.test.js -t "migration 0031"`
Expected: FAIL — `no such table: asset_inventory_batches` (the migration file doesn't exist yet).

- [ ] **Step 3: Write the migration**

Create `v4/migrations/0031_asset_inventory_counting.sql`:

```sql
-- v4/migrations/0031_asset_inventory_counting.sql

CREATE TABLE asset_inventory_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location_id INTEGER NOT NULL REFERENCES asset_locations(id),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'counting', 'pending_close', 'closed')) DEFAULT 'draft',
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT
);
CREATE INDEX idx_asset_inventory_batches_location ON asset_inventory_batches(location_id, status);

CREATE TABLE asset_inventory_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES asset_inventory_batches(id),
  asset_id INTEGER NOT NULL REFERENCES assets(id),
  book_quantity INTEGER,
  actual_quantity INTEGER,
  condition_found TEXT,
  photo_key TEXT,
  photo_filename TEXT,
  photo_uploaded_at TEXT,
  note TEXT,
  suggested_action TEXT,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(batch_id, asset_id)
);
CREATE INDEX idx_asset_inventory_lines_batch ON asset_inventory_lines(batch_id);

ALTER TABLE assets ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v4 && npx vitest run test/migrations.test.js -t "migration 0031"`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
cd v4
git add migrations/0031_asset_inventory_counting.sql test/migrations.test.js
git commit -m "feat: add asset_inventory_batches/lines tables and assets.is_deleted

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Asset-delete permission (migration 0032 + auth plumbing + toggle endpoint + client checkbox)

**Files:**
- Create: `v4/migrations/0032_asset_delete_permission.sql`
- Create: `v4/functions/api/users/[id]/asset-delete-access.js`
- Modify: `v4/lib/auth.js:64-76`
- Modify: `v4/functions/api/auth/me.js`
- Modify: `v4/functions/api/users/index.js`
- Modify: `v4/admin/users.html`
- Modify: `v4/admin/users.js`
- Test: `v4/test/migrations.test.js` (append), `v4/test/userManagement.test.js` (append)

**Interfaces:**
- Consumes: `requireAuth` from `v4/lib/requireAuth.js` (unchanged signature).
- Produces: `getSession()` return object now includes `canDeleteAsset: boolean`. `GET /api/auth/me` and `GET /api/users` responses now include `canDeleteAsset`. Later tasks (Task 5) read `auth.canDeleteAsset` from `requireAuth(request, env, null)`.

- [ ] **Step 1: Write the failing migration test**

Append to `v4/test/migrations.test.js`:

```js
describe('migration 0032', () => {
  it('adds can_delete_asset to staff_accounts, defaulting to 0', async () => {
    const insert = await env.DB.prepare(
      `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('mig0032_default', 'x', 'reception', '2026-09-08T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT can_delete_asset FROM staff_accounts WHERE id = ?`).bind(insert.meta.last_row_id).first();
    expect(row.can_delete_asset).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/migrations.test.js -t "migration 0032"`
Expected: FAIL — `no such column: can_delete_asset`.

- [ ] **Step 3: Write the migration**

Create `v4/migrations/0032_asset_delete_permission.sql`:

```sql
-- v4/migrations/0032_asset_delete_permission.sql
ALTER TABLE staff_accounts ADD COLUMN can_delete_asset INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd v4 && npx vitest run test/migrations.test.js -t "migration 0032"`
Expected: PASS, 1/1.

- [ ] **Step 5: Update `lib/auth.js` to carry the new flag**

In `v4/lib/auth.js`, replace the `getSession` function (currently lines 64-76):

```js
export async function getSession(db, token) {
  const row = await db
    .prepare(
      `SELECT s.staff_id AS staffId, a.username, a.role, a.can_manage_room_layout AS canManageRoomLayout, a.can_add_finance_transaction AS canAddFinanceTransaction FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, new Date().toISOString())
    .first();

  if (!row) return null;
  return { staffId: row.staffId, username: row.username, role: row.role, canManageRoomLayout: !!row.canManageRoomLayout, canAddFinanceTransaction: !!row.canAddFinanceTransaction };
}
```

with:

```js
export async function getSession(db, token) {
  const row = await db
    .prepare(
      `SELECT s.staff_id AS staffId, a.username, a.role, a.can_manage_room_layout AS canManageRoomLayout, a.can_add_finance_transaction AS canAddFinanceTransaction, a.can_delete_asset AS canDeleteAsset FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, new Date().toISOString())
    .first();

  if (!row) return null;
  return { staffId: row.staffId, username: row.username, role: row.role, canManageRoomLayout: !!row.canManageRoomLayout, canAddFinanceTransaction: !!row.canAddFinanceTransaction, canDeleteAsset: !!row.canDeleteAsset };
}
```

- [ ] **Step 6: Expose it on `/api/auth/me`**

In `v4/functions/api/auth/me.js`, replace the whole file:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, null);
  if (auth instanceof Response) return auth;

  return new Response(JSON.stringify({ username: auth.username, role: auth.role, canManageRoomLayout: auth.canManageRoomLayout, canAddFinanceTransaction: auth.canAddFinanceTransaction, canDeleteAsset: auth.canDeleteAsset }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 7: Write the failing endpoint tests**

Append to `v4/test/userManagement.test.js` (find the existing `describe` blocks for the finance-transaction/room-layout access endpoints and add a sibling block after them — use the same `authedRequest`/session-seeding helpers already defined at the top of that file):

```js
describe('PATCH /api/users/:id/asset-delete-access', () => {
  it('lets admin grant the permission', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/asset-delete-access`, adminToken, 'PATCH', { canDeleteAsset: true });
    const response = await assetDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT can_delete_asset FROM staff_accounts WHERE id = ?`).bind(receptionId).first();
    expect(row.can_delete_asset).toBe(1);
  });

  it('lets admin revoke the permission', async () => {
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(receptionId).run();
    const request = authedRequest(`https://x/api/users/${receptionId}/asset-delete-access`, adminToken, 'PATCH', { canDeleteAsset: false });
    const response = await assetDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT can_delete_asset FROM staff_accounts WHERE id = ?`).bind(receptionId).first();
    expect(row.can_delete_asset).toBe(0);
  });

  it('rejects a manager (403) -- unlike room-layout/finance-transaction access, only admin grants this one', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/asset-delete-access`, managerAToken, 'PATCH', { canDeleteAsset: true });
    const response = await assetDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(403);
  });

  it('rejects a reception account (403)', async () => {
    const request = authedRequest(`https://x/api/users/${managerBId}/asset-delete-access`, receptionToken, 'PATCH', { canDeleteAsset: true });
    const response = await assetDeleteAccess({ request, env, params: { id: String(managerBId) } });
    expect(response.status).toBe(403);
  });

  it('rejects granting to an observer target (400)', async () => {
    const request = authedRequest(`https://x/api/users/${observerId}/asset-delete-access`, adminToken, 'PATCH', { canDeleteAsset: true });
    const response = await assetDeleteAccess({ request, env, params: { id: String(observerId) } });
    expect(response.status).toBe(400);
    const row = await env.DB.prepare(`SELECT can_delete_asset FROM staff_accounts WHERE id = ?`).bind(observerId).first();
    expect(row.can_delete_asset).toBe(0);
  });

  it('rejects a non-boolean value (400)', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/asset-delete-access`, adminToken, 'PATCH', { canDeleteAsset: 'yes' });
    const response = await assetDeleteAccess({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(400);
  });

  it('returns 404 for a nonexistent account', async () => {
    const request = authedRequest('https://x/api/users/999999/asset-delete-access', adminToken, 'PATCH', { canDeleteAsset: true });
    const response = await assetDeleteAccess({ request, env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('writes an account_permission_change audit_log row', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/asset-delete-access`, adminToken, 'PATCH', { canDeleteAsset: true });
    await assetDeleteAccess({ request, env, params: { id: String(receptionId) } });
    const row = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'account_permission_change' AND entity_id = ? ORDER BY id DESC LIMIT 1`).bind(receptionId).first();
    expect(row.entity_type).toBe('staff_account');
    expect(row.entity_label).toBe('le_tan_a');
    expect(row.old_value).toBe('Tắt');
    expect(row.new_value).toBe('Bật');
    expect(row.actor).toBe('admin_a');
  });
});
```

Add the import at the top of the file alongside the existing endpoint imports:

```js
import { onRequestPatch as assetDeleteAccess } from '../functions/api/users/[id]/asset-delete-access.js';
```

- [ ] **Step 8: Run to verify it fails**

Run: `cd v4 && npx vitest run test/userManagement.test.js -t "asset-delete-access"`
Expected: FAIL — module not found (the endpoint file doesn't exist yet).

- [ ] **Step 9: Create the endpoint**

Create `v4/functions/api/users/[id]/asset-delete-access.js`:

```js
// v4/functions/api/users/[id]/asset-delete-access.js
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
  const { canDeleteAsset } = body || {};

  if (typeof canDeleteAsset !== 'boolean') {
    return jsonError('Giá trị không hợp lệ', 400);
  }

  const target = await env.DB.prepare(`SELECT id, username, role, can_delete_asset FROM staff_accounts WHERE id = ?`).bind(params.id).first();
  if (!target) {
    return jsonError('Không tìm thấy tài khoản', 404);
  }

  if (canDeleteAsset && target.role === 'observer') {
    return jsonError('Không thể cấp quyền xoá tài sản cho tài khoản người quan sát', 400);
  }

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = ? WHERE id = ?`).bind(canDeleteAsset ? 1 : 0, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('account_permission_change', 'staff_account', ?, ?, ?, ?, ?, ?)`
    ).bind(params.id, target.username, target.can_delete_asset ? 'Bật' : 'Tắt', canDeleteAsset ? 'Bật' : 'Tắt', auth.username, now),
  ]);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 10: Expose the flag on `GET /api/users`**

In `v4/functions/api/users/index.js`, replace the `onRequestGet` SELECT line:

```js
    `SELECT id, username, role, can_manage_room_layout AS canManageRoomLayout, can_add_finance_transaction AS canAddFinanceTransaction, created_at AS createdAt FROM staff_accounts ORDER BY username`
```

with:

```js
    `SELECT id, username, role, can_manage_room_layout AS canManageRoomLayout, can_add_finance_transaction AS canAddFinanceTransaction, can_delete_asset AS canDeleteAsset, created_at AS createdAt FROM staff_accounts ORDER BY username`
```

- [ ] **Step 11: Run to verify the backend tests pass**

Run: `cd v4 && npx vitest run test/migrations.test.js test/userManagement.test.js`
Expected: PASS, all tests including the new ones.

- [ ] **Step 12: Add the admin-only checkbox column to Quản lý user**

In `v4/admin/users.html`, replace the table header line:

```html
        <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Bố cục phòng</th><th>Thêm giao dịch</th><th>Ngày tạo</th><th></th></tr></thead>
```

with:

```html
        <thead><tr><th>Tên đăng nhập</th><th>Vai trò</th><th>Bố cục phòng</th><th>Thêm giao dịch</th><th id="deleteAssetColumnHeader">Xoá tài sản</th><th>Ngày tạo</th><th></th></tr></thead>
```

In `v4/admin/users.js`, insert a new column right after the existing `tdFinanceTx` block (after the line `tdFinanceTx.appendChild(financeTxCheckbox);` and before `const tdCreated = document.createElement('td');`):

```js
    const tdDeleteAsset = document.createElement('td');
    tdDeleteAsset.className = 'delete-asset-cell';
    if (window.__currentRole === 'admin') {
      const deleteAssetCheckbox = document.createElement('input');
      deleteAssetCheckbox.type = 'checkbox';
      deleteAssetCheckbox.checked = !!u.canDeleteAsset;
      deleteAssetCheckbox.title = 'Xoá tài sản trong Danh mục tài sản';
      deleteAssetCheckbox.addEventListener('change', async () => {
        const response = await fetch(`/api/users/${u.id}/asset-delete-access`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canDeleteAsset: deleteAssetCheckbox.checked }),
        });
        const listError = document.getElementById('listError');
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          listError.textContent = body.error || 'Có lỗi khi cập nhật quyền xoá tài sản';
          deleteAssetCheckbox.checked = !deleteAssetCheckbox.checked;
          return;
        }
        listError.textContent = '';
      });
      tdDeleteAsset.appendChild(deleteAssetCheckbox);
    }
```

Then change the row-append line from:

```js
    tr.append(tdName, tdRole, tdLayout, tdFinanceTx, tdCreated, tdActions);
```

to:

```js
    tr.append(tdName, tdRole, tdLayout, tdFinanceTx, tdDeleteAsset, tdCreated, tdActions);
```

Finally, in the top-level init IIFE (right after `window.__currentRole = currentRole;`), hide the whole column for non-admin viewers so it doesn't exist as an empty column for manager:

```js
  if (window.__currentRole !== 'admin') {
    document.getElementById('deleteAssetColumnHeader').style.display = 'none';
  }
```

and inside `loadUsers()`, right before `tbody.innerHTML = '';`, add the matching hide for every already-rendered row on a reload (belt-and-braces — the header hide above only runs once at page load, but `loadUsers()` re-runs on every table refresh, so hide each row's cell as it's built rather than relying on a one-time header-only hide): in the per-row block, immediately after `tdDeleteAsset.className = 'delete-asset-cell';`, add:

```js
    if (window.__currentRole !== 'admin') tdDeleteAsset.style.display = 'none';
```

- [ ] **Step 13: Commit**

```bash
cd v4
git add migrations/0032_asset_delete_permission.sql functions/api/users/[id]/asset-delete-access.js lib/auth.js functions/api/auth/me.js functions/api/users/index.js admin/users.html admin/users.js test/migrations.test.js test/userManagement.test.js
git commit -m "feat: add admin-only can_delete_asset permission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Inventory batches backend (list/create/detail/status-transition/refresh-lines)

**Files:**
- Create: `v4/functions/api/asset-inventory-batches/index.js`
- Create: `v4/functions/api/asset-inventory-batches/[id].js`
- Create: `v4/functions/api/asset-inventory-batches/[id]/refresh-lines.js`
- Test: `v4/test/assetInventoryBatches.test.js`

**Interfaces:**
- Consumes: `assets` table (Phase 3a, `is_deleted` from Task 1), `asset_locations` (Phase 2), `asset_categories.management_type` (Phase 2), `asset_inventory_batches`/`asset_inventory_lines` (Task 1).
- Produces: `GET/POST /api/asset-inventory-batches`, `GET/PATCH /api/asset-inventory-batches/:id`, `POST /api/asset-inventory-batches/:id/refresh-lines`. Batch JSON shape: `{id, locationId, label, status, note, createdBy, createdAt, closedBy, closedAt}`. Detail adds `lines: [{id, batchId, assetId, assetName, internalCode, managementType, bookQuantity, actualQuantity, conditionFound, photoFilename, note, suggestedAction, updatedBy, updatedAt}]`. Task 4's line-PATCH endpoint and Task 6's client both rely on this exact field naming. New `audit_log` action type `asset_inventory_adjustment` (registered in Task 5's audit-log 3-registry update, alongside `asset_delete` — this task's closing logic writes rows with that `action_type` before it exists in `VALID_ACTION_TYPES`, which is fine since that list only gates the `GET /api/audit-log?type=` filter, not inserts; Task 5 makes the label resolvable in the Nhật ký thao tác UI).

- [ ] **Step 1: Write the failing tests**

Create `v4/test/assetInventoryBatches.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as listBatches, onRequestPost as createBatch } from '../functions/api/asset-inventory-batches/index.js';
import { onRequestGet as getBatch, onRequestPatch as patchBatchStatus } from '../functions/api/asset-inventory-batches/[id].js';
import { onRequestPost as refreshLines } from '../functions/api/asset-inventory-batches/[id]/refresh-lines.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken, observerToken;
let individualCategoryId, bulkCategoryId;
let locationId, inactiveLocationId;
let individualAssetId, bulkAssetId;

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM assets');
  await env.DB.exec('DELETE FROM asset_categories');
  await env.DB.exec('DELETE FROM asset_locations');
  await env.DB.exec('DELETE FROM asset_inventory_lines');
  await env.DB.exec('DELETE FROM asset_inventory_batches');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_ib', 'x', 'manager', '2026-09-08T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_ib', 'x', 'reception', '2026-09-08T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_ib', 'x', 'admin', '2026-09-08T00:00:00Z')`).run();
  const o = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_sat_ib', 'x', 'observer', '2026-09-08T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);
  observerToken = await createSession(env.DB, o.meta.last_row_id);

  const cat1 = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('individual_device', 'Điều hoà', 'bộ', 'admin_ib', '2026-09-08T00:00:00Z')`).run();
  individualCategoryId = cat1.meta.last_row_id;
  const cat2 = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('durable_goods', 'Giường', 'cái', 'admin_ib', '2026-09-08T00:00:00Z')`).run();
  bulkCategoryId = cat2.meta.last_row_id;

  const loc = await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('common_area', 'Sảnh 1', 'admin_ib', '2026-09-08T00:00:00Z')`).run();
  locationId = loc.meta.last_row_id;
  const inactiveLoc = await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, is_active, created_by, created_at) VALUES ('common_area', 'Kho cũ', 0, 'admin_ib', '2026-09-08T00:00:00Z')`).run();
  inactiveLocationId = inactiveLoc.meta.last_row_id;

  const ind = await env.DB.prepare(
    `INSERT INTO assets (category_id, name, source_type, location_id, quantity, created_by, created_at) VALUES (?, 'Điều hoà Daikin', 'handover_a', ?, 1, 'admin_ib', '2026-09-08T00:00:00Z')`
  ).bind(individualCategoryId, locationId).run();
  individualAssetId = ind.meta.last_row_id;
  const bulk = await env.DB.prepare(
    `INSERT INTO assets (category_id, name, source_type, location_id, quantity, created_by, created_at) VALUES (?, 'Giường 1.6m', 'handover_a', ?, 4, 'admin_ib', '2026-09-08T00:00:00Z')`
  ).bind(bulkCategoryId, locationId).run();
  bulkAssetId = bulk.meta.last_row_id;
});

describe('POST /api/asset-inventory-batches', () => {
  it('creates a batch and auto-populates one line per asset at the location, snapshotting book_quantity', async () => {
    const response = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { results } = await env.DB.prepare(`SELECT asset_id, book_quantity FROM asset_inventory_lines WHERE batch_id = ? ORDER BY asset_id`).bind(id).all();
    expect(results).toEqual([
      { asset_id: individualAssetId, book_quantity: 1 },
      { asset_id: bulkAssetId, book_quantity: 4 },
    ]);
  });

  it('defaults the label from the location name and date when none is given', async () => {
    const response = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await response.json();
    const row = await env.DB.prepare(`SELECT label FROM asset_inventory_batches WHERE id = ?`).bind(id).first();
    expect(row.label).toContain('Sảnh 1');
  });

  it('excludes a soft-deleted asset from the auto-populated lines', async () => {
    await env.DB.prepare(`UPDATE assets SET is_deleted = 1 WHERE id = ?`).bind(bulkAssetId).run();
    const response = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await response.json();
    const { results } = await env.DB.prepare(`SELECT asset_id FROM asset_inventory_lines WHERE batch_id = ?`).bind(id).all();
    expect(results).toEqual([{ asset_id: individualAssetId }]);
  });

  it('rejects an inactive location (400)', async () => {
    const response = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId: inactiveLocationId }), env });
    expect(response.status).toBe(400);
  });

  it('rejects reception (403)', async () => {
    const response = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', receptionToken, 'POST', { locationId }), env });
    expect(response.status).toBe(403);
  });
});

describe('GET /api/asset-inventory-batches', () => {
  it('filters by locationId and status', async () => {
    await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const other = await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('common_area', 'Sảnh 2', 'admin_ib', '2026-09-08T00:00:00Z')`).run();
    await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId: other.meta.last_row_id }), env });

    const response = await listBatches({ request: authedRequest(`https://x/api/asset-inventory-batches?locationId=${locationId}`, observerToken, 'GET'), env });
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].locationId).toBe(locationId);
    expect(body[0].status).toBe('draft');
  });
});

describe('GET /api/asset-inventory-batches/:id', () => {
  it('returns the batch with its lines joined to asset info', async () => {
    const created = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await created.json();

    const response = await getBatch({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, observerToken, 'GET'), env, params: { id: String(id) } });
    const body = await response.json();
    expect(body.status).toBe('draft');
    expect(body.lines).toHaveLength(2);
    const indLine = body.lines.find((l) => l.assetId === individualAssetId);
    expect(indLine.managementType).toBe('individual_device');
    expect(indLine.assetName).toBe('Điều hoà Daikin');
    expect(indLine.bookQuantity).toBe(1);
    expect(indLine.actualQuantity).toBeNull();
  });

  it('404s for a nonexistent batch', async () => {
    const response = await getBatch({ request: authedRequest('https://x/api/asset-inventory-batches/999999', adminToken, 'GET'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });
});

describe('PATCH /api/asset-inventory-batches/:id -- status transitions', () => {
  async function makeBatch() {
    const created = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    return (await created.json()).id;
  }

  it('lets a manager move draft -> counting', async () => {
    const id = await makeBatch();
    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, managerToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status FROM asset_inventory_batches WHERE id = ?`).bind(id).first();
    expect(row.status).toBe('counting');
  });

  it('rejects reception moving draft -> counting (403)', async () => {
    const id = await makeBatch();
    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, receptionToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('lets reception move counting -> pending_close', async () => {
    const id = await makeBatch();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, receptionToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(id) } });
    expect(response.status).toBe(200);
  });

  it('rejects reception moving pending_close -> closed (403)', async () => {
    const id = await makeBatch();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(id) } });
    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, receptionToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });

  it('rejects skipping a state (draft -> pending_close, 400)', async () => {
    const id = await makeBatch();
    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('rejects any transition once closed (terminal)', async () => {
    const id = await makeBatch();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(id) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });
    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });
});

describe('PATCH .../status {closed} -- closing-time reconciliation', () => {
  async function makeCountingBatch() {
    const created = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await created.json();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(id) } });
    return id;
  }

  it('updates a bulk asset quantity and writes asset_inventory_adjustment when actual differs from book', async () => {
    const id = await makeCountingBatch();
    await env.DB.prepare(`UPDATE asset_inventory_lines SET actual_quantity = 3 WHERE batch_id = ? AND asset_id = ?`).bind(id, bulkAssetId).run();

    const response = await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });
    expect(response.status).toBe(200);

    const asset = await env.DB.prepare(`SELECT quantity FROM assets WHERE id = ?`).bind(bulkAssetId).first();
    expect(asset.quantity).toBe(3);

    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_inventory_adjustment' AND entity_id = ?`).bind(bulkAssetId).first();
    expect(audit.old_value).toBe('4');
    expect(audit.new_value).toBe('3');
  });

  it('never changes quantity, location, or lifecycle for an individual asset, even when actual_quantity is 0', async () => {
    const id = await makeCountingBatch();
    await env.DB.prepare(`UPDATE asset_inventory_lines SET actual_quantity = 0 WHERE batch_id = ? AND asset_id = ?`).bind(id, individualAssetId).run();

    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });

    const asset = await env.DB.prepare(`SELECT quantity, location_id, lifecycle_status FROM assets WHERE id = ?`).bind(individualAssetId).first();
    expect(asset.quantity).toBe(1);
    expect(asset.location_id).toBe(locationId);
    expect(asset.lifecycle_status).toBe('dang_quan_ly');
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_inventory_adjustment' AND entity_id = ?`).bind(individualAssetId).first();
    expect(audit).toBeNull();
  });

  it('skips a line whose actual_quantity was never set (NULL), writing no adjustment', async () => {
    const id = await makeCountingBatch();
    // bulkAssetId's line is left untouched -- actual_quantity stays NULL

    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });

    const asset = await env.DB.prepare(`SELECT quantity FROM assets WHERE id = ?`).bind(bulkAssetId).first();
    expect(asset.quantity).toBe(4);
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_inventory_adjustment' AND entity_id = ?`).bind(bulkAssetId).first();
    expect(audit).toBeNull();
  });

  it('does not write an adjustment when actual_quantity equals book_quantity', async () => {
    const id = await makeCountingBatch();
    await env.DB.prepare(`UPDATE asset_inventory_lines SET actual_quantity = 4 WHERE batch_id = ? AND asset_id = ?`).bind(id, bulkAssetId).run();

    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });

    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_inventory_adjustment' AND entity_id = ?`).bind(bulkAssetId).first();
    expect(audit).toBeNull();
  });

  it('stamps closed_by and closed_at on the batch', async () => {
    const id = await makeCountingBatch();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });
    const row = await env.DB.prepare(`SELECT closed_by, closed_at FROM asset_inventory_batches WHERE id = ?`).bind(id).first();
    expect(row.closed_by).toBe('admin_ib');
    expect(row.closed_at).not.toBeNull();
  });
});

describe('POST /api/asset-inventory-batches/:id/refresh-lines', () => {
  it('adds a line for an asset that moved into the location after batch creation, without touching existing lines', async () => {
    const created = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await created.json();
    await env.DB.prepare(`UPDATE asset_inventory_lines SET actual_quantity = 4 WHERE batch_id = ? AND asset_id = ?`).bind(id, bulkAssetId).run();

    const newAsset = await env.DB.prepare(
      `INSERT INTO assets (category_id, name, source_type, location_id, quantity, created_by, created_at) VALUES (?, 'Ghế mới', 'purchased_b', ?, 2, 'admin_ib', '2026-09-08T00:00:00Z')`
    ).bind(bulkCategoryId, locationId).run();

    const response = await refreshLines({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}/refresh-lines`, adminToken, 'POST'), env, params: { id: String(id) } });
    expect(response.status).toBe(200);
    const { addedCount } = await response.json();
    expect(addedCount).toBe(1);

    const { results } = await env.DB.prepare(`SELECT asset_id, actual_quantity FROM asset_inventory_lines WHERE batch_id = ? ORDER BY asset_id`).bind(id).all();
    expect(results).toEqual([
      { asset_id: individualAssetId, actual_quantity: null },
      { asset_id: bulkAssetId, actual_quantity: 4 },
      { asset_id: newAsset.meta.last_row_id, actual_quantity: null },
    ]);
  });

  it('rejects refreshing a closed batch (400)', async () => {
    const created = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await created.json();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'counting' }), env, params: { id: String(id) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(id) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(id) } });

    const response = await refreshLines({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}/refresh-lines`, adminToken, 'POST'), env, params: { id: String(id) } });
    expect(response.status).toBe(400);
  });

  it('rejects reception (403)', async () => {
    const created = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
    const { id } = await created.json();
    const response = await refreshLines({ request: authedRequest(`https://x/api/asset-inventory-batches/${id}/refresh-lines`, receptionToken, 'POST'), env, params: { id: String(id) } });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/assetInventoryBatches.test.js`
Expected: FAIL — modules not found (none of the 3 endpoint files exist yet).

- [ ] **Step 3: Create `functions/api/asset-inventory-batches/index.js`**

```js
// v4/functions/api/asset-inventory-batches/index.js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

function coerceRow(r) {
  return {
    id: r.id,
    locationId: r.location_id,
    label: r.label,
    status: r.status,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const locationId = url.searchParams.get('locationId');
  const status = url.searchParams.get('status');

  const clauses = [];
  const params = [];
  if (locationId) { clauses.push('location_id = ?'); params.push(Number(locationId)); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await env.DB.prepare(
    `SELECT * FROM asset_inventory_batches ${where} ORDER BY id DESC`
  ).bind(...params).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { locationId, label, note } = body || {};

  if (!Number.isInteger(locationId)) return jsonError('Vui lòng chọn vị trí', 400);
  const location = await env.DB.prepare(`SELECT id, name FROM asset_locations WHERE id = ? AND is_active = 1`).bind(locationId).first();
  if (!location) return jsonError('Không tìm thấy vị trí hoặc vị trí đã ngừng sử dụng', 400);

  const now = new Date().toISOString();
  const resolvedLabel = typeof label === 'string' && label.trim() !== '' ? label.trim() : `${location.name} - ${now.slice(0, 10)}`;

  const insert = await env.DB.prepare(
    `INSERT INTO asset_inventory_batches (location_id, label, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(locationId, resolvedLabel, note || null, auth.username, now).run();
  const batchId = insert.meta.last_row_id;

  const { results: assetsAtLocation } = await env.DB.prepare(
    `SELECT id, quantity FROM assets WHERE location_id = ? AND is_deleted = 0`
  ).bind(locationId).all();

  if (assetsAtLocation.length > 0) {
    const lineInserts = assetsAtLocation.map((a) =>
      env.DB.prepare(`INSERT INTO asset_inventory_lines (batch_id, asset_id, book_quantity) VALUES (?, ?, ?)`).bind(batchId, a.id, a.quantity)
    );
    await env.DB.batch(lineInserts);
  }

  return new Response(JSON.stringify({ id: batchId, ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Create `functions/api/asset-inventory-batches/[id].js`**

```js
// v4/functions/api/asset-inventory-batches/[id].js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const INDIVIDUAL_MANAGEMENT_TYPES = ['individual_device', 'device_set'];
const NEXT_STATUS = { draft: 'counting', counting: 'pending_close', pending_close: 'closed' };

function coerceBatch(r) {
  return {
    id: r.id,
    locationId: r.location_id,
    label: r.label,
    status: r.status,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    closedBy: r.closed_by,
    closedAt: r.closed_at,
  };
}

function coerceLine(r) {
  return {
    id: r.id,
    batchId: r.batch_id,
    assetId: r.asset_id,
    assetName: r.asset_name,
    internalCode: r.internal_code,
    managementType: r.management_type,
    bookQuantity: r.book_quantity,
    actualQuantity: r.actual_quantity,
    conditionFound: r.condition_found,
    photoFilename: r.photo_filename,
    note: r.note,
    suggestedAction: r.suggested_action,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const batch = await env.DB.prepare(`SELECT * FROM asset_inventory_batches WHERE id = ?`).bind(params.id).first();
  if (!batch) return jsonError('Không tìm thấy đợt kiểm kê', 404);

  const { results: lines } = await env.DB.prepare(
    `SELECT l.*, a.name AS asset_name, a.internal_code, c.management_type
     FROM asset_inventory_lines l
     JOIN assets a ON a.id = l.asset_id
     JOIN asset_categories c ON c.id = a.category_id
     WHERE l.batch_id = ? ORDER BY a.name`
  ).bind(params.id).all();

  return new Response(JSON.stringify({ ...coerceBatch(batch), lines: lines.map(coerceLine) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception']);
  if (auth instanceof Response) return auth;

  const batch = await env.DB.prepare(`SELECT * FROM asset_inventory_batches WHERE id = ?`).bind(params.id).first();
  if (!batch) return jsonError('Không tìm thấy đợt kiểm kê', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { status } = body || {};

  const expectedNext = NEXT_STATUS[batch.status];
  if (!expectedNext || status !== expectedNext) {
    return jsonError(`Không thể chuyển từ trạng thái "${batch.status}" sang "${status}"`, 400);
  }

  // Reception may only move counting -> pending_close; starting a count and
  // closing a batch stay admin/manager-only, matching every other write in
  // this subsystem's "who can finalize official records" boundary.
  if (status === 'counting' && auth.role === 'reception') {
    return jsonError('Không đủ quyền bắt đầu kiểm kê', 403);
  }
  if (status === 'closed' && auth.role === 'reception') {
    return jsonError('Không đủ quyền chốt đợt kiểm kê', 403);
  }

  const now = new Date().toISOString();

  if (status !== 'closed') {
    await env.DB.prepare(`UPDATE asset_inventory_batches SET status = ? WHERE id = ?`).bind(status, params.id).run();
    return new Response(JSON.stringify({ ok: true, status }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Closing: run the spec §5 reconciliation.
  const { results: lines } = await env.DB.prepare(
    `SELECT l.id, l.asset_id, l.actual_quantity, l.book_quantity, a.quantity AS asset_quantity, a.name AS asset_name, c.management_type
     FROM asset_inventory_lines l
     JOIN assets a ON a.id = l.asset_id
     JOIN asset_categories c ON c.id = a.category_id
     WHERE l.batch_id = ?`
  ).bind(params.id).all();

  const statements = [
    env.DB.prepare(`UPDATE asset_inventory_batches SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ?`).bind(auth.username, now, params.id),
  ];

  for (const line of lines) {
    if (line.actual_quantity === null || line.actual_quantity === undefined) continue; // never counted -- skip, never confuse with 0
    if (INDIVIDUAL_MANAGEMENT_TYPES.includes(line.management_type)) continue; // individual assets: quantity/location/lifecycle never auto-change
    if (line.actual_quantity === line.asset_quantity) continue; // no change

    statements.push(
      env.DB.prepare(`UPDATE assets SET quantity = ?, updated_by = ?, updated_at = ? WHERE id = ?`).bind(line.actual_quantity, auth.username, now, line.asset_id)
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
         VALUES ('asset_inventory_adjustment', 'asset', ?, ?, ?, ?, ?, ?)`
      ).bind(line.asset_id, line.asset_name, String(line.asset_quantity), String(line.actual_quantity), auth.username, now)
    );
  }

  await env.DB.batch(statements);

  return new Response(JSON.stringify({ ok: true, status: 'closed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Create `functions/api/asset-inventory-batches/[id]/refresh-lines.js`**

```js
// v4/functions/api/asset-inventory-batches/[id]/refresh-lines.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager']);
  if (auth instanceof Response) return auth;

  const batch = await env.DB.prepare(`SELECT * FROM asset_inventory_batches WHERE id = ?`).bind(params.id).first();
  if (!batch) return jsonError('Không tìm thấy đợt kiểm kê', 404);
  if (batch.status === 'closed') return jsonError('Đợt kiểm kê đã chốt, không thể làm mới danh sách', 400);

  const { results: assetsAtLocation } = await env.DB.prepare(
    `SELECT id, quantity FROM assets WHERE location_id = ? AND is_deleted = 0`
  ).bind(batch.location_id).all();

  const { results: existingLines } = await env.DB.prepare(`SELECT asset_id FROM asset_inventory_lines WHERE batch_id = ?`).bind(params.id).all();
  const existingAssetIds = new Set(existingLines.map((l) => l.asset_id));

  const newAssets = assetsAtLocation.filter((a) => !existingAssetIds.has(a.id));
  if (newAssets.length > 0) {
    const inserts = newAssets.map((a) =>
      env.DB.prepare(`INSERT INTO asset_inventory_lines (batch_id, asset_id, book_quantity) VALUES (?, ?, ?)`).bind(params.id, a.id, a.quantity)
    );
    await env.DB.batch(inserts);
  }

  return new Response(JSON.stringify({ ok: true, addedCount: newAssets.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd v4 && npx vitest run test/assetInventoryBatches.test.js`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
cd v4
git add functions/api/asset-inventory-batches test/assetInventoryBatches.test.js
git commit -m "feat: add asset inventory batch endpoints (list/create/detail/status/refresh)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Inventory lines backend (edit line, photo attachment, "không tìm thấy" report)

**Files:**
- Create: `v4/functions/api/asset-inventory-lines/[id].js`
- Create: `v4/functions/api/asset-inventory-lines/[id]/photo.js`
- Create: `v4/functions/api/asset-inventory-lines/missing-devices.js`
- Test: `v4/test/assetInventoryLines.test.js`

**Interfaces:**
- Consumes: `asset_inventory_lines`/`asset_inventory_batches` (Task 1/3), `env.RECEIPTS` R2 binding (already bound project-wide, reused with a new key prefix per spec §7).
- Produces: `PATCH /api/asset-inventory-lines/:id`, `POST/GET/DELETE /api/asset-inventory-lines/:id/photo`, `GET /api/asset-inventory-lines/missing-devices` (returns `[{id, batchId, batchLabel, locationId, locationName, closedAt, assetId, assetName, internalCode, note}]`, all 4 roles, spec §6.1's "Thiết bị không tìm thấy" tab reads this). Task 6's client calls all of these by these exact paths and field names.

- [ ] **Step 1: Write the failing tests**

Create `v4/test/assetInventoryLines.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPatch as patchLine } from '../functions/api/asset-inventory-lines/[id].js';
import { onRequestPost as uploadPhoto, onRequestGet as getPhoto, onRequestDelete as deletePhoto } from '../functions/api/asset-inventory-lines/[id]/photo.js';
import { onRequestGet as missingDevices } from '../functions/api/asset-inventory-lines/missing-devices.js';
import { onRequestPost as createBatch } from '../functions/api/asset-inventory-batches/index.js';
import { onRequestPatch as patchBatchStatus } from '../functions/api/asset-inventory-batches/[id].js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken, adminToken;
let individualCategoryId;
let locationId;
let assetId;
let lineId;
let batchId;

function authedRequest(url, token, method, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function uploadRequest(url, token, file) {
  const form = new FormData();
  form.append('file', file);
  const headers = {};
  if (token) headers.Cookie = `session=${token}`;
  return new Request(url, { method: 'POST', headers, body: form });
}

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM assets');
  await env.DB.exec('DELETE FROM asset_categories');
  await env.DB.exec('DELETE FROM asset_locations');
  await env.DB.exec('DELETE FROM asset_inventory_lines');
  await env.DB.exec('DELETE FROM asset_inventory_batches');
  await env.DB.exec('DELETE FROM audit_log');

  const m = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('quan_ly_il', 'x', 'manager', '2026-09-08T00:00:00Z')`).run();
  const r = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('le_tan_il', 'x', 'reception', '2026-09-08T00:00:00Z')`).run();
  const a = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_il', 'x', 'admin', '2026-09-08T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, m.meta.last_row_id);
  receptionToken = await createSession(env.DB, r.meta.last_row_id);
  adminToken = await createSession(env.DB, a.meta.last_row_id);

  const cat = await env.DB.prepare(`INSERT INTO asset_categories (management_type, name, default_unit, created_by, created_at) VALUES ('individual_device', 'Điều hoà', 'bộ', 'admin_il', '2026-09-08T00:00:00Z')`).run();
  individualCategoryId = cat.meta.last_row_id;

  const loc = await env.DB.prepare(`INSERT INTO asset_locations (location_type, name, created_by, created_at) VALUES ('common_area', 'Sảnh 1', 'admin_il', '2026-09-08T00:00:00Z')`).run();
  locationId = loc.meta.last_row_id;

  const asset = await env.DB.prepare(
    `INSERT INTO assets (category_id, name, internal_code, source_type, location_id, quantity, created_by, created_at) VALUES (?, 'Điều hoà Daikin', 'TS000001', 'handover_a', ?, 1, 'admin_il', '2026-09-08T00:00:00Z')`
  ).bind(individualCategoryId, locationId).run();
  assetId = asset.meta.last_row_id;

  const batch = await createBatch({ request: authedRequest('https://x/api/asset-inventory-batches', adminToken, 'POST', { locationId }), env });
  batchId = (await batch.json()).id;
  const line = await env.DB.prepare(`SELECT id FROM asset_inventory_lines WHERE batch_id = ? AND asset_id = ?`).bind(batchId, assetId).first();
  lineId = line.id;
});

async function moveBatchTo(status) {
  const chain = ['counting', 'pending_close', 'closed'];
  const targetIndex = chain.indexOf(status);
  for (let i = 0; i <= targetIndex; i++) {
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${batchId}`, adminToken, 'PATCH', { status: chain[i] }), env, params: { id: String(batchId) } });
  }
}

describe('PATCH /api/asset-inventory-lines/:id', () => {
  it('lets reception fill in a line while the batch is counting', async () => {
    await moveBatchTo('counting');
    const response = await patchLine({
      request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}`, receptionToken, 'PATCH', { actualQuantity: 1, conditionFound: 'tot', note: 'Đủ', suggestedAction: '' }),
      env,
      params: { id: String(lineId) },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT actual_quantity, condition_found, note FROM asset_inventory_lines WHERE id = ?`).bind(lineId).first();
    expect(row).toEqual({ actual_quantity: 1, condition_found: 'tot', note: 'Đủ' });
  });

  it('rejects reception once the batch is pending_close (400)', async () => {
    await moveBatchTo('pending_close');
    const response = await patchLine({
      request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}`, receptionToken, 'PATCH', { actualQuantity: 1 }),
      env,
      params: { id: String(lineId) },
    });
    expect(response.status).toBe(400);
  });

  it('lets a manager fill in a line while pending_close', async () => {
    await moveBatchTo('pending_close');
    const response = await patchLine({
      request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}`, managerToken, 'PATCH', { actualQuantity: 0 }),
      env,
      params: { id: String(lineId) },
    });
    expect(response.status).toBe(200);
  });

  it('rejects any edit once the batch is closed (400)', async () => {
    await moveBatchTo('closed');
    const response = await patchLine({
      request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}`, adminToken, 'PATCH', { actualQuantity: 1 }),
      env,
      params: { id: String(lineId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects an edit while the batch is still draft, even for admin (400)', async () => {
    // No moveBatchTo() call -- the batch created in beforeEach starts in draft
    // and counting hasn't been started yet, so canWriteLine() falls through
    // to its default `false` regardless of role.
    const response = await patchLine({
      request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}`, adminToken, 'PATCH', { actualQuantity: 1 }),
      env,
      params: { id: String(lineId) },
    });
    expect(response.status).toBe(400);
  });

  it('rejects a negative actualQuantity (400)', async () => {
    await moveBatchTo('counting');
    const response = await patchLine({
      request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}`, adminToken, 'PATCH', { actualQuantity: -1 }),
      env,
      params: { id: String(lineId) },
    });
    expect(response.status).toBe(400);
  });

  it('404s for a nonexistent line', async () => {
    const response = await patchLine({ request: authedRequest('https://x/api/asset-inventory-lines/999999', adminToken, 'PATCH', { actualQuantity: 1 }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });
});

describe('POST/GET/DELETE /api/asset-inventory-lines/:id/photo', () => {
  it('uploads a photo while counting and it can be read back', async () => {
    await moveBatchTo('counting');
    const file = new File(['fake-image-bytes'], 'thiet-bi.jpg', { type: 'image/jpeg' });
    const uploadResponse = await uploadPhoto({ request: uploadRequest(`https://x/api/asset-inventory-lines/${lineId}/photo`, receptionToken, file), env, params: { id: String(lineId) } });
    expect(uploadResponse.status).toBe(200);

    const row = await env.DB.prepare(`SELECT photo_key, photo_filename FROM asset_inventory_lines WHERE id = ?`).bind(lineId).first();
    expect(row.photo_filename).toBe('thiet-bi.jpg');
    expect(row.photo_key).toContain(`inventory-line-photos/${lineId}/`);

    const getResponse = await getPhoto({ request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}/photo`, adminToken, 'GET'), env, params: { id: String(lineId) } });
    expect(getResponse.status).toBe(200);
  });

  it('rejects an upload once the batch is closed (400)', async () => {
    await moveBatchTo('closed');
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const response = await uploadPhoto({ request: uploadRequest(`https://x/api/asset-inventory-lines/${lineId}/photo`, adminToken, file), env, params: { id: String(lineId) } });
    expect(response.status).toBe(400);
  });

  it('deletes a photo and clears all 3 columns', async () => {
    await moveBatchTo('counting');
    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    await uploadPhoto({ request: uploadRequest(`https://x/api/asset-inventory-lines/${lineId}/photo`, adminToken, file), env, params: { id: String(lineId) } });

    const response = await deletePhoto({ request: authedRequest(`https://x/api/asset-inventory-lines/${lineId}/photo`, adminToken, 'DELETE'), env, params: { id: String(lineId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT photo_key, photo_filename, photo_uploaded_at FROM asset_inventory_lines WHERE id = ?`).bind(lineId).first();
    expect(row).toEqual({ photo_key: null, photo_filename: null, photo_uploaded_at: null });
  });
});

describe('GET /api/asset-inventory-lines/missing-devices', () => {
  it('lists an individual asset line only once the batch is closed and actual_quantity is 0', async () => {
    await moveBatchTo('counting');
    await env.DB.prepare(`UPDATE asset_inventory_lines SET actual_quantity = 0 WHERE id = ?`).bind(lineId).run();

    const beforeClose = await missingDevices({ request: authedRequest('https://x/api/asset-inventory-lines/missing-devices', receptionToken, 'GET'), env });
    expect(await beforeClose.json()).toEqual([]);

    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${batchId}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(batchId) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${batchId}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(batchId) } });

    const afterClose = await missingDevices({ request: authedRequest('https://x/api/asset-inventory-lines/missing-devices', receptionToken, 'GET'), env });
    const body = await afterClose.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ assetId, assetName: 'Điều hoà Daikin', internalCode: 'TS000001', locationId, batchId });
  });

  it('never lists a line whose actual_quantity is 1 (found)', async () => {
    await moveBatchTo('counting');
    await env.DB.prepare(`UPDATE asset_inventory_lines SET actual_quantity = 1 WHERE id = ?`).bind(lineId).run();
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${batchId}`, adminToken, 'PATCH', { status: 'pending_close' }), env, params: { id: String(batchId) } });
    await patchBatchStatus({ request: authedRequest(`https://x/api/asset-inventory-batches/${batchId}`, adminToken, 'PATCH', { status: 'closed' }), env, params: { id: String(batchId) } });

    const response = await missingDevices({ request: authedRequest('https://x/api/asset-inventory-lines/missing-devices', receptionToken, 'GET'), env });
    expect(await response.json()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/assetInventoryLines.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Create `functions/api/asset-inventory-lines/[id].js`**

```js
// v4/functions/api/asset-inventory-lines/[id].js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_CONDITIONS = ['tot', 'kha', 'trung_binh', 'can_sua', 'chua_danh_gia'];

function canWriteLine(role, batchStatus) {
  if (batchStatus === 'counting') return true;
  if (batchStatus === 'pending_close') return role === 'admin' || role === 'manager';
  return false;
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception']);
  if (auth instanceof Response) return auth;

  const line = await env.DB.prepare(
    `SELECT l.*, b.status AS batch_status FROM asset_inventory_lines l JOIN asset_inventory_batches b ON b.id = l.batch_id WHERE l.id = ?`
  ).bind(params.id).first();
  if (!line) return jsonError('Không tìm thấy dòng kiểm kê', 404);
  if (!canWriteLine(auth.role, line.batch_status)) return jsonError('Không thể sửa dòng kiểm kê ở trạng thái đợt hiện tại', 400);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  body = body || {};

  const actualQuantity = 'actualQuantity' in body ? body.actualQuantity : line.actual_quantity;
  const conditionFound = 'conditionFound' in body ? body.conditionFound : line.condition_found;
  const note = 'note' in body ? body.note : line.note;
  const suggestedAction = 'suggestedAction' in body ? body.suggestedAction : line.suggested_action;

  if (actualQuantity !== null && actualQuantity !== undefined && (!Number.isInteger(actualQuantity) || actualQuantity < 0)) {
    return jsonError('Số lượng thực tế phải là số nguyên không âm', 400);
  }
  if (conditionFound !== null && conditionFound !== undefined && conditionFound !== '' && !VALID_CONDITIONS.includes(conditionFound)) {
    return jsonError('Tình trạng không hợp lệ', 400);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE asset_inventory_lines SET actual_quantity = ?, condition_found = ?, note = ?, suggested_action = ?, updated_by = ?, updated_at = ? WHERE id = ?`
  ).bind(actualQuantity ?? null, conditionFound || null, note || null, suggestedAction || null, auth.username, now, params.id).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Create `functions/api/asset-inventory-lines/[id]/photo.js`**

```js
// v4/functions/api/asset-inventory-lines/[id]/photo.js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function sanitizeFilename(name) {
  return (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

function photoKeyFor(lineId, filename) {
  return `inventory-line-photos/${lineId}/${Date.now()}-${sanitizeFilename(filename)}`;
}

function canWriteLine(role, batchStatus) {
  if (batchStatus === 'counting') return true;
  if (batchStatus === 'pending_close') return role === 'admin' || role === 'manager';
  return false;
}

async function loadLineWithBatchStatus(env, id) {
  return env.DB.prepare(
    `SELECT l.*, b.status AS batch_status FROM asset_inventory_lines l JOIN asset_inventory_batches b ON b.id = l.batch_id WHERE l.id = ?`
  ).bind(id).first();
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception']);
  if (auth instanceof Response) return auth;

  const existing = await loadLineWithBatchStatus(env, params.id);
  if (!existing) return jsonError('Không tìm thấy dòng kiểm kê', 404);
  if (!canWriteLine(auth.role, existing.batch_status)) return jsonError('Không thể sửa dòng kiểm kê ở trạng thái đợt hiện tại', 400);

  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return jsonError('Vui lòng chọn tệp để tải lên', 400);
  if (!ALLOWED_CONTENT_TYPES.includes(file.type)) {
    return jsonError('Chỉ chấp nhận ảnh (JPG/PNG/WebP) hoặc PDF', 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return jsonError('Tệp vượt quá dung lượng tối đa 10MB', 400);
  }

  if (existing.photo_key) {
    await env.RECEIPTS.delete(existing.photo_key);
  }

  const key = photoKeyFor(params.id, file.name);
  await env.RECEIPTS.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE asset_inventory_lines SET photo_key = ?, photo_filename = ?, photo_uploaded_at = ?, updated_by = ?, updated_at = ? WHERE id = ?`
  ).bind(key, file.name, now, auth.username, now, params.id).run();

  return new Response(JSON.stringify({ ok: true, photoFilename: file.name }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception']);
  if (auth instanceof Response) return auth;

  const existing = await loadLineWithBatchStatus(env, params.id);
  if (!existing) return jsonError('Không tìm thấy dòng kiểm kê', 404);
  if (!canWriteLine(auth.role, existing.batch_status)) return jsonError('Không thể sửa dòng kiểm kê ở trạng thái đợt hiện tại', 400);
  if (!existing.photo_key) return jsonError('Dòng kiểm kê này chưa có ảnh đính kèm', 400);

  await env.RECEIPTS.delete(existing.photo_key);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE asset_inventory_lines SET photo_key = NULL, photo_filename = NULL, photo_uploaded_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?`
  ).bind(auth.username, now, params.id).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM asset_inventory_lines WHERE id = ?`).bind(params.id).first();
  if (!existing || !existing.photo_key) return jsonError('Không tìm thấy ảnh', 404);

  const object = await env.RECEIPTS.get(existing.photo_key);
  if (!object) return jsonError('Không tìm thấy ảnh', 404);

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  const displayName = existing.photo_filename || 'anh-kiem-ke';
  headers.set('Content-Disposition', `inline; filename="${sanitizeFilename(displayName)}"; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, no-store');
  return new Response(object.body, { status: 200, headers });
}
```

- [ ] **Step 5: Create `functions/api/asset-inventory-lines/missing-devices.js`**

```js
// v4/functions/api/asset-inventory-lines/missing-devices.js
import { requireAuth } from '../../../lib/requireAuth.js';

function coerceRow(r) {
  return {
    id: r.id,
    batchId: r.batch_id,
    batchLabel: r.batch_label,
    locationId: r.location_id,
    locationName: r.location_name,
    closedAt: r.closed_at,
    assetId: r.asset_id,
    assetName: r.asset_name,
    internalCode: r.internal_code,
    note: r.note,
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['admin', 'manager', 'reception', 'observer']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT l.id, l.batch_id, b.label AS batch_label, b.location_id, loc.name AS location_name, b.closed_at,
            l.asset_id, a.name AS asset_name, a.internal_code, l.note
     FROM asset_inventory_lines l
     JOIN asset_inventory_batches b ON b.id = l.batch_id
     JOIN asset_locations loc ON loc.id = b.location_id
     JOIN assets a ON a.id = l.asset_id
     JOIN asset_categories c ON c.id = a.category_id
     WHERE b.status = 'closed' AND l.actual_quantity = 0 AND c.management_type IN ('individual_device', 'device_set')
     ORDER BY b.closed_at DESC`
  ).all();

  return new Response(JSON.stringify(results.map(coerceRow)), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

Note this file sits at `functions/api/asset-inventory-lines/missing-devices.js` — a sibling of the `[id]` directory, not inside it (same nesting depth as `functions/api/assets/index.js`, hence the `../../../lib/requireAuth.js` import path, 3 levels up).

- [ ] **Step 6: Run to verify it passes**

Run: `cd v4 && npx vitest run test/assetInventoryLines.test.js`
Expected: PASS, all tests.

- [ ] **Step 7: Commit**

```bash
cd v4
git add functions/api/asset-inventory-lines test/assetInventoryLines.test.js
git commit -m "feat: add asset inventory line editing, photo attachment, and missing-devices report

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Asset soft-delete + reconcile-ceiling fix + audit-log registration

**Files:**
- Modify: `v4/functions/api/assets/[id].js` (add `DELETE`, block `PATCH` on a deleted asset)
- Modify: `v4/functions/api/assets/index.js` (GET excludes `is_deleted`, adds `includeDeleted`)
- Modify: `v4/functions/api/asset-source-rows/index.js` (reconciledCount excludes deleted)
- Modify: `v4/functions/api/asset-source-rows/[id]/reconcile.js` (ceiling check excludes deleted)
- Modify: `v4/functions/api/audit-log/index.js`, `v4/admin/audit-log.js`, `v4/admin/audit-log.html` (register `asset_delete`, `asset_inventory_adjustment`)
- Test: `v4/test/assets.test.js` (append), `v4/test/assetReconcile.test.js` (append)

**Interfaces:**
- Consumes: `staff_accounts.can_delete_asset` / `auth.canDeleteAsset` (Task 2).
- Produces: `DELETE /api/assets/:id`. Every later reference to `GET /api/assets` (Task 6's client, if it ever lists assets) must know it now excludes soft-deleted rows by default.

- [ ] **Step 1: Write the failing tests**

Append to `v4/test/assets.test.js` (add this import alongside the existing ones at the top of the file):

```js
import { onRequestDelete as deleteAsset } from '../functions/api/assets/[id].js';
```

Append these `describe` blocks at the end of the file:

```js
describe('DELETE /api/assets/:id', () => {
  async function createTestAsset() {
    const response = await createAsset({
      request: authedRequest('https://x/api/assets', adminToken, 'POST', { categoryId: bulkCategoryId, name: 'Test Delete Asset', sourceType: 'handover_a', quantity: 2 }),
      env,
    });
    return (await response.json()).id;
  }

  it('rejects any role without canDeleteAsset (403), including admin', async () => {
    const assetId = await createTestAsset();
    const response = await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(403);
  });

  it('lets any role with canDeleteAsset delete, regardless of role -- reception here', async () => {
    const assetId = await createTestAsset();
    const receptionRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'le_tan_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(receptionRow.id).run();

    const response = await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, receptionToken, 'DELETE'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT is_deleted FROM assets WHERE id = ?`).bind(assetId).first();
    expect(row.is_deleted).toBe(1);
  });

  it('writes an asset_delete audit_log row', async () => {
    const assetId = await createTestAsset();
    const adminRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'admin_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(adminRow.id).run();

    await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action_type = 'asset_delete' AND entity_id = ?`).bind(assetId).first();
    expect(audit.entity_label).toBe('Test Delete Asset');
    expect(audit.actor).toBe('admin_as');
  });

  it('404s for a nonexistent asset', async () => {
    const adminRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'admin_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(adminRow.id).run();
    const response = await deleteAsset({ request: authedRequest('https://x/api/assets/999999', adminToken, 'DELETE'), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('400s when the asset is already deleted', async () => {
    const assetId = await createTestAsset();
    const adminRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'admin_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(adminRow.id).run();
    await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });

    const response = await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });
    expect(response.status).toBe(400);
  });

  it('excludes a deleted asset from GET /api/assets by default', async () => {
    const assetId = await createTestAsset();
    const adminRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'admin_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(adminRow.id).run();
    await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });

    const response = await listAssets({ request: authedRequest('https://x/api/assets', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body.find((a) => a.id === assetId)).toBeUndefined();
  });

  it('includeDeleted=1 shows it again for admin/manager but is silently ignored for reception', async () => {
    const assetId = await createTestAsset();
    const adminRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'admin_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(adminRow.id).run();
    await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });

    const asAdmin = await listAssets({ request: authedRequest('https://x/api/assets?includeDeleted=1', adminToken, 'GET'), env });
    expect((await asAdmin.json()).find((a) => a.id === assetId)).toBeDefined();

    const asReception = await listAssets({ request: authedRequest('https://x/api/assets?includeDeleted=1', receptionToken, 'GET'), env });
    expect((await asReception.json()).find((a) => a.id === assetId)).toBeUndefined();
  });

  it('rejects PATCH on a deleted asset (400)', async () => {
    const assetId = await createTestAsset();
    const adminRow = await env.DB.prepare(`SELECT id FROM staff_accounts WHERE username = 'admin_as'`).first();
    await env.DB.prepare(`UPDATE staff_accounts SET can_delete_asset = 1 WHERE id = ?`).bind(adminRow.id).run();
    await deleteAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'DELETE'), env, params: { id: String(assetId) } });

    const response = await patchAsset({ request: authedRequest(`https://x/api/assets/${assetId}`, adminToken, 'PATCH', { name: 'Renamed' }), env, params: { id: String(assetId) } });
    expect(response.status).toBe(400);
  });
});
```

Append to `v4/test/assetReconcile.test.js` (this file already imports `reconcileRow`, `listSourceRows`, `createSession`, and already has `individualCategoryId`, `knownRowId` seeded — reuse those, don't reseed):

```js
describe('is_deleted exclusion from reconciliation', () => {
  it('reconciledCount (GET /api/asset-source-rows) drops after the reconciled asset is soft-deleted', async () => {
    const created = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 1 }), env, params: { id: String(knownRowId) } });
    const { createdIds } = await created.json();

    const beforeDelete = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, adminToken, 'GET'), env });
    const rowBefore = (await beforeDelete.json()).find((r) => r.id === knownRowId);
    expect(rowBefore.reconciledCount).toBe(1);

    await env.DB.prepare(`UPDATE assets SET is_deleted = 1 WHERE id = ?`).bind(createdIds[0]).run();

    const afterDelete = await listSourceRows({ request: authedRequest(`https://x/api/asset-source-rows?documentId=${documentId}`, adminToken, 'GET'), env });
    const rowAfter = (await afterDelete.json()).find((r) => r.id === knownRowId);
    expect(rowAfter.reconciledCount).toBe(0);
  });

  it('frees the reconcile ceiling once the previously-reconciled asset is soft-deleted', async () => {
    // knownRowId has raw_quantity '3' -- reconcile all 3, confirm blocked, delete 1, confirm unblocked
    const first = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 3 }), env, params: { id: String(knownRowId) } });
    const { createdIds } = await first.json();

    const blocked = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 1 }), env, params: { id: String(knownRowId) } });
    expect(blocked.status).toBe(400);

    await env.DB.prepare(`UPDATE assets SET is_deleted = 1 WHERE id = ?`).bind(createdIds[0]).run();

    const unblocked = await reconcileRow({ request: authedRequest(`https://x/api/asset-source-rows/${knownRowId}/reconcile`, adminToken, 'POST', { categoryId: individualCategoryId, count: 1 }), env, params: { id: String(knownRowId) } });
    expect(unblocked.status).toBe(201);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd v4 && npx vitest run test/assets.test.js test/assetReconcile.test.js`
Expected: FAIL — `deleteAsset is not a function` (no `onRequestDelete` export yet), and the reconcile-exclusion tests fail because deleting doesn't yet affect either count.

- [ ] **Step 3: Add `DELETE` and the already-deleted guard to `functions/api/assets/[id].js`**

In `v4/functions/api/assets/[id].js`, inside `onRequestPatch`, right after:

```js
  if (!existing) return jsonError('Không tìm thấy tài sản', 404);
```

add:

```js
  if (existing.is_deleted) return jsonError('Tài sản này đã bị xoá', 400);
```

Then append this new export at the end of the file:

```js

export async function onRequestDelete({ request, env, params }) {
  const auth = await requireAuth(request, env, null);
  if (auth instanceof Response) return auth;
  if (!auth.canDeleteAsset) return jsonError('Tài khoản không có quyền xoá tài sản', 403);

  const existing = await env.DB.prepare(`SELECT id, name, is_deleted FROM assets WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy tài sản', 404);
  if (existing.is_deleted) return jsonError('Tài sản này đã bị xoá', 400);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE assets SET is_deleted = 1, updated_by = ?, updated_at = ? WHERE id = ?`).bind(auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('asset_delete', 'asset', ?, ?, NULL, NULL, ?, ?)`
    ).bind(params.id, existing.name, auth.username, now),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Filter deleted assets in `functions/api/assets/index.js`**

In `v4/functions/api/assets/index.js`, replace the `onRequestGet` function's query-building section:

```js
  const url = new URL(request.url);
  const categoryId = url.searchParams.get('categoryId');
  const locationId = url.searchParams.get('locationId');
  const sourceType = url.searchParams.get('sourceType');
  const managementType = url.searchParams.get('managementType');
  const q = url.searchParams.get('q');

  const clauses = [];
  const params = [];
  if (categoryId) { clauses.push('a.category_id = ?'); params.push(Number(categoryId)); }
```

with:

```js
  const url = new URL(request.url);
  const categoryId = url.searchParams.get('categoryId');
  const locationId = url.searchParams.get('locationId');
  const sourceType = url.searchParams.get('sourceType');
  const managementType = url.searchParams.get('managementType');
  const q = url.searchParams.get('q');
  const includeDeleted = url.searchParams.get('includeDeleted') === '1' && (auth.role === 'admin' || auth.role === 'manager');

  const clauses = [];
  const params = [];
  if (!includeDeleted) clauses.push('a.is_deleted = 0');
  if (categoryId) { clauses.push('a.category_id = ?'); params.push(Number(categoryId)); }
```

Also add `isDeleted: !!r.is_deleted,` to `coerceRow` (right after the `note: r.note,` line), so the field is inspectable when `includeDeleted=1` is used.

- [ ] **Step 5: Fix the reconciledCount subqueries to exclude deleted assets**

In `v4/functions/api/asset-source-rows/index.js`, replace:

```js
    `SELECT r.*, (SELECT COALESCE(SUM(quantity), 0) FROM assets WHERE assets.source_row_id = r.id) AS reconciled_count
     FROM asset_source_rows r WHERE r.source_document_id = ? ORDER BY r.stt`
```

with:

```js
    `SELECT r.*, (SELECT COALESCE(SUM(quantity), 0) FROM assets WHERE assets.source_row_id = r.id AND assets.is_deleted = 0) AS reconciled_count
     FROM asset_source_rows r WHERE r.source_document_id = ? ORDER BY r.stt`
```

In `v4/functions/api/asset-source-rows/[id]/reconcile.js`, replace:

```js
  const { reconciled_count: reconciledCount } = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS reconciled_count FROM assets WHERE source_row_id = ?`
  ).bind(params.id).first();
```

with:

```js
  const { reconciled_count: reconciledCount } = await env.DB.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS reconciled_count FROM assets WHERE source_row_id = ? AND is_deleted = 0`
  ).bind(params.id).first();
```

This is the fix that actually closes out the reason this whole delete feature was requested: a wrongly-reconciled asset, once soft-deleted, stops counting against its source row's ceiling, freeing it up to be reconciled correctly.

- [ ] **Step 6: Run to verify it passes**

Run: `cd v4 && npx vitest run test/assets.test.js test/assetReconcile.test.js`
Expected: PASS, all tests including the new ones.

- [ ] **Step 7: Register the 2 new audit_log action types**

In `v4/functions/api/audit-log/index.js`, in the `VALID_ACTION_TYPES` array, add `'asset_delete', 'asset_inventory_adjustment'` right after the existing `'asset_update'` entry (so the array's trailing portion reads `..., 'asset_create', 'asset_update', 'asset_delete', 'asset_inventory_adjustment']`).

In `v4/admin/audit-log.js`, in the `ACTION_TYPE_LABELS` object, add these two entries right after the existing `asset_update: 'Sửa tài sản',` line:

```js
  asset_delete: 'Xoá tài sản',
  asset_inventory_adjustment: 'Điều chỉnh số lượng qua kiểm kê',
```

In `v4/admin/audit-log.html`, in the action-type `<select>`, add these two options right after the existing `<option value="asset_update">Sửa tài sản</option>` line:

```html
        <option value="asset_delete">Xoá tài sản</option>
        <option value="asset_inventory_adjustment">Điều chỉnh số lượng qua kiểm kê</option>
```

- [ ] **Step 8: Commit**

```bash
cd v4
git add functions/api/assets functions/api/asset-source-rows functions/api/audit-log/index.js admin/audit-log.js admin/audit-log.html test/assets.test.js test/assetReconcile.test.js
git commit -m "feat: asset soft-delete, reconcile-ceiling fix, audit-log registration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: "Kiểm kê tài sản" client page + nav/redirects registration

**Files:**
- Create: `v4/admin/asset-inventory.html`
- Create: `v4/admin/asset-inventory.js`
- Modify: `v4/admin/nav-drawer.js`
- Modify: `v4/_redirects`
- Modify: `v4/admin/admin.css`

**Interfaces:**
- Consumes: every endpoint from Task 3/4 by their exact paths and field names (`GET/POST /api/asset-inventory-batches`, `GET/PATCH /api/asset-inventory-batches/:id`, `POST /api/asset-inventory-batches/:id/refresh-lines`, `PATCH /api/asset-inventory-lines/:id`, `POST /api/asset-inventory-lines/:id/photo`, `GET /api/asset-inventory-lines/missing-devices`), plus `GET /api/asset-locations` (Phase 2, already active-only by default).

This task has no dedicated backend test — it's pure client code exercised by Task 8's e2e suite. Verify it manually against a local `http-server` per this project's established convention (see Task 8) before moving on, since there's no automated gate for it until then.

- [ ] **Step 1: Create `admin/asset-inventory.html`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Kiểm kê tài sản — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Kiểm kê tài sản</h1>
    <p id="pageError" class="error"></p>

    <div class="filters" id="inventoryTabToggle">
      <button type="button" class="tab-btn active" data-tab="batches">Các đợt kiểm kê</button>
      <button type="button" class="tab-btn" data-tab="missing">Thiết bị không tìm thấy</button>
    </div>

    <div id="batchesTab">
      <button type="button" id="openCreateBatchBtn" class="hidden">+ Tạo đợt kiểm kê</button>

      <div class="filters" id="batchFilters">
        <select id="batchFilterLocation"><option value="">Tất cả vị trí</option></select>
        <select id="batchFilterStatus">
          <option value="">Tất cả trạng thái</option>
          <option value="draft">Nháp</option>
          <option value="counting">Đang kiểm kê</option>
          <option value="pending_close">Chờ chốt</option>
          <option value="closed">Đã chốt</option>
        </select>
      </div>

      <div id="batchList" class="booking-list"></div>
      <div class="filters" id="batchPagination">
        <button type="button" id="batchPrevBtn" class="btn-secondary">← Trước</button>
        <span id="batchPageInfo"></span>
        <button type="button" id="batchNextBtn" class="btn-secondary">Sau →</button>
      </div>
    </div>

    <div id="missingTab" class="hidden">
      <div id="missingList" class="booking-list"></div>
      <div class="filters" id="missingPagination">
        <button type="button" id="missingPrevBtn" class="btn-secondary">← Trước</button>
        <span id="missingPageInfo"></span>
        <button type="button" id="missingNextBtn" class="btn-secondary">Sau →</button>
      </div>
    </div>
  </div>

  <div id="createBatchOverlay" class="confirm-overlay form-overlay hidden">
    <div class="confirm-box">
      <h3>Tạo đợt kiểm kê</h3>
      <form id="createBatchForm">
        <label>Vị trí
          <select name="locationId" required></select>
        </label>
        <label>Tên đợt (để trống sẽ tự đặt) <input type="text" name="label" /></label>
        <label>Ghi chú <input type="text" name="note" /></label>
        <button type="submit">Tạo</button>
        <button type="button" id="createBatchCancelBtn" class="btn-secondary">Đóng</button>
        <p id="createBatchError" class="error"></p>
      </form>
    </div>
  </div>

  <div id="batchDetailOverlay" class="confirm-overlay form-overlay hidden">
    <div class="confirm-box wide">
      <h3 id="batchDetailTitle"></h3>
      <p id="batchDetailMeta"></p>
      <div id="batchDetailActions"></div>
      <p id="batchDetailError" class="error"></p>
      <div class="table-scroll">
        <table id="batchLinesTable">
          <thead><tr><th>Tài sản</th><th>Số sách</th><th>Số thực tế</th><th>Tình trạng</th><th>Ảnh</th><th>Ghi chú</th><th>Đề nghị xử lý</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <button type="button" id="batchDetailCloseBtn" class="btn-secondary">Đóng</button>
    </div>
  </div>

  <script src="/admin/asset-inventory.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `admin/asset-inventory.js`**

```js
// v4/admin/asset-inventory.js
let currentRole = null;
let locations = [];

let batchesAll = [];
let batchPage = 1;
const BATCH_PAGE_SIZE = 10;

let missingAll = [];
let missingPage = 1;
const MISSING_PAGE_SIZE = 10;

let currentBatch = null;

const BATCH_STATUS_LABELS = { draft: 'Nháp', counting: 'Đang kiểm kê', pending_close: 'Chờ chốt', closed: 'Đã chốt' };
const CONDITION_LABELS = { chua_danh_gia: 'Chưa đánh giá', tot: 'Tốt', kha: 'Khá', trung_binh: 'Trung bình', can_sua: 'Cần sửa' };
const NEXT_STATUS_LABEL = { draft: { next: 'counting', label: 'Bắt đầu kiểm kê' }, counting: { next: 'pending_close', label: 'Gửi chờ chốt' }, pending_close: { next: 'closed', label: 'Chốt đợt' } };

function showPageError(message) {
  document.getElementById('pageError').textContent = message || '';
}

(async () => {
  let res;
  try {
    res = await fetch('/api/auth/me');
  } catch (err) {
    window.location.href = '/admin';
    return;
  }
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;

  if (currentRole === 'admin' || currentRole === 'manager') {
    document.getElementById('openCreateBatchBtn').classList.remove('hidden');
  }

  await loadLocations();
  await loadBatches();

  document.getElementById('batchFilterLocation').addEventListener('change', loadBatches);
  document.getElementById('batchFilterStatus').addEventListener('change', loadBatches);
  document.getElementById('batchPrevBtn').addEventListener('click', () => {
    if (batchPage > 1) { batchPage -= 1; renderBatchPage(); }
  });
  document.getElementById('batchNextBtn').addEventListener('click', () => {
    batchPage += 1; renderBatchPage();
  });
  document.getElementById('missingPrevBtn').addEventListener('click', () => {
    if (missingPage > 1) { missingPage -= 1; renderMissingPage(); }
  });
  document.getElementById('missingNextBtn').addEventListener('click', () => {
    missingPage += 1; renderMissingPage();
  });
})();

document.querySelectorAll('#inventoryTabToggle .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#inventoryTabToggle .tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('batchesTab').classList.toggle('hidden', tab !== 'batches');
    document.getElementById('missingTab').classList.toggle('hidden', tab !== 'missing');
    if (tab === 'missing' && missingAll.length === 0) loadMissingDevices();
  });
});

async function loadLocations() {
  let response;
  try {
    response = await fetch('/api/asset-locations');
  } catch (err) {
    return;
  }
  if (!response.ok) return;
  locations = await response.json();

  const filterSelect = document.getElementById('batchFilterLocation');
  const formSelect = document.querySelector('#createBatchForm select[name="locationId"]');
  while (filterSelect.options.length > 1) filterSelect.remove(1);
  formSelect.innerHTML = '';
  locations.forEach((l) => {
    const filterOpt = document.createElement('option');
    filterOpt.value = l.id;
    filterOpt.textContent = l.name;
    filterSelect.appendChild(filterOpt);

    const formOpt = document.createElement('option');
    formOpt.value = l.id;
    formOpt.textContent = l.name;
    formSelect.appendChild(formOpt);
  });
}

function locationName(locationId) {
  const loc = locations.find((l) => l.id === locationId);
  return loc ? loc.name : 'Không rõ vị trí';
}

async function loadBatches() {
  showPageError('');
  const params = new URLSearchParams();
  const locationId = document.getElementById('batchFilterLocation').value;
  const status = document.getElementById('batchFilterStatus').value;
  if (locationId) params.set('locationId', locationId);
  if (status) params.set('status', status);

  let response;
  try {
    response = await fetch(`/api/asset-inventory-batches?${params.toString()}`);
  } catch (err) {
    showPageError('Có lỗi khi tải danh sách đợt kiểm kê');
    return;
  }
  if (!response.ok) {
    showPageError('Có lỗi khi tải danh sách đợt kiểm kê');
    return;
  }
  batchesAll = await response.json();
  batchPage = 1;
  renderBatchPage();
}

function renderBatchPage() {
  const totalPages = Math.max(1, Math.ceil(batchesAll.length / BATCH_PAGE_SIZE));
  if (batchPage > totalPages) batchPage = totalPages;
  const offset = (batchPage - 1) * BATCH_PAGE_SIZE;
  const pageItems = batchesAll.slice(offset, offset + BATCH_PAGE_SIZE);

  const container = document.getElementById('batchList');
  container.innerHTML = '';
  if (pageItems.length === 0) {
    const p = document.createElement('p');
    p.className = 'booking-empty';
    p.textContent = 'Chưa có đợt kiểm kê nào phù hợp bộ lọc.';
    container.appendChild(p);
  } else {
    pageItems.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'booking-card';
      const line1 = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = b.label;
      line1.appendChild(strong);
      line1.append(` — ${locationName(b.locationId)}`);
      card.appendChild(line1);

      const line2 = document.createElement('p');
      const badge = document.createElement('span');
      badge.className = `status-badge status-${b.status}`;
      badge.textContent = BATCH_STATUS_LABELS[b.status] || b.status;
      line2.appendChild(badge);
      card.appendChild(line2);

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'table-actions-btn';
      openBtn.textContent = 'Xem chi tiết';
      openBtn.addEventListener('click', () => openBatchDetail(b.id));
      card.appendChild(openBtn);

      container.appendChild(card);
    });
  }

  document.getElementById('batchPageInfo').textContent = `Trang ${batchPage}/${totalPages} (${batchesAll.length} kết quả)`;
  document.getElementById('batchPrevBtn').disabled = batchPage <= 1;
  document.getElementById('batchNextBtn').disabled = batchPage >= totalPages;
}

async function loadMissingDevices() {
  let response;
  try {
    response = await fetch('/api/asset-inventory-lines/missing-devices');
  } catch (err) {
    showPageError('Có lỗi khi tải danh sách thiết bị không tìm thấy');
    return;
  }
  if (!response.ok) {
    showPageError('Có lỗi khi tải danh sách thiết bị không tìm thấy');
    return;
  }
  missingAll = await response.json();
  missingPage = 1;
  renderMissingPage();
}

function renderMissingPage() {
  const totalPages = Math.max(1, Math.ceil(missingAll.length / MISSING_PAGE_SIZE));
  if (missingPage > totalPages) missingPage = totalPages;
  const offset = (missingPage - 1) * MISSING_PAGE_SIZE;
  const pageItems = missingAll.slice(offset, offset + MISSING_PAGE_SIZE);

  const container = document.getElementById('missingList');
  container.innerHTML = '';
  if (pageItems.length === 0) {
    const p = document.createElement('p');
    p.className = 'booking-empty';
    p.textContent = 'Không có thiết bị nào được ghi nhận "không tìm thấy".';
    container.appendChild(p);
  } else {
    pageItems.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'booking-card';
      const line1 = document.createElement('p');
      const strong = document.createElement('strong');
      strong.textContent = m.assetName;
      line1.appendChild(strong);
      line1.append(m.internalCode ? ` — ${m.internalCode}` : '');
      card.appendChild(line1);
      const line2 = document.createElement('p');
      line2.textContent = `${m.locationName} — ${m.batchLabel} — chốt ${new Date(m.closedAt).toLocaleDateString('vi-VN')}`;
      card.appendChild(line2);
      if (m.note) {
        const line3 = document.createElement('p');
        line3.textContent = `Ghi chú: ${m.note}`;
        card.appendChild(line3);
      }
      container.appendChild(card);
    });
  }

  document.getElementById('missingPageInfo').textContent = `Trang ${missingPage}/${totalPages} (${missingAll.length} kết quả)`;
  document.getElementById('missingPrevBtn').disabled = missingPage <= 1;
  document.getElementById('missingNextBtn').disabled = missingPage >= totalPages;
}

document.getElementById('openCreateBatchBtn').addEventListener('click', () => {
  document.getElementById('createBatchForm').reset();
  document.getElementById('createBatchError').textContent = '';
  document.getElementById('createBatchOverlay').classList.remove('hidden');
});

document.getElementById('createBatchCancelBtn').addEventListener('click', () => {
  document.getElementById('createBatchOverlay').classList.add('hidden');
});

document.getElementById('createBatchForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const errorEl = document.getElementById('createBatchError');
  errorEl.textContent = '';

  const locationId = Number(form.querySelector('select[name="locationId"]').value);
  if (!locationId) {
    errorEl.textContent = 'Vui lòng chọn vị trí';
    return;
  }
  const label = form.querySelector('input[name="label"]').value.trim();
  const note = form.querySelector('input[name="note"]').value.trim();

  let response;
  try {
    response = await fetch('/api/asset-inventory-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, label: label || undefined, note: note || undefined }),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tạo đợt kiểm kê';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tạo đợt kiểm kê';
    return;
  }
  const { id } = await response.json();
  document.getElementById('createBatchOverlay').classList.add('hidden');
  await loadBatches();
  await openBatchDetail(id);
});

function canTransition(status, role) {
  if (status === 'draft') return role === 'admin' || role === 'manager';
  if (status === 'counting') return role === 'admin' || role === 'manager' || role === 'reception';
  if (status === 'pending_close') return role === 'admin' || role === 'manager';
  return false;
}

function canWriteLine(status, role) {
  if (status === 'counting') return true;
  if (status === 'pending_close') return role === 'admin' || role === 'manager';
  return false;
}

async function openBatchDetail(batchId) {
  document.getElementById('batchDetailError').textContent = '';
  let response;
  try {
    response = await fetch(`/api/asset-inventory-batches/${batchId}`);
  } catch (err) {
    showPageError('Có lỗi khi tải chi tiết đợt kiểm kê');
    return;
  }
  if (!response.ok) {
    showPageError('Có lỗi khi tải chi tiết đợt kiểm kê');
    return;
  }
  currentBatch = await response.json();
  renderBatchDetail();
  document.getElementById('batchDetailOverlay').classList.remove('hidden');
}

function renderBatchDetail() {
  const b = currentBatch;
  document.getElementById('batchDetailTitle').textContent = b.label;
  document.getElementById('batchDetailMeta').textContent = `${locationName(b.locationId)} — ${BATCH_STATUS_LABELS[b.status]} — tạo bởi ${b.createdBy}${b.closedBy ? ` — chốt bởi ${b.closedBy}` : ''}`;

  const actions = document.getElementById('batchDetailActions');
  actions.innerHTML = '';

  if (canTransition(b.status, currentRole)) {
    const info = NEXT_STATUS_LABEL[b.status];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = info.label;
    btn.addEventListener('click', () => transitionBatch(info.next));
    actions.appendChild(btn);
  }

  if (b.status !== 'closed' && (currentRole === 'admin' || currentRole === 'manager')) {
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn-secondary';
    refreshBtn.textContent = 'Làm mới danh sách dòng';
    refreshBtn.addEventListener('click', refreshLines);
    actions.appendChild(refreshBtn);
  }

  const tbody = document.querySelector('#batchLinesTable tbody');
  tbody.innerHTML = '';
  const writable = canWriteLine(b.status, currentRole);
  b.lines.forEach((line) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.textContent = `${line.assetName}${line.internalCode ? ' (' + line.internalCode + ')' : ''}`;
    tr.appendChild(nameTd);

    const bookTd = document.createElement('td');
    bookTd.textContent = line.bookQuantity ?? 'Chưa xác định';
    tr.appendChild(bookTd);

    const actualTd = document.createElement('td');
    const actualInput = document.createElement('input');
    actualInput.type = 'number';
    actualInput.min = '0';
    actualInput.step = '1';
    actualInput.value = line.actualQuantity ?? '';
    actualInput.disabled = !writable;
    actualTd.appendChild(actualInput);
    tr.appendChild(actualTd);

    const conditionTd = document.createElement('td');
    const conditionSelect = document.createElement('select');
    Object.entries(CONDITION_LABELS).forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = line.conditionFound === value;
      conditionSelect.appendChild(opt);
    });
    conditionSelect.disabled = !writable;
    conditionTd.appendChild(conditionSelect);
    tr.appendChild(conditionTd);

    const photoTd = document.createElement('td');
    const photoInfo = document.createElement('span');
    photoInfo.textContent = line.photoFilename || '—';
    photoTd.appendChild(photoInfo);
    if (writable) {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/jpeg,image/png,image/webp,application/pdf';
      fileInput.style.display = 'none';
      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'table-actions-btn';
      uploadBtn.textContent = 'Tải ảnh';
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        if (!fileInput.files[0]) return;
        const formData = new FormData();
        formData.append('file', fileInput.files[0]);
        const errorEl = document.getElementById('batchDetailError');
        let uploadResponse;
        try {
          uploadResponse = await fetch(`/api/asset-inventory-lines/${line.id}/photo`, { method: 'POST', body: formData });
        } catch (err) {
          errorEl.textContent = 'Có lỗi khi tải ảnh lên';
          return;
        }
        if (!uploadResponse.ok) {
          const body = await uploadResponse.json().catch(() => ({}));
          errorEl.textContent = body.error || 'Có lỗi khi tải ảnh lên';
          return;
        }
        await openBatchDetail(currentBatch.id);
      });
      photoTd.appendChild(uploadBtn);
      photoTd.appendChild(fileInput);
    }
    tr.appendChild(photoTd);

    const noteTd = document.createElement('td');
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.value = line.note || '';
    noteInput.disabled = !writable;
    noteTd.appendChild(noteInput);
    tr.appendChild(noteTd);

    const suggestedTd = document.createElement('td');
    const suggestedInput = document.createElement('input');
    suggestedInput.type = 'text';
    suggestedInput.value = line.suggestedAction || '';
    suggestedInput.disabled = !writable;
    suggestedTd.appendChild(suggestedInput);
    tr.appendChild(suggestedTd);

    const saveTd = document.createElement('td');
    if (writable) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'table-actions-btn';
      saveBtn.textContent = 'Lưu';
      saveBtn.addEventListener('click', () => saveLine(line.id, actualInput, conditionSelect, noteInput, suggestedInput));
      saveTd.appendChild(saveBtn);
    }
    tr.appendChild(saveTd);

    tbody.appendChild(tr);
  });
}

async function saveLine(lineId, actualInput, conditionSelect, noteInput, suggestedInput) {
  const errorEl = document.getElementById('batchDetailError');
  errorEl.textContent = '';
  const payload = {
    actualQuantity: actualInput.value === '' ? null : Number(actualInput.value),
    conditionFound: conditionSelect.value,
    note: noteInput.value,
    suggestedAction: suggestedInput.value,
  };
  let response;
  try {
    response = await fetch(`/api/asset-inventory-lines/${lineId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi lưu dòng kiểm kê';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi lưu dòng kiểm kê';
    return;
  }
  await openBatchDetail(currentBatch.id);
}

async function transitionBatch(nextStatus) {
  const errorEl = document.getElementById('batchDetailError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/asset-inventory-batches/${currentBatch.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi chuyển trạng thái';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi chuyển trạng thái';
    return;
  }
  await openBatchDetail(currentBatch.id);
  await loadBatches();
}

async function refreshLines() {
  const errorEl = document.getElementById('batchDetailError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch(`/api/asset-inventory-batches/${currentBatch.id}/refresh-lines`, { method: 'POST' });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi làm mới danh sách dòng';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi làm mới danh sách dòng';
    return;
  }
  await openBatchDetail(currentBatch.id);
}

document.getElementById('batchDetailCloseBtn').addEventListener('click', () => {
  currentBatch = null;
  document.getElementById('batchDetailOverlay').classList.add('hidden');
});
```

- [ ] **Step 3: Add status badge colors for the 3 batch statuses not already covered**

`.status-draft` already exists (grey, shared with finance's draft status — "Nháp" fits the same visual meaning). `counting`/`pending_close`/`closed` have no color rule yet, so their badges would render with no background. In `v4/admin/admin.css`, add these 3 rules right after the existing `.status-paid { background: rgba(120,200,140,0.2); color: #7FD99A; }` line:

```css
.status-counting { background: rgba(120,160,220,0.2); color: #8FB8E8; }
.status-pending_close { background: rgba(217,166,92,0.2); color: #D9A65C; }
.status-closed { background: rgba(120,200,140,0.2); color: #7FD99A; }
```

- [ ] **Step 4: Register the page in `nav-drawer.js`**

In `v4/admin/nav-drawer.js`, in the `NAV_GROUPS` array's `'Tài sản & Kho'` group, replace:

```js
      { page: 'assets.html', label: 'Danh mục tài sản', icon: '🏷️', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
```

with:

```js
      { page: 'assets.html', label: 'Danh mục tài sản', icon: '🏷️', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'asset-inventory.html', label: 'Kiểm kê tài sản', icon: '📦', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
```

In the same file, in the `pageSlug` map literal, add `'asset-inventory.html': 'asset-inventory'` right after the existing `'assets.html': 'assets'` entry.

- [ ] **Step 5: Register clean URLs in `_redirects`**

In `v4/_redirects`, add these 3 lines immediately after the existing `.../assets .../admin/assets 200` lines (one per role prefix, same as every other page in this project):

```
/manager/asset-inventory       /admin/asset-inventory 200
/reception/asset-inventory     /admin/asset-inventory 200
/observer/asset-inventory      /admin/asset-inventory 200
```

- [ ] **Step 6: Commit**

```bash
cd v4
git add admin/asset-inventory.html admin/asset-inventory.js admin/admin.css admin/nav-drawer.js _redirects
git commit -m "feat: add Kiểm kê tài sản admin page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: "Xoá" button on Danh mục tài sản

**Files:**
- Modify: `v4/admin/assets.html`
- Modify: `v4/admin/assets.js`

**Interfaces:**
- Consumes: `DELETE /api/assets/:id` (Task 5), `canDeleteAsset` from `GET /api/auth/me` (Task 2).

No dedicated backend test (the endpoint is already covered by Task 5). Verify manually per Task 8's e2e coverage.

- [ ] **Step 1: Add the confirm overlay markup**

In `v4/admin/assets.html`, insert this new overlay right after the existing `</div>` that closes `#assetFormOverlay` (i.e. right before the closing `</div>` of `#assetFormOverlay`'s wrapper is already there — add the new block as its own top-level sibling, right before the `<script src="/admin/lib/qrcode.min.js">` line):

```html
  <div id="assetDeleteOverlay" class="confirm-overlay hidden">
    <div class="confirm-box">
      <h3>Xác nhận xoá tài sản</h3>
      <p id="assetDeleteSummary"></p>
      <p>Tài sản sẽ bị ẩn khỏi mọi danh sách. Không thể tự khôi phục lại qua giao diện.</p>
      <button type="button" id="assetDeleteConfirmBtn">Xoá tài sản</button>
      <button type="button" id="assetDeleteCancelBtn" class="btn-secondary">Đóng</button>
      <p id="assetDeleteError" class="error"></p>
    </div>
  </div>
```

- [ ] **Step 2: Read `canDeleteAsset` and gate the button independent of role**

In `v4/admin/assets.js`, add a new module-level variable right after `let editingManagementType = null;`:

```js
let canDeleteAsset = false;
```

Replace the init IIFE's auth-handling block:

```js
  const { role } = await res.json();
  currentRole = role;

  if (currentRole === 'admin' || currentRole === 'manager') {
    document.getElementById('openAddAssetBtn').classList.remove('hidden');
  }
```

with:

```js
  const { role, canDeleteAsset: deleteFlag } = await res.json();
  currentRole = role;
  canDeleteAsset = !!deleteFlag;

  if (currentRole === 'admin' || currentRole === 'manager') {
    document.getElementById('openAddAssetBtn').classList.remove('hidden');
  }
```

- [ ] **Step 3: Add the "Xoá" button to each card, independent of the "Sửa" button's role gate**

Replace the actions block inside `renderAssetList`:

```js
    if (currentRole === 'admin' || currentRole === 'manager') {
      const actions = document.createElement('div');
      actions.className = 'booking-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'table-actions-btn';
      editBtn.textContent = 'Sửa';
      editBtn.addEventListener('click', () => openEditAsset(a));
      actions.appendChild(editBtn);
      card.appendChild(actions);
    }
```

with:

```js
    const canEdit = currentRole === 'admin' || currentRole === 'manager';
    if (canEdit || canDeleteAsset) {
      const actions = document.createElement('div');
      actions.className = 'booking-actions';
      if (canEdit) {
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'table-actions-btn';
        editBtn.textContent = 'Sửa';
        editBtn.addEventListener('click', () => openEditAsset(a));
        actions.appendChild(editBtn);
      }
      if (canDeleteAsset) {
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn-secondary table-actions-btn';
        deleteBtn.textContent = 'Xoá';
        deleteBtn.addEventListener('click', () => openDeleteConfirm(a));
        actions.appendChild(deleteBtn);
      }
      card.appendChild(actions);
    }
```

This intentionally decouples "Xoá" from the `canEdit` (admin/manager) gate — per the approved design, `canDeleteAsset` alone controls delete access regardless of role, so a reception account granted the flag sees "Xoá" without ever seeing "Sửa".

- [ ] **Step 4: Wire the confirm overlay**

Append at the end of `v4/admin/assets.js`:

```js
let pendingDeleteAssetId = null;

function openDeleteConfirm(asset) {
  pendingDeleteAssetId = asset.id;
  document.getElementById('assetDeleteError').textContent = '';
  document.getElementById('assetDeleteSummary').textContent = `${asset.name}${asset.internalCode ? ' — ' + asset.internalCode : ''}`;
  document.getElementById('assetDeleteOverlay').classList.remove('hidden');
}

function closeDeleteConfirm() {
  pendingDeleteAssetId = null;
  document.getElementById('assetDeleteOverlay').classList.add('hidden');
}

document.getElementById('assetDeleteCancelBtn').addEventListener('click', closeDeleteConfirm);

document.getElementById('assetDeleteConfirmBtn').addEventListener('click', async () => {
  if (!pendingDeleteAssetId) return;
  const errorEl = document.getElementById('assetDeleteError');
  let response;
  try {
    response = await fetch(`/api/assets/${pendingDeleteAssetId}`, { method: 'DELETE' });
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi xoá tài sản';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi xoá tài sản';
    return;
  }
  closeDeleteConfirm();
  await loadAssets();
});
```

- [ ] **Step 5: Commit**

```bash
cd v4
git add admin/assets.html admin/assets.js
git commit -m "feat: add Xoá button to Danh mục tài sản, gated on canDeleteAsset

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: E2e coverage (outer repo)

**Files:**
- Create: `tests/e2e/asset-inventory.spec.js`
- Modify: `tests/e2e/assets.spec.js` (append Xoá-button coverage)
- Modify: `tests/e2e/crm-users.spec.js` (append the new checkbox's coverage)

**Interfaces:**
- Consumes: every DOM id from Tasks 6-7, and the API contracts from Tasks 2-5.

- [ ] **Step 1: Create `tests/e2e/asset-inventory.spec.js`**

```js
// tests/e2e/asset-inventory.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'common_area', roomId: null, code: null, name: 'Sảnh 1', isActive: true },
];

const SAMPLE_BATCHES = [
  { id: 10, locationId: 1, label: 'Sảnh 1 - 2026-09-08', status: 'draft', note: null, createdBy: 'admin_x', createdAt: '2026-09-08T00:00:00Z', closedBy: null, closedAt: null },
];

const SAMPLE_BATCH_DETAIL = {
  id: 10, locationId: 1, label: 'Sảnh 1 - 2026-09-08', status: 'counting', note: null, createdBy: 'admin_x', createdAt: '2026-09-08T00:00:00Z', closedBy: null, closedAt: null,
  lines: [
    { id: 100, batchId: 10, assetId: 1, assetName: 'Điều hoà Daikin', internalCode: 'TS000001', managementType: 'individual_device', bookQuantity: 1, actualQuantity: null, conditionFound: null, photoFilename: null, note: null, suggestedAction: null, updatedBy: null, updatedAt: null },
    { id: 101, batchId: 10, assetId: 2, assetName: 'Giường 1.6m', internalCode: null, managementType: 'durable_goods', bookQuantity: 4, actualQuantity: null, conditionFound: null, photoFilename: null, note: null, suggestedAction: null, updatedBy: null, updatedAt: null },
  ],
};

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    mockAuth(page, role),
    page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) })),
    page.route('**/api/asset-inventory-batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCHES) })),
    page.route('**/api/asset-inventory-lines/missing-devices', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
  ]);
}

test.describe('Kiểm kê tài sản (admin/asset-inventory.html)', () => {
  test('admin sees the create-batch button; reception does not', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-inventory.html');
    await expect(page.locator('#openCreateBatchBtn')).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.reload();
    await expect(page.locator('#openCreateBatchBtn')).toBeHidden();
  });

  test('creating a batch posts locationId and opens its detail', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    let posted = null;
    await page.route('**/api/asset-inventory-batches', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 10, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCHES) });
    });
    await page.route('**/api/asset-inventory-batches/10', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCH_DETAIL) }));

    await page.goto('/admin/asset-inventory.html');
    await page.click('#openCreateBatchBtn');
    await page.selectOption('#createBatchForm select[name="locationId"]', '1');
    await page.click('#createBatchForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ locationId: 1 });
    await expect(page.locator('#batchDetailOverlay')).toBeVisible();
    await expect(page.locator('#batchDetailTitle')).toHaveText('Sảnh 1 - 2026-09-08');
  });

  test('batch list paginates at 10 per page', async ({ page }) => {
    const manyBatches = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, locationId: 1, label: `Đợt ${i + 1}`, status: 'draft', note: null, createdBy: 'admin_x', createdAt: '2026-09-08T00:00:00Z', closedBy: null, closedAt: null }));
    await mockAuth(page, 'admin');
    await page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) }));
    await page.route('**/api/asset-inventory-batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manyBatches) }));
    await page.route('**/api/asset-inventory-lines/missing-devices', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/asset-inventory.html');
    await expect(page.locator('#batchList .booking-card')).toHaveCount(10);
    await expect(page.locator('#batchPageInfo')).toContainText('Trang 1/3 (23 kết quả)');
    await expect(page.locator('#batchPrevBtn')).toBeDisabled();

    await page.click('#batchNextBtn');
    await expect(page.locator('#batchPageInfo')).toContainText('Trang 2/3');
    await page.click('#batchNextBtn');
    await expect(page.locator('#batchPageInfo')).toContainText('Trang 3/3');
    await expect(page.locator('#batchList .booking-card')).toHaveCount(3);
    await expect(page.locator('#batchNextBtn')).toBeDisabled();
  });

  test('reception can fill in a line while counting and save it', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'reception' });
    await page.route('**/api/asset-inventory-batches/10', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCH_DETAIL) }));
    let patched = null;
    await page.route('**/api/asset-inventory-lines/100', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/asset-inventory.html');
    await page.locator('.booking-card', { hasText: 'Sảnh 1' }).locator('button', { hasText: 'Xem chi tiết' }).click();
    await expect(page.locator('#batchDetailOverlay')).toBeVisible();

    const row = page.locator('#batchLinesTable tbody tr').first();
    await row.locator('input[type="number"]').fill('1');
    await row.locator('select').selectOption('tot');
    await row.locator('button', { hasText: 'Lưu' }).click();

    await expect.poll(() => patched).toMatchObject({ actualQuantity: 1, conditionFound: 'tot' });
  });

  test('reception sees no status-transition button once the batch is pending_close', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'reception' });
    await page.route('**/api/asset-inventory-batches/10', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...SAMPLE_BATCH_DETAIL, status: 'pending_close' }) })
    );

    await page.goto('/admin/asset-inventory.html');
    await page.locator('.booking-card', { hasText: 'Sảnh 1' }).locator('button', { hasText: 'Xem chi tiết' }).click();
    await expect(page.locator('#batchDetailActions')).toBeEmpty();
    await expect(page.locator('#batchLinesTable tbody tr').first().locator('input[type="number"]')).toBeDisabled();
  });

  test('admin sees "Chốt đợt" when pending_close and it PATCHes status:closed', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-inventory-batches/10', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...SAMPLE_BATCH_DETAIL, status: 'pending_close' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'closed' }) });
    });

    await page.goto('/admin/asset-inventory.html');
    await page.locator('.booking-card', { hasText: 'Sảnh 1' }).locator('button', { hasText: 'Xem chi tiết' }).click();
    await expect(page.locator('#batchDetailActions button', { hasText: 'Chốt đợt' })).toBeVisible();
  });

  test('"Thiết bị không tìm thấy" tab lists closed-batch individual lines with actual_quantity 0', async ({ page }) => {
    await mockAuth(page, 'observer');
    await page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) }));
    await page.route('**/api/asset-inventory-batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/asset-inventory-lines/missing-devices', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 100, batchId: 10, batchLabel: 'Sảnh 1 - 2026-09-08', locationId: 1, locationName: 'Sảnh 1', closedAt: '2026-09-08T00:00:00Z', assetId: 1, assetName: 'Điều hoà Daikin', internalCode: 'TS000001', note: null }]),
      })
    );

    await page.goto('/admin/asset-inventory.html');
    await page.click('#inventoryTabToggle button[data-tab="missing"]');
    await expect(page.locator('#missingList')).toContainText('Điều hoà Daikin');
    await expect(page.locator('#missingList')).toContainText('TS000001');
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx playwright test tests/e2e/asset-inventory.spec.js --project=v4`
Expected: PASS, 8/8.

- [ ] **Step 3: Append the Xoá-button coverage to `tests/e2e/assets.spec.js`**

Add this test at the end of the existing `test.describe('Danh mục tài sản (admin/assets.html)', ...)` block (right before its closing `});`), reusing the file's existing `SAMPLE_CATEGORIES`/`SAMPLE_LOCATIONS`/`SAMPLE_ASSETS`/`mockCommonRoutes` already defined at the top:

```js
  test('the Xoá button appears only with canDeleteAsset, independent of role, and DELETEs on confirm', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canDeleteAsset: true }) }));
    await page.route('**/api/asset-categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));
    await page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) }));
    await page.route('**/api/assets**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) }));

    let deletedId = null;
    await page.route('**/api/assets/1', (route) => {
      if (route.request().method() === 'DELETE') {
        deletedId = 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
    });

    await page.goto('/admin/assets.html');
    const card = page.locator('.booking-card', { hasText: 'Điều hoà Daikin' });
    await expect(card.locator('button', { hasText: 'Sửa' })).toHaveCount(0); // reception, no edit rights
    await card.locator('button', { hasText: 'Xoá' }).click();

    await expect(page.locator('#assetDeleteOverlay')).toBeVisible();
    await expect(page.locator('#assetDeleteSummary')).toContainText('TS000001');
    await page.click('#assetDeleteConfirmBtn');

    await expect.poll(() => deletedId).toBe(1);
    await expect(page.locator('#assetDeleteOverlay')).toBeHidden();
  });
```

If this test file's top-level `mockAuth` helper doesn't already exist under that exact name, read the file first and either reuse whatever the file's own `mockCommonRoutes`/auth-mocking helper is actually called, or inline the `page.route('**/api/auth/me', ...)` call directly as shown for the second, more specific mock above (which intentionally overrides any earlier one, since this test needs `canDeleteAsset: true` on the session).

- [ ] **Step 4: Append the checkbox coverage to `tests/e2e/crm-users.spec.js`**

Add these two tests at the end of the file's `test.describe('CRM user management', ...)` block (right before its closing `});`), reusing the file's own `mockUsers`-style route pattern already shown above them in the file:

```js
  test('the "Xoá tài sản" checkbox column exists only for an admin viewer', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, username: 'admin_a', role: 'admin', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, createdAt: '2026-08-01T00:00:00Z' },
          { id: 2, username: 'hienle', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, createdAt: '2026-08-20T00:00:00Z' },
        ]),
      })
    );

    await page.goto('/admin/users.html');
    await expect(page.locator('#deleteAssetColumnHeader')).toBeVisible();
    const targetRow = page.locator('#userTable tbody tr', { hasText: 'hienle' });
    await expect(targetRow.locator('input[title="Xoá tài sản trong Danh mục tài sản"]')).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_ly_a', role: 'manager' }) }));
    await page.reload();
    await expect(page.locator('#deleteAssetColumnHeader')).toBeHidden();
  });

  test('toggling "Xoá tài sản" PATCHes asset-delete-access', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, username: 'admin_a', role: 'admin', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, createdAt: '2026-08-01T00:00:00Z' },
          { id: 2, username: 'hienle', role: 'reception', canManageRoomLayout: false, canAddFinanceTransaction: false, canDeleteAsset: false, createdAt: '2026-08-20T00:00:00Z' },
        ]),
      })
    );
    let lastPayload = null;
    await page.route('**/api/users/2/asset-delete-access', (route) => {
      lastPayload = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/users.html');
    const targetRow = page.locator('#userTable tbody tr', { hasText: 'hienle' });
    await targetRow.locator('input[title="Xoá tài sản trong Danh mục tài sản"]').check();
    await expect.poll(() => lastPayload).toEqual({ canDeleteAsset: true });
  });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx playwright test tests/e2e/assets.spec.js tests/e2e/crm-users.spec.js tests/e2e/asset-inventory.spec.js --project=v4`
Expected: PASS, all tests including the new ones.

- [ ] **Step 6: Run the full v4 project to confirm no regressions**

Run: `npx playwright test --project=v4 --list` first to confirm the current baseline count, then `npx playwright test --project=v4`.
Expected: PASS, baseline + new tests. The single pre-existing `reception-ops-board.spec.js` full-suite-parallel-load flake (see Phase 3a's SDD ledger) may still appear — do not attempt to fix it, it's unrelated to this plan.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/asset-inventory.spec.js tests/e2e/assets.spec.js tests/e2e/crm-users.spec.js
git commit -m "test: e2e coverage for asset inventory counting, asset delete, and the Xoá tài sản permission

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0031 và 0032 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), deploy qua `npx wrangler pages deploy .`.
3. Push repo ngoài (e2e test mới).
4. Smoke-test thực tế trên production:
   - Mở "Kiểm kê tài sản": tạo 1 đợt kiểm kê thử cho 1 vị trí có sẵn, xác nhận danh sách dòng tự populate đúng, điền thử 1 dòng và lưu, chuyển trạng thái Đang kiểm kê → Chờ chốt → Đã chốt, xác nhận số lượng tài sản dạng số lượng có cập nhật đúng sau khi chốt (dùng 1 tài sản test, không phải dữ liệu thật).
   - Mở "Danh mục tài sản": cấp thử quyền "Xoá tài sản" cho 1 tài khoản qua "Quản lý user" (chỉ đăng nhập admin mới thấy được checkbox này), xác nhận nút "Xoá" xuất hiện, xoá thử 1 tài sản test (không phải dữ liệu thật) rồi xác nhận nó biến mất khỏi danh sách và dòng nguồn liên quan (nếu có) mở lại được để đối chiếu.
   - Thu hồi lại quyền "Xoá tài sản" vừa cấp thử, xác nhận checkbox tắt đúng.
