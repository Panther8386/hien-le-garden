# Asset & Inventory Phase 3b: Room-by-Room Inventory Counting + Asset Delete — Design

## 1. Purpose

Phase 3a (shipped) gave the property a live operational asset registry (`assets`,
Layer 3) reconciled from the immutable handover records (`asset_source_rows`,
Layer 1). Phase 3b adds the workflow the original requirements document (§5,
§12 step 3) calls "kiểm kê từng phòng": periodic, per-location physical counts
that compare book quantities against what staff actually find, capture
condition/photos/notes per line, and — on closing — feed corrections back into
`assets`.

Separately, this phase also adds a soft-delete capability for `assets`,
requested directly by the business owner after Phase 3a's final review
surfaced that a mistaken reconcile (wrong category, wrong count) had no way to
be undone. Delete is gated by its own admin-only-grantable permission,
independent of the general admin/manager write access `assets` already has.

This is **not** the quarterly recurrence engine (that is Phase 5's job — this
phase builds the counting mechanism itself, run manually whenever someone
starts a batch) and **not** maintenance/repair tracking (also Phase 5).

## 2. Global Constraints (binding, carried from the original requirements doc and Phase 3a)

- Never treat the "3-month cycle" as anything but the asset-inventory-count
  cycle — never maintenance. This phase does not implement the cycle at all;
  it implements the count itself, triggered manually.
- Never overwrite Layer 1 (`asset_source_rows`/`asset_source_documents`) with
  inventory results. Nothing in this phase writes to those tables.
- Never coerce an unknown quantity to 0/1; never guess an unknown location.
- Never auto-map real room names to new location codes — this phase reuses
  `asset_locations` exactly as Phase 2 built it (16 rooms + 5 common areas + 5
  warehouses already exist in production; no new locations are created by
  this phase).
- Mandatory server-side permission checks everywhere — never trust
  client-side role gating alone.
- Reuse the existing 4 roles (admin/manager/reception/observer) and the
  existing `rooms`/`asset_locations`/`assets` tables — no second room, user,
  or permission system.
- Do not expand into a full accounting/maintenance system.
- `assets.category_id` stays immutable (Phase 3a rule, unaffected by this
  phase).
- `assets.quantity` stays forced to 1 for `individual_device`/`device_set`
  (Phase 3a rule) — this phase's closing-reconciliation logic (§5) never
  overrides that.

## 3. Data Model

### 3.1 `asset_inventory_batches` (new)

One row per counting round at one location.

```sql
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
```

A batch always covers exactly one location (decided over "one batch, many
locations" — matches how staff actually walk the property room by room;
covering the whole property means creating several batches).

### 3.2 `asset_inventory_lines` (new)

One row per asset counted within a batch.

```sql
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
```

- `book_quantity` is a snapshot of `assets.quantity` taken when the line is
  created (batch creation, or a later "refresh lines" call) — never
  recomputed live, so it reflects what the books said *at count time*, not
  whatever `assets.quantity` has drifted to since.
- "Refresh lines" (§6.1) only ever *adds* lines — for assets that now match
  the batch's `location_id` and don't already have one — and never removes
  or overwrites an existing line, touched or not. An asset whose
  `location_id` changed away from the batch's location after its line was
  created keeps that line untouched: the batch is a record of what *was*
  expected there when counting started, and a stale expectation showing up
  as a variance is exactly what the count is supposed to surface, not
  something to quietly delete.
- `actual_quantity`: `NULL` = not yet counted (distinct from `0` = counted
  and confirmed absent). For individual assets this is only ever `NULL`, `0`,
  or `1` (book_quantity is always `1` for these).
- The variance ("chênh lệch") is never stored — it is always
  `actual_quantity - book_quantity`, computed at read time, mirroring how
  Phase 3a's `reconciledCount` is a live `SUM`, never a cached column.
- `UNIQUE(batch_id, asset_id)` is the structural guarantee against
  double-counting: re-scanning the same asset's QR code during a count is an
  `UPDATE` of its existing line, never an `INSERT` of a new one.
- `condition_found` reuses the same 5-value vocabulary as
  `assets.physical_condition` (tốt/khá/trung bình/cần sửa/chưa đánh giá) but
  is a separate column — the count's finding does not silently overwrite the
  asset's canonical condition; a human decides whether to apply it (via the
  normal `PATCH /api/assets/:id` edit flow, unchanged by this phase).
