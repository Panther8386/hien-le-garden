# CRM Admin Management — Design Spec

**Repo:** `hien-le-garden-v4` (unified frontend + backend, see `BACKEND.md`)
**Builds on:** `docs/specs/2026-08-19-v4-crm-loyalty-design.md`

## Problem

The CRM backend (built 2026-08-19) stores every guest survey submission and
generated promo code in D1, but the admin UI (`admin/manager.html`,
`admin/reception.html`) has no way to browse that data — only single-code
lookup. There is also no user-management UI (the only account-creation path
is a CLI script, `scripts/seed-manager.js`, run against production), and the
promo email/Telegram content is hardcoded in `lib/email.js`/`lib/telegram.js`
with no way to edit it without a code change.

This spec adds: a searchable customer list with computed promo-code status,
a message-template library that drives both automatic and manual
email/Telegram sends, and an in-UI user-management page.

## Permissions matrix

| Capability | manager | reception |
|---|---|---|
| View customer list | ✅ | ✅ |
| Send a message from a template | ✅ | ✅ |
| Create/edit/delete/activate templates | ✅ | ❌ |
| Create/delete users, change roles | ✅ | ❌ |
| Change own password | ✅ | ✅ |
| Policy config, gift inventory (existing) | ✅ | ❌ |

Enforced server-side via `requireAuth(request, env, ['manager'])` or
`['reception', 'manager']`, following the existing pattern in
`functions/api/policy.js`.

## Data model

### New table: `message_templates`

```sql
CREATE TABLE message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'telegram')),
  subject TEXT,
  body TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_templates_channel_active ON message_templates(channel, is_active);
```

- `subject` is required for `channel = 'email'`, ignored for `'telegram'`.
- At most one row per channel has `is_active = 1`. Activating a template
  deactivates any other template on the same channel in the same statement
  (mirrors the "single active policy" pattern already used for
  `promo_policy`, except promo_policy allows multiple simultaneously-valid
  rows by date range — templates do not have date ranges, so this is a
  simpler single-row toggle).
- Supported variables in `subject`/`body`: `{guestName}`, `{promoCode}`,
  `{discountPercent}`, `{expiresAt}` (formatted `dd/mm/yyyy`), `{giftLine}`
  (renders a fixed Vietnamese sentence about the gift when the guest's
  `gift_offered = 1`, else renders empty string — same conditional the
  current `buildHtml()` in `lib/email.js` already implements inline).
  Unknown `{placeholder}` tokens are left as literal text (not stripped),
  so a typo is visible to whoever wrote the template rather than silently
  disappearing.

### New table: `message_log`

```sql
CREATE TABLE message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id TEXT NOT NULL REFERENCES feedback_responses(id),
  template_id INTEGER REFERENCES message_templates(id),
  channel TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  error TEXT,
  sent_at TEXT NOT NULL
);

CREATE INDEX idx_message_log_feedback ON message_log(feedback_id);
```

- `template_id` is nullable and carries no `ON DELETE` action — this
  project does not enable `PRAGMA foreign_keys`, so D1 never enforces the
  reference. If a template is later deleted, older log rows are left with
  a dangling `template_id`; the detail-view join must tolerate that (a
  `LEFT JOIN`, showing "template đã xoá" when the joined row is absent)
  rather than assume the template still exists.
- Every send — automatic (on submission / Telegram opt-in) or manual (from
  the customer list) — writes one row here.

### Migration file

`migrations/0003_templates_and_logging.sql` — both `CREATE TABLE` statements
above, applied via `wrangler d1 migrations apply hien_le_garden_crm --remote`
same as prior migrations.

### Seed data (part of the same migration)

Two `INSERT` statements seeding the current hardcoded content as the initial
active templates, so guest-facing behavior does not change until someone
edits them in the UI:

- Email template: subject `"Mã ưu đãi từ Hiền Lê Garden Farmstay"`, body
  built from the existing `buildHtml()` markup in `lib/email.js`, rewritten
  with `{guestName}`, `{promoCode}`, `{discountPercent}`, `{expiresAt}`,
  `{giftLine}` in place of the current template-literal interpolations.
  `is_active = 1`, `created_by = 'system'`.
- Telegram template: body from the current message text built in
  `lib/telegram.js`, same variable substitution, `is_active = 1`,
  `created_by = 'system'`.

## Computed promo-code status (customer list + detail)

Not a stored column — computed at query time (or client-side from
`promo_status` + `promo_expires_at`, both already returned by the API):

```
if promo_status == 'used':        'used'    ("Đã dùng", gray)
elif promo_expires_at < now:      'expired' ("Hết hạn", red)
else:                              'valid'   ("Còn hạn", green)
```

