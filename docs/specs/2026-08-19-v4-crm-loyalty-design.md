# V4 Checkout CRM & Loyalty — Design Spec

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a checkout feedback + loyalty flow to `v4`: guests scan a QR code at checkout, fill a short survey at `crm.hienlegarden.vn`, and receive a time-limited discount code (plus a counter gift, if in stock) by email and/or Telegram. Admin staff configure the active discount policy and redeem codes on a guest's next visit.

Scope is **v4 only**. v1/v2/v3 are untouched and remain independent repos/deployments. This spec also answers two standing questions from the original request: what infrastructure to run this on, and which email provider to use — both are folded into the architecture below rather than treated as separate deliverables.

## Current-state facts (verified before writing this spec)

- `v4` (repo `hien-le-garden-v4`) is currently a byte-identical copy of `v3`: a static site with **no backend, no database, no forms, and no build tooling** (confirmed via `diff -rq v3 v4` and grep for `fetch(`/`form`/`apps-script` in `v4/index.html`).
- A Playwright regression suite already exists at the `hien-le-garden` repo root (`tests/`), covering both `v3` and `v4` as separate projects. It has no knowledge of any backend — it only exercises static HTML/CSS/JS.
- No customer database exists anywhere in the business today; contact info is currently gathered ad hoc over Zalo/phone.
- Checkout volume is small: under 50 guests/day.
- Telegram Bot API cannot push a message to a user who has not first opened a chat with the bot and pressed **Start** — this is a hard platform constraint, not a design choice, and shapes the notification flow below.

## Decisions (confirmed with user)

1. **Architecture**: managed/serverless — Cloudflare Pages (static site + survey form + admin UI) + Cloudflare Workers (API) + D1 (SQLite-compatible serverless database). No VPS to provision or patch.
2. **QR code**: one static QR code, printed/displayed at the checkout counter, shared by all guests. It links to the survey page. No per-booking QR generation, since no booking system exists to link it to.
3. **Survey collects fresh contact info** each time (name, phone, email optional, Telegram opt-in, 1–5 rating, free-text comment, consent checkbox) — it is the first structured place this data is captured.
4. **Notification channels**: both email and Telegram; guest fills in whichever they want (at least one contact method required to receive the code).
5. **Discount code validity: 6 months from issue date.**
6. **Redemption is manual**: reception looks the code up in the admin UI on the guest's next visit and marks it used. No integration with a payment/booking system.
7. **Gift inventory is tracked**: admin/reception can see and decrement stock; the system stops offering the gift line in notifications once stock hits zero.
8. **Admin roles**: two roles — **Reception** (look up/redeem codes, decrement gift stock on claim) and **Manager** (everything Reception can do, plus configure discount %, campaign date range, gift toggle, and gift stock levels).
9. **Email provider: Brevo** (not Resend — see §6).

## 1. Architecture

```
Guest scans static QR at checkout
        ↓
Cloudflare Pages — survey form (crm.hienlegarden.vn)
        ↓  POST /api/feedback
Cloudflare Worker (API)  ⇄  D1 database
        ↓                        ↓
   Brevo (email)          Telegram Bot API

Cloudflare Pages — admin UI (crm.hienlegarden.vn/admin)
        ↓  authenticated requests
Cloudflare Worker (API)  ⇄  D1 database
```