- Photo/note/suggested-action satisfy §5's per-line field list ("ảnh/ghi
  chú", "đề nghị xử lý"). `suggested_action` is free text only — it does not
  drive any automated workflow in this phase (repair/replace routing is
  Phase 5's job).

### 3.3 `assets.is_deleted` (new column on the existing table)

```sql
ALTER TABLE assets ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;
```

Kept deliberately separate from `lifecycle_status` (đang_quản_lý/đã_hoàn_trả/đã_thanh_lý)
— those are real business states for equipment that legitimately left the
property's possession; `is_deleted` means "this row should never have
existed" (wrong category picked, duplicate created by a botched reconcile
count). Conflating the two would violate the project's own repeated rule of
never merging distinct concepts into one field (condition vs. operational
status vs. location vs. lifecycle are already kept separate for the same
reason).

### 3.4 `staff_accounts.can_delete_asset` (new column)

```sql
ALTER TABLE staff_accounts ADD COLUMN can_delete_asset INTEGER NOT NULL DEFAULT 0;
```

Defaults to `0` for every account, including existing admin/manager accounts
— unlike `can_add_finance_transaction` (which layers *on top of* a role that
already has the underlying permission), deleting an asset requires this flag
regardless of role. No account is grandfathered in.

### 3.5 Migration split

Two migrations, not one, following this project's one-file-per-logical-concern
convention: `0031` creates `asset_inventory_batches`/`asset_inventory_lines`
and adds `assets.is_deleted` (all part of the counting-and-correcting-mistakes
concern this phase centers on); `0032` adds `staff_accounts.can_delete_asset`
(a separate table, the permission-grant concern), mirroring how `0027`
(catalogs) and `0028` (a single permission column on `staff_accounts`) were
already kept as separate migrations in Phase 2/3a rather than combined.

## 4. Batch Workflow

