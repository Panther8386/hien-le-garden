# Sổ thu chi — Danh mục cấu hình được bởi Admin

**Status:** Approved by user 2026-09-03, ready for implementation planning.

## 1. Goal

Turn the finance-ledger category taxonomy (currently 13 slugs hardcoded in `lib/financeCategories.js` and duplicated in `admin/finance.js`) into an Admin-manageable, database-backed list — add/edit-label/hide categories through a new admin page instead of editing code. As part of the same migration, apply two specific content changes the user requested: add a new income category "Giờ xanh Hiền Lê", and rename the "Bán hàng" category to "Dịch vụ khác".

## 2. Non-goals

- No reordering UI (drag-to-reorder) — display order follows insertion order (`id` ascending) within each Thu/Chi group, matching the existing curated order exactly for the 14 seeded categories.
- No changing a category's `type` (Thu/Chi) after creation — if the wrong type was chosen, the fix is to hide that category and create a new one with the correct type. This is deliberate: a category's transactions already carry semantic meaning tied to its type, and retroactively flipping it would misrepresent history.
- No hard delete — "xoá" a category means `is_active = 0` (hidden from the add/edit category picker), never a `DELETE FROM finance_categories` row removal. Historical transactions keep displaying the category's label regardless of its active state.
- No change to who can edit a transaction's own `category` field (Manager keeps full edit access, as today) — explicitly confirmed with the user. This work does not touch `PATCH /api/finance/transactions/:id`'s role list or its existing type/category-pairing "grandfathering" logic; it only changes where that logic's category data comes from (DB instead of a hardcoded module).
- No bulk re-categorization tool — changing a transaction's category one at a time via the existing edit form is sufficient (confirmed with user); no new bulk-edit UI.
- No editable `slug` — a category's slug is generated once at creation time from its label and never changes, since it is what past and future transactions reference in `finance_transactions.category`.

## 3. Architecture fit

Same stack as the rest of V4: Cloudflare Pages Functions + D1, vanilla-JS admin frontend, no build step. Follows the existing `service_catalog` / `admin/catalog.html` precedent closely: a dedicated D1 table, admin-only CRUD endpoints, `is_active` soft-delete, a separate admin page.

**A necessary but non-obvious structural change**: `finance_transactions.category` currently has a hardcoded `CHECK (category IN (13 literal slugs))` constraint (from migration 0016). Once categories become admin-configurable, any newly-added category would violate that CHECK the moment someone tries to file a transaction under it — a confusing raw SQLite constraint error instead of a clean app-level validation message. This work removes that CHECK entirely (SQLite cannot `ALTER` a CHECK constraint in place, so this requires the same create-new-table/copy-data/drop-old/rename-new rebuild procedure used in migration 0016, this time dropping the enum list instead of widening it) and moves *all* category-validity checking to the application layer, against the new `finance_categories` table.

## 4. Data model

Two new migrations.

### 4.1. `migrations/0018_finance_categories.sql` — new table + seed

```sql
CREATE TABLE finance_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);

CREATE INDEX idx_finance_categories_type ON finance_categories(type);

INSERT INTO finance_categories (slug, label, type, is_active, created_by, created_at) VALUES
  ('cay_giong', 'Cây giống', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('vat_tu', 'Vật tư', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('nhan_cong', 'Nhân công', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('van_chuyen', 'Vận chuyển', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('bao_tri', 'Bảo trì', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('thuc_pham', 'Thực phẩm', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('am_thuc_lien_ket', 'Ẩm thực liên kết', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('khac', 'Chi phí khác', 'expense', 1, 'system', '2026-09-03T00:00:00Z'),
  ('ban_hang', 'Dịch vụ khác', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('dich_vu', 'Lưu trú Hiền Lê', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('bep_hien_le', 'Bếp Hiền Lê', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('hien_le_drinks', 'Hiền Lê Drinks', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('hh_am_thuc_lien_ket', 'HH Ẩm thực liên kết', 'income', 1, 'system', '2026-09-03T00:00:00Z'),
  ('gio_xanh_hien_le', 'Giờ xanh Hiền Lê', 'income', 1, 'system', '2026-09-03T00:00:00Z');
```

13 slugs and labels are carried over byte-for-byte from `lib/financeCategories.js`'s current `CATEGORY_META`, with two edits baked into the seed itself: `ban_hang`'s label is `'Dịch vụ khác'` (not `'Bán hàng'`), and a 14th row `gio_xanh_hien_le` / `'Giờ xanh Hiền Lê'` / `income` is new. Slugs for the 13 carried-over rows are unchanged, so no existing `finance_transactions.category` value needs touching.