Computed server-side in the list endpoint (see below) so the client never
duplicates date-comparison logic, and so the status filter (`?status=`)
can filter on it directly.

## API endpoints (all under `functions/api/`, all require auth)

### `GET /api/customers` — list, manager + reception

Query params: `search` (matches `guest_name`, `phone`, or `promo_code`,
case-insensitive substring), `status` (`valid` | `used` | `expired`,
omitted = all), `page` (1-based, default 1), `pageSize` (default 25, max
100).

Response:
```json
{
  "results": [
    {
      "feedbackId": "...", "guestName": "...", "phone": "...", "email": "...",
      "rating": 5, "promoCode": "HLG-XXXX", "discountPercent": 10,
      "promoStatus": "valid", "submittedAt": "2026-08-20T...",
      "wantsTelegram": true, "hasTelegramChatId": true,
      "giftOffered": true, "giftClaimed": false
    }
  ],
  "total": 42, "page": 1, "pageSize": 25
}
```

`hasTelegramChatId` (boolean, not the raw chat ID) tells the client whether
the Telegram send option can be enabled for this guest.

### `GET /api/customers/:feedbackId` — detail, manager + reception

Same fields as the list row plus `comment`, `stayDate`, `wishesNextTime`,
`favoriteActivities` (parsed array), and the guest's `message_log` history
(channel, template name, status, sent_at) for that `feedbackId`.

### `GET /api/templates` — list, manager + reception (read-only for reception)

Returns all templates (both channels, active and inactive) — reception
needs the full list to pick one for a manual send.

### `POST /api/templates` — create, manager only

Body: `{ name, channel, subject, body }`. `is_active` always starts `0` —
activation is a separate explicit action (below), never implicit on create,
so creating a new draft can never silently replace what's live.

### `PUT /api/templates/:id` — edit, manager only

Same body shape as create. Editing an active template edits it in place —
no separate "publish" step, since there is already an explicit
active/inactive toggle for going live.

### `DELETE /api/templates/:id` — manager only

Rejects with 400 if the template's `is_active = 1` — an active template
must be replaced (activate a different template on that channel) before
it can be deleted, so a channel is never left mid-delete without anyone
having made an explicit choice about what happens to automatic sends.

A channel with zero active templates is a valid steady state on its own
(reached by explicit deactivation, not by this guard) — it just means
automatic sends on that channel are skipped (see "Automatic send" below).

### `POST /api/templates/:id/activate` — manager only

Sets this template's `is_active = 1` and, in the same D1 batch, sets
`is_active = 0` on every other template with the same `channel`.

### `POST /api/templates/:id/deactivate` — manager only

Sets this template's `is_active = 0` and nothing else — the only way to
reach "no active template for this channel" (automatic sends on that
channel are then skipped until something is activated again). Without
this, a channel could never leave the active state once it entered it,
since `activate` always guarantees exactly one active template.

### `POST /api/customers/:feedbackId/send` — manual send, manager + reception

Body: `{ templateId }`. Loads the guest's row and the template, rejects
with 400 if the template's channel is `'telegram'` and the guest has no
`telegram_chat_id`, renders variables, sends via the existing
`sendPromoEmail`/`sendTelegramMessage` functions in `lib/email.js` /
`lib/telegram.js` (both generalized to accept pre-rendered
subject/body/text instead of building their own — see "Implementation
notes"), writes one `message_log` row regardless of send success/failure
(status reflects the outcome), and returns `{ ok: true }` or
`{ ok: false, error }`.

### `GET /api/users` — list, manager only

Returns `[{ id, username, role, createdAt }]` — never the password hash.

### `POST /api/users` — create, manager only

Body: `{ username, password, role }`. Hashes via the existing
`hashPassword` in `lib/auth.js` (same PBKDF2 scheme `scripts/seed-manager.js`
already uses). Rejects duplicate usernames with 409.

### `PATCH /api/users/:id/role` — manager only

Body: `{ role }`. Rejects with 400 if this would leave zero accounts with
`role = 'manager'`.

### `DELETE /api/users/:id` — manager only

Rejects with 400 if `id` is the requesting manager's own account. This
alone guarantees at least one manager always remains: deleting a manager
requires being an authenticated manager who isn't the target, so the
acting manager is always still there afterward — a separate "last manager"
count guard would be unreachable dead code on this endpoint (contrast with
`PATCH .../role` below, where a manager *can* target their own account).

### `POST /api/auth/change-password` — self-service, manager + reception

Body: `{ currentPassword, newPassword }`. Verifies `currentPassword` against
the caller's own stored hash (via `requireAuth`'s session) before accepting
`newPassword`; 400 on mismatch.

## Automatic send (replaces current hardcoded behavior)

