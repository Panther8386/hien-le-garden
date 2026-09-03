# Sổ thu chi — Chứng từ đính kèm, danh mục mở rộng & mặc định Thu/Chi

**Status:** Approved by user 2026-09-03, ready for implementation planning.

## 1. Goal

Extend the existing "Sổ thu chi" finance ledger (built 2026-08-29/30) with three related upgrades to the transaction-entry workflow:

1. Attach a receipt/proof-of-payment file (image or PDF) to a transaction, stored in Cloudflare R2.
2. Let each manager/admin user set a per-browser default for whether the quick-add form opens pre-selected to Thu (income) or Chi (expense).
3. Expand and reclassify the `category` taxonomy: rename `dich_vu` → "Lưu trú Hiền Lê" (same DB slug, no data migration needed for the rename itself), add 5 new categories, and — for the first time — give every category a fixed Thu-or-Chi classification, enforced both in the category dropdown (client-side filter) and by the server (a mismatched type+category pair is now a validation error, not just a UI inconvenience).

## 2. Non-goals

- No receipt OCR/auto-extraction of amounts — the file is a manually-attached reference document only.
- No multi-file attachments — exactly one file per transaction (replacing an existing one discards the old file from storage).
- No public/anonymous access to receipt files — every read goes through an authenticated proxy endpoint, never a public R2 URL.
- No retroactive reclassification of historical transactions — existing rows keep whatever category they were saved with; the new type↔category enforcement applies only to new creates/edits going forward.
- No cross-user server-side default preference — the Thu/Chi default is explicitly a per-browser `localStorage` setting (already decided with the user), not a server-side config.

## 3. Architecture fit

Same stack as the rest of V4: Cloudflare Pages Functions + D1, vanilla-JS admin frontend, no build step, no new frontend library. The one genuinely new piece of infrastructure is **Cloudflare R2** for file storage — nothing in this codebase uses object storage today.

**Known account-level blocker, not a design question:** this Cloudflare account does not have R2 enabled yet (`wrangler r2 bucket list` currently fails with "Please enable R2 through the Cloudflare Dashboard"). This is a one-time, account-level toggle only the account owner can do via the Cloudflare dashboard — it does not block writing or locally testing this feature (`wrangler pages dev`/`vitest` both emulate R2 locally without the account flag), but it does block creating the real bucket and deploying to production until enabled. The implementation plan's deploy checklist calls this out explicitly as a prerequisite step for the human, the same way every other plan this session has gated production changes behind explicit confirmation.

### 3.1. Upload flow (two independent requests, not one combined multipart create)

Creating a transaction and attaching its receipt are two separate HTTP requests against two separate endpoints:

1. `POST /api/finance/transactions` (existing, **unchanged** request/response shape) creates the transaction row and returns its `id`.
2. If the user picked a file, the client immediately follows up with `POST /api/finance/transactions/:id/attachment` (new, multipart) to upload it.

This keeps the existing create endpoint's contract completely stable (no risk to Task 1-10's existing tests or the client code that already calls it), and means a transaction is never *blocked* from being saved by a flaky upload — if step 2 fails, the transaction still exists; the user retries the upload later via the edit form. The same two endpoints are reused for editing: uploading again on an existing transaction *replaces* whatever file was there.

### 3.2. Storage layout

One R2 bucket, binding name `RECEIPTS`, bucket name `hien-le-garden-finance-receipts`. Object key format:

```
finance-receipts/{transactionId}/{unix-timestamp}-{sanitized-original-filename}
```

The timestamp in the key means every upload gets a fresh, non-colliding key — replacing a receipt uploads a new object under a new key and then deletes the previous key from R2 (not soft-deleted; unlike transaction data, a superseded receipt file has no audit-trail value the user asked for, and leaving old versions around forever is pure storage bloat with no corresponding UI to ever browse them). The *current* receipt, once attached, is never deleted by voiding its transaction — voiding only sets `voided_by`/`voided_at` on the transaction row as usual; the file stays retrievable for as long as the transaction row exists.

### 3.3. Reading a receipt back

No R2 object is ever public. `GET /api/finance/transactions/:id/attachment` is an authenticated proxy: it re-runs the exact same role/visibility check the transaction itself is subject to (see §6), then streams the R2 object's bytes back with the correct `Content-Type` and `Content-Disposition: inline; filename="..."`. This is the only way to view or download a receipt.

## 4. Data model

