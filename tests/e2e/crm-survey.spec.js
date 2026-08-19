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
