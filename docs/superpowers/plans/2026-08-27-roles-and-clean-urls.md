# Roles & Clean URLs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new staff roles (`admin`, a superset of `manager`; `observer`, read-only) and give the CRM/admin area clean, role-based entry URLs (`/admin`, `/manager`, `/reception`, `/observer`) via Cloudflare Pages rewrites, without moving or duplicating any existing HTML file.

**Architecture:** All existing pages stay physically at `admin/*.html`. A new `v4/_redirects` file maps clean URLs to those files via HTTP-200 rewrites (address bar keeps the clean URL). Because rewrites don't change the actual served path, every relative asset reference (`<script src="x.js">`, `<link href="admin.css">`) in those 8 HTML files must become root-relative (`/admin/x.js`) or it 404s once reached through a clean URL that isn't `/admin/...`. `admin` is added everywhere `manager` is currently allowed (no new capability). `observer` gets new, explicit read-only grants on exactly 4 GET endpoints, with PII (phone/email) stripped from the customer list response.

**Tech Stack:** Cloudflare Pages (static + Functions), D1 (SQLite), vanilla JS, Vitest (`@cloudflare/vitest-pool-workers`), Playwright.

**Spec:** `docs/specs/2026-08-27-roles-and-clean-urls-design.md` (this repo)

## Global Constraints

- `admin` role: added to every `requireAuth` allow-list that currently contains `'manager'`. Never changes `manager`'s own behavior.
- `observer` role: added ONLY to `GET /api/rooms`, `GET /api/bookings`, `GET /api/dashboard/summary`, `GET /api/customers`. Never added to any endpoint that creates, updates, or deletes data — that omission is the enforcement mechanism.
- `GET /api/customers` must null out `phone` and `email` in every row of the response when the caller's role is `observer` (keep the keys present, just `null` — the frontend renderer must not need a different code path per role for missing keys).
- Every relative `<script src>`/`<link href="admin.css">` inside `v4/admin/*.html` becomes root-relative (`/admin/...`). This must be done for all 8 pages (`login.html`, `dashboard.html`, `reception.html`, `customers.html`, `templates.html`, `manager.html`, `users.html`, `change-password.html`) — a page missed here will silently 404 its own JS/CSS the moment it's reached through anything other than the legacy `/admin/*.html` path.
- `nav-drawer.js`'s generated links must be root-relative and role-prefixed (e.g. `/manager/dashboard`), not the current plain filenames (`dashboard.html`).
- The role → clean-URL-prefix map used throughout (login redirect, nav-drawer link generation) is: `admin` → `/manager` (reuses manager's family, per spec), `manager` → `/manager`, `reception` → `/reception`, `observer` → `/observer`.
- D1 migrations are applied with `wrangler d1 migrations apply hien_le_garden_crm --remote` against production, and only after local tests pass — never skip straight to remote apply.
- Never stage `test/policy.test.js` if it shows as modified with no real diff — it's a known CRLF line-ending artifact from this Windows checkout.
- After each task, run the full `npm test` (v4 repo) and, for tasks touching `admin/*` or `_redirects`, the outer repo's `npx playwright test --project=v4` against a local `http-server` on port 4174, per this project's established verification pattern (start server, curl-check readiness, run tests, `taskkill` the server's PID via `netstat`/`tasklist` afterward — never leave it running).

---

### Task 1: Widen the role CHECK constraint

**Files:**
- Create: `v4/migrations/0007_add_admin_observer_roles.sql`
- Test: `v4/test/rolesMigration.test.js`

**Interfaces:**
- Produces: `staff_accounts.role` now accepts `'reception' | 'manager' | 'admin' | 'observer'` (was `'reception' | 'manager'`). No other task depends on a specific interface from this one beyond "the column accepts the two new values without error."

- [ ] **Step 1: Write the failing test**

```js
// v4/test/rolesMigration.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
});

describe('staff_accounts.role CHECK constraint', () => {
  it('accepts admin and observer roles', async () => {
    await env.DB.prepare(
      `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_a', 'x', 'admin', '2026-08-27T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('observer_a', 'x', 'observer', '2026-08-27T00:00:00Z')`
    ).run();
    const { results } = await env.DB.prepare(`SELECT username, role FROM staff_accounts ORDER BY username`).all();
    expect(results).toEqual([
      { username: 'admin_a', role: 'admin' },
      { username: 'observer_a', role: 'observer' },
    ]);
  });

  it('still rejects an invalid role', async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('bad', 'x', 'superuser', '2026-08-27T00:00:00Z')`
      ).run()
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `v4/`): `npm run test:once -- rolesMigration`
Expected: FAIL — `CHECK constraint failed: role` on the `admin_a` insert, because the migration doesn't exist yet and the local D1 still has the old constraint.

- [ ] **Step 3: Write the migration**

```sql
-- v4/migrations/0007_add_admin_observer_roles.sql
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT; rebuild the table with the
-- widened CHECK, copying rows across and preserving id values (sessions.staff_id
-- references staff_accounts.id, so ids must not change).
CREATE TABLE staff_accounts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reception', 'manager', 'admin', 'observer')),
  created_at TEXT NOT NULL
);
INSERT INTO staff_accounts_new SELECT * FROM staff_accounts;
DROP TABLE staff_accounts;
ALTER TABLE staff_accounts_new RENAME TO staff_accounts;
```

- [ ] **Step 4: Apply the migration locally and run the test**

Run: `wrangler d1 migrations apply hien_le_garden_crm --local` then `npm run test:once -- rolesMigration`
Expected: PASS (both tests).

- [ ] **Step 5: Run the full local suite to confirm nothing else broke**

Run: `npm test`
Expected: all existing tests still pass (Windows Miniflare flake aside — if you see an "Isolated storage failed" crash rather than a named `FAIL`, clear `%TEMP%\miniflare-*` and wait ~150s before retrying once).

- [ ] **Step 6: Commit**

