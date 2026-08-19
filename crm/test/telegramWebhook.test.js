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

  it('returns 200 for malformed payload with message text but no chat', async () => {
    const update = { message: { text: '/start fb-1' } };
    const request = new Request('https://crm.hienlegarden.vn/api/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify(update),
    });
    const response = await webhook({ request, env: { ...env, TELEGRAM_BOT_TOKEN: 'test-token' } });
    expect(response.status).toBe(200);

    const row = await env.DB.prepare(`SELECT telegram_chat_id FROM feedback_responses WHERE id = 'fb-1'`).first();
    expect(row?.telegram_chat_id).toBeNull();
  });

});
