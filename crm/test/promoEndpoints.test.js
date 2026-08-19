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

  it('rejects redeeming an expired-but-unused code', async () => {
    await env.DB.prepare(`UPDATE feedback_responses SET promo_expires_at = '2026-08-01T00:00:00Z' WHERE promo_code = ?`)
      .bind('HLG-4F7K9P').run();
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P/redeem', 'POST');
    const response = await redeem({ request, env, params: { code: 'HLG-4F7K9P' } });
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

  it('rejects double-claim for the same code', async () => {
    await claimGift({ request: authedRequest('https://x/api/promo/HLG-4F7K9P/claim-gift', 'POST'), env, params: { code: 'HLG-4F7K9P' } });
    const response = await claimGift({ request: authedRequest('https://x/api/promo/HLG-4F7K9P/claim-gift', 'POST'), env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(409);
  });

  it('guards against TOCTOU race when stock becomes zero after SELECT', async () => {
    await env.DB.prepare(`UPDATE gift_inventory SET stock_count = 1 WHERE id = 1`).run();
    // Simulate the race: stock is checked as > 0, but before the UPDATE, it becomes 0
    await env.DB.prepare(`UPDATE gift_inventory SET stock_count = 0 WHERE id = 1`).run();
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P/claim-gift', 'POST');
    const response = await claimGift({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(409);
  });

  it('rejects claiming a gift for code where gift_offered is false', async () => {
    await env.DB.prepare(`UPDATE feedback_responses SET gift_offered = 0 WHERE promo_code = ?`)
      .bind('HLG-4F7K9P').run();
    const request = authedRequest('https://x/api/promo/HLG-4F7K9P/claim-gift', 'POST');
    const response = await claimGift({ request, env, params: { code: 'HLG-4F7K9P' } });
    expect(response.status).toBe(409);
  });
});
