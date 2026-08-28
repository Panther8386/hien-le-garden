// tests/e2e/manager-reminder-settings.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Manager reminder-settings config', () => {
  test('an admin can view and save the thresholds', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/policy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gift-inventory', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

    let saved = null;
    await page.route('**/api/reminder-settings', (route) => {
      if (route.request().method() === 'PATCH') {
        saved = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pendingDepositHours: 2, cleaningMinutes: 60, updatedAt: '2026-08-28T00:00:00Z' }) });
    });

    await page.goto('/admin/manager.html');
    await expect(page.locator('#reminderSettingsSection')).toBeVisible();
    await expect(page.locator('input[name="pendingDepositHours"]')).toHaveValue('2');
    await expect(page.locator('input[name="cleaningMinutes"]')).toHaveValue('60');

    await page.fill('input[name="pendingDepositHours"]', '4');
    await page.fill('input[name="cleaningMinutes"]', '45');
    await page.click('#reminderSettingsForm button[type="submit"]');

    expect(saved).toEqual({ pendingDepositHours: 4, cleaningMinutes: 45 });
  });

  test('a manager (not admin) never sees the reminder-settings section', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_ly_a', role: 'manager' }) }));
    await page.route('**/api/policy', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gift-inventory', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.route('**/api/notification-settings', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connected: false }) }));

    await page.goto('/admin/manager.html');
    await expect(page.locator('#reminderSettingsSection')).toBeHidden();
  });
});
