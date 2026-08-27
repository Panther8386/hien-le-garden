# Roles & Clean URLs — Design

**Date:** 2026-08-27
**Repo:** `hien-le-garden-v4` (`v4/` in this monorepo checkout)
**Status:** Approved by user, ready for implementation planning

## Problem

The CRM/admin area currently has two roles (`reception`, `manager`) and every
page lives at a flat, unbranded path (`/admin/dashboard.html`,
`/admin/customers.html`, …). The site owner wants:

1. Clean, memorable entry URLs per audience: `/admin`, `/manager`,
   `/reception`, and a new `/observer`.
2. A new `admin` role that is a strict superset of `manager` (same
   permissions, intended for whoever has ultimate authority over the
   system — e.g. the business owner).
3. A new `observer` role: read-only visibility into daily operations and
   manager-level stats, with no ability to take any operational or
   configuration action, and with guest PII (phone, email) hidden from the
   one list view it can see.
4. Every role lands on the "Vận hành hôm nay" (daily ops board) screen
   immediately after login, not a role-specific landing page as today.

## Roles & Permissions Matrix

| Capability | admin | manager | reception | observer |
|---|---|---|---|---|
| View ops board (rooms + pending/confirmed bookings) | ✅ | ✅ | ✅ | ✅ (read-only) |
| Confirm / reject booking requests | ✅ | ✅ | ✅ | ❌ |
| Check in / check out / cancel a booking | ✅ | ✅ | ✅ | ❌ |
| Drag-reorder room display order | ✅ | ✅ | ❌ | ❌ |
| Clean a room | ✅ | ✅ | ✅ | ❌ |
| View manager stats dashboard | ✅ | ✅ | ❌ | ✅ (read-only) |
| View customer list | ✅ | ✅ | ✅ | ✅ (phone & email hidden) |
| View customer detail / send message | ✅ | ✅ | ✅ | ❌ |
| Configure promo policy (create/list/delete) | ✅ | ✅ | list only | ❌ |
| Manage gift inventory | ✅ | ✅ | view only | ❌ |
| Manage Telegram staff-notification settings | ✅ | ✅ | view status only | ❌ |
| Manage message templates | ✅ | ✅ | use in send form only | ❌ |
| Manage user accounts | ✅ | ✅ | ❌ | ❌ |
| Change own password | ✅ | ✅ | ✅ | ✅ |

`admin` is implemented as "everywhere `manager` is currently allowed, `admin`
is allowed too" — no endpoint changes behavior for `manager`, and no new
capability is introduced that `manager` doesn't already have. The
distinction between the two is purely about which humans hold the role.

`observer` is implemented as new read-only grants on a short, explicit list
of `GET` endpoints (below) — never added to any endpoint that creates,
updates, or deletes data. This means observer's restriction is enforced at
the API layer, not just hidden in the UI.

## URL Routing

Cloudflare Pages' `_redirects` file supports rewrites (HTTP 200, not a real
redirect — the browser's address bar keeps the clean URL while the response
body is served from the target file). Add `v4/_redirects` mapping every
clean URL to its existing physical file. No HTML files move or get
duplicated.

`/admin` is the shared staff login front door — every role signs in there
(it rewrites to the existing `admin/login.html`). It is **not** a
post-login landing on its own; because `admin`'s permissions are a strict
superset of `manager`'s, an admin-role user's post-login landing and every
subsequent nav link reuses the `/manager/*` clean-URL family. This avoids
inventing a fourth parallel URL family for a role that has no page or
capability `manager` lacks.