| State | Who can enter it | What's true while in it |
|---|---|---|
| **Nháp** (`draft`) | admin/manager, via `POST /api/asset-inventory-batches` (picks a location) | Lines auto-populated: one line per `assets` row where `location_id` matches and `is_deleted = 0`, with `book_quantity` snapshotted. Freely re-creatable via "refresh lines" (adds lines for assets that arrived at the location since, never removes or overwrites an already-touched line). |
| **Đang kiểm kê** (`counting`) | admin/manager, via `PATCH .../status` `{status:'counting'}` | All 3 write roles (admin/manager/**reception**) can `PATCH` any line's `actual_quantity`/`condition_found`/photo/`note`/`suggested_action`. This is the only state reception can write in. |
| **Chờ chốt** (`pending_close`) | any of the 3 write roles, once counting is done | Reception's line-write access is now read-only; admin/manager can still adjust before finalizing. |
| **Đã chốt** (`closed`) | admin/manager only, via `PATCH .../status` `{status:'closed'}` | Terminal. No further line edits from anyone, ever (mirrors `audit_log`/`booking_service_items` — closed records are not mutated). Triggers §5's reconciliation. |

Transitions are strictly forward (`draft`→`counting`→`pending_close`→`closed`);
the `PATCH` endpoint validates the requested `status` is the immediate next
state for the batch's current status and 400s otherwise — no skipping, no
going back. There is no "reopen" path in this phase; a batch closed in error
is a Phase-5-scale problem (same category as "how do we handle a wrong
maintenance record" — out of scope here, same way Task 4's reconcile
double-count guard's TOCTOU race was judged acceptable for a manual,
sequential admin workflow in Phase 3a).

## 5. Closing-Time Reconciliation

Fires once, synchronously, inside the `PATCH .../status {status:'closed'}`
handler, iterating every line in the batch:

1. **`actual_quantity IS NULL`** (never counted) → skip entirely. No
   `assets` write, no audit_log row. This is the one case that must not be
   confused with "counted and found to be 0".
2. **Asset's `management_type` is `durable_goods`/`infrastructure`** (bulk,
   quantity-tracked) and `actual_quantity != book_quantity` (equivalently,
   `!= assets.quantity` at this point, since nothing else could have changed
   it mid-batch under the single-admin-workflow assumption already accepted
   in Phase 3a) →
   `UPDATE assets SET quantity = actual_quantity, updated_by, updated_at`,
   then `INSERT INTO audit_log (action_type='asset_inventory_adjustment', ...)`
   recording the asset, old quantity, new quantity, and the batch/line it
   came from in the label.
3. **Asset's `management_type` is `individual_device`/`device_set`** → never
   touch `quantity` (stays 1), never touch `location_id`, never touch
   `lifecycle_status` — regardless of `actual_quantity` being `0` or `1`. A
   `0` here is retained forever as a closed line in `asset_inventory_lines`
   and surfaced through the "Thiết bị không tìm thấy" view (§6), not written
   anywhere on the `assets` row itself. A human decides what to do about a
   truly-missing device (mark it `đã thanh lý` via the existing edit form,
   soft-delete it if it was a duplicate, or just keep looking) — the system
   never infers loss from one missed count.

All writes for one batch's close happen in a single `env.DB.batch([...])`
call (matching the pattern already used for multi-statement writes elsewhere
in this codebase, e.g. Task 6's reconcile-and-audit-log pair) so a crash
mid-close cannot leave some assets adjusted and others not from the same
close operation.

## 6. Screens

### 6.1 `admin/asset-inventory.html` / `.js` (new page, "Kiểm kê tài sản")

Registered in `nav-drawer.js`'s existing "Tài sản & Kho" group and in
`_redirects` for `/manager|reception|observer/asset-inventory`, exactly like
`assets.html` and `asset-source-data.html` were in Phase 3a.

- **List view**: batches, filterable by location and status, **paginated
  client-side at 10/page** (fetch once, filter, then paginate — the same
  technique already shipped for Reception's booking-history search, reused
  verbatim rather than inventing a second pagination style in the same
  codebase). "Tạo đợt kiểm kê" button (admin/manager) opens a small form:
  pick a location (only `asset_locations.is_active = 1` ones offered — Phase
  3a's final review flagged the sibling gap of not checking
  `asset_categories.is_active` during reconcile; this phase does check its
  own analogous case), optional label override (defaults to
  `"<tên vị trí> - <ngày tạo>"`), optional note.
- **Detail view** (one batch): header with location/status/created_by/
  closed_by; status-transition button matching the current state + the
  viewer's role/permission per §4's table; "Làm mới danh sách dòng" button
  (admin/manager, hidden once `pending_close`/`closed`); a table of lines —
  each row shows the asset's name/internal_code/book_quantity, an
  `actual_quantity` number input, a `condition_found` select, a photo
  upload/thumbnail (mirrors the existing asset-photo widget from
  `assets.js`), a note text field, a suggested-action text field — all
  disabled once the viewer's write window has closed per §4.
- **"Thiết bị không tìm thấy" tab**, same page: lists every
  `asset_inventory_lines` row where the asset is `individual_device`/
  `device_set`, `actual_quantity = 0`, and the batch is `closed` — joined
  with the asset's name/internal_code and the batch's location/date, also
  **paginated client-side at 10/page**. Read-only; no actions here (fixing a
  missing device happens through the normal Danh mục tài sản edit/delete
  flow, not from this report).
- Observer sees both the batch list and detail views read-only (no create
  button, no transition buttons, no line-edit inputs) — matches the
  read-everywhere/write-nowhere pattern observer already has for every other
  page in this project.

### 6.2 `admin/assets.js` (existing page, extended)

- A "Xoá" button next to each asset's existing "Sửa" button, visible only
  when `auth.canDeleteAsset` is true (regardless of role) — confirmed via the
  existing `.confirm-overlay`/`.confirm-box` pattern already used for
  destructive-feeling actions elsewhere in this codebase, with copy
  explaining the action is reversible only via direct database access ("Tài
  sản sẽ bị ẩn khỏi mọi danh sách. Không thể tự khôi phục lại qua giao diện.").
- The list/filter fetch stays `is_deleted`-excluded by default; no
  `includeDeleted` toggle is added to this page in this phase (nothing in
  the approved design calls for viewing deleted assets again — YAGNI; the
  `includeDeleted=1` query param exists on the API for direct
  inspection/support use, not wired to this UI).

### 6.3 `admin/users.js` (existing page, extended)

A 4th permission checkbox column, "Xoá tài sản", rendered **only when the
viewer's own role is `admin`** (mirrors the existing admin-only "Đặt lại mật
khẩu" button — manager viewing this page does not see the column exist at
all, not merely disabled). Wired to
`PATCH /api/users/:id/asset-delete-access`.

## 7. API Surface

New:
- `GET /api/asset-inventory-batches` — all 4 roles. Query params: `locationId`, `status`.
- `POST /api/asset-inventory-batches` — admin/manager. Body: `{locationId, label?, note?}`. Validates `asset_locations.is_active`. Auto-populates lines.
- `GET /api/asset-inventory-batches/:id` — all 4 roles. Includes its lines joined with asset name/internal_code/category management_type.
- `PATCH /api/asset-inventory-batches/:id` — status transition. Body: `{status}`. Role/state validated per §4's table; 400 on an invalid (non-immediate-next) transition.
- `POST /api/asset-inventory-batches/:id/refresh-lines` — admin/manager, only while `draft`/`counting`/`pending_close`.
- `PATCH /api/asset-inventory-lines/:id` — role/state gated per §4 (admin/manager/reception while `counting`; admin/manager while `pending_close`; nobody once `closed`). Body: any of `actualQuantity`, `conditionFound`, `note`, `suggestedAction`.
- `POST/GET/DELETE /api/asset-inventory-lines/:id/photo` — mirrors `functions/api/assets/[id]/photo.js` exactly (same size/type limits), R2 prefix `inventory-line-photos/<lineId>/<timestamp>-<filename>`. Write roles match the line's own write gate.
- `DELETE /api/assets/:id` — any authenticated role, gated purely on `auth.canDeleteAsset`. Soft-deletes (`is_deleted = 1`), 400s if already deleted. Writes `audit_log` `asset_delete`.
- `PATCH /api/users/:id/asset-delete-access` — **admin only** (not manager — the one place this phase's permission model diverges from the existing `canManageRoomLayout`/`canAddFinanceTransaction` precedent, per explicit product decision). Body: `{canDeleteAsset: boolean}`. Rejects granting to an `observer` target account, matching the existing finance-permission rule.

Modified:
- `GET /api/assets` — excludes `is_deleted = 1` by default; `includeDeleted=1` opts back in (admin/manager only, matching every other `includeX` escape hatch in this codebase being restricted to elevated roles).
- `PATCH /api/assets/:id` — 400s if the target asset is already `is_deleted`.
- `GET /api/asset-source-rows` — `reconciledCount`'s subquery adds `AND a.is_deleted = 0`, so a soft-deleted asset frees up its source row's reconcile ceiling again.
- `functions/api/audit-log/index.js`, `admin/audit-log.js`, `admin/audit-log.html` — register `asset_delete` and `asset_inventory_adjustment` in the established 3-registry pattern.
- `lib/auth.js` `getSession` — joins and returns `canDeleteAsset`.
- `functions/api/users/index.js` GET — includes `canDeleteAsset` per user.
- `nav-drawer.js` / `_redirects` — register `asset-inventory.html`.

## 8. Roles Summary

| Action | admin | manager | reception | observer |
|---|---|---|---|---|
| View batches/lines/"không tìm thấy" report | ✅ | ✅ | ✅ | ✅ |
| Create batch, refresh lines, close batch | ✅ | ✅ | ❌ | ❌ |
| Start counting, send to pending_close | ✅ | ✅ | ✅ | ❌ |
| Fill in a line while `counting` | ✅ | ✅ | ✅ | ❌ |
| Fill in a line while `pending_close` | ✅ | ✅ | ❌ | ❌ |
| Delete an asset | only if `canDeleteAsset` | only if `canDeleteAsset` | only if `canDeleteAsset` | never (flag ungrantable) |
| Grant/revoke `canDeleteAsset` | ✅ | ❌ | ❌ | ❌ |

## 9. Testing Approach

Follows the exact pattern established across Phases 2 and 3a: migration
tests (`test/migrations.test.js`), endpoint unit tests per new file hitting
real D1 via `@cloudflare/vitest-pool-workers`, and e2e coverage in the outer
repo's `tests/e2e/` mocking every `/api/*` route. Particular cases the plan
must cover explicitly (not exhaustive — the plan enumerates the rest):

- Batch status transitions: every valid forward transition succeeds; every
  skip/backward transition 400s; reception cannot transition to/from
  `pending_close`→`closed`.
- Double-scan of the same asset within one batch updates the existing line,
  never creates a second (`UNIQUE(batch_id, asset_id)` violation surfaced as
  a clean upsert, not a 500).
- Closing: bulk-asset quantity actually changes and audit-logs; individual
  asset's `quantity`/`location_id`/`lifecycle_status` never change regardless
  of `actual_quantity`; a `NULL` line is skipped (no audit_log row for it).
- Delete: `canDeleteAsset=false` on every role (including admin without the
  flag) gets 403; soft-deleted asset disappears from default `GET /api/assets`
  and from a fresh batch's auto-populated lines; its source row's
  `reconciledCount` drops correspondingly.
- Permission grant: manager attempting `PATCH .../asset-delete-access` gets
  403; granting to an `observer` target gets 400.
