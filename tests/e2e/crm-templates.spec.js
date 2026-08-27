// tests/e2e/crm-templates.spec.js
const { test, expect } = require('@playwright/test');

test.describe('CRM template library', () => {
  test('creates a template and shows it in the list', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Panther', role: 'manager' }) }));

    let created = false;
    await page.route('**/api/templates', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 2 }) });
      }
      const list = created
        ? [{ id: 2, name: 'Lời cảm ơn', channel: 'email', body: 'x', isActive: false }]
        : [];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
    });

    await page.goto('/admin/templates.html');
    await page.fill('input[name="name"]', 'Lời cảm ơn');
    await page.fill('input[name="subject"]', 'Cảm ơn bạn');
    await page.fill('textarea[name="body"]', 'Xin chào {guestName}');
    await page.click('button[type="submit"]');

    await expect(page.locator('#templateList')).toContainText('Lời cảm ơn');
  });

  test('redirects to login.html when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/templates.html');
    await page.waitForURL('**/admin/');
  });
});
