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
