const { test, expect } = require('@playwright/test');

test.describe('Audit log viewer', () => {
  test('renders entries and re-fetches with the type filter', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_ly_a', role: 'manager' }) }));

    const requestedTypes = [];
    await page.route('**/api/audit-log**', (route) => {
      const url = new URL(route.request().url());
      const type = url.searchParams.get('type') || '';
      requestedTypes.push(type);
      const entries = type === 'service_void'
        ? [{ id: 2, actionType: 'service_void', entityType: 'service_item', entityId: 5, entityLabel: 'Cà phê ×1 — Khách B', oldValue: 'posted', newValue: 'voided', actor: 'le_tan_a', createdAt: '2026-08-27T12:00:00Z' }]
        : [{ id: 1, actionType: 'deposit_change', entityType: 'booking', entityId: 9, entityLabel: 'Khách A', oldValue: '0', newValue: '200000', actor: 'le_tan_a', createdAt: '2026-08-27T10:00:00Z' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(entries) });
    });

    await page.goto('/admin/audit-log.html');
    await expect(page.locator('#logTable tbody')).toContainText('Khách A');
    await expect(page.locator('#logTable tbody')).toContainText('Đổi tiền cọc');
    await expect(page.locator('#logTable tbody')).toContainText('0 đ → 200.000 đ');

    await page.locator('#typeFilter').selectOption('service_void');
    await expect(page.locator('#logTable tbody')).toContainText('Khách B');
    expect(requestedTypes).toContain('service_void');
  });

  test('shows the empty state when there are no entries', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/audit-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/audit-log.html');
    await expect(page.locator('#emptyState')).toBeVisible();
  });
});
