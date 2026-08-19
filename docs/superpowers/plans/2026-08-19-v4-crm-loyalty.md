# V4 Checkout CRM & Loyalty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the checkout survey → promo-code → notification → admin-redemption flow described in the spec, running entirely on Cloudflare Pages + Pages Functions + D1.

**Architecture:** A single Cloudflare Pages project at `crm/` serves the static survey/admin HTML and, via file-based Pages Functions (`crm/functions/**`), the API — this is the concrete implementation of the spec's "Cloudflare Workers" layer: Pages Functions run on the same Workers runtime and bind directly to D1, so there is no separate Worker deployable to manage. Business logic (code generation, policy resolution, auth) lives in plain JS modules under `crm/lib/`, imported by both the Functions and their Vitest unit tests.

**Tech Stack:** Cloudflare Pages, Pages Functions (JS, Workers runtime), D1 (SQLite), Vitest + `@cloudflare/vitest-pool-workers` for API/logic tests, Playwright (extending the existing suite) for UI tests, Brevo transactional email API, Telegram Bot API, Web Crypto (PBKDF2) for password hashing.

**Spec:** `docs/specs/2026-08-19-v4-crm-loyalty-design.md`

## Global Constraints

- Promo codes expire **6 months** from issue date, computed with calendar-correct month math (not naive day-add).
- Email provider is **Brevo**, not Resend.
- QR code is **static and shared** — the survey form itself collects name/phone/email fresh; no booking-system linkage.
- Redemption is **manual only** — reception looks up a code and marks it used; no POS/payment integration.
- Telegram delivery requires the guest to press **Start** on the bot first (deep link from the confirmation screen) — the backend can never push a Telegram message to a guest who hasn't done this.
- Two roles: **reception** (lookup/redeem codes, claim gifts) and **manager** (all reception permissions + configure discount policy + set gift stock).
- If no `promo_policy` row is active for today, the API must still issue a code, falling back to `discount_percent=0`, `gift_enabled=false`.
- Consent checkbox is mandatory to submit the survey (Nghị định 13/2023 personal-data compliance).
- No TypeScript build step — plain JS, consistent with the rest of the repo.

---

## Task 1: Project scaffold — directories, config, D1 schema

**Files:**
- Create: `crm/wrangler.toml`
- Create: `crm/package.json`
- Create: `crm/schema.sql`
- Create: `crm/vitest.config.js`
- Create: `crm/.gitignore`

**Interfaces:**
- Produces: the `hien_le_garden_crm` D1 database binding (env var `DB` in all Functions), and the four tables (`feedback_responses`, `promo_policy`, `gift_inventory`, `staff_accounts`) every later task reads/writes.

- [ ] **Step 1: Create the directory structure**

Run:
```bash
mkdir -p crm/functions/api crm/lib crm/public crm/test
```

- [ ] **Step 2: Write `crm/wrangler.toml`**

```toml
name = "hien-le-garden-crm"
compatibility_date = "2024-09-01"
pages_build_output_dir = "public"

[[d1_databases]]
binding = "DB"
database_name = "hien_le_garden_crm"
database_id = "REPLACE_AFTER_WRANGLER_D1_CREATE"
```

- [ ] **Step 3: Write `crm/schema.sql`**

```sql
CREATE TABLE feedback_responses (
  id TEXT PRIMARY KEY,
  submitted_at TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  wants_telegram INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id TEXT,
  rating INTEGER NOT NULL,
  comment TEXT,
  consent_given INTEGER NOT NULL,
  promo_code TEXT NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL,
  promo_expires_at TEXT NOT NULL,
  promo_status TEXT NOT NULL DEFAULT 'unused',
  redeemed_at TEXT,
  redeemed_by TEXT,
  gift_offered INTEGER NOT NULL DEFAULT 0,
  gift_claimed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_feedback_promo_code ON feedback_responses(promo_code);

CREATE TABLE promo_policy (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discount_percent INTEGER NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  gift_enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE gift_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stock_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE staff_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reception', 'manager')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  staff_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
```

(`sessions` wasn't in the spec's data model table but is required to implement §4's "session cookie issued by the Worker" — noted here since it's an addition beyond the spec.)

- [ ] **Step 4: Write `crm/package.json`**

```json
{
  "name": "hien-le-garden-crm",
  "private": true,
  "version": "1.0.0",
  "scripts": {
    "dev": "wrangler pages dev public --d1=DB",
    "test": "vitest run",
    "deploy": "wrangler pages deploy public"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "vitest": "^2.1.0",
    "wrangler": "^3.78.0"
  }
}
```

- [ ] **Step 5: Write `crm/vitest.config.js`**

```js
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
```

- [ ] **Step 6: Write `crm/.gitignore`**

```
node_modules/
.wrangler/
```

- [ ] **Step 7: Install dependencies and verify Vitest runs (even with zero tests)**

Run: `cd crm && npm install && npm test`
Expected: Vitest reports "No test files found" without erroring — confirms the pool/config wiring is correct before any real code exists.

- [ ] **Step 8: Commit**

```bash
git add crm/wrangler.toml crm/package.json crm/schema.sql crm/vitest.config.js crm/.gitignore
git commit -m "chore(crm): scaffold Cloudflare Pages Functions project + D1 schema"
```

---

## Task 2: Date/code utilities — promo code generation and 6-month expiry

**Files:**
- Create: `crm/lib/promoCode.js`
- Test: `crm/test/promoCode.test.js`

**Interfaces:**
- Produces: `generatePromoCode(): string`, `addMonthsClamped(date: Date, months: number): Date`, `computeExpiry(submittedAt: Date): Date` — used by Task 7's feedback endpoint.

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/promoCode.test.js
import { describe, it, expect } from 'vitest';
import { generatePromoCode, addMonthsClamped, computeExpiry } from '../lib/promoCode.js';

describe('generatePromoCode', () => {
  it('matches the HLG-XXXXXX format with unambiguous characters', () => {
    const code = generatePromoCode();
    expect(code).toMatch(/^HLG-[A-HJ-NP-Z2-9]{6}$/);
  });

  it('produces different codes on repeated calls', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePromoCode()));
    expect(codes.size).toBe(50);
  });
});

