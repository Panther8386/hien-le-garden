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
