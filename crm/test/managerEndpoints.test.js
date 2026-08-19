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

  it('rejects out-of-range discountPercent (400)', async () => {
    const request = authedRequest('https://x/api/policy', managerToken, 'POST', {
      discountPercent: 150, validFrom: '2026-09-01', validTo: '2026-09-30', giftEnabled: false,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid validFrom date format (400)', async () => {
    const request = authedRequest('https://x/api/policy', managerToken, 'POST', {
      discountPercent: 20, validFrom: 'not-a-date', validTo: '2026-09-30', giftEnabled: false,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(400);
  });

  it('rejects an invalid validTo date format (400)', async () => {
    const request = authedRequest('https://x/api/policy', managerToken, 'POST', {
      discountPercent: 20, validFrom: '2026-09-01', validTo: 'not-a-date', giftEnabled: false,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(400);
  });

  it('rejects validFrom later than validTo (400)', async () => {
    const request = authedRequest('https://x/api/policy', managerToken, 'POST', {
      discountPercent: 20, validFrom: '2026-09-30', validTo: '2026-09-01', giftEnabled: false,
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed JSON body with 400 instead of crashing', async () => {
    const request = new Request('https://x/api/policy', {
      method: 'POST',
      headers: { Cookie: `session=${managerToken}`, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const response = await createPolicy({ request, env });
    expect(response.status).toBe(400);
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

  it('returns boolean values for isActive and giftEnabled', async () => {
    await createPolicy({ request: authedRequest('https://x/api/policy', managerToken, 'POST', { discountPercent: 20, validFrom: '2026-09-01', validTo: '2026-09-30', giftEnabled: true }), env });
    const response = await listPolicy({ request: authedRequest('https://x/api/policy', managerToken, 'GET'), env });
    const body = await response.json();
    expect(body[0].isActive).toBe(true);
    expect(body[0].giftEnabled).toBe(true);
    expect(typeof body[0].isActive).toBe('boolean');
    expect(typeof body[0].giftEnabled).toBe('boolean');
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

  it('rejects negative stockCount (400)', async () => {
    const response = await setGiftStock({
      request: authedRequest('https://x/api/gift-inventory', managerToken, 'POST', { name: 'Túi vải', stockCount: -3 }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a missing name (400)', async () => {
    const response = await setGiftStock({
      request: authedRequest('https://x/api/gift-inventory', managerToken, 'POST', { stockCount: 10 }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects an empty/whitespace-only name (400)', async () => {
    const response = await setGiftStock({
      request: authedRequest('https://x/api/gift-inventory', managerToken, 'POST', { name: '   ', stockCount: 10 }),
      env,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed JSON body with 400 instead of crashing', async () => {
    const request = new Request('https://x/api/gift-inventory', {
      method: 'POST',
      headers: { Cookie: `session=${managerToken}`, 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const response = await setGiftStock({ request, env });
    expect(response.status).toBe(400);
  });
});