describe('addMonthsClamped', () => {
  it('adds months within the same day-of-month when possible', () => {
    const result = addMonthsClamped(new Date('2026-01-15T00:00:00Z'), 6);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('clamps to the last day of the target month on overflow', () => {
    // Aug 31 + 6 months = Feb, which has 28 days in 2027 (not a leap year)
    const result = addMonthsClamped(new Date('2026-08-31T00:00:00Z'), 6);
    expect(result.toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('computeExpiry', () => {
  it('is exactly addMonthsClamped(submittedAt, 6)', () => {
    const submitted = new Date('2026-03-10T09:00:00Z');
    expect(computeExpiry(submitted).toISOString()).toBe(addMonthsClamped(submitted, 6).toISOString());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — `../lib/promoCode.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/lib/promoCode.js

// Excludes 0/O and 1/I to avoid reception misreading codes read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePromoCode() {
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `HLG-${code}`;
}

export function addMonthsClamped(date, months) {
  const result = new Date(date.getTime());
  const targetMonth = result.getUTCMonth() + months;
  const originalDay = result.getUTCDate();

  result.setUTCDate(1); // avoid month-rollover surprises while shifting the month
  result.setUTCMonth(targetMonth);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

export function computeExpiry(submittedAt) {
  return addMonthsClamped(submittedAt, 6);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/lib/promoCode.js crm/test/promoCode.test.js
git commit -m "feat(crm): add promo code generation and 6-month expiry math"
```

---

## Task 3: Policy resolution — active discount lookup with safe fallback

**Files:**
- Create: `crm/lib/policy.js`
- Test: `crm/test/policy.test.js`

**Interfaces:**
- Consumes: D1 `env.DB` binding, `promo_policy` table (Task 1 schema).
- Produces: `resolveActivePolicy(db, todayISODate: string): Promise<{ policyId: number|null, discountPercent: number, giftEnabled: boolean }>` — used by Task 7.

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/policy.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resolveActivePolicy } from '../lib/policy.js';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM promo_policy');
});

describe('resolveActivePolicy', () => {
  it('returns the active policy covering today', async () => {
    await env.DB.prepare(
      `INSERT INTO promo_policy (discount_percent, valid_from, valid_to, is_active, gift_enabled, updated_by, updated_at)
       VALUES (15, '2026-08-01', '2026-08-31', 1, 1, 'manager1', '2026-08-01T00:00:00Z')`
    ).run();

    const result = await resolveActivePolicy(env.DB, '2026-08-19');
    expect(result).toEqual({ policyId: 1, discountPercent: 15, giftEnabled: true });
  });

  it('falls back to 0% / no gift when no policy covers today', async () => {
    const result = await resolveActivePolicy(env.DB, '2026-08-19');
    expect(result).toEqual({ policyId: null, discountPercent: 0, giftEnabled: false });
  });

  it('ignores policies marked inactive', async () => {
    await env.DB.prepare(
      `INSERT INTO promo_policy (discount_percent, valid_from, valid_to, is_active, gift_enabled, updated_by, updated_at)
       VALUES (20, '2026-08-01', '2026-08-31', 0, 1, 'manager1', '2026-08-01T00:00:00Z')`
    ).run();

    const result = await resolveActivePolicy(env.DB, '2026-08-19');
    expect(result.policyId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — `../lib/policy.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/lib/policy.js

export async function resolveActivePolicy(db, todayISODate) {
  const row = await db
    .prepare(
      `SELECT id, discount_percent, gift_enabled FROM promo_policy
       WHERE is_active = 1 AND valid_from <= ?1 AND valid_to >= ?1
       ORDER BY id DESC LIMIT 1`
    )
    .bind(todayISODate)
    .first();

  if (!row) {
    return { policyId: null, discountPercent: 0, giftEnabled: false };
  }

  return {
    policyId: row.id,
    discountPercent: row.discount_percent,
    giftEnabled: !!row.gift_enabled,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/lib/policy.js crm/test/policy.test.js
git commit -m "feat(crm): resolve active discount policy with safe fallback"
```

---

## Task 4: Password hashing + auth session utilities

**Files:**
- Create: `crm/lib/auth.js`
- Test: `crm/test/auth.test.js`

**Interfaces:**
- Consumes: D1 `env.DB` (`staff_accounts`, `sessions` tables).
- Produces: `hashPassword(password: string): Promise<string>`, `verifyPassword(password: string, stored: string): Promise<boolean>`, `createSession(db, staffId: number): Promise<string>` (returns token), `getSession(db, token: string): Promise<{ staffId, role, username } | null>` — used by Task 5 (login endpoint) and Task 8/9 (protected admin endpoints).

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/auth.test.js
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { hashPassword, verifyPassword, createSession, getSession } from '../lib/auth.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies a correct password against its hash', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('produces different hashes for the same password (random salt)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });
});

describe('createSession / getSession', () => {
  it('creates a session that resolves back to the staff account', async () => {
    await env.DB.prepare(
      `INSERT INTO staff_accounts (id, username, password_hash, role, created_at)
       VALUES (1, 'le_tan_a', 'x', 'reception', '2026-08-01T00:00:00Z')`
    ).run();

    const token = await createSession(env.DB, 1);
    const session = await getSession(env.DB, token);
    expect(session).toEqual({ staffId: 1, username: 'le_tan_a', role: 'reception' });
  });

  it('returns null for an unknown token', async () => {
    expect(await getSession(env.DB, 'does-not-exist')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — `../lib/auth.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/lib/auth.js

const PBKDF2_ITERATIONS = 100000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function bufferToHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function deriveKey(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufferToHex(bits);
}

export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveKey(password, saltBytes);
  return `${bufferToHex(saltBytes)}:${hash}`;
}

export async function verifyPassword(password, stored) {
  const [saltHex, expectedHash] = stored.split(':');
  const actualHash = await deriveKey(password, hexToBuffer(saltHex));
  return actualHash === expectedHash;
}

export async function createSession(db, staffId) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db
    .prepare(`INSERT INTO sessions (token, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(token, staffId, now.toISOString(), expiresAt.toISOString())
    .run();
  return token;
}

export async function getSession(db, token) {
  const row = await db
    .prepare(
      `SELECT s.staff_id AS staffId, a.username, a.role FROM sessions s
       JOIN staff_accounts a ON a.id = s.staff_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, new Date().toISOString())
    .first();

  if (!row) return null;
  return { staffId: row.staffId, username: row.username, role: row.role };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/lib/auth.js crm/test/auth.test.js
git commit -m "feat(crm): add password hashing and session utilities"
```

---

## Task 5: Auth endpoint + seed script for the first manager account

**Files:**
- Create: `crm/functions/api/auth/login.js`
- Create: `crm/functions/api/auth/logout.js`
- Create: `crm/scripts/seed-manager.js`
- Test: `crm/test/authEndpoint.test.js`

**Interfaces:**
- Consumes: `hashPassword`, `verifyPassword`, `createSession` from Task 4.
- Produces: `POST /api/auth/login` (body `{username, password}` → sets `session` cookie, returns `{username, role}`), `POST /api/auth/logout` (clears cookie) — consumed by Task 10's login page and Task 8/9's protected endpoints (which read the same `session` cookie).

- [ ] **Step 1: Write the failing test**

```js
// crm/test/authEndpoint.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { hashPassword } from '../lib/auth.js';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  const hash = await hashPassword('s3cret-pass');
  await env.DB.prepare(
    `INSERT INTO staff_accounts (id, username, password_hash, role, created_at)
     VALUES (1, 'quan_ly_a', ?, 'manager', '2026-08-01T00:00:00Z')`
  ).bind(hash).run();
});

describe('POST /api/auth/login', () => {
  it('sets a session cookie and returns the role on correct credentials', async () => {
    const request = new Request('https://crm.hienlegarden.vn/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'quan_ly_a', password: 's3cret-pass' }),
    });
    const response = await login({ request, env });

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/^session=/);
    expect(await response.json()).toEqual({ username: 'quan_ly_a', role: 'manager' });
  });

  it('returns 401 on wrong password', async () => {
    const request = new Request('https://crm.hienlegarden.vn/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'quan_ly_a', password: 'wrong' }),
    });
    const response = await login({ request, env });
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd crm && npm test`
Expected: FAIL — `../functions/api/auth/login.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/functions/api/auth/login.js
import { verifyPassword, createSession } from '../../../lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { username, password } = await request.json();

  const account = await env.DB.prepare(
    `SELECT id, password_hash, role FROM staff_accounts WHERE username = ?`
  )
    .bind(username)
    .first();

  if (!account || !(await verifyPassword(password, account.password_hash))) {
    return new Response(JSON.stringify({ error: 'Sai tài khoản hoặc mật khẩu' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const token = await createSession(env.DB, account.id);

  return new Response(JSON.stringify({ username, role: account.role }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
    },
  });
}
```

```js
// crm/functions/api/auth/logout.js
export async function onRequestPost() {
  return new Response(null, {
    status: 204,
    headers: {
      'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    },
  });
}
```

```js
// crm/scripts/seed-manager.js
// Run once against production after the first deploy:
//   node crm/scripts/seed-manager.js <username> <password>
// then apply the printed SQL with:
//   wrangler d1 execute hien_le_garden_crm --remote --command "<printed SQL>"
import { webcrypto as crypto } from 'node:crypto';

async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256
  );
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${toHex(saltBytes)}:${toHex(bits)}`;
}

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: node seed-manager.js <username> <password>');
  process.exit(1);
}
const hash = await hashPassword(password);
console.log(
  `INSERT INTO staff_accounts (username, password_hash, role, created_at) VALUES ('${username}', '${hash}', 'manager', '${new Date().toISOString()}');`
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd crm && npm test`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/functions/api/auth crm/scripts/seed-manager.js crm/test/authEndpoint.test.js
git commit -m "feat(crm): add login/logout endpoints and manager seed script"
```

---

## Task 6: Brevo email helper

**Files:**
- Create: `crm/lib/email.js`
- Test: `crm/test/email.test.js`

**Interfaces:**
- Produces: `sendPromoEmail(env, { to, guestName, promoCode, discountPercent, expiresAt, giftOffered }): Promise<void>` — used by Task 8's feedback endpoint. Never throws on Brevo API failure (logs and returns) so a guest's submission never fails just because the email provider had a hiccup.
- Consumes: `env.BREVO_API_KEY` secret.

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/email.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendPromoEmail } from '../lib/email.js';

describe('sendPromoEmail', () => {
  const baseArgs = {
    to: 'khach@example.com',
    guestName: 'Nguyễn Văn A',
    promoCode: 'HLG-4F7K9P',
    discountPercent: 15,
    expiresAt: new Date('2027-02-19T00:00:00Z'),
    giftOffered: true,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the Brevo API with the correct recipient and API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendPromoEmail({ BREVO_API_KEY: 'test-key' }, baseArgs);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(options.headers['api-key']).toBe('test-key');
    const body = JSON.parse(options.body);
    expect(body.to).toEqual([{ email: 'khach@example.com', name: 'Nguyễn Văn A' }]);
    expect(body.htmlContent).toContain('HLG-4F7K9P');
    expect(body.htmlContent).toContain('15%');
  });

  it('does not throw when the Brevo API call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));
    await expect(sendPromoEmail({ BREVO_API_KEY: 'test-key' }, baseArgs)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — `../lib/email.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/lib/email.js

function formatDate(date) {
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildHtml({ guestName, promoCode, discountPercent, expiresAt, giftOffered }) {
  const giftLine = giftOffered
    ? '<p>Mang mã này đến quầy lễ tân để nhận thêm quà lưu niệm nhé!</p>'
    : '';
  return `
    <div style="font-family: Georgia, serif; background:#0D1F14; color:#F5F0E6; padding:32px;">
      <h1 style="color:#C9A84C;">Hiền Lê Garden Farmstay</h1>
      <p>Xin chào ${guestName},</p>
      <p>Cảm ơn bạn đã chia sẻ trải nghiệm tại Hiền Lê Garden. Đây là mã ưu đãi dành riêng cho bạn:</p>
      <p style="font-size:28px; letter-spacing:2px; color:#C9A84C; font-weight:bold;">${promoCode}</p>
      <p>Giảm <strong>${discountPercent}%</strong> cho lần sử dụng dịch vụ tiếp theo, có hiệu lực đến <strong>${formatDate(expiresAt)}</strong>.</p>
      ${giftLine}
      <p>Hẹn gặp lại bạn tại Hiền Lê Garden!</p>
    </div>
  `;
}

export async function sendPromoEmail(env, { to, guestName, promoCode, discountPercent, expiresAt, giftOffered }) {
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'api-key': env.BREVO_API_KEY,
      },
      body: JSON.stringify({
        sender: { email: 'khuyenmai@hienlegarden.vn', name: 'Hiền Lê Garden' },
        to: [{ email: to, name: guestName }],
        subject: 'Mã ưu đãi từ Hiền Lê Garden Farmstay',
        htmlContent: buildHtml({ guestName, promoCode, discountPercent, expiresAt, giftOffered }),
      }),
    });

    if (!response.ok) {
      console.error('Brevo send failed', response.status, await response.text());
    }
  } catch (err) {
    console.error('Brevo send threw', err);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/lib/email.js crm/test/email.test.js
git commit -m "feat(crm): add Brevo transactional email helper"
```

---

## Task 7: Telegram bot helper + webhook handler

**Files:**
- Create: `crm/lib/telegram.js`
- Create: `crm/functions/api/telegram/webhook.js`
- Test: `crm/test/telegram.test.js`
- Test: `crm/test/telegramWebhook.test.js`

**Interfaces:**
- Produces: `sendTelegramMessage(env, { chatId, guestName, promoCode, discountPercent, expiresAt, giftOffered }): Promise<void>` and the `POST /api/telegram/webhook` route (Telegram calls this on every bot update).
- Consumes: `env.TELEGRAM_BOT_TOKEN`, `feedback_responses` table (Task 1).

- [ ] **Step 1: Write the failing test for the message helper**

```js
// crm/test/telegram.test.js
import { describe, it, expect, vi } from 'vitest';
import { sendTelegramMessage } from '../lib/telegram.js';

describe('sendTelegramMessage', () => {
  it('calls the Telegram sendMessage API with the chat id and formatted text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegramMessage(
      { TELEGRAM_BOT_TOKEN: 'test-token' },
      {
        chatId: '123456',
        guestName: 'Nguyễn Văn A',
        promoCode: 'HLG-4F7K9P',
        discountPercent: 15,
        expiresAt: new Date('2027-02-19T00:00:00Z'),
        giftOffered: false,
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    const body = JSON.parse(options.body);
    expect(body.chat_id).toBe('123456');
    expect(body.text).toContain('HLG-4F7K9P');
  });
});
```

- [ ] **Step 2: Run test to verify it fails, then write the implementation**

Run: `cd crm && npm test` — expect FAIL (`../lib/telegram.js` missing).

```js
// crm/lib/telegram.js

function formatDate(date) {
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export async function sendTelegramMessage(env, { chatId, guestName, promoCode, discountPercent, expiresAt, giftOffered }) {
  const giftLine = giftOffered ? '\n🎁 Mang mã này đến quầy lễ tân để nhận thêm quà lưu niệm nhé!' : '';
  const text =
    `🌿 *Hiền Lê Garden Farmstay*\n\n` +
    `Xin chào ${guestName}, cảm ơn bạn đã chia sẻ trải nghiệm!\n\n` +
    `Mã ưu đãi của bạn: *${promoCode}*\n` +
    `Giảm *${discountPercent}%* cho lần sau, có hiệu lực đến *${formatDate(expiresAt)}*.` +
    giftLine;

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    if (!response.ok) {
      console.error('Telegram send failed', response.status, await response.text());
    }
  } catch (err) {
    console.error('Telegram send threw', err);
  }
}
```

Run: `cd crm && npm test` — expect PASS.

- [ ] **Step 3: Write the failing test for the webhook**

```js
// crm/test/telegramWebhook.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as webhook } from '../functions/api/telegram/webhook.js';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM feedback_responses');
  await env.DB.prepare(
    `INSERT INTO feedback_responses
     (id, submitted_at, guest_name, phone, wants_telegram, rating, consent_given,
      promo_code, discount_percent, promo_expires_at, promo_status, gift_offered, gift_claimed)
     VALUES ('fb-1', '2026-08-19T10:00:00Z', 'Nguyễn Văn A', '0900000000', 1, 5, 1,
             'HLG-4F7K9P', 15, '2027-02-19T00:00:00Z', 'unused', 0, 0)`
  ).run();
});

describe('POST /api/telegram/webhook', () => {
  it('links the chat id to the feedback row and sends the promo message on /start', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const update = {
      message: { chat: { id: 987654 }, text: '/start fb-1' },
    };
    const request = new Request('https://crm.hienlegarden.vn/api/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify(update),
    });

    const response = await webhook({ request, env: { ...env, TELEGRAM_BOT_TOKEN: 'test-token' } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT telegram_chat_id FROM feedback_responses WHERE id = 'fb-1'`).first();
    expect(row.telegram_chat_id).toBe('987654');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores updates with an unknown feedback id without throwing', async () => {
    const update = { message: { chat: { id: 1 }, text: '/start unknown-id' } };
    const request = new Request('https://crm.hienlegarden.vn/api/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify(update),
    });
    const response = await webhook({ request, env: { ...env, TELEGRAM_BOT_TOKEN: 'test-token' } });
    expect(response.status).toBe(200);
  });
});
```

- [ ] **Step 4: Run test to verify it fails, then write the implementation**

Run: `cd crm && npm test` — expect FAIL (`../functions/api/telegram/webhook.js` missing).

```js
// crm/functions/api/telegram/webhook.js
import { sendTelegramMessage } from '../../../lib/telegram.js';

export async function onRequestPost({ request, env }) {
  const update = await request.json();
  const message = update.message;

  if (!message || !message.text || !message.text.startsWith('/start ')) {
    return new Response('ok', { status: 200 });
  }

  const feedbackId = message.text.replace('/start ', '').trim();
  const chatId = String(message.chat.id);

  const row = await env.DB.prepare(
    `SELECT guest_name, promo_code, discount_percent, promo_expires_at, gift_offered
     FROM feedback_responses WHERE id = ?`
  )
    .bind(feedbackId)
    .first();

  if (!row) {
    return new Response('ok', { status: 200 });
  }

  await env.DB.prepare(`UPDATE feedback_responses SET telegram_chat_id = ? WHERE id = ?`)
    .bind(chatId, feedbackId)
    .run();

  await sendTelegramMessage(env, {
    chatId,
    guestName: row.guest_name,
    promoCode: row.promo_code,
    discountPercent: row.discount_percent,
    expiresAt: new Date(row.promo_expires_at),
    giftOffered: !!row.gift_offered,
  });

  return new Response('ok', { status: 200 });
}
```

Run: `cd crm && npm test` — expect PASS.

- [ ] **Step 5: Commit**

```bash
git add crm/lib/telegram.js crm/functions/api/telegram crm/test/telegram.test.js crm/test/telegramWebhook.test.js
git commit -m "feat(crm): add Telegram promo message helper and /start webhook"
```

---

## Task 8: POST /api/feedback — the core submission endpoint

**Files:**
- Create: `crm/functions/api/feedback.js`
- Test: `crm/test/feedbackEndpoint.test.js`

**Interfaces:**
- Consumes: `generatePromoCode`, `computeExpiry` (Task 2), `resolveActivePolicy` (Task 3), `sendPromoEmail` (Task 6), `gift_inventory`/`feedback_responses` tables.
- Produces: `POST /api/feedback` — request body `{ guestName, phone, email?, wantsTelegram, rating, comment?, consentGiven }`; response `{ feedbackId, promoCode, discountPercent, expiresAt, giftOffered }` — consumed by Task 10's survey page.

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/feedbackEndpoint.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as submitFeedback } from '../functions/api/feedback.js';

beforeEach(async () => {
  await env.DB.exec('DELETE FROM feedback_responses');
  await env.DB.exec('DELETE FROM promo_policy');
  await env.DB.exec('DELETE FROM gift_inventory');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 201 })));
});

function validBody(overrides = {}) {
  return {
    guestName: 'Nguyễn Văn A',
    phone: '0900000000',
    email: 'khach@example.com',
    wantsTelegram: false,
    rating: 5,
    comment: 'Rất tuyệt vời',
    consentGiven: true,
    ...overrides,
  };
}

describe('POST /api/feedback', () => {
  it('rejects submissions without consent', async () => {
    const request = new Request('https://x/api/feedback', {
      method: 'POST',
      body: JSON.stringify(validBody({ consentGiven: false })),
    });
    const response = await submitFeedback({ request, env });
    expect(response.status).toBe(400);
  });

  it('rejects submissions with no contact method', async () => {
    const request = new Request('https://x/api/feedback', {
      method: 'POST',
      body: JSON.stringify(validBody({ email: undefined, wantsTelegram: false })),
    });
    const response = await submitFeedback({ request, env });
    expect(response.status).toBe(400);
  });

  it('creates a feedback row with a 6-month promo code and sends the email', async () => {
    await env.DB.prepare(
      `INSERT INTO gift_inventory (id, name, stock_count, updated_at) VALUES (1, 'Túi vải', 10, '2026-08-01T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO promo_policy (discount_percent, valid_from, valid_to, is_active, gift_enabled, updated_by, updated_at)
       VALUES (15, '2026-01-01', '2026-12-31', 1, 1, 'manager1', '2026-08-01T00:00:00Z')`
    ).run();

    const request = new Request('https://x/api/feedback', {
      method: 'POST',
      body: JSON.stringify(validBody()),
    });
    const response = await submitFeedback({ request, env });
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.promoCode).toMatch(/^HLG-/);
    expect(body.discountPercent).toBe(15);
    expect(body.giftOffered).toBe(true);

    const row = await env.DB.prepare(`SELECT * FROM feedback_responses WHERE id = ?`).bind(body.feedbackId).first();
    expect(row.promo_status).toBe('unused');
    expect(fetch).toHaveBeenCalledTimes(1); // Brevo call
  });

  it('does not offer a gift when stock is zero', async () => {
    await env.DB.prepare(
      `INSERT INTO gift_inventory (id, name, stock_count, updated_at) VALUES (1, 'Túi vải', 0, '2026-08-01T00:00:00Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO promo_policy (discount_percent, valid_from, valid_to, is_active, gift_enabled, updated_by, updated_at)
       VALUES (15, '2026-01-01', '2026-12-31', 1, 1, 'manager1', '2026-08-01T00:00:00Z')`
    ).run();

    const request = new Request('https://x/api/feedback', { method: 'POST', body: JSON.stringify(validBody()) });
    const response = await submitFeedback({ request, env });
    const body = await response.json();
    expect(body.giftOffered).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — `../functions/api/feedback.js` does not exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/functions/api/feedback.js
import { generatePromoCode, computeExpiry } from '../../lib/promoCode.js';
import { resolveActivePolicy } from '../../lib/policy.js';
import { sendPromoEmail } from '../../lib/email.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestPost({ request, env }) {
  const body = await request.json();
  const { guestName, phone, email, wantsTelegram, rating, comment, consentGiven } = body;

  if (!consentGiven) {
    return jsonError('Cần đồng ý sử dụng thông tin để tiếp tục', 400);
  }
  if (!email && !wantsTelegram) {
    return jsonError('Cần ít nhất một cách liên hệ (email hoặc Telegram)', 400);
  }
  if (!guestName || !phone || !rating) {
    return jsonError('Thiếu thông tin bắt buộc', 400);
  }

  const now = new Date();
  const todayISODate = now.toISOString().slice(0, 10);
  const policy = await resolveActivePolicy(env.DB, todayISODate);

  let giftOffered = false;
  if (policy.giftEnabled) {
    const gift = await env.DB.prepare(`SELECT stock_count FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
    giftOffered = !!gift && gift.stock_count > 0;
  }

  const feedbackId = crypto.randomUUID();
  const promoCode = generatePromoCode();
  const expiresAt = computeExpiry(now);

  await env.DB.prepare(
    `INSERT INTO feedback_responses
     (id, submitted_at, guest_name, phone, email, wants_telegram, rating, comment, consent_given,
      promo_code, discount_percent, promo_expires_at, promo_status, gift_offered, gift_claimed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'unused', ?, 0)`
  )
    .bind(
      feedbackId,
      now.toISOString(),
      guestName,
      phone,
      email || null,
      wantsTelegram ? 1 : 0,
      rating,
      comment || null,
      promoCode,
      policy.discountPercent,
      expiresAt.toISOString(),
      giftOffered ? 1 : 0
    )
    .run();

  if (email) {
    await sendPromoEmail(env, {
      to: email,
      guestName,
      promoCode,
      discountPercent: policy.discountPercent,
      expiresAt,
      giftOffered,
    });
  }

  return new Response(
    JSON.stringify({
      feedbackId,
      promoCode,
      discountPercent: policy.discountPercent,
      expiresAt: expiresAt.toISOString(),
      giftOffered,
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/functions/api/feedback.js crm/test/feedbackEndpoint.test.js
git commit -m "feat(crm): add POST /api/feedback submission endpoint"
```

---

## Task 9: Reception endpoints — lookup, redeem, gift claim

**Files:**
- Create: `crm/lib/requireAuth.js`
- Create: `crm/functions/api/promo/[code].js`
- Create: `crm/functions/api/promo/[code]/redeem.js`
- Create: `crm/functions/api/promo/[code]/claim-gift.js`
- Test: `crm/test/promoEndpoints.test.js`

**Interfaces:**
- Consumes: `getSession` (Task 4).
- Produces: `requireAuth(request, env, allowedRoles: string[]): Promise<{staffId, username, role} | Response>` (a Response means "reject — return this"), `GET /api/promo/:code`, `POST /api/promo/:code/redeem`, `POST /api/promo/:code/claim-gift` — consumed by Task 11's reception admin page.

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/promoEndpoints.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestGet as lookup } from '../functions/api/promo/[code].js';
import { onRequestPost as redeem } from '../functions/api/promo/[code]/redeem.js';
import { onRequestPost as claimGift } from '../functions/api/promo/[code]/claim-gift.js';
import { createSession } from '../lib/auth.js';

let sessionToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM feedback_responses');
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM gift_inventory');

  await env.DB.prepare(
    `INSERT INTO staff_accounts (id, username, password_hash, role, created_at)
     VALUES (1, 'le_tan_a', 'x', 'reception', '2026-08-01T00:00:00Z')`
  ).run();
  sessionToken = await createSession(env.DB, 1);

  await env.DB.prepare(
    `INSERT INTO feedback_responses
     (id, submitted_at, guest_name, phone, rating, consent_given, promo_code, discount_percent,
      promo_expires_at, promo_status, gift_offered, gift_claimed)
     VALUES ('fb-1', '2026-08-19T10:00:00Z', 'Nguyễn Văn A', '0900000000', 5, 1,
             'HLG-4F7K9P', 15, '2027-02-19T00:00:00Z', 'unused', 1, 0)`
  ).run();
  await env.DB.prepare(
    `INSERT INTO gift_inventory (id, name, stock_count, updated_at) VALUES (1, 'Túi vải', 3, '2026-08-01T00:00:00Z')`
  ).run();
});

function authedRequest(url, method = 'GET') {
  return new Request(url, { method, headers: { Cookie: `session=${sessionToken}` } });
}

describe('GET /api/promo/:code', () => {
  it('rejects unauthenticated requests', async () => {
    const request = new Request('https://x/api/promo/HLG-4F7K9P');
    const response = await lookup({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(401);
  });

  it('returns the promo details for a logged-in staff member', async () => {
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P');
    const response = await lookup({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ guestName: 'Nguyễn Văn A', discountPercent: 15, status: 'unused', giftOffered: true });
  });

  it('returns 404 for an unknown code', async () => {
    const request = authedRequest('https://x/api/promo/HLG-NOPE99');
    const response = await lookup({ request, env, params: { code: 'HLG-NOPE99' } });
    expect(response.status).toBe(404);
  });
});

describe('POST /api/promo/:code/redeem', () => {
  it('marks the code used and records who redeemed it', async () => {
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P/redeem', 'POST');
    const response = await redeem({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT promo_status, redeemed_by FROM feedback_responses WHERE promo_code = ?`)
      .bind('HLG-4F7K9P').first();
    expect(row.promo_status).toBe('used');
    expect(row.redeemed_by).toBe('le_tan_a');
  });

  it('rejects redeeming an already-used code', async () => {
    await redeem({ request: authedRequest('https://x/api/promo/HLG-4F7K9P/redeem', 'POST'), env, params: { code: 'HLG-4F7K9P' } });
    const response = await redeem({ request: authedRequest('https://x/api/promo/HLG-4F7K9P/redeem', 'POST'), env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(409);
  });
});

describe('POST /api/promo/:code/claim-gift', () => {
  it('decrements gift stock and marks the gift claimed', async () => {
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P/claim-gift', 'POST');
    const response = await claimGift({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(200);

    const stock = await env.DB.prepare(`SELECT stock_count FROM gift_inventory WHERE id = 1`).first();
    expect(stock.stock_count).toBe(2);
  });

  it('returns 409 when stock is already zero', async () => {
    await env.DB.prepare(`UPDATE gift_inventory SET stock_count = 0 WHERE id = 1`).run();
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P/claim-gift', 'POST');
    const response = await claimGift({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — none of the target files exist yet.

- [ ] **Step 3: Write `crm/lib/requireAuth.js`**

```js
// crm/lib/requireAuth.js
import { getSession } from './auth.js';

function parseCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? match[1] : null;
}

export async function requireAuth(request, env, allowedRoles) {
  const token = parseCookie(request, 'session');
  const session = token ? await getSession(env.DB, token) : null;

  if (!session) {
    return new Response(JSON.stringify({ error: 'Chưa đăng nhập' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    return new Response(JSON.stringify({ error: 'Không đủ quyền' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return session;
}
```

- [ ] **Step 4: Write the three endpoint files**

```js
// crm/functions/api/promo/[code].js
import { requireAuth } from '../../../lib/requireAuth.js';

export async function onRequestGet({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(
    `SELECT guest_name, discount_percent, promo_expires_at, promo_status, gift_offered, gift_claimed
     FROM feedback_responses WHERE promo_code = ?`
  ).bind(params.code).first();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy mã' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const status = row.promo_status === 'unused' && new Date(row.promo_expires_at) < new Date() ? 'expired' : row.promo_status;

  return new Response(
    JSON.stringify({
      guestName: row.guest_name,
      discountPercent: row.discount_percent,
      expiresAt: row.promo_expires_at,
      status,
      giftOffered: !!row.gift_offered,
      giftClaimed: !!row.gift_claimed,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}
```

```js
// crm/functions/api/promo/[code]/redeem.js
import { requireAuth } from '../../../../lib/requireAuth.js';

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(`SELECT promo_status FROM feedback_responses WHERE promo_code = ?`)
    .bind(params.code).first();

  if (!row) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy mã' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  if (row.promo_status === 'used') {
    return new Response(JSON.stringify({ error: 'Mã đã được sử dụng' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  await env.DB.prepare(
    `UPDATE feedback_responses SET promo_status = 'used', redeemed_at = ?, redeemed_by = ? WHERE promo_code = ?`
  ).bind(new Date().toISOString(), auth.username, params.code).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

```js
// crm/functions/api/promo/[code]/claim-gift.js
import { requireAuth } from '../../../../lib/requireAuth.js';

export async function onRequestPost({ request, env, params }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const feedback = await env.DB.prepare(`SELECT id, gift_claimed FROM feedback_responses WHERE promo_code = ?`)
    .bind(params.code).first();
  if (!feedback) {
    return new Response(JSON.stringify({ error: 'Không tìm thấy mã' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const gift = await env.DB.prepare(`SELECT id, stock_count FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
  if (!gift || gift.stock_count <= 0) {
    return new Response(JSON.stringify({ error: 'Hết quà' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE gift_inventory SET stock_count = stock_count - 1, updated_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), gift.id),
    env.DB.prepare(`UPDATE feedback_responses SET gift_claimed = 1 WHERE id = ?`).bind(feedback.id),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Commit**

```bash
git add crm/lib/requireAuth.js crm/functions/api/promo crm/test/promoEndpoints.test.js
git commit -m "feat(crm): add promo lookup, redeem, and gift-claim endpoints"
```

---

## Task 10: Manager endpoints — discount policy and gift stock

**Files:**
- Create: `crm/functions/api/policy.js`
- Create: `crm/functions/api/gift-inventory.js`
- Test: `crm/test/managerEndpoints.test.js`

**Interfaces:**
- Consumes: `requireAuth` (Task 9).
- Produces: `POST /api/policy` (create a policy row, manager-only), `GET /api/policy` (list, reception+manager), `POST /api/gift-inventory` (set stock count, manager-only), `GET /api/gift-inventory` (current stock, reception+manager) — consumed by Task 12's manager admin page.

- [ ] **Step 1: Write the failing tests**

```js
// crm/test/managerEndpoints.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { onRequestPost as createPolicy, onRequestGet as listPolicy } from '../functions/api/policy.js';
import { onRequestPost as setGiftStock, onRequestGet as getGiftStock } from '../functions/api/gift-inventory.js';
import { createSession } from '../lib/auth.js';

let managerToken, receptionToken;

beforeEach(async () => {
  await env.DB.exec('DELETE FROM staff_accounts');
  await env.DB.exec('DELETE FROM sessions');
  await env.DB.exec('DELETE FROM promo_policy');
  await env.DB.exec('DELETE FROM gift_inventory');

  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (1, 'quan_ly_a', 'x', 'manager', '2026-08-01T00:00:00Z')`).run();
  await env.DB.prepare(`INSERT INTO staff_accounts (id, username, password_hash, role, created_at) VALUES (2, 'le_tan_a', 'x', 'reception', '2026-08-01T00:00:00Z')`).run();
  managerToken = await createSession(env.DB, 1);
  receptionToken = await createSession(env.DB, 2);
});

function authedRequest(url, token, method, body) {
  return new Request(url, {
    method,
    headers: { Cookie: `session=${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('POST /api/policy', () => {
  it('lets a manager create a policy', async () => {
    const request = authedRequest('https://x/api/policy', managerToken, 'POST', {
      discountPercent: 20, validFrom: '2026-09-01', validTo: '2026-09-30', giftEnabled: true,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(201);
  });

  it('rejects a reception account (403)', async () => {
    const request = authedRequest('https://x/api/policy', receptionToken, 'POST', {
      discountPercent: 20, validFrom: '2026-09-01', validTo: '2026-09-30', giftEnabled: true,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(403);
  });
});

describe('GET /api/policy', () => {
  it('lets reception read the policy list', async () => {
    await createPolicy({ request: authedRequest('https://x/api/policy', managerToken, 'POST', { discountPercent: 20, validFrom: '2026-09-01', validTo: '2026-09-30', giftEnabled: true }), env });
    const response = await listPolicy({ request: authedRequest('https://x/api/policy', receptionToken, 'GET'), env });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
  });
});

describe('POST /api/gift-inventory', () => {
  it('lets a manager set stock, and reception can read it', async () => {
    const setResponse = await setGiftStock({
      request: authedRequest('https://x/api/gift-inventory', managerToken, 'POST', { name: 'Túi vải', stockCount: 25 }),
      env,
    });
    expect(setResponse.status).toBe(200);

    const getResponse = await getGiftStock({ request: authedRequest('https://x/api/gift-inventory', receptionToken, 'GET'), env });
    const body = await getResponse.json();
    expect(body).toEqual({ name: 'Túi vải', stockCount: 25 });
  });

  it('rejects a reception account trying to set stock (403)', async () => {
    const response = await setGiftStock({
      request: authedRequest('https://x/api/gift-inventory', receptionToken, 'POST', { name: 'Túi vải', stockCount: 25 }),
      env,
    });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd crm && npm test`
Expected: FAIL — target files don't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// crm/functions/api/policy.js
import { requireAuth } from '../../lib/requireAuth.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['manager']);
  if (auth instanceof Response) return auth;

  const { discountPercent, validFrom, validTo, giftEnabled } = await request.json();
  await env.DB.prepare(
    `INSERT INTO promo_policy (discount_percent, valid_from, valid_to, is_active, gift_enabled, updated_by, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(discountPercent, validFrom, validTo, giftEnabled ? 1 : 0, auth.username, new Date().toISOString())
    .run();

  return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(
    `SELECT id, discount_percent AS discountPercent, valid_from AS validFrom, valid_to AS validTo,
            is_active AS isActive, gift_enabled AS giftEnabled
     FROM promo_policy ORDER BY id DESC`
  ).all();

  return new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

```js
// crm/functions/api/gift-inventory.js
import { requireAuth } from '../../lib/requireAuth.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['manager']);
  if (auth instanceof Response) return auth;

  const { name, stockCount } = await request.json();
  const existing = await env.DB.prepare(`SELECT id FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();

  if (existing) {
    await env.DB.prepare(`UPDATE gift_inventory SET name = ?, stock_count = ?, updated_at = ? WHERE id = ?`)
      .bind(name, stockCount, new Date().toISOString(), existing.id)
      .run();
  } else {
    await env.DB.prepare(`INSERT INTO gift_inventory (name, stock_count, updated_at) VALUES (?, ?, ?)`)
      .bind(name, stockCount, new Date().toISOString())
      .run();
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAuth(request, env, ['reception', 'manager']);
  if (auth instanceof Response) return auth;

  const row = await env.DB.prepare(`SELECT name, stock_count AS stockCount FROM gift_inventory ORDER BY id DESC LIMIT 1`).first();
  return new Response(JSON.stringify(row || { name: null, stockCount: 0 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd crm && npm test`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add crm/functions/api/policy.js crm/functions/api/gift-inventory.js crm/test/managerEndpoints.test.js
git commit -m "feat(crm): add manager-only discount policy and gift stock endpoints"
```

---

## Task 11: Survey page (guest-facing frontend)

**Files:**
- Create: `crm/public/index.html`
- Create: `crm/public/styles.css`
- Create: `crm/public/survey.js`
- Test: `tests/e2e/crm-survey.spec.js` (in the root `hien-le-garden` repo's existing Playwright suite)

**Interfaces:**
- Consumes: `POST /api/feedback` (Task 8) response shape `{ feedbackId, promoCode, discountPercent, expiresAt, giftOffered }`.
- Produces: the guest-facing survey page at `/`, and a confirmation screen that shows the deep-link button `https://t.me/HienLeGardenBot?start={feedbackId}` when the guest checked "wants Telegram".

- [ ] **Step 1: Write `crm/public/index.html`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chia sẻ trải nghiệm — Hiền Lê Garden</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <main class="card">
    <h1>Cảm ơn bạn đã ghé Hiền Lê Garden!</h1>
    <p>Chia sẻ trải nghiệm để nhận mã ưu đãi cho lần sau.</p>

    <form id="surveyForm">
      <label>Họ tên <input type="text" name="guestName" required /></label>
      <label>Số điện thoại <input type="tel" name="phone" required /></label>
      <label>Email (không bắt buộc) <input type="email" name="email" /></label>
      <label class="checkbox"><input type="checkbox" name="wantsTelegram" /> Nhận mã qua Telegram</label>

      <fieldset>
        <legend>Đánh giá trải nghiệm</legend>
        <div class="rating" role="radiogroup" aria-label="Đánh giá 1 đến 5 sao">
          <label><input type="radio" name="rating" value="1" required /> 1</label>
          <label><input type="radio" name="rating" value="2" /> 2</label>
          <label><input type="radio" name="rating" value="3" /> 3</label>
          <label><input type="radio" name="rating" value="4" /> 4</label>
          <label><input type="radio" name="rating" value="5" /> 5</label>
        </div>
      </fieldset>

      <label>Nhận xét (không bắt buộc) <textarea name="comment"></textarea></label>
      <label class="checkbox">
        <input type="checkbox" name="consentGiven" required />
        Tôi đồng ý để Hiền Lê Garden sử dụng thông tin này để liên hệ ưu đãi.
      </label>

      <button type="submit">Gửi đánh giá</button>
      <p id="formError" class="error" role="alert"></p>
    </form>

    <section id="confirmation" hidden>
      <h2>Cảm ơn bạn!</h2>
      <p>Mã ưu đãi của bạn: <strong id="promoCode"></strong></p>
      <p id="promoDetails"></p>
      <p id="giftLine" hidden>Mang mã này đến quầy lễ tân để nhận thêm quà lưu niệm nhé!</p>
      <a id="telegramLink" href="#" hidden>Nhận mã qua Telegram</a>
    </section>
  </main>

  <script src="survey.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `crm/public/styles.css`**

```css
:root {
  --gold: #C9A84C;
  --dark-green: #0D1F14;
  --cream: #F5F0E6;
}
body {
  font-family: Georgia, serif;
  background: var(--dark-green);
  color: var(--cream);
  margin: 0;
  padding: 24px;
}
.card {
  max-width: 480px;
  margin: 0 auto;
}
h1 { color: var(--gold); }
label { display: block; margin-bottom: 12px; }
input, textarea { width: 100%; padding: 8px; box-sizing: border-box; }
.checkbox { display: flex; align-items: center; gap: 8px; }
.checkbox input { width: auto; }
.rating { display: flex; gap: 12px; }
button {
  background: var(--gold);
  color: var(--dark-green);
  border: none;
  padding: 12px 24px;
  font-weight: bold;
  cursor: pointer;
}
.error { color: #ff8a8a; }
#confirmation strong { color: var(--gold); font-size: 1.4em; }
</style>
```

- [ ] **Step 3: Write `crm/public/survey.js`**

```js
const form = document.getElementById('surveyForm');
const errorEl = document.getElementById('formError');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';

  const data = new FormData(form);
  const payload = {
    guestName: data.get('guestName'),
    phone: data.get('phone'),
    email: data.get('email') || undefined,
    wantsTelegram: data.get('wantsTelegram') === 'on',
    rating: Number(data.get('rating')),
    comment: data.get('comment') || undefined,
    consentGiven: data.get('consentGiven') === 'on',
  };

  const response = await fetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi xảy ra, vui lòng thử lại.';
    return;
  }

  const result = await response.json();
  form.hidden = true;

  const confirmation = document.getElementById('confirmation');
  confirmation.hidden = false;
  document.getElementById('promoCode').textContent = result.promoCode;
  document.getElementById('promoDetails').textContent =
    `Giảm ${result.discountPercent}% cho lần sau, có hiệu lực đến ${new Date(result.expiresAt).toLocaleDateString('vi-VN')}.`;

  if (result.giftOffered) {
    document.getElementById('giftLine').hidden = false;
  }
  if (payload.wantsTelegram) {
    const link = document.getElementById('telegramLink');
    link.href = `https://t.me/HienLeGardenBot?start=${result.feedbackId}`;
    link.hidden = false;
  }
});
```

- [ ] **Step 4: Write the Playwright test**

```js
// tests/e2e/crm-survey.spec.js  (added to the existing root Playwright suite)
const { test, expect } = require('@playwright/test');

test.describe('CRM survey page', () => {
  test('rejects submission without consent (HTML5 required validation)', async ({ page }) => {
    await page.goto('/'); // this project's baseURL is configured separately for crm/public — see Task 13
    await page.fill('input[name="guestName"]', 'Test User');
    await page.fill('input[name="phone"]', '0900000000');
    await page.check('input[name="rating"][value="5"]');
    await page.click('button[type="submit"]');
    // consentGiven is `required`; the browser blocks submission, so the confirmation panel stays hidden
    await expect(page.locator('#confirmation')).toBeHidden();
  });

  test('shows the promo code and Telegram deep link on successful submission', async ({ page }) => {
    await page.route('**/api/feedback', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          feedbackId: 'fb-test-1',
          promoCode: 'HLG-TEST99',
          discountPercent: 15,
          expiresAt: '2027-02-19T00:00:00Z',
          giftOffered: true,
        }),
      })
    );

    await page.goto('/');
    await page.fill('input[name="guestName"]', 'Test User');
    await page.fill('input[name="phone"]', '0900000000');
    await page.fill('input[name="email"]', 'test@example.com');
    await page.check('input[name="wantsTelegram"]');
    await page.check('input[name="rating"][value="5"]');
    await page.check('input[name="consentGiven"]');
    await page.click('button[type="submit"]');

    await expect(page.locator('#promoCode')).toHaveText('HLG-TEST99');
    await expect(page.locator('#giftLine')).toBeVisible();
    await expect(page.locator('#telegramLink')).toHaveAttribute('href', 'https://t.me/HienLeGardenBot?start=fb-test-1');
  });
});
```

- [ ] **Step 5: Run the new Playwright spec (see Task 13 for the `crm` project wiring it depends on)**

This spec is written now but wired into `playwright.config.js` and actually run in Task 13, once a `crm` project/baseURL exists — running it before then would fail to resolve `/`. Leave it uncommitted-but-tracked and continue; Task 13 makes it pass.

- [ ] **Step 6: Commit**

```bash
git add crm/public tests/e2e/crm-survey.spec.js
git commit -m "feat(crm): add guest-facing survey page and Playwright coverage"
```

---

## Task 12: Admin pages — login, reception redemption, manager configuration

**Files:**
- Create: `crm/public/admin/login.html`
- Create: `crm/public/admin/login.js`
- Create: `crm/public/admin/reception.html`
- Create: `crm/public/admin/reception.js`
- Create: `crm/public/admin/manager.html`
- Create: `crm/public/admin/manager.js`
- Create: `crm/public/admin/admin.css`
- Test: `tests/e2e/crm-admin.spec.js`

**Interfaces:**
- Consumes: `POST /api/auth/login` (Task 5), `GET/POST /api/promo/:code[...]` (Task 9), `GET/POST /api/policy` and `GET/POST /api/gift-inventory` (Task 10).

- [ ] **Step 1: Write `crm/public/admin/admin.css`**

```css
:root { --gold: #C9A84C; --dark-green: #0D1F14; --cream: #F5F0E6; }
body { font-family: Georgia, serif; background: var(--dark-green); color: var(--cream); padding: 24px; }
input, button { padding: 8px; margin: 4px 0; }
button { background: var(--gold); color: var(--dark-green); border: none; font-weight: bold; cursor: pointer; }
.error { color: #ff8a8a; }
.hidden { display: none; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
td, th { border-bottom: 1px solid #333; padding: 8px; text-align: left; }
```

- [ ] **Step 2: Write `crm/public/admin/login.html` + `login.js`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>Đăng nhập — Hiền Lê Garden CRM</title>
  <link rel="stylesheet" href="admin.css" />
</head>
<body>
  <h1>Đăng nhập nhân viên</h1>
  <form id="loginForm">
    <label>Tài khoản <input type="text" name="username" required /></label>
    <label>Mật khẩu <input type="password" name="password" required /></label>
    <button type="submit">Đăng nhập</button>
    <p id="loginError" class="error"></p>
  </form>
  <script src="login.js"></script>
</body>
</html>
```

```js
// crm/public/admin/login.js
document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
  });

  if (!response.ok) {
    document.getElementById('loginError').textContent = 'Sai tài khoản hoặc mật khẩu';
    return;
  }

  const { role } = await response.json();
  window.location.href = role === 'manager' ? 'manager.html' : 'reception.html';
});
```

- [ ] **Step 3: Write `crm/public/admin/reception.html` + `reception.js`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>Tra cứu mã — Hiền Lê Garden CRM</title>
  <link rel="stylesheet" href="admin.css" />
</head>
<body>
  <h1>Tra cứu & đổi mã ưu đãi</h1>
  <form id="lookupForm">
    <label>Mã ưu đãi <input type="text" name="code" required /></label>
    <button type="submit">Tra cứu</button>
  </form>
  <p id="lookupError" class="error"></p>

  <section id="result" class="hidden">
    <p>Khách: <strong id="guestName"></strong></p>
    <p>Giảm giá: <strong id="discountPercent"></strong>%</p>
    <p>Hạn dùng: <span id="expiresAt"></span></p>
    <p>Trạng thái: <span id="status"></span></p>
    <button id="redeemBtn">Đánh dấu đã dùng</button>
    <button id="claimGiftBtn">Đã phát quà</button>
    <p id="actionError" class="error"></p>
  </section>

  <script src="reception.js"></script>
</body>
</html>
```

```js
// crm/public/admin/reception.js
let currentCode = null;

document.getElementById('lookupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = new FormData(event.target).get('code');
  const response = await fetch(`/api/promo/${encodeURIComponent(code)}`);
  const errorEl = document.getElementById('lookupError');
  errorEl.textContent = '';

  if (!response.ok) {
    const body = await response.json();
    errorEl.textContent = body.error || 'Có lỗi xảy ra';
    document.getElementById('result').classList.add('hidden');
    return;
  }

  currentCode = code;
  const data = await response.json();
  document.getElementById('guestName').textContent = data.guestName;
  document.getElementById('discountPercent').textContent = data.discountPercent;
  document.getElementById('expiresAt').textContent = new Date(data.expiresAt).toLocaleDateString('vi-VN');
  document.getElementById('status').textContent = data.status;
  document.getElementById('claimGiftBtn').style.display = data.giftOffered && !data.giftClaimed ? 'inline-block' : 'none';
  document.getElementById('result').classList.remove('hidden');
});

document.getElementById('redeemBtn').addEventListener('click', async () => {
  const response = await fetch(`/api/promo/${encodeURIComponent(currentCode)}/redeem`, { method: 'POST' });
  const errorEl = document.getElementById('actionError');
  if (!response.ok) {
    errorEl.textContent = (await response.json()).error;
    return;
  }
  document.getElementById('status').textContent = 'used';
  errorEl.textContent = '';
});

document.getElementById('claimGiftBtn').addEventListener('click', async () => {
  const response = await fetch(`/api/promo/${encodeURIComponent(currentCode)}/claim-gift`, { method: 'POST' });
  const errorEl = document.getElementById('actionError');
  if (!response.ok) {
    errorEl.textContent = (await response.json()).error;
    return;
  }
  document.getElementById('claimGiftBtn').style.display = 'none';
  errorEl.textContent = '';
});
```

- [ ] **Step 4: Write `crm/public/admin/manager.html` + `manager.js`**

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>Quản lý khuyến mãi — Hiền Lê Garden CRM</title>
  <link rel="stylesheet" href="admin.css" />
</head>
<body>
  <h1>Cấu hình khuyến mãi</h1>
  <form id="policyForm">
    <label>% giảm giá <input type="number" name="discountPercent" min="0" max="100" required /></label>
    <label>Từ ngày <input type="date" name="validFrom" required /></label>
    <label>Đến ngày <input type="date" name="validTo" required /></label>
    <label><input type="checkbox" name="giftEnabled" /> Kèm quà lưu niệm</label>
    <button type="submit">Lưu chương trình</button>
  </form>

  <h2>Các chương trình đã cấu hình</h2>
  <table id="policyTable">
    <thead><tr><th>%</th><th>Từ</th><th>Đến</th><th>Quà</th></tr></thead>
    <tbody></tbody>
  </table>

  <h2>Kho quà lưu niệm</h2>
  <form id="giftForm">
    <label>Tên quà <input type="text" name="name" required /></label>
    <label>Số lượng <input type="number" name="stockCount" min="0" required /></label>
    <button type="submit">Cập nhật kho</button>
  </form>

  <script src="manager.js"></script>
</body>
</html>
```

```js
// crm/public/admin/manager.js
async function loadPolicies() {
  const response = await fetch('/api/policy');
  const policies = await response.json();
  const tbody = document.querySelector('#policyTable tbody');
  tbody.innerHTML = policies
    .map((p) => `<tr><td>${p.discountPercent}%</td><td>${p.validFrom}</td><td>${p.validTo}</td><td>${p.giftEnabled ? 'Có' : 'Không'}</td></tr>`)
    .join('');
}

document.getElementById('policyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  await fetch('/api/policy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      discountPercent: Number(data.get('discountPercent')),
      validFrom: data.get('validFrom'),
      validTo: data.get('validTo'),
      giftEnabled: data.get('giftEnabled') === 'on',
    }),
  });
  event.target.reset();
  await loadPolicies();
});

document.getElementById('giftForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  await fetch('/api/gift-inventory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: data.get('name'), stockCount: Number(data.get('stockCount')) }),
  });
});

loadPolicies();
```

- [ ] **Step 5: Write the Playwright test**

```js
// tests/e2e/crm-admin.spec.js
const { test, expect } = require('@playwright/test');

test.describe('CRM admin', () => {
  test('reception can look up a code and redeem it', async ({ page }) => {
    await page.route('**/api/promo/HLG-TEST99', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          guestName: 'Test User', discountPercent: 15, expiresAt: '2027-02-19T00:00:00Z',
          status: 'unused', giftOffered: true, giftClaimed: false,
        }),
      })
    );
    await page.route('**/api/promo/HLG-TEST99/redeem', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    );

    await page.goto('/admin/reception.html');
    await page.fill('input[name="code"]', 'HLG-TEST99');
    await page.click('button[type="submit"]');

    await expect(page.locator('#guestName')).toHaveText('Test User');
    await page.click('#redeemBtn');
    await expect(page.locator('#status')).toHaveText('used');
  });
});
```

- [ ] **Step 6: Commit**

```bash
git add crm/public/admin tests/e2e/crm-admin.spec.js
git commit -m "feat(crm): add staff login, reception, and manager admin pages"
```

---

## Task 13: Wire the `crm` project into the root Playwright suite

**Files:**
- Modify: `playwright.config.js` (repo root)

**Interfaces:**
- Consumes: the `crm/public` directory (Tasks 11–12) and `tests/e2e/crm-survey.spec.js` / `tests/e2e/crm-admin.spec.js`.

- [ ] **Step 1: Add a `crm` webServer entry and project**

Modify `playwright.config.js`: add a third webServer (serving `crm/public` on its own port, e.g. `4175`) and a third project `crm` with that baseURL — following the same pattern already used for `v3`/`v4`. Restrict the `v3`/`v4` projects to their existing `tests/e2e` + `tests/seo` specs via `testMatch`, and restrict the new `crm` project to `tests/e2e/crm-*.spec.js`, so each project only runs the specs meant for it.

```js
// playwright.config.js — add alongside the existing V3_PORT/V4_PORT constants
const CRM_PORT = 4175;

// add to the webServer array:
{
  command: `npx http-server crm/public -p ${CRM_PORT} -s -c-1`,
  port: CRM_PORT,
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
},

// add to the projects array:
{
  name: 'crm',
  use: { baseURL: `http://localhost:${CRM_PORT}` },
  testMatch: /crm-.*\.spec\.js/,
},

// and add testMatch to the existing v3/v4 projects so they skip the new crm specs:
// testMatch: /(?!crm-).*\.spec\.js/,
```

- [ ] **Step 2: Run the full suite and verify the new crm specs pass alongside the existing ones**

Run: `npm test`
Expected: all `v3`/`v4` specs still pass (60, as before), plus the new `crm` project's specs (3 tests from Tasks 11–12) pass — total 63 passed, 0 failed.

- [ ] **Step 3: Commit**

```bash
git add playwright.config.js
git commit -m "test: wire crm survey/admin pages into the Playwright suite"
```

---

## Task 14: Deployment configuration and secrets documentation

**Files:**
- Create: `crm/README.md`

**Interfaces:**
- None — this is operational documentation, not code other tasks depend on.

- [ ] **Step 1: Write `crm/README.md`**

```markdown
# Hiền Lê Garden CRM (checkout survey + loyalty codes)

Cloudflare Pages + Pages Functions + D1. See `docs/specs/2026-08-19-v4-crm-loyalty-design.md` for the design.

## One-time setup

1. `wrangler d1 create hien_le_garden_crm` — copy the returned `database_id` into `wrangler.toml`.
2. `wrangler d1 execute hien_le_garden_crm --remote --file=schema.sql`
3. Set secrets:
   - `wrangler pages secret put BREVO_API_KEY`
   - `wrangler pages secret put TELEGRAM_BOT_TOKEN`
4. Create the first manager account:
   - `node scripts/seed-manager.js <username> <password>`
   - Run the printed `INSERT` with `wrangler d1 execute hien_le_garden_crm --remote --command "<sql>"`
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
```

- [ ] **Step 2: Commit**

```bash
git add crm/README.md
git commit -m "docs(crm): add setup, secrets, and deployment instructions"
```

---

## Self-review notes

- **Spec coverage**: §1 architecture → Task 1; §2 data model → Task 1 schema (plus the `sessions` table added to support §4's session cookie, called out explicitly); §3 guest flow → Tasks 2, 3, 6, 7, 8, 11; §4 admin flow → Tasks 4, 5, 9, 10, 12; §5 VPS analysis → delivered in the spec document itself, no code task needed; §6 Brevo → Task 6; §7 consent → Task 8 (400 on missing consent) + Task 11 (required checkbox); §8 testing → Vitest throughout (Tasks 2–10) + Playwright (Tasks 11–13).
- **Type consistency checked**: `resolveActivePolicy` return shape (`policyId`/`discountPercent`/`giftEnabled`) used identically in Task 8. `requireAuth` returning either a session object or a `Response` is used the same way (`instanceof Response` check) in every protected endpoint (Tasks 9, 10). Feedback response field names (`feedbackId`, `promoCode`, `discountPercent`, `expiresAt`, `giftOffered`) match between Task 8's endpoint and Task 11's `survey.js` consumer.
- **No placeholders**: every step has runnable code; no "TBD"/"add validation later" left in any task.