```bash
git add migrations/0007_add_admin_observer_roles.sql test/rolesMigration.test.js
git commit -m "Widen staff_accounts.role to accept admin and observer"
```

---

### Task 2: Grant `admin` everywhere `manager` is currently allowed

**Files:**
- Modify: `v4/functions/api/dashboard/summary.js`
- Modify: `v4/functions/api/gift-inventory.js` (both handlers)
- Modify: `v4/functions/api/policy.js` (all three handlers)
- Modify: `v4/functions/api/rooms/reorder.js`
- Modify: `v4/functions/api/templates/index.js` (both handlers), `templates/[id].js` (both handlers), `templates/[id]/activate.js`, `templates/[id]/deactivate.js`
- Modify: `v4/functions/api/users/index.js` (both handlers, plus role-validation whitelist), `users/[id].js`, `users/[id]/role.js` (plus role-validation whitelist)
- Modify: `v4/functions/api/bookings/index.js` (both handlers), `bookings/[id]/confirm.js`, `bookings/[id]/reject.js`, `bookings/[id]/check-in.js`, `bookings/[id]/check-out.js`, `bookings/[id]/cancel.js`, `bookings/staff.js`
- Modify: `v4/functions/api/customers/index.js`, `customers/[id].js`, `customers/[id]/send.js`
- Modify: `v4/functions/api/notification-settings.js`
- Modify: `v4/functions/api/promo/[code].js`, `promo/[code]/claim-gift.js`, `promo/[code]/redeem.js`
- Modify: `v4/functions/api/rooms/index.js`, `rooms/[id]/clean.js`
- Test: `v4/test/managerEndpoints.test.js`, `v4/test/roomsEndpoints.test.js`, `v4/test/usersEndpoints.test.js`, `v4/test/userManagement.test.js`

**Interfaces:**
- Consumes: `requireAuth(request, env, allowedRoles)` from `lib/requireAuth.js` (unchanged signature — role list is just data).
- Produces: every endpoint listed above now returns non-403 for a session with `role: 'admin'`, identically to `role: 'manager'`.

This is mechanical, same-shape find/replace across every file: every occurrence of `['manager']` becomes `['manager', 'admin']`, and every occurrence of `['reception', 'manager']` becomes `['reception', 'manager', 'admin']`. Two files additionally need their inline role-string whitelist widened (not just the `requireAuth` call).

- [ ] **Step 1: Write the failing tests**

Add to `v4/test/managerEndpoints.test.js` (inside the existing `beforeEach`, add an admin fixture user right after the existing manager/reception ones):

```js
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (3, 'admin_a', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminToken = await createSession(env.DB, 3);
```

(Add `let managerToken, receptionToken, adminToken;` at the top alongside the existing `let` line.)

Then add, right after the existing `'lets a manager create a policy'` test in the `describe('POST /api/policy', ...)` block:

```js
  it('lets an admin create a policy', async () => {
    const request = authedRequest('https://x/api/policy', adminToken, 'POST', {
      discountPercent: 20, validFrom: '2026-09-01', validTo: '2026-09-30', giftEnabled: true,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(201);
  });
```

Add to `v4/test/roomsEndpoints.test.js` (add `adminToken` fixture the same way, id 3, role `'admin'`), inside `describe('PATCH /api/rooms/reorder', ...)`:

```js
  it('lets an admin reorder rooms', async () => {
    const { results } = await listRooms({ request: authedRequest('https://x/api/rooms'), env }).then((r) => r.json());
    const ids = results.map((r) => r.id).reverse();
    const request = authedBody('https://x/api/rooms/reorder', adminToken, 'PATCH', { order: ids });
    const response = await reorderRooms({ request, env, params: {} });
    expect(response.status).toBe(200);
  });
```

Add to `v4/test/usersEndpoints.test.js` (add `adminToken` fixture, id 3, role `'admin'`), inside `describe('POST /api/users', ...)`:

```js
  it('lets an admin create a reception account', async () => {
    const request = authedRequest('https://x/api/users', adminToken, 'POST', {
      username: 'new_reception', password: 'password123', role: 'reception',
    });
    const response = await createUser({ request, env });
    expect(response.status).toBe(201);
  });

  it('lets an admin create another admin account', async () => {
    const request = authedRequest('https://x/api/users', adminToken, 'POST', {
      username: 'second_admin', password: 'password123', role: 'admin',
    });
    const response = await createUser({ request, env });
    expect(response.status).toBe(201);
  });

  it('lets a manager create an observer account', async () => {
    const request = authedRequest('https://x/api/users', managerToken, 'POST', {
      username: 'obs_a', password: 'password123', role: 'observer',
    });
    const response = await createUser({ request, env });
    expect(response.status).toBe(201);
  });
```

`v4/test/userManagement.test.js` does not use hardcoded ids — it captures each inserted row's id via `.meta.last_row_id` into module-level `let` variables (`managerAId`, `managerBId`, `receptionId`) inside `beforeEach`. Add an `adminId`/`adminToken` pair the same way: add `adminId, adminToken` to the existing `let managerAId, managerBId, receptionId, managerAToken, receptionToken;` line, add a fourth insert in `beforeEach` (`role: 'admin'`, username `'admin_a'`), capture its id the same way the other three do, and create its session:

```js
  const d = await env.DB.prepare(`INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('admin_a', 'x', 'admin', '2026-08-01T00:00:00Z')`).run();
  adminId = d.meta.last_row_id;
  adminToken = await createSession(env.DB, adminId);
```

Then, inside `describe('PATCH /api/users/:id/role', ...)`:

```js
  it('lets an admin change a role', async () => {
    const request = authedRequest(`https://x/api/users/${receptionId}/role`, adminToken, 'PATCH', { role: 'observer' });
    const response = await changeRole({ request, env, params: { id: String(receptionId) } });
    expect(response.status).toBe(200);
  });