New migration `migrations/0016_finance_transactions_v2.sql`. SQLite cannot `ALTER TABLE` a `CHECK` constraint in place, so widening the `category` list requires the standard SQLite rebuild-and-rename procedure (safe, data-preserving, and this codebase already has a `test/migrations.test.js` convention for asserting a migration's effects — this one gets a new `describe('migration 0016', ...)` block asserting no row was lost and the new columns/constraint are live):

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE finance_transactions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  category TEXT NOT NULL CHECK (category IN (
    'cay_giong', 'vat_tu', 'nhan_cong', 'van_chuyen', 'bao_tri', 'thuc_pham', 'am_thuc_lien_ket', 'khac',
    'ban_hang', 'dich_vu', 'bep_hien_le', 'hien_le_drinks', 'hh_am_thuc_lien_ket'
  )),
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
  (id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at)
  SELECT id, type, category, amount, note, transaction_date, status, created_by, created_at, updated_by, updated_at, voided_by, voided_at
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

`finance_opening_balance` and every other table are untouched by this migration — only `finance_transactions` needs the rebuild, since it's the only table whose `CHECK` constraint is changing.

### 4.1. The category → type classification table (binding, exact)

This is the single source of truth both the server and the client must agree on byte-for-byte:

| Slug | Nhãn hiển thị | Loại |
|---|---|---|
| `cay_giong` | Cây giống | Chi |
| `vat_tu` | Vật tư | Chi |
| `nhan_cong` | Nhân công | Chi |
| `van_chuyen` | Vận chuyển | Chi |
| `bao_tri` | Bảo trì | Chi |
| `thuc_pham` | Thực phẩm | Chi |
| `am_thuc_lien_ket` | Ẩm thực liên kết | Chi |
| `khac` | Chi phí khác | Chi |
| `ban_hang` | Bán hàng | Thu |
| `dich_vu` | **Lưu trú Hiền Lê** *(renamed display label; slug unchanged)* | Thu |
| `bep_hien_le` | Bếp Hiền Lê | Thu |
| `hien_le_drinks` | Hiền Lê Drinks | Thu |
| `hh_am_thuc_lien_ket` | HH Ẩm thực liên kết | Thu |

## 5. API contract

### 5.1. Existing endpoints, updated

- `POST /api/finance/transactions` and `PATCH /api/finance/transactions/:id`: the `category` list (`VALID_CATEGORIES`) grows to the 13 slugs above, `CATEGORY_LABELS`'s `dich_vu` entry changes to `'Lưu trú Hiền Lê'`, and 5 new label entries are added. **New validation rule**: after resolving `type` and `category` (the existing per-field validation still runs first), check that `category` belongs to the `type`'s allowed set per §4.1 — if not, `400 { error: 'Danh mục không phù hợp với loại giao dịch đã chọn' }`. This check runs for both create (all fields fresh) and update (fields resolved via the existing fallback-to-existing-value pattern, so an edit that changes `type` without also changing `category` gets validated against the *new* type, exactly the case this rule exists to catch).
- `GET /api/finance/transactions`: `coerceRow` gains three more passthrough fields: `receiptKey`, `receiptFilename`, `receiptUploadedAt` (all `null` when no attachment). The existing observer income-only filter (from the previous plan) is untouched and continues to apply identically.

### 5.2. New endpoints — `functions/api/finance/transactions/[id]/attachment.js`

**`POST /api/finance/transactions/:id/attachment`** — roles `manager`, `admin` (same as every other finance write). Body: `multipart/form-data` with a single `file` field.

Validation, in order:
1. Transaction must exist (`404` otherwise) and must not be voided (`400` — same "can't edit a voided transaction" rule already applied to the transaction's own fields).
2. Content-Type of the uploaded file must be one of `image/jpeg`, `image/png`, `image/webp`, `application/pdf` (`400` otherwise).
3. File size must be ≤ 10MB (`400` otherwise).

On success: if the transaction already has a `receipt_key`, delete that old R2 object first. Upload the new file to R2 under the key format in §3.2, `UPDATE finance_transactions SET receipt_key = ?, receipt_filename = ?, receipt_uploaded_at = ? WHERE id = ?`, write one `audit_log` row (`action_type: 'finance_transaction_attachment_upload'`). Returns `200 { ok: true, receiptFilename }`.

**`DELETE /api/finance/transactions/:id/attachment`** — roles `manager`, `admin`. `404` if the transaction doesn't exist, `400` if voided, `400` if it has no attachment to remove. Deletes the R2 object, clears all three `receipt_*` columns to `NULL`, writes one `audit_log` row (`action_type: 'finance_transaction_attachment_delete'`). Returns `200 { ok: true }`.

**`GET /api/finance/transactions/:id/attachment`** — roles `manager`, `admin`, `observer`. `404` if the transaction doesn't exist or has no attachment. For `observer`, an **additional** check: `404` (not `403` — a 403 would confirm to an observer that *some* attachment exists on a transaction they can't see the type of, which is itself a small information leak; `404` is indistinguishable from "no attachment") if `transaction.type !== 'income'`. On success, streams the R2 object with `Content-Type` set from the object's stored HTTP metadata and `Content-Disposition: inline; filename="<receiptFilename>"`.

## 6. Client (`admin/finance.js` / `admin/finance.html`)

### 6.1. Category dropdown, driven by type

`CATEGORY_LABELS` becomes `CATEGORY_META = { cay_giong: { label: 'Cây giống', type: 'expense' }, ... }` (the exact §4.1 table). `populateCategorySelect` gains a `type` parameter: when given, it only adds `<option>`s whose `CATEGORY_META[slug].type` matches; when omitted (the filter bar's "Tất cả danh mục" case), it lists everything grouped income-then-expense with an `<optgroup>` per type for readability.

The quick-add form's `type` `<select>` gets a `change` listener: on every change, re-run `populateCategorySelect(categorySelect, newType)` and reset the category selection to the placeholder (never leave a stale, now-invalid category silently selected).

### 6.2. Default Thu/Chi toggle

Two buttons ("Mặc định: Thu" / "Mặc định: Chi") next to the quick-add form. Clicking one writes `localStorage.setItem('financeDefaultType', 'income'|'expense')` immediately and updates a visual active/inactive state on the two buttons. `resetFinanceForm()` reads this value (`localStorage.getItem('financeDefaultType') || 'expense'` — `'expense'` preserves today's actual default with no key ever set) and pre-selects the type dropdown accordingly *before* populating the category dropdown, so the category list is correctly filtered from the very first render, not just after a manual type change.

### 6.3. File input and attachment display

- Quick-add form gets one `<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf">`, optional.
- On successful transaction create, if a file was selected, the client immediately does the follow-up `POST .../attachment` (§3.1). A failure here shows a distinct, non-blocking message ("Đã lưu giao dịch nhưng tải chứng từ lên thất bại — có thể thử lại bằng nút Sửa") — the transaction list still refreshes and shows the new row either way.
- Transaction list rows: a 📎 indicator with a link to the (authenticated, in-app) attachment view when `receiptKey` is present.
- Edit form (`openEditTransaction`): shows the current attachment's filename/link if any, offers a file input to replace it, and a "Gỡ chứng từ" button that calls the `DELETE` endpoint when there's an existing one.

## 7. Testing

Following this codebase's established TDD convention:
- `test/migrations.test.js` — new `describe('migration 0016', ...)` block: confirms every pre-migration transaction row survives with identical field values, confirms the 5 new category slugs are now insertable and the *old* invalid slugs still correctly rejected, confirms a fresh insert after the migration gets an id greater than any pre-migration id (the `sqlite_sequence` fix-up).
- `test/financeTransactions.test.js` — extend: type↔category mismatch rejected on create and on update (several cases across the §4.1 table, not just one), `dich_vu` transactions round-trip with the new `'Lưu trú Hiền Lê'` label, `receiptKey`/`receiptFilename`/`receiptUploadedAt` present (null) on a plain transaction response.
- `test/financeAttachments.test.js` (new) — covers all three attachment endpoints: role gates (reception/unauthenticated rejected on all three; observer only allowed on GET, and only for income transactions — 404 for an expense transaction's attachment even if role-permitted in general), content-type and size validation on POST, replace-deletes-the-old-object behavior, void-blocks-further-attachment-changes, GET streams the right bytes/content-type, DELETE clears all three columns and removes the R2 object. R2 itself is exercised via the same local-emulation Miniflare already provides for D1 in this test suite — no real network calls to Cloudflare in tests.
- `tests/e2e/finance-dashboard.spec.js` (outer repo, extend) — the default-type toggle persists across a page reload (via `localStorage`, actually settable/readable in a Playwright test), category dropdown re-filters on type change losing a stale selection, uploading a file via the picker and seeing the 📎 indicator appear (mocked attachment endpoints, consistent with how every other write in this spec file is already mocked).

## 8. Open implementation-time details left for the plan

- Exact R2 API calls (`env.RECEIPTS_BUCKET.put`/`.get`/`.delete`) and the `wrangler.toml` `[[r2_buckets]]` binding block — mechanical, the plan writes this out concretely.
- Exact icon/markup for the 📎 attachment indicator and the two default-type toggle buttons — small CSS/HTML detail, follows the exact existing `.btn-secondary`/`.status-badge`-style conventions already in `admin/admin.css`, decided in the plan's UI tasks with real code, not left vague.