```
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

This is the complete, final rewrite table — 1 login route + 6 `/manager/*`
+ 4 `/reception/*` + 4 `/observer/*` = 15 rules, enumerated directly from
the permissions matrix above (a role's clean-URL family has one entry per
page it can reach; `templates` and `users` are absent from `/observer/*`
and `users`/`dashboard` are absent from `/reception/*`, matching the
matrix).

All pages continue to read `role` from `GET /api/auth/me` and build their
own nav/UI client-side — the clean URL is purely cosmetic routing, not a
new server-side concept. `nav-drawer.js`'s existing `currentPageFile()`
helper (derives the active nav item from `location.pathname`) needs to
strip a leading `/admin`, `/manager`, `/reception`, or `/observer` segment
before comparing against the drawer's `item.href` list, since the same
physical file is now reachable at multiple clean paths.

## Login Flow

`login.js` currently does `role === 'manager' ? 'manager.html' : 'reception.html'`.
Change this to a role → landing-URL map: `{ admin: '/manager', manager:
'/manager', reception: '/reception', observer: '/observer' }` — every role's
first screen after login is the ops board, reached through that role's own
clean-URL family (`admin` reuses `/manager`'s, per the URL Routing section
above).

## Observer Read-Only Ops Board

`reception.js` currently renders confirm/reject buttons and (for managers)
wires up room drag-and-drop unconditionally once role is known. Add an
`isReadOnly = currentRole === 'observer'` check: when true, skip attaching
click handlers to confirm/reject buttons (or don't render them at all —
render as plain text/badges instead) and skip enabling the drag-and-drop
listeners (already gated to `manager` only — extend the same gate to also
exclude `observer` implicitly, since drag is `manager`-only already).

## Data Model

The real table (confirmed in `migrations/0001_init.sql`) is `staff_accounts`,
not `users` — `functions/api/users/*.js` is the endpoint *path* naming, the
underlying table is `staff_accounts`. `sessions.staff_id` references
`staff_accounts.id`, so the rebuild below must preserve `id` values exactly
(`INSERT INTO ... SELECT *` does this).

`migrations/0007_add_admin_observer_roles.sql`:

```sql
-- SQLite has no ALTER TABLE ... DROP CONSTRAINT; recreate the table with the
-- widened CHECK, copy data across, then swap. Preserves id values so
-- sessions.staff_id references stay valid.
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

## Customer List PII Redaction for Observer

`GET /api/customers` (`functions/api/customers/index.js`) adds `'observer'`
to its `requireAuth` allow-list. After building `mapped`, when
`auth.role === 'observer'`, strip `phone` and `email` from each row (set to
`null`, not omit the key — keeps the response shape stable for the shared
frontend table renderer). `customers.js` renders `null` phone/email as an
em dash or blank cell; no other behavior changes. The customer detail
endpoint (`GET /api/customers/:id`) and the send-message flow are **not**
granted to `observer` — the customers page for observer shows the list only,
with the row-click-to-open-detail interaction disabled when
`currentRole === 'observer'`.

## Endpoints Gaining `admin`

Every endpoint currently listing `'manager'` in its `requireAuth` allow-list
gains `'admin'` alongside it. Full enumeration (from a repo-wide grep,
confirmed at plan time): `dashboard/summary.js`, `gift-inventory.js` (both
handlers), `policy.js` (all three handlers), `rooms/reorder.js`,
`templates/*.js` (all five handlers), `users/*.js` (all three handlers), and
every `['reception', 'manager']` pair across `bookings/*`, `customers/*`,
`notification-settings.js`, `promo/*`, `rooms/index.js`,
`rooms/[id]/clean.js` becomes `['reception', 'manager', 'admin']`.

## Endpoints Gaining `observer` (read-only)

- `GET /api/rooms` (`rooms/index.js`)
- `GET /api/bookings` (`bookings/index.js`)
- `GET /api/dashboard/summary`
- `GET /api/customers` (with PII redaction, above)

No other endpoint grants `observer` access. Write endpoints
(`bookings/[id]/confirm|reject|check-in|check-out|cancel`,
`rooms/reorder`, `rooms/[id]/clean`, `policy.js` POST/DELETE,
`gift-inventory.js` POST, `templates/*` mutations, `users/*` mutations,
`customers/[id]/send.js`) are left untouched — `observer` is absent from
their allow-lists by omission, which is the enforcement mechanism.

## User Management UI

`users.html`'s role `<select>` gains two new `<option>`s: `admin` (label
"Quản trị") and `observer` (label "Người quan sát"), alongside the existing
`manager` ("Quản lý") and `reception` ("Lễ tân"). `users.js`'s
`managerCount`/`isLastManager` last-manager-protection logic is unaffected
(it only concerns the `manager` role specifically, unchanged).

## Nav Drawer

`nav-drawer.js`'s `NAV_GROUPS` items gain `'admin'` wherever `'manager'`
appears, and a subset of items gain `'observer'`:

```js
const NAV_GROUPS = [
  {
    label: 'Vận hành',
    items: [
      { href: 'dashboard.html', label: 'Tổng quan số liệu', icon: '📊', roles: ['manager', 'admin', 'observer'] },
      { href: 'reception.html', label: 'Vận hành hôm nay', icon: '🛎️', roles: ['reception', 'manager', 'admin', 'observer'] },
    ],
  },
  {
    label: 'Khách hàng & CRM',
    items: [
      { href: 'customers.html', label: 'Danh sách khách hàng', icon: '👥', roles: ['reception', 'manager', 'admin', 'observer'] },
      { href: 'templates.html', label: 'Kho template', icon: '✉️', roles: ['reception', 'manager', 'admin'] },
    ],
  },
  {
    label: 'Cấu hình & Quản trị',
    items: [
      { href: 'manager.html', label: 'Cấu hình khuyến mãi', icon: '🎁', roles: ['reception', 'manager', 'admin'] },
      { href: 'users.html', label: 'Quản lý user', icon: '🔑', roles: ['manager', 'admin'] },
    ],
  },
];
```

The drawer's generated `<a href>` targets currently point at plain
filenames (`dashboard.html`, …). As established below, these must become
root-relative clean URLs computed from `currentRole` — see next section for
why and exactly what changes.

## Critical Implementation Detail: Relative Paths Break Under Clean URLs

Relative-path links (`href="dashboard.html"`, `href="../"`, script
`src="nav-drawer.js"`) resolve against the current URL's *directory*. A
rewrite from `/manager/customers` (200) to `/admin/customers.html` serves
that file's *content* at the `/manager/customers` URL — but the browser's
address bar (and therefore relative-link resolution) stays at
`/manager/customers`, not `/admin/`. This means every relative `<script
src>` and relative `<a href>` inside the admin HTML files would break
under the new clean URLs (e.g. `nav-drawer.js` would resolve to
`/manager/nav-drawer.js`, which doesn't exist).

**Resolution for the plan:** convert every relative asset reference in the
eight `admin/*.html` files (`admin.css`, `nav-drawer.js`, each page's own
`.js`) to root-relative paths (`/admin/admin.css`, `/admin/nav-drawer.js`,
`/admin/customers.js`, …), and convert `nav-drawer.js`'s generated `<a
href>` targets (currently plain filenames like `dashboard.html`) to
root-relative clean URLs per role (computed from `currentRole` at drawer-build
time, e.g. `/manager/dashboard` when `role === 'manager'`). This is the
single largest mechanical piece of the implementation and must be done
consistently across all eight pages or navigation will silently 404 for
some role/page combinations.

## Testing

- Extend `test/managerEndpoints.test.js` (or a new `rolesAndAccess.test.js`)
  with an `observer` fixture user; assert 200 + redacted `phone`/`email` on
  `GET /api/customers`, 200 on `GET /api/rooms`, `GET /api/bookings`,
  `GET /api/dashboard/summary`; assert 403 on every write endpoint listed
  above.
- Extend the same suite with an `admin` fixture user; assert 200 on every
  endpoint `manager` currently passes (reuse existing manager test cases
  parametrized over `['manager', 'admin']`).
- New Playwright e2e coverage: login as observer → lands on `/observer` →
  ops board renders with no confirm/reject buttons and no drag capability;
  customers list shows blank phone/email; `/observer/config` (not in the
  rewrite table) and `/manager/users` both fail to resolve or 403 for
  observer.
- New Playwright e2e coverage: each clean URL (`/admin`, `/manager`,
  `/reception`, `/observer`, and their sub-paths) loads the right page
  content and the nav drawer's assets (`nav-drawer.js`, `admin.css`) load
  without a 404, for at least one role per clean path.
