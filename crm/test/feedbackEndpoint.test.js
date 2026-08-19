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

  it('rejects rating above 5', async () => {
    const request = new Request('https://x/api/feedback', {
      method: 'POST',
      body: JSON.stringify(validBody({ rating: 999 })),
    });
    const response = await submitFeedback({ request, env });
    expect(response.status).toBe(400);
  });

  it('rejects rating below 1', async () => {
    const request = new Request('https://x/api/feedback', {
      method: 'POST',
      body: JSON.stringify(validBody({ rating: 0 })),
    });
    const response = await submitFeedback({ request, env });
    expect(response.status).toBe(400);
  });

  it('falls back to zero discount and no gift when no active policy exists', async () => {
    const request = new Request('https://x/api/feedback', {
      method: 'POST',
      body: JSON.stringify(validBody()),
    });
    const response = await submitFeedback({ request, env });
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.discountPercent).toBe(0);
    expect(body.giftOffered).toBe(false);
  });
});
