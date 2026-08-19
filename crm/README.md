# Hiền Lê Garden CRM (checkout survey + loyalty codes)

Cloudflare Pages + Pages Functions + D1. See `docs/specs/2026-08-19-v4-crm-loyalty-design.md` for the design.

## One-time setup

1. `wrangler d1 create hien_le_garden_crm` — copy the returned `database_id` into `wrangler.toml`.
2. `wrangler d1 migrations apply hien_le_garden_crm --remote`
3. Set secrets:
   - `wrangler pages secret put BREVO_API_KEY`
   - `wrangler pages secret put TELEGRAM_BOT_TOKEN`
4. Create the first manager account:
   - `node scripts/seed-manager.js <username> <password>`
   - Run the printed `INSERT` with `wrangler d1 execute hien_le_garden_crm --remote --command "<sql>"`
   - `seed-manager.js` accepts an optional 3rd argument for role (`manager` or `reception`, defaults to `manager`). Create a reception account the same way: `node scripts/seed-manager.js <username> <password> reception`
5. Create the Telegram bot via @BotFather, set its webhook:
   - `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://crm.hienlegarden.vn/api/telegram/webhook"`
6. Point `crm.hienlegarden.vn` DNS at the Cloudflare Pages project (Cloudflare dashboard → Pages → Custom domains).
7. Verify the sending domain (`mail.hienlegarden.vn` or similar) in Brevo so `sender.email` in `lib/email.js` is authorized.

## Local development

```bash
npm install
npm run dev    # wrangler pages dev, local D1
npm test       # Vitest (crm/) — run from crm/
```

The root Playwright suite (`npm test` from the repo root) covers the survey/admin pages against a static server; it does not exercise the live Functions/D1 — that's what the Vitest suite in `crm/test/` is for.

## Deploy

```bash
npm run deploy   # wrangler pages deploy public
```

CI: extend `.github/workflows/test.yml` (repo root) with a second job that runs `cd crm && npm ci && npm test`, or add a dedicated workflow — not wired in this plan; add when the team decides deploys should be automated.