```

(Match each file's existing helper names exactly — read the file before adding, since `authedRequest`'s parameter order differs slightly between `managerEndpoints.test.js` (`url, token, method, body`) and `roomsEndpoints.test.js` (`authedBody(url, token, method, body)` is the one with a body; its bare `authedRequest(url, method)` always uses `managerToken`) — use whichever each file already provides.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:once -- managerEndpoints roomsEndpoints usersEndpoints userManagement`
Expected: FAIL with 403 on every new admin-fixture test (the endpoints don't grant `admin` yet).

- [ ] **Step 3: Grant `admin` in every endpoint**

For each file listed in **Files** above, change every `requireAuth(request, env, ['manager'])` to `requireAuth(request, env, ['manager', 'admin'])`, and every `requireAuth(request, env, ['reception', 'manager'])` to `requireAuth(request, env, ['reception', 'manager', 'admin'])`. Leave every other argument, response shape, and business-logic line untouched.

Additionally, in `functions/api/users/index.js`, change:

```js
  if (role !== 'manager' && role !== 'reception') {
    return jsonError('Vai trò phải là manager hoặc reception', 400);
  }
```

to:

```js
  if (!['manager', 'reception', 'admin', 'observer'].includes(role)) {
    return jsonError('Vai trò phải là manager, reception, admin hoặc observer', 400);
  }
```

and in `functions/api/users/[id]/role.js`, change the identical block the same way.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:once -- managerEndpoints roomsEndpoints usersEndpoints userManagement`
Expected: PASS.

- [ ] **Step 5: Run the full local suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add functions/api test/managerEndpoints.test.js test/roomsEndpoints.test.js test/usersEndpoints.test.js test/userManagement.test.js
git commit -m "Grant admin role everywhere manager is currently allowed"
```

---

### Task 3: Grant `observer` read-only access with PII redaction

**Files:**
- Modify: `v4/functions/api/rooms/index.js`
- Modify: `v4/functions/api/bookings/index.js` (`onRequestGet` only — leave `onRequestPost` untouched)
- Modify: `v4/functions/api/dashboard/summary.js`
- Modify: `v4/functions/api/customers/index.js`
- Test: `v4/test/roomsEndpoints.test.js`, `v4/test/bookingsEndpoints.test.js`, `v4/test/dashboardEndpoint.test.js`, `v4/test/customersEndpoints.test.js`

**Interfaces:**
- Consumes: `auth.role` from the `requireAuth` return value (already available in every handler as the `auth` variable).
- Produces: `GET /api/customers` response rows now always include `phone`/`email` keys, `null` instead of the real value when the caller is `observer`.

- [ ] **Step 1: Write the failing tests**

Add an `observerToken` fixture to each of the four test files' `beforeEach`, following each file's existing fixture pattern exactly (see Task 2 Step 1 for the insert syntax). The id to use depends on what's already seeded in that specific file — `roomsEndpoints.test.js` already has ids 1 (manager) and 2 (reception), and Task 2 just added id 3 (admin) to this same file, so its observer fixture must use **id 4**. `dashboardEndpoint.test.js` has ids 1 (manager) and 2 (reception) only — Task 2 does not touch this file — so its observer fixture uses **id 3**. `customersEndpoints.test.js` and `bookingsEndpoints.test.js` each currently seed only id 1 (manager) — Task 2 does not touch either file — so each of their observer fixtures uses **id 2**.

`v4/test/roomsEndpoints.test.js`, inside `describe('GET /api/rooms', ...)`:

```js
  it('lets an observer view rooms', async () => {
    const request = new Request('https://x/api/rooms', { headers: { Cookie: `session=${observerToken}` } });
    const response = await listRooms({ request, env });
    expect(response.status).toBe(200);
  });
```

`v4/test/bookingsEndpoints.test.js`, inside the existing `describe('GET /api/bookings', ...)` block:

```js
  it('lets an observer list bookings', async () => {
    const request = authedRequest('https://x/api/bookings', observerToken);
    const response = await listBookings({ request, env });
    expect(response.status).toBe(200);
  });
```

`v4/test/dashboardEndpoint.test.js`, inside the existing `describe('GET /api/dashboard/summary', ...)`:

```js
  it('lets an observer view the summary', async () => {
    const response = await getSummary({ request: authedRequest('https://x/api/dashboard/summary', observerToken), env });
    expect(response.status).toBe(200);
  });
```

`v4/test/customersEndpoints.test.js` currently declares `function authedRequest(url, method = 'GET')` which hardcodes `managerToken` in its `Cookie` header — it cannot be reused with a different token as-is. Add a second helper right below it, then a new `describe` block using that helper:

```js
function authedRequestAs(url, token, method = 'GET') {
  return new Request(url, { method, headers: { Cookie: `session=${token}` } });
}

describe('GET /api/customers as observer', () => {
  it('redacts phone and email but keeps every other field', async () => {
    const response = await listCustomers({ request: authedRequestAs('https://x/api/customers', observerToken), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.length).toBeGreaterThan(0);
    body.results.forEach((r) => {
      expect(r.phone).toBeNull();
      expect(r.email).toBeNull();
      expect(r.guestName).not.toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:once -- roomsEndpoints bookingsEndpoints dashboardEndpoint customersEndpoints`
Expected: FAIL with 403 (rooms/bookings/dashboard — observer not yet granted) and a thrown/incorrect assertion on the customers test (redaction not yet implemented).

- [ ] **Step 3: Grant observer read access**

In `functions/api/rooms/index.js`, change:
```js
  const auth = await requireAuth(request, env, ['reception', 'manager']);
```
to:
```js
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
```
(Note: this line already gained `'admin'` in Task 2 — this task adds `'observer'` on top of that result.)

In `functions/api/bookings/index.js`, apply the same change to the `onRequestGet` handler's `requireAuth` call only (the `onRequestPost` handler for creating bookings is a *public* endpoint with no `requireAuth` call at all — confirm this by reading the file; do not add one).

In `functions/api/dashboard/summary.js`, change `requireAuth(request, env, ['manager', 'admin'])` to `requireAuth(request, env, ['manager', 'admin', 'observer'])`.

- [ ] **Step 4: Add PII redaction to the customer list**

In `functions/api/customers/index.js`, change:

```js
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin']);
  if (auth instanceof Response) return auth;
```

to:

```js
  const auth = await requireAuth(request, env, ['reception', 'manager', 'admin', 'observer']);
  if (auth instanceof Response) return auth;
```

and, right after the `pageResults` computation (before the `return new Response(...)` line), insert:

```js
  if (auth.role === 'observer') {
    pageResults.forEach((r) => {
      r.phone = null;
      r.email = null;
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:once -- roomsEndpoints bookingsEndpoints dashboardEndpoint customersEndpoints`
Expected: PASS.

- [ ] **Step 6: Run the full local suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add functions/api/rooms/index.js functions/api/bookings/index.js functions/api/dashboard/summary.js functions/api/customers/index.js test/roomsEndpoints.test.js test/bookingsEndpoints.test.js test/dashboardEndpoint.test.js test/customersEndpoints.test.js
git commit -m "Grant observer read-only access; redact customer PII for observer"
```

---

### Task 4: Root-relative asset paths and login-redirect targets on every admin page

**Files:**
- Modify: `v4/admin/login.html`, `dashboard.html`, `reception.html`, `customers.html`, `templates.html`, `manager.html`, `users.html`, `change-password.html`
- Modify: `v4/admin/change-password.js`, `dashboard.js`, `manager.js`, `templates.js`, `users.js` (their `window.location.href = 'login.html';` 401-redirect lines only — `reception.js` and `customers.js`'s equivalent lines are handled in Tasks 8 and 9 respectively since those tasks already touch those two files for other reasons; `nav-drawer.js`'s is handled in Task 5)

**Interfaces:**
- Produces: every `<link href="admin.css">` becomes `<link href="/admin/admin.css">`; every `<script src="X.js">` becomes `<script src="/admin/X.js">`, for all 8 files. Every remaining `window.location.href = 'login.html';` (client-side 401 redirect) across the whole `admin/` directory becomes `window.location.href = '/admin';` — by the end of this task plus Tasks 5, 8, and 9, no file in `admin/` contains the literal string `'login.html'` anymore. No other task depends on this one's internals, but Tasks 6-10 (which edit the *content* of some of these same JS files) must be rebased on top of this if done out of order — this task's JS edits are limited to the exact single-line redirect targets named above, never any other logic in those files.

- [ ] **Step 1: Make the change in each file**

Run this exact `sed`-equivalent edit in each of the 8 files (via the Edit tool, not a shell one-liner, to keep per-file diffs reviewable): replace `href="admin.css"` with `href="/admin/admin.css"`, and replace every `src="<name>.js"` with `src="/admin/<name>.js"` for that file's own scripts. The full per-file list (from the current repo state):

- `login.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="login.js"` → `src="/admin/login.js"`
- `dashboard.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="dashboard.js"` → `src="/admin/dashboard.js"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`
- `reception.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="reception.js"` → `src="/admin/reception.js"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`
- `customers.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="customers.js"` → `src="/admin/customers.js"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`
- `templates.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="templates.js"` → `src="/admin/templates.js"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`
- `manager.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="manager.js"` → `src="/admin/manager.js"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`
- `users.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="users.js"` → `src="/admin/users.js"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`
- `change-password.html`: `href="admin.css"` → `href="/admin/admin.css"`; `src="nav-drawer.js"` → `src="/admin/nav-drawer.js"`; `src="change-password.js"` → `src="/admin/change-password.js"`

Leave the `favicon.svg`/`favicon-32.png`/`apple-touch-icon.png`/Google Fonts `<link>` tags untouched — they're already root-relative or absolute.

- [ ] **Step 2: Verify no relative reference remains**

Run: `grep -rn 'href="admin.css"\|src="[a-z-]*\.js"' admin/*.html` (from `v4/`)
Expected: no output (empty match) — every reference is now root-relative.

- [ ] **Step 3: Fix the login-redirect target in the five listed JS files**

In each of `admin/change-password.js`, `admin/dashboard.js` (both occurrences — lines 102 and 126 as of this plan's writing), `admin/manager.js`, `admin/templates.js`, `admin/users.js`, change the exact line:

```js
    window.location.href = 'login.html';
```

to:

```js
    window.location.href = '/admin';
```

Leave every other line in each file untouched — this is a single-string-literal change, repeated once per occurrence (twice in `dashboard.js`).

- [ ] **Step 4: Verify no stray reference remains**

Run: `grep -rn "login.html" admin/*.js` (from `v4/`)
Expected: no output — `reception.js` and `customers.js` still have their own occurrence at this point (fixed in Tasks 8 and 9), so re-run this same grep again after those two tasks land and expect empty output only then. For now, confirm the five files touched in this step no longer match.

- [ ] **Step 5: Commit**

```bash
git add admin/*.html admin/change-password.js admin/dashboard.js admin/manager.js admin/templates.js admin/users.js
git commit -m "Make admin page asset references and login redirects root-relative"
```

(No automated test for this step in isolation — Task 11's Playwright suite verifies it end-to-end once the `_redirects` file exists to actually exercise clean URLs. Committing now keeps this mechanical, easy-to-review change isolated from the logic changes in later tasks.)

---

### Task 5: `nav-drawer.js` — role-aware links, widened `NAV_GROUPS`, logout fix

**Files:**
- Modify: `v4/admin/nav-drawer.js`

**Interfaces:**
- Consumes: `role` (one of `'reception' | 'manager' | 'admin' | 'observer'`) from `GET /api/auth/me`, already passed into `buildDrawer(role, username)`.
- Produces: a `ROLE_URL_PREFIX` map other tasks can reference if needed: `{ admin: '/manager', manager: '/manager', reception: '/reception', observer: '/observer' }`.

- [ ] **Step 1: Add the role → URL prefix map and rewrite `currentPageFile()`**

Replace:

```js
function currentPageFile() {
  return window.location.pathname.split('/').pop();
}
```

with:

```js
const ROLE_URL_PREFIX = { admin: '/manager', manager: '/manager', reception: '/reception', observer: '/observer' };

function currentPageFile() {
  return window.location.pathname.split('/').pop();
}
```

(`currentPageFile()` itself needs no change — `location.pathname.split('/').pop()` already returns just the last segment regardless of which clean-URL prefix precedes it, e.g. `/manager/customers` → `customers`. The active-link comparison in `buildDrawer` currently compares against `item.href`, which is about to become a full path — see Step 2.)

- [ ] **Step 2: Widen `NAV_GROUPS` and switch to a `page` key separate from `href`**

Replace the whole `NAV_GROUPS` declaration with:

```js
const NAV_GROUPS = [
  {
    label: 'Vận hành',
    items: [
      { page: 'dashboard.html', label: 'Tổng quan số liệu', icon: '📊', roles: ['manager', 'admin', 'observer'] },
      { page: 'reception.html', label: 'Vận hành hôm nay', icon: '🛎️', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
  {
    label: 'Khách hàng & CRM',
    items: [
      { page: 'customers.html', label: 'Danh sách khách hàng', icon: '👥', roles: ['reception', 'manager', 'admin', 'observer'] },
      { page: 'templates.html', label: 'Kho template', icon: '✉️', roles: ['reception', 'manager', 'admin'] },
    ],
  },
  {
    label: 'Cấu hình & Quản trị',
    items: [
      { page: 'manager.html', label: 'Cấu hình khuyến mãi', icon: '🎁', roles: ['reception', 'manager', 'admin'] },
      { page: 'users.html', label: 'Quản lý user', icon: '🔑', roles: ['manager', 'admin'] },
    ],
  },
];
```

(Renamed `href` → `page` because the value is no longer a usable `<a href>` target on its own — it's now just the bare filename used to build the real, role-prefixed URL.)

- [ ] **Step 3: Compute each link's real URL in `buildDrawer`**

Inside `buildDrawer(role, username)`, right after `const page = currentPageFile();`, add:

```js
  const prefix = ROLE_URL_PREFIX[role] || '/reception';
  const pageSlug = { 'dashboard.html': 'dashboard', 'customers.html': 'customers', 'templates.html': 'templates', 'manager.html': 'config', 'users.html': 'users', 'change-password.html': 'change-password' };
  function urlFor(pageFile) {
    if (pageFile === 'reception.html') return prefix;
    return `${prefix}/${pageSlug[pageFile]}`;
  }
```

Then change the item-building loop from:

```js
    visibleItems.forEach((item) => {
      const a = document.createElement('a');
      a.href = item.href;
      a.className = 'nav-drawer-item' + (item.href === page ? ' active' : '');
      a.textContent = `${item.icon} ${item.label}`;
      groupEl.appendChild(a);
    });
```

to:

```js
    visibleItems.forEach((item) => {
      const a = document.createElement('a');
      a.href = urlFor(item.page);
      a.className = 'nav-drawer-item' + (item.page === page ? ' active' : '');
      a.textContent = `${item.icon} ${item.label}`;
      groupEl.appendChild(a);
    });
```

- [ ] **Step 4: Fix the footer links (home, change-password, logout)**

Replace:

```js
  const changePasswordLink = document.createElement('a');
  changePasswordLink.href = 'change-password.html';
  changePasswordLink.textContent = 'Đổi mật khẩu';
  if (page === 'change-password.html') changePasswordLink.className = 'active';
  const logoutLink = document.createElement('a');
  logoutLink.href = '#';
  logoutLink.textContent = 'Đăng xuất';
  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = 'login.html';
  });
```

with:

```js
  const changePasswordLink = document.createElement('a');
  changePasswordLink.href = urlFor('change-password.html');
  changePasswordLink.textContent = 'Đổi mật khẩu';
  if (page === 'change-password.html') changePasswordLink.className = 'active';
  const logoutLink = document.createElement('a');
  logoutLink.href = '#';
  logoutLink.textContent = 'Đăng xuất';
  logoutLink.addEventListener('click', async (event) => {
    event.preventDefault();
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/admin';
  });
```

(Logout now sends everyone to `/admin`, the shared login page, matching the URL Routing section of the spec — not the old relative `login.html`, which would 404 under a clean URL other than `/admin/*.html`.)

- [ ] **Step 5: Manual verification (no unit test framework covers DOM-building JS in this repo — Playwright in Task 11 covers this end-to-end)**

Read the full modified file back and confirm: `NAV_GROUPS` has no leftover `href:` keys, `urlFor` is defined before first use, and the home link (`homeLink.href = '/'`, added in an earlier session) and its `target="_blank"` are untouched.

- [ ] **Step 6: Commit**

```bash
git add admin/nav-drawer.js
git commit -m "Make nav-drawer role-aware: clean URLs, admin/observer grants, logout target"
```

---

### Task 6: `login.js` — role → landing URL map

**Files:**
- Modify: `v4/admin/login.js`

**Interfaces:**
- Consumes: `{ role }` from `POST /api/auth/login`'s existing response shape (unchanged).

- [ ] **Step 1: Replace the redirect ternary**

Replace:

```js
  const { role } = await response.json();
  window.location.href = role === 'manager' ? 'manager.html' : 'reception.html';
```

with:

```js
  const { role } = await response.json();
  const landing = { admin: '/manager', manager: '/manager', reception: '/reception', observer: '/observer' };
  window.location.href = landing[role] || '/reception';
```

- [ ] **Step 2: Manual verification**

Read the file back; confirm the map matches `ROLE_URL_PREFIX` in `nav-drawer.js` exactly (both must agree, or a role would land somewhere its own nav-drawer doesn't recognize as "home"). Playwright in Task 11 verifies this end-to-end for each role.

- [ ] **Step 3: Commit**

```bash
git add admin/login.js
git commit -m "Redirect every role to its clean-URL ops board after login"
```

---

### Task 7: `users.html`/`users.js` — admin & observer role options

**Files:**
- Modify: `v4/admin/users.html`
- Modify: `v4/admin/users.js`

**Interfaces:**
- Produces: the create-account form and the per-row role `<select>` both offer all 4 roles.

- [ ] **Step 1: Read `users.html`'s create-form role select**

Read `admin/users.html` and find the `<select name="role">` block (per the file as read earlier in this session, it currently has exactly two `<option>`s: `reception` and `manager`).

- [ ] **Step 2: Add the two new options**

Change:

```html
        <select name="role">
          <option value="reception">Lễ tân</option>
          <option value="manager">Quản lý</option>
        </select>
```

to:

```html
        <select name="role">
          <option value="reception">Lễ tân</option>
          <option value="manager">Quản lý</option>
          <option value="admin">Quản trị</option>
          <option value="observer">Người quan sát</option>
        </select>
```

- [ ] **Step 3: Update the per-row role `<select>` and its label map in `users.js`**

Replace:

```js
    const roleSelect = document.createElement('select');
    ['reception', 'manager'].forEach((role) => {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = role === 'manager' ? 'Quản lý' : 'Lễ tân';
      opt.selected = role === u.role;
      roleSelect.appendChild(opt);
    });
```

with:

```js
    const ROLE_LABELS = { manager: 'Quản lý', reception: 'Lễ tân', admin: 'Quản trị', observer: 'Người quan sát' };
    const roleSelect = document.createElement('select');
    Object.keys(ROLE_LABELS).forEach((role) => {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = ROLE_LABELS[role];
      opt.selected = role === u.role;
      roleSelect.appendChild(opt);
    });
```

(Move `const ROLE_LABELS = {...}` to module scope, above `async function loadUsers()`, rather than re-declaring it inside the per-row forEach loop — declaring a `const` inside a loop that runs per-row is harmless here since it's never mutated, but hoisting it once avoids re-creating the same object on every row and matches the codebase's style of declaring constants once.)

- [ ] **Step 4: Manual verification**

Read both files back. Confirm `ROLE_LABELS` is declared once, before `loadUsers`, and used both there and nowhere else needs it (the create-form's labels are static HTML, not JS-generated, so no second usage is expected).

- [ ] **Step 5: Commit**

```bash
git add admin/users.html admin/users.js
git commit -m "Add admin/observer role options to user management UI"
```

---

### Task 8: `reception.js`/`reception.html` — observer read-only mode

**Files:**
- Modify: `v4/admin/reception.html`
- Modify: `v4/admin/reception.js`
- Test: `v4/tests/e2e/reception-ops-board.spec.js` (outer repo — path relative to `hien-le-garden` root: `tests/e2e/reception-ops-board.spec.js`)

**Interfaces:**
- Consumes: `currentRole` (already set in the existing top-level auth IIFE).

- [ ] **Step 1: Wrap the two write-only sections in `reception.html`**

Read `admin/reception.html`. Wrap the "+ Tạo đặt phòng mới" heading and form in a new container, and the "Tra cứu & đổi mã ưu đãi" heading, form, error paragraph, and result section in another:

Change:

```html
    <h2>+ Tạo đặt phòng mới</h2>
    <form id="newBookingForm">
```

to:

```html
    <div id="newBookingSection">
    <h2>+ Tạo đặt phòng mới</h2>
    <form id="newBookingForm">
```

and its closing `</form>` (currently the form's own closing tag, right before `<h2>Cần xử lý</h2>`) gains a matching `</div>` right after it:

```html
    </form>
    </div>

    <h2>Cần xử lý</h2>
```

Change:

```html
    <h2>Tra cứu &amp; đổi mã ưu đãi</h2>
    <form id="lookupForm">
```

to:

```html
    <div id="promoLookupSection">
    <h2>Tra cứu &amp; đổi mã ưu đãi</h2>
    <form id="lookupForm">
```

and after the existing closing `</section>` for `#result`, add:

```html
    </section>
    </div>
```

- [ ] **Step 2: Write the failing e2e test**

Add to `tests/e2e/reception-ops-board.spec.js` (outer repo) — read the file first to match its existing `page.route` mocking style, then add:

```js
  test('observer sees a read-only ops board', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer' }) }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, guestName: 'Khách A', phone: '0900000001', roomType: 'triangle', checkIn: '2026-09-01', checkOut: '2026-09-02', status: 'pending' }]) })
    );
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Triangle 1', roomType: 'triangle', needsCleaning: false, status: 'empty' }]) }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#newBookingSection')).toBeHidden();
    await expect(page.locator('#promoLookupSection')).toBeHidden();
    await expect(page.locator('#pendingList')).toContainText('Khách A');
    await expect(page.locator('#pendingList button')).toHaveCount(0);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run (from outer repo, against a local `http-server . -p 4174 -s -c-1` started from `v4/`): `npx playwright test reception-ops-board --project=v4`
Expected: FAIL — the two sections aren't hidden yet, and pending-list action buttons still render.

- [ ] **Step 4: Fix the login redirect and hide the two sections for observer**

In `reception.js`, inside the top-level auth IIFE, change:

```js
  if (!res.ok) {
    window.location.href = 'login.html';
    return;
  }
```

to:

```js
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
```

Then, right after `currentRole = role;`, add:

```js
  if (currentRole === 'observer') {
    document.getElementById('newBookingSection').classList.add('hidden');
    document.getElementById('promoLookupSection').classList.add('hidden');
  }
```

Then change every `buildActions` callback that appends buttons to skip doing so for observer. `loadPending`:

```js
async function loadPending() {
  const bookings = await fetchBookings('status=pending');
  renderList('pendingList', bookings, 'Không có yêu cầu nào đang chờ.', (actions, b) => {
    if (currentRole === 'observer') return;
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Xác nhận';
    confirmBtn.addEventListener('click', () => openConfirmDialog(b));
    actions.appendChild(confirmBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.textContent = 'Từ chối';
    rejectBtn.className = 'btn-secondary';
    rejectBtn.addEventListener('click', () => rejectBooking(b.id));
    actions.appendChild(rejectBtn);
  });
}
```

Apply the identical one-line guard (`if (currentRole === 'observer') return;` as the first line inside the `buildActions` callback) to `loadArrivals`, `loadUpcomingConfirmed`, and `loadDepartures` — each of their callbacks gets that same first line, then their existing button-creation code is unchanged below it.

In `loadRooms`, guard the "Đã dọn xong" button:

```js
    if (r.status === 'needs_cleaning' && currentRole !== 'observer') {
      const btn = document.createElement('button');
```

(only the `if` condition changes — the rest of that block is unchanged).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx playwright test reception-ops-board --project=v4`
Expected: PASS.

- [ ] **Step 6: Run the full v4 Playwright project to confirm nothing else broke**

Run: `npx playwright test --project=v4`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
# from v4/
git add admin/reception.html admin/reception.js
git commit -m "Hide operational controls on the ops board for observer"
# from the outer hien-le-garden repo
git add tests/e2e/reception-ops-board.spec.js
git commit -m "Add e2e coverage for observer read-only ops board"
```

---

### Task 9: `customers.js` — redacted display, no detail view for observer

**Files:**
- Modify: `v4/admin/customers.js`
- Test: `v4/tests/e2e/crm-customers.spec.js` (outer repo)

**Interfaces:**
- Consumes: `phone: null` from `GET /api/customers` when the caller is observer (Task 3).

- [ ] **Step 1: Track `currentRole` and disable row-click for observer**

Replace:

```js
// admin/customers.js
(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = 'login.html';
  }
})();

let currentPage = 1;
```

with:

```js
// admin/customers.js
let currentRole = null;

(async () => {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;
})();

let currentPage = 1;
```

(Also fixes the pre-existing bug where a failed auth check didn't `return`, letting the rest of the page's code run anyway — and switches the redirect target from the now-broken relative `login.html` to the root-relative `/admin`.)

- [ ] **Step 2: Render redacted phone as an em dash and disable the row click**

Replace:

```js
    const tdPhone = document.createElement('td');
    tdPhone.textContent = c.phone;
```

with:

```js
    const tdPhone = document.createElement('td');
    tdPhone.textContent = c.phone || '—';
```

Replace:

```js
    tr.append(tdName, tdPhone, tdRating, tdPromoCode, tdDiscount, tdStatus, tdDate);
    tr.addEventListener('click', () => showDetail(c.feedbackId));
```

with:

```js
    tr.append(tdName, tdPhone, tdRating, tdPromoCode, tdDiscount, tdStatus, tdDate);
    if (currentRole !== 'observer') {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => showDetail(c.feedbackId));
    }
```

(The pre-existing `tr.style.cursor = 'pointer';` line a few lines above, inside the same `forEach`, becomes redundant with this — remove the original unconditional `tr.style.cursor = 'pointer';` line so it's only set when the row is actually clickable.)

- [ ] **Step 3: Write the failing e2e test**

Add to `tests/e2e/crm-customers.spec.js` (outer repo), a new test in the existing `describe`:

```js
  test('observer sees redacted phone and cannot open detail', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer' }) }));
    await page.route('**/api/customers?**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ results: [{ feedbackId: 'fb-1', guestName: 'Nguyễn Văn A', phone: null, rating: 5, promoCode: 'HLG-AAAA', discountPercent: 10, promoStatus: 'unused', submittedAt: '2026-08-20T10:00:00Z' }], total: 1, page: 1, pageSize: 25 }),
      })
    );

    await page.goto('/admin/customers.html');
    await expect(page.locator('#customerTable tbody tr')).toContainText('—');
    await page.click('#customerTable tbody tr');
    await expect(page.locator('#detailPanel')).toBeHidden();
  });
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx playwright test crm-customers --project=v4`
Expected: FAIL — clicking the row still opens the (now-broken, since the mocked detail route doesn't exist) detail panel, or the em dash isn't rendered yet.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx playwright test crm-customers --project=v4`
Expected: PASS (after Steps 1-2 above are in place).

