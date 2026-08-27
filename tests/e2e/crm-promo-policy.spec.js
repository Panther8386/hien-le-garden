// tests/e2e/crm-promo-policy.spec.js
const { test, expect } = require('@playwright/test');

test.describe('CRM promo policy status column', () => {
  test('labels active, pending, and ended policies correctly', async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'manager' }) })
    );
    await page.route('**/api/policy', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, discountPercent: 10, validFrom: '2020-01-01', validTo: '2099-12-31', isActive: true, giftEnabled: false },
          { id: 2, discountPercent: 20, validFrom: '2099-01-01', validTo: '2099-12-31', isActive: true, giftEnabled: true },
          { id: 3, discountPercent: 15, validFrom: '2020-01-01', validTo: '2020-12-31', isActive: true, giftEnabled: false },
          { id: 4, discountPercent: 5, validFrom: '2020-01-01', validTo: '2099-12-31', isActive: false, giftEnabled: false },
        ]),
      });
    });
    await page.route('**/api/gift-inventory', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: '', stockCount: 0 }) })
    );
    await page.route('**/api/notification-settings', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) })
    );

    await page.goto('/admin/manager.html');
    const rows = page.locator('#policyTable tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0).locator('.status-badge')).toHaveText('Đang áp dụng');
    await expect(rows.nth(1).locator('.status-badge')).toHaveText('Sắp diễn ra');
    await expect(rows.nth(2).locator('.status-badge')).toHaveText('Đã kết thúc');
    await expect(rows.nth(3).locator('.status-badge')).toHaveText('Đã tắt');
  });
});
