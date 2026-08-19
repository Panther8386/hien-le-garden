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

  it('escapes Telegram Markdown special characters in guest name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await sendTelegramMessage(
      { TELEGRAM_BOT_TOKEN: 'test-token' },
      {
        chatId: '123456',
        guestName: 'An_Nguyen* [VIP]',
        promoCode: 'HLG-4F7K9P',
        discountPercent: 15,
        expiresAt: new Date('2027-02-19T00:00:00Z'),
        giftOffered: false,
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.parse_mode).toBe('Markdown');
    expect(body.text).toContain('An\\_Nguyen\\* \\[VIP]');
    expect(body.text).not.toContain('An_Nguyen* [VIP]');
  });
});
