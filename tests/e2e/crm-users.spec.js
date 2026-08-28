// tests/e2e/crm-users.spec.js
const { test, expect } = require('@playwright/test');

test.describe('CRM user management', () => {
  test('creates a user and shows it in the list', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Panther', role: 'manager' }) }));

    let created = false;
    await page.route('**/api/users', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 2 }) });
      }
      const list = [
        { id: 1, username: 'Panther', role: 'manager', createdAt: '2026-08-01T00:00:00Z' },
        ...(created ? [{ id: 2, username: 'hienle2', role: 'reception', createdAt: '2026-08-20T00:00:00Z' }] : []),
      ];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
    });

    await page.goto('/admin/users.html');
    await page.fill('input[name="username"]', 'hienle2');
    await page.fill('input[name="password"]', 'MatKhauManh123');
    await page.click('button[type="submit"]');

    await expect(page.locator('#userTable tbody')).toContainText('hienle2');
  });

  test('disables delete on your own row', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Panther', role: 'manager' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, username: 'Panther', role: 'manager', createdAt: '2026-08-01T00:00:00Z' }]) })
    );

    await page.goto('/admin/users.html');
    await expect(page.locator('#userTable tbody tr button')).toBeDisabled();
  });

  test('redirects to login.html when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/users.html');
    await page.waitForURL('**/admin/');
  });

  test('admin can reset another account\'s password', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, username: 'Vinhdx', role: 'admin', createdAt: '2026-08-01T00:00:00Z' },
          { id: 2, username: 'hienle', role: 'reception', createdAt: '2026-08-20T00:00:00Z' },
        ]),
      })
    );
    let resetPayload = null;
    await page.route('**/api/users/2/password', (route) => {
      resetPayload = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/users.html');

    const ownRow = page.locator('#userTable tbody tr', { hasText: 'Vinhdx' });
    await expect(ownRow.locator('button', { hasText: 'Đặt lại mật khẩu' })).toBeDisabled();

    const targetRow = page.locator('#userTable tbody tr', { hasText: 'hienle' });
    await targetRow.locator('button', { hasText: 'Đặt lại mật khẩu' }).click();
    await expect(page.locator('.reset-password-row')).toBeVisible();
    await page.locator('.reset-password-row input[type="password"]').fill('MatKhauMoi123');
    await page.locator('.reset-password-row button', { hasText: 'Xác nhận' }).click();

    await expect(page.locator('.reset-password-row')).toHaveCount(0);
    expect(resetPayload).toEqual({ password: 'MatKhauMoi123' });
  });

  test('the reset-password button is hidden for non-admin roles', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Panther', role: 'manager' }) }));
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, username: 'Panther', role: 'manager', createdAt: '2026-08-01T00:00:00Z' }]),
      })
    );

    await page.goto('/admin/users.html');
    await expect(page.locator('#userTable tbody tr button', { hasText: 'Đặt lại mật khẩu' })).toHaveCount(0);
  });
});