### 4.2. `migrations/0019_finance_transactions_drop_category_check.sql` — remove the hardcoded category CHECK

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE finance_transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  note TEXT,
  transaction_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'paid')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  voided_by TEXT,
  voided_at TEXT,
  receipt_key TEXT,
  receipt_filename TEXT,
  receipt_uploaded_at TEXT
);

INSERT INTO finance_transactions_new
  (id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at, receipt_key, receipt_filename, receipt_uploaded_at)
  SELECT id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at, receipt_key, receipt_filename, receipt_uploaded_at
  FROM finance_transactions;

DROP TABLE finance_transactions;
ALTER TABLE finance_transactions_new RENAME TO finance_transactions;

CREATE INDEX idx_finance_transactions_date ON finance_transactions(transaction_date);
CREATE INDEX idx_finance_transactions_status ON finance_transactions(status);

-- Explicitly carry the AUTOINCREMENT high-water mark forward so the next
-- genuinely-new transaction can never reuse an id from the pre-rebuild table.
INSERT OR REPLACE INTO sqlite_sequence (name, seq)
  VALUES ('finance_transactions', (SELECT COALESCE(MAX(id), 0) FROM finance_transactions));

PRAGMA foreign_keys=ON;
```

Identical to migration 0016's rebuild except `category` drops its `CHECK (category IN (...))` clause entirely, keeping only `NOT NULL`. Every other column, index, and the `sqlite_sequence` fix-up are unchanged.

### 4.3. Slug generation

New categories get a slug auto-derived from their label at creation time — the admin only types a display name, never a machine key:

```js
function slugify(label) {
  return label
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')   // strip combining diacritics after NFD decomposition (à, ê, ộ, ...) — \p{Mn} = Unicode "Mark, Nonspacing"
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')  // đ/Đ don't decompose via NFD, handled separately
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
```

Example: `"Giờ xanh Hiền Lê"` → `"gio_xanh_hien_le"`. If the generated slug is empty (label was pure punctuation/whitespace) or already exists on *any* row regardless of `is_active`, the create request is rejected with a clear error — no auto-suffixing (`_2`, `_3`, ...); the admin picks a different label instead.

## 5. API contract

### 5.1. New endpoints — `functions/api/finance/categories/index.js`, `functions/api/finance/categories/[id].js`

Follows the `functions/api/catalog/` precedent exactly (role split, `is_active` toggle instead of hard delete, `{ ok: true }` PATCH response).

**`GET /api/finance/categories`** — roles `manager`, `admin`, `observer` (same roles as everything else on the Sổ thu chi page). Returns **every** category, active and inactive alike:

```json
[{ "id": 1, "slug": "cay_giong", "label": "Cây giống", "type": "expense", "isActive": true, "createdBy": "system", "createdAt": "...", "updatedBy": null, "updatedAt": null }, ...]
```

Inactive rows are included (not filtered server-side) because the client needs them to resolve a label for a transaction whose category has since been hidden — filtering to active-only happens client-side, only for populating the *choosable* dropdown.

**`POST /api/finance/categories`** — role `admin`. Body `{ label, type }`.
- `label`: non-empty string after `.trim()`.
- `type`: must be `'income'` or `'expense'`.
- Slug is generated per §4.3; `400` if empty or already in use (active or not).
- On success: `INSERT` with `is_active = 1`, `created_by = auth.username`, `created_at = now`; one `audit_log` row (`action_type: 'finance_category_create'`); `201 { id, slug, label, type, isActive: true }`.

**`PATCH /api/finance/categories/:id`** — role `admin`. Body accepts only `label` and/or `isActive`; `type` and `slug` in the body are silently ignored (not an error — guards against a stale/buggy client accidentally sending them without breaking the request). `404` if the id doesn't exist. `400` if `label` is provided but empty after `.trim()`. On success: `UPDATE`, one `audit_log` row (`action_type: 'finance_category_update'`, capturing old/new label and old/new `isActive` in its summary), `200 { ok: true }`.

### 5.2. Existing endpoints, updated

- `lib/financeCategories.js` changes from a static module (`export const CATEGORY_META = {...}`) to an async loader: `export async function loadCategoryMeta(env)` that queries `finance_categories` and returns the same `{ slug: { label, type } }` shape the rest of the code already expects, PLUS `export async function categoryMatchesType(env, category, type)` (now async, needs a DB round-trip). Every call site (`functions/api/finance/transactions/index.js`, `[id].js`) adds `await` and threads `env` through — the validation logic itself (the `pairingChanged` grandfathering check from the previous feature) is unchanged, only its data source changes.
- `POST /api/finance/transactions`: category must exist in `finance_categories` **and have `is_active = 1`** — creating a transaction under a hidden category is rejected (`400`), same message as an unrecognized category (`'Danh mục không hợp lệ'`) — a hidden category and a nonexistent one look identical to a fresh create, which is the correct signal (both mean "not choosable right now").
- `PATCH /api/finance/transactions/:id`: category lookups for both halves of the `pairingChanged` comparison (the transaction's existing category and, if changing, the newly-chosen one) use the **full** table including inactive rows for the *existing-value* side — an edit to a transaction whose category has since been hidden must not itself become impossible to save (matches the non-goal above: editing other fields on such a transaction must keep working). The newly-chosen category (when the pairing does change) still must be active, same as create.
- `GET /api/finance/transactions`: unchanged — still returns the raw `category` slug; label resolution is a client-side concern via the categories list.

## 6. Client (`admin/finance-categories.html`/`.js`, `admin/finance.js`)

### 6.1. New admin page `admin/finance-categories.html` + `admin/finance-categories.js`

Admin-only page (same auth-redirect convention as `admin/catalog.html` — non-admin visitors get 403s from every API call and stay on the page with an error message, no client-side role redirect, matching this codebase's established pattern). Two grouped lists ("Thu" / "Chi"), each row showing the label, an active/hidden status badge, an inline "Sửa tên" control, and a toggle button ("Ẩn" ↔ "Hiện lại"). An "add category" form at the top of each group: label input + submit (type is implicit from which group's form was used, so the form doesn't need its own type selector).

`admin/finance.html` gets a link to this new page, placed near the existing admin-only controls (opening-balance editor area), visible only when `currentRole === 'admin'`.

### 6.2. `admin/finance.js` — categories become a runtime fetch, not a hardcoded object

`CATEGORY_META` (the client's independent hardcoded copy — necessarily separate from the server's, since `admin/*.js` are classic `<script>` tags with no bundler) is replaced by a module-level variable populated once, early in the page-init IIFE, from `GET /api/finance/categories`:

```js
let categoryMeta = {}; // { [slug]: { label, type, isActive } }
```

`categoryLabel(slug)` and `populateCategorySelect(select, { includeAllOption, type })` are updated to read from `categoryMeta` instead of the old static object — `categoryLabel` looks up any slug (active or not, so old transactions still show correctly); `populateCategorySelect`'s type-filtered branch (used by the quick-add form and the edit form) additionally filters to `meta.isActive`, since only active categories are choosable for a create or a genuine pairing change. This fetch happens once per page load; the new admin page is a separate page/reload, so no live-sync mechanism is needed within a single `finance.html` session — a category added while `finance.html` is already open in another tab requires a reload to appear, which is an acceptable, unsurprising limitation (matches how a new `service_catalog` row also requires a reload elsewhere in this app).

## 7. Testing

- `test/migrations.test.js` — new `describe('migration 0018', ...)` (14 seeded rows, correct labels/types including the two edits, slug uniqueness) and `describe('migration 0019', ...)` (an insert with a category slug outside the old 13-item enum now succeeds; existing rows and columns unaffected — same style of assertions as migration 0016's block).
- `test/financeCategories.test.js` (new) — full endpoint coverage: role gates on all three verbs, slug generation from a Vietnamese label, duplicate-slug rejection, `PATCH` ignoring a `type`/`slug` in the body, `isActive` toggling both directions.
- `test/financeTransactions.test.js` — extend: create rejected for an inactive category (`400`, same message as an unknown one); update of a transaction whose category has since been deactivated, changing only `amount`, still succeeds (grandfathering survives category deactivation); update that *changes* to an inactive category is rejected.
- `tests/e2e/finance-dashboard.spec.js` / new `tests/e2e/finance-categories.spec.js` (outer repo) — Admin adds a category via the new page, reloads Sổ thu chi, confirms it's selectable in the quick-add form; hiding a category removes it from the picker but a pre-existing transaction using it still renders its label; non-admin visiting `finance-categories.html` sees 403s and no add form.

## 8. Open implementation-time details left for the plan

- Exact markup/CSS for `admin/finance-categories.html`'s two-group layout and per-row edit/toggle controls — follows existing `admin/admin.css` button/badge conventions (`.btn-secondary`, `.status-badge`), decided in the plan's UI task with real code.
- Exact wording of the admin-only nav link added to `admin/finance.html`.