`functions/api/feedback.js`: after inserting the feedback row, if `email` is
present, load the active `email` template (`is_active = 1`); if one exists,
render it and call `sendPromoEmail` with the rendered subject/body; if none
is active, skip silently (same as today's behavior would be — no email
provider configured means no send, no error to the guest).

`functions/api/telegram/webhook.js`: after recording `telegram_chat_id`,
load the active `telegram` template the same way, render, send via
`sendTelegramMessage`. Both automatic sends also write a `message_log` row
(`sent_by = 'system'`) so the send history in the customer detail view is
complete regardless of automatic vs. manual origin.

## UI pages

### `admin/customers.html` — new, manager + reception

Table (columns per the design doc above), search box, status filter
dropdown, pagination controls. Clicking a row expands/navigates to a detail
view (comment, wishes, activities, message history) with a "Gửi tin nhắn"
action: channel selector (Telegram option disabled with a tooltip if no
`telegram_chat_id`), template dropdown (filtered to the selected channel),
a read-only rendered preview (variables substituted with this guest's real
data), and a send button.

Linked from both `admin/manager.html` and `admin/reception.html` nav.

### `admin/templates.html` — new, manager only

List of templates grouped by channel, each showing name, active/inactive
badge, and edit/delete/activate-or-deactivate actions (the badge's own
toggle calls whichever of the two endpoints applies). Create-new form: name, channel,
subject (shown only when channel = email), body (plain textarea — no rich
text editor, matching the project's existing minimal-JS admin style).

Linked from `admin/manager.html` nav.

### `admin/users.html` — new, manager only

Table: username, role, created date, delete button (disabled with a
tooltip on self-row and on the last manager row — the client mirrors the
server's guard so the button is visibly disabled rather than erroring after
a click). Create-user form: username, initial password, role dropdown.
Role change: inline dropdown per row.

Linked from `admin/manager.html` nav.

### Change-password control — added to all three existing + new admin pages

A small collapsible section (or a shared top-of-page bar) present on
`manager.html`, `reception.html`, `customers.html`, `templates.html`,
`users.html`: current password, new password, submit. Uses
`POST /api/auth/change-password`. Implemented as one shared script
(`admin/change-password.js`) included via `<script>` tag on every admin
page, matching how `auth-guard.js`-equivalent logic already lives inline
per-page today (Task breakdown decides whether to extract a shared file or
duplicate the ~15 lines — either is small enough not to matter much, but a
shared file avoids five copies to keep in sync).

## Implementation notes

- `lib/email.js`'s `sendPromoEmail` and `lib/telegram.js`'s
  `sendTelegramMessage` currently build their own subject/body internally
  from raw fields. They need a signature change to accept a pre-rendered
  `subject`/`body` (email) or `text` (telegram) string instead, since
  rendering now happens once in a shared `lib/templates.js` helper
  (`renderTemplate(template, variables) -> { subject, body }`) used by both
  the automatic-send call sites and the manual `/send` endpoint. This is a
  breaking change to those two functions' call signatures — every existing
  call site (`functions/api/feedback.js`,
  `functions/api/telegram/webhook.js`) and every existing test
  (`test/email.test.js`, `test/telegram.test.js`,
  `test/feedbackEndpoint.test.js`, `test/telegramWebhook.test.js`) must be
  updated together in the same task.
- `escapeHtml` (already in `lib/email.js`) must still run on every
  variable substituted into an HTML email body, to preserve the existing
  XSS-injection protection covered by
  `test/email.test.js`'s "escapes HTML in guestName and promoCode" case —
  `renderTemplate` for the `email` channel escapes each variable value
  before substitution; the `telegram` channel does not (Telegram messages
  are plain text, matching current behavior).
- The new endpoints follow the exact `jsonError`/`requireAuth`/CORS-headers
  pattern already established in `functions/api/policy.js` and
  `functions/api/feedback.js` — no new conventions introduced.
- `GET /api/customers`'s `search` match uses SQLite's built-in `LOWER()`,
  which only case-folds ASCII. A search like `"vinh"` still matches
  `phone`/`promo_code` (always ASCII) and matches `guest_name` when the
  stored capitalization already lines up (e.g. `"Vĩnh"` vs a search for
  `"vĩnh"` matches; `"VĨNH"` does not lower-case-fold against it). This is
  a known limitation of D1/SQLite without an ICU extension, not a bug to
  fix in this pass — accept it as-is.

## Out of scope

- Rich-text/WYSIWYG template editing (plain textarea only, as noted above).
- Bulk/batch sending to multiple guests at once (one guest per manual send).
- Editing a guest's own submitted survey answers.
- Template versioning/history (editing a template overwrites it; no undo).