- [ ] **Step 6: Run the full v4 Playwright project**

Run: `npx playwright test --project=v4`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
# from v4/
git add admin/customers.js
git commit -m "Render redacted customer PII; disable detail view for observer"
# from the outer hien-le-garden repo
git add tests/e2e/crm-customers.spec.js
git commit -m "Add e2e coverage for observer's redacted customer list"
```

---

### Task 10: `_redirects` — the clean URL rewrite table

**Files:**
- Create: `v4/_redirects`
- Test: `v4/tests/seo/links.spec.js` is NOT extended here (it only walks public marketing pages) — Task 11 adds dedicated clean-URL Playwright coverage.

**Interfaces:**
- Produces: the 15 rewrite rules from the spec, verified end-to-end by Task 11.

- [ ] **Step 1: Write the file**

```
# v4/_redirects
# Clean, role-based entry URLs for the CRM/admin area. HTTP-200 rewrites --
# the browser's address bar keeps the clean URL; the body comes from the
# existing physical file in admin/. Every page referenced here already has
# its own client-side role check via GET /api/auth/me (unauthorized visits
# get redirected to /admin, the shared login page, by that page's own JS).

/admin                        /admin/login.html           200

/manager                      /admin/reception.html       200
/manager/dashboard            /admin/dashboard.html       200
/manager/customers            /admin/customers.html       200
/manager/templates            /admin/templates.html       200
/manager/config               /admin/manager.html         200
/manager/users                /admin/users.html            200
/manager/change-password      /admin/change-password.html 200

