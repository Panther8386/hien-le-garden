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
