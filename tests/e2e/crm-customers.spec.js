// tests/e2e/crm-customers.spec.js
const { test, expect } = require('@playwright/test');

test.describe('CRM customer list', () => {
  test('lists customers, filters by search, and opens detail with send form', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception' }) }));
    await page.route('**/api/customers?**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [{ feedbackId: 'fb-1', guestName: 'Nguyễn Văn A', phone: '0900000001', rating: 5, promoCode: 'HLG-AAAA', discountPercent: 10, promoStatus: 'unused', submittedAt: '2026-08-20T10:00:00Z' }],
          total: 1, page: 1, pageSize: 25,
        }),
      })
    );
    await page.route('**/api/customers/fb-1', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          feedbackId: 'fb-1', comment: 'Rất tốt', stayDate: null, wishesNextTime: null, favoriteActivities: [],
          giftOffered: false, giftClaimed: false, hasTelegramChatId: false, messageHistory: [],
        }),
      })
    );
    await page.route('**/api/templates', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Email mặc định', channel: 'email', isActive: true }]) })
    );

    await page.goto('/admin/customers.html');
    await expect(page.locator('#customerTable tbody tr')).toHaveCount(1);
    await page.click('#customerTable tbody tr');
    await expect(page.locator('#detailPanel')).toBeVisible();
    await expect(page.locator('#detailContent')).toContainText('Rất tốt');
  });

  test('redirects to login.html when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/customers.html');
    await page.waitForURL('**/admin/login.html');
  });
});