/reception                    /admin/reception.html       200
/reception/customers          /admin/customers.html       200
/reception/templates          /admin/templates.html       200
/reception/config             /admin/manager.html         200
/reception/change-password    /admin/change-password.html 200

/observer                     /admin/reception.html       200
/observer/dashboard           /admin/dashboard.html       200
/observer/customers           /admin/customers.html       200
/observer/change-password     /admin/change-password.html 200
```

- [ ] **Step 2: Confirm the file isn't excluded from the deployed static bundle**

Read `v4/.assetsignore` (referenced in `BACKEND.md`) and confirm `_redirects` is not listed there (Cloudflare Pages requires this file to actually ship in the deployed output to take effect — unlike `wrangler.toml`/`test/`/`migrations/`, which `.assetsignore` deliberately keeps out of the public upload).

- [ ] **Step 3: Commit**

```bash
git add _redirects
git commit -m "Add clean role-based URL rewrites"
```

(No local test framework exercises Cloudflare Pages' `_redirects` rewrite behavior — `wrangler pages dev` and the production deploy are the only environments that honor it. Task 11 verifies it against the real deployed site.)

---

### Task 11: End-to-end verification of clean URLs per role

**Files:**
- Create: `v4/tests/e2e/clean-urls.spec.js` — wait, this repo's e2e tests live in the **outer** repo. Create: `tests/e2e/clean-urls.spec.js` (outer `hien-le-garden` repo)

**Interfaces:**
- Consumes: every page and role from Tasks 1-10.

Local `http-server` does not read `_redirects` (that's a Cloudflare Pages-specific mechanism), so this task's tests can only be run meaningfully against a real Cloudflare Pages deployment, not the local `http-server:4174` setup this project's other Playwright tests use. Write the test now; it is verified in Task 12 after deployment, not locally.

- [ ] **Step 1: Write the test**

```js
// tests/e2e/clean-urls.spec.js
const { test, expect } = require('@playwright/test');