- **Why serverless over VPS**: at <50 checkouts/day, a VPS would sit almost entirely idle while still costing a fixed monthly fee and requiring someone to patch, back up, and monitor it. Cloudflare's free tier (Pages, Workers, D1) comfortably covers this volume with zero fixed cost and no server to maintain. The full VPS analysis is kept in §5 as the fallback option, since it was explicitly requested.
- **Why not the Google Apps Script hybrid**: it was viable at this scale (evidenced by the `google-apps-script.js` file found in the old `v4` before this session's duplication overwrote it), but a Google Sheet as the admin UI can't cleanly support two roles, code redemption state, or gift stock decrementing without becoming a pile of Apps Script glue. The Cloudflare stack gives a real admin UI for roughly the same operating cost (free).
- Deployment stays git-based, consistent with how `v3`/`v4` are already deployed (push → CI/CD), just adding a Worker + D1 binding to the existing Pages project.

## 2. Data model (D1 / SQLite)

```
feedback_responses
  id                 TEXT PRIMARY KEY (uuid)
  submitted_at       TEXT (ISO datetime)
  guest_name         TEXT
  phone              TEXT
  email              TEXT NULL
  wants_telegram     INTEGER (bool)
  telegram_chat_id   TEXT NULL          -- filled in once the guest presses Start
  rating             INTEGER (1-5)
  comment            TEXT NULL
  consent_given      INTEGER (bool)     -- required to submit
  promo_code         TEXT UNIQUE
  discount_percent   INTEGER            -- copied from active policy at submit time
  promo_expires_at   TEXT               -- submitted_at + 6 months
  promo_status       TEXT               -- 'unused' | 'used' | 'expired'
  redeemed_at        TEXT NULL
  redeemed_by        TEXT NULL          -- staff username
  gift_offered       INTEGER (bool)     -- was gift in stock at submit time
  gift_claimed       INTEGER (bool)

promo_policy
  id                 INTEGER PRIMARY KEY
  discount_percent   INTEGER
  valid_from         TEXT (date)
  valid_to           TEXT (date)
  is_active          INTEGER (bool)
  gift_enabled       INTEGER (bool)
  updated_by         TEXT
  updated_at         TEXT
  -- multiple rows allowed (seasonal campaigns); at most one row is_active=1
  -- per date range at a time — enforced in the Worker, not the schema.
  -- If no row is active for today's date, the Worker falls back to
  -- discount_percent=0 and gift_enabled=false — a code is still issued
  -- (as a thank-you record), so submission never fails on missing config.

gift_inventory
  id                 INTEGER PRIMARY KEY
  name               TEXT
  stock_count        INTEGER
  updated_at         TEXT

staff_accounts
  id                 INTEGER PRIMARY KEY
  username            TEXT UNIQUE
  password_hash       TEXT             -- scrypt/PBKDF2 via Web Crypto (Workers-native)
  role                TEXT             -- 'reception' | 'manager'
  created_at          TEXT
```

`promo_status` is computed as `expired` at read time if `now > promo_expires_at` and still `unused` — no cron needed to flip it.

## 3. Guest-facing flow

1. Guest scans the counter QR → lands on the survey page (`crm.hienlegarden.vn`).
2. Form fields: name, phone, email (optional), "nhận mã qua Telegram?" checkbox, rating (1–5), comment (optional), consent checkbox (required — see §7). At least one of email/Telegram must be chosen to submit.
3. On submit, the Worker:
   - Reads the currently active `promo_policy` row for today's date.
   - Generates a unique `promo_code` (format `HLG-XXXXXX`), sets `promo_expires_at = now + 6 months`.
   - Checks `gift_inventory.stock_count`; sets `gift_offered` accordingly.
   - Inserts the `feedback_responses` row.
4. Confirmation screen shows the code and expiry immediately (so the guest has it even if a notification fails to send).
5. **Email** (if provided): Worker calls Brevo's transactional email API with a Hiền Lê Garden–branded HTML template (logo, gold/dark-green palette matching the site) containing the code, discount %, expiry date, and the gift pickup line if `gift_offered`.
6. **Telegram** (if opted in): confirmation screen shows a deep-link button `https://t.me/<HienLeGardenBot>?start=<feedback_id>`. Guest taps it, opens Telegram, presses Start. The bot's `/start` webhook handler (a Worker route) reads the `feedback_id` payload, stores `telegram_chat_id` on that row, and sends the same branded message via the Bot API. This indirection exists solely because of the Telegram platform constraint noted above — it cannot be simplified further.

## 4. Admin flow

- Login: username/password (per staff member), session cookie issued by the Worker.
- **Reception view**: a single "Tra cứu mã" screen — enter a `promo_code`, see guest name, discount %, status (unused/used/expired), gift status. Actions: "Đánh dấu đã dùng" (sets `promo_status='used'`, `redeemed_at`, `redeemed_by`); "Đã phát quà" (sets `gift_claimed=1`, decrements `gift_inventory.stock_count`, blocked with a "Hết quà" message if stock is already 0).
- **Manager view**: everything above, plus "Cấu hình khuyến mãi" (create/edit `promo_policy` rows: discount %, valid_from/valid_to, is_active, gift_enabled) and "Kho quà" (set/adjust `gift_inventory.stock_count`).

## 5. Infrastructure analysis (VPS, as requested)

Chosen path is serverless (§1), but since VPS sizing was explicitly requested, here is the equivalent if this were ever self-hosted instead:

| Aspect | Recommendation |
|---|---|
| Compute | 1 vCPU / 1–2 GB RAM / 25 GB SSD — e.g. DigitalOcean/Vultr Basic droplet (~$6/mo) or a VN provider (Vietnix/TinoHost, ~100–150k VNĐ/mo) |
| Stack | Node.js/Express (or same Worker code adapted) + PostgreSQL or SQLite, behind Nginx with Let's Encrypt TLS |
| Why this is enough | <50 checkouts/day plus a handful of admin sessions is a trivial load; this spec is sized for headroom, not the ceiling |
| What you take on vs. serverless | OS/security patching, database backups, uptime monitoring, TLS renewal — all of which Cloudflare's managed stack removes entirely at this scale |

Recommendation stands: only move to a VPS if a future requirement needs something Cloudflare's stack can't do (e.g., long-running background jobs, a specific self-hosted dependency).

## 6. Email provider: Brevo

- Free tier: 300 emails/day. At ≤50 checkouts/day this covers 100% of expected volume with headroom for retries.
- REST API works over plain `fetch` inside a Cloudflare Worker — no Node-only SDK dependency.
- Supports custom-domain sending (e.g. `mail.hienlegarden.vn`) and HTML templates, which covers the "branded template" requirement in §3.
- Fallback if volume ever outgrows the free tier: Brevo's paid tiers scale by email volume without switching providers, so there is no forced migration later.

## 7. Data privacy

The survey collects name, phone, and optionally email — personal data under Vietnam's Nghị định 13/2023/NĐ-CP on personal data protection. The consent checkbox (§3, step 2) is mandatory to submit, with a short notice on what the data is used for (contacting the guest with their promo code / rare follow-up on feedback) and no third-party sharing.

## 8. Testing

Extends, not replaces, the existing suite from the testing sub-project:

- Playwright specs for the survey page (form validation, required-field/consent enforcement, submit flow against a mocked API) and the admin login/redemption screens, added alongside the existing `tests/e2e/` and `tests/seo/` suites.
- Worker API logic (code generation, policy lookup, redemption, gift stock decrement) gets its own Vitest unit tests using Cloudflare's `@cloudflare/vitest-pool-workers` — the standard, Workers-native test runner — kept separate from the Playwright suite since it tests API logic, not rendered pages.

## Non-goals (this iteration)

- No integration with a real booking/PMS system (none exists yet).
- No per-booking/dynamic QR codes.
- No automated redemption (POS integration) — redemption stays a manual admin lookup.
- No SMS channel.
