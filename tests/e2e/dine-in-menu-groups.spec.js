// tests/e2e/dine-in-menu-groups.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role }) }));
}

function menuItem(overrides) {
  return {
    id: 1, name: 'Gỏi hải sản', category: 'mon_an', price: 179000, subgroup: 'Hải sản', unit: 'đĩa', requiresPreorder: false,
    displayOrder: 0, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z',
    ...overrides,
  };
}

test.describe('Menu quán — grouping and reordering', () => {
  test('renders subgroup headers and shows unit + preorder badge', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [
      menuItem({ id: 1, name: 'Gỏi hải sản', subgroup: 'Hải sản', unit: 'đĩa', displayOrder: 0 }),
      menuItem({ id: 2, name: 'Gà nướng', subgroup: 'Món gà', unit: 'con', requiresPreorder: true, displayOrder: 1 }),
    ];
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }));

    await page.goto('/admin/dine-in-menu.html');
    await expect(page.locator('#monAnTable')).toContainText('Hải sản');
    await expect(page.locator('#monAnTable')).toContainText('Món gà');
    await expect(page.locator('#monAnTable')).toContainText('179.000đ/đĩa');
    await expect(page.locator('#monAnTable')).toContainText('⚠ Đặt trước');
  });

  test('clicking the group ▼ button calls move-group with the right payload', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [
      menuItem({ id: 1, name: 'Gỏi hải sản', subgroup: 'Hải sản', displayOrder: 0 }),
      menuItem({ id: 2, name: 'Gà nướng', subgroup: 'Món gà', displayOrder: 1 }),
    ];
    await page.route('**/api/dine-in-menu', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    });
    let moveGroupBody = null;
    await page.route('**/api/dine-in-menu/move-group', (route) => {
      moveGroupBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-menu.html');
    const groupHeaderRow = page.locator('#monAnTable tr', { hasText: 'Hải sản' }).first();
    await groupHeaderRow.locator('button', { hasText: '▼' }).click();

    await expect.poll(() => moveGroupBody).toMatchObject({ category: 'mon_an', subgroup: 'Hải sản', direction: 'down' });
  });

  test('clicking an item ▲ button calls the move endpoint for that item', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [
      menuItem({ id: 1, name: 'Gỏi hải sản', subgroup: 'Hải sản', displayOrder: 0 }),
      menuItem({ id: 2, name: 'Tôm sốt', subgroup: 'Hải sản', displayOrder: 1 }),
    ];
    await page.route('**/api/dine-in-menu', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    });
    let moveUrl = null;
    let moveBody = null;
    await page.route('**/api/dine-in-menu/2/move', (route) => {
      moveUrl = route.request().url();
      moveBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-menu.html');
    const itemRow = page.locator('#monAnTable tr', { hasText: 'Tôm sốt' });
    await itemRow.locator('button', { hasText: '▲' }).click();

    await expect.poll(() => moveBody).toMatchObject({ direction: 'up' });
    expect(moveUrl).toContain('/api/dine-in-menu/2/move');
  });

  test('drinks table also groups by subgroup and shows unit, but never a preorder badge', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [menuItem({ id: 3, name: 'Cà phê đen', category: 'do_uong', subgroup: 'Cà phê', unit: 'ly', price: 25000, requiresPreorder: false, displayOrder: 0 })];
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }));

    await page.goto('/admin/dine-in-menu.html');
    await expect(page.locator('#doUongTable')).toContainText('Cà phê');
    await expect(page.locator('#doUongTable')).toContainText('25.000đ/ly');
    await expect(page.locator('#doUongTable')).not.toContainText('Đặt trước');
  });
});