// These assert against the live Cloudflare Pages deployment because
// _redirects rewrites are not honored by the local http-server used for
// the rest of this project's e2e suite. Run manually after deploying:
// npx playwright test clean-urls --project=v4-live
// (see playwright.config.js for a v4-live project pointing at
// https://hien-le-garden-v4.pages.dev, added in this task if it doesn't
// already exist.)

test.describe('Clean role-based URLs', () => {
  const cases = [
    { url: '/admin', expectTitle: /Đăng nhập|Login/i },
    { url: '/manager', expectRedirectToLogin: true },
    { url: '/reception', expectRedirectToLogin: true },
    { url: '/observer', expectRedirectToLogin: true },
    { url: '/manager/dashboard', expectRedirectToLogin: true },
    { url: '/manager/customers', expectRedirectToLogin: true },
    { url: '/reception/customers', expectRedirectToLogin: true },
    { url: '/observer/customers', expectRedirectToLogin: true },
  ];

  for (const c of cases) {
    test(`${c.url} serves content without a 404`, async ({ page }) => {
      const response = await page.goto(c.url);
      expect(response.status()).toBeLessThan(400);
      // Every unauthenticated visit to a role page bounces to /admin via
      // each page's own client-side auth check.
      if (c.expectRedirectToLogin) {
        await page.waitForURL('**/admin');
      }
      // Confirm the page's own JS assets actually loaded (no console 404s
      // for nav-drawer.js/admin.css under this URL).
      const failed = [];
      page.on('requestfailed', (req) => failed.push(req.url()));
      await page.waitForLoadState('networkidle');
      expect(failed).toEqual([]);
    });
  }
});
```

- [ ] **Step 2: Check whether a `v4-live` Playwright project already exists**

Read `playwright.config.js` (outer repo root). If no project points `baseURL` at `https://hien-le-garden-v4.pages.dev`, add one:

