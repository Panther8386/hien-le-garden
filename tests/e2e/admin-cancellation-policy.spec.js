// tests/e2e/admin-cancellation-policy.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Admin cancellation policy', () => {
  test('admin can add a tier; a non-admin role sees it read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));

    let created = false;
    await page.route('**/api/cancellation-policy', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      const tiers = created ? [{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: 'Huỷ trước 7 ngày' }] : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tiers) });
    });

    await page.goto('/admin/cancellation-policy.html');
    await expect(page.locator('#emptyState')).toBeVisible();
    await page.click('#addTierBtn');
    await page.fill('input[name="minDaysBeforeCheckin"]', '7');
    await page.fill('input[name="refundPercent"]', '100');
    await page.click('#tierSubmitBtn');
    await expect(page.locator('#tierTable tbody')).toContainText('100%');
  });

  test('a non-admin role sees the list read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception' }) }));
    await page.route('**/api/cancellation-policy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: null }]) }));

    await page.goto('/admin/cancellation-policy.html');
    await expect(page.locator('#tierTable tbody')).toContainText('100%');
    await expect(page.locator('#addTierBtn')).toBeHidden();
    await expect(page.locator('#tierTable tbody tr button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/cancellation-policy.html');
    await page.waitForURL('**/admin/');
  });
});