```js
    {
      name: 'v4-live',
      use: { ...devices['Desktop Chrome'], baseURL: 'https://hien-le-garden-v4.pages.dev' },
      testMatch: /clean-urls\.spec\.js/,
    },
```

(Match the existing `projects` array's structure exactly — read the file first and follow its established `devices`/`use` pattern rather than guessing at syntax.)

- [ ] **Step 3: Commit (test is written now, run in Task 12 after deploy)**

```bash
git add tests/e2e/clean-urls.spec.js playwright.config.js
git commit -m "Add live clean-URL e2e coverage (run after deploy)"
```

---

### Task 12: Apply migration, deploy, run live verification

**Files:** none (operational task)

- [ ] **Step 1: Apply the migration to production D1**

Run (from `v4/`): `wrangler d1 migrations apply hien_le_garden_crm --remote`
Expected: confirms `0007_add_admin_observer_roles.sql` applied.

- [ ] **Step 2: Push and let CI deploy, or deploy manually**

Push all commits from Tasks 1-11 (both repos) to `main`. Confirm `.github/workflows/deploy.yml` runs and completes (or run `npm run deploy` manually from `v4/` per `BACKEND.md`).

- [ ] **Step 3: Run the live clean-URL suite**

Run (outer repo): `npx playwright test clean-urls --project=v4-live`
Expected: PASS — every clean URL resolves without a 404 and correctly bounces unauthenticated visitors to `/admin`.

- [ ] **Step 4: Manual smoke test with a real observer account**

Using `wrangler d1 execute hien_le_garden_crm --remote` or the `/manager/users` UI (logged in as an existing manager/admin), create one `observer`-role account. Log in as that account at `/admin` and confirm: lands on `/observer`, sees the ops board with no action buttons, `/observer/dashboard` shows stats, `/observer/customers` shows the list with blank phone column and non-clickable rows, and `/observer/config` (not a defined route) 404s as expected since observer has no promo-config access.

- [ ] **Step 5: Report completion**

No commit — this task is verification only.
