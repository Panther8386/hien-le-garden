// tests/e2e/asset-config.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

const SAMPLE_CATEGORIES = [
  { id: 1, managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', isActive: true, note: null, createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
  { id: 2, managementType: 'linen', name: 'Khăn', defaultUnit: 'cái', isActive: false, note: 'Ngừng dùng', createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
];

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'room', roomId: 4, code: 'P04', name: 'Nhà tròn 1 (khu tài sản)', isActive: true, note: null, createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
  { id: 2, locationType: 'warehouse', roomId: null, code: 'BP', name: 'Buồng phòng', isActive: true, note: null, createdBy: 'admin_a', createdAt: '2026-09-07T00:00:00Z', updatedBy: null, updatedAt: null },
];

const SAMPLE_ROOMS = [{ id: 4, name: 'Circle House 1', roomType: 'circle', needsCleaning: false }];

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    mockAuth(page, role),
    page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROOMS) })),
    page.route('**/api/asset-categories**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
    page.route('**/api/asset-locations**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
  ]);
}

test.describe('Danh mục & vị trí (admin/asset-config.html)', () => {
  test('admin sees add/edit/deactivate controls; reception does not', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    await expect(page.locator('#openAddCategoryBtn')).toBeVisible();
    await expect(page.locator('#openAddLocationBtn')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sửa' }).first()).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.reload();
    await expect(page.locator('#openAddCategoryBtn')).toBeHidden();
    await expect(page.locator('#openAddLocationBtn')).toBeHidden();
    await expect(page.locator('button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('categories render grouped by management type, inactive ones dimmed', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    await expect(page.locator('#categoryGroups')).toContainText('Thiết bị riêng lẻ');
    await expect(page.locator('#categoryGroups')).toContainText('Điều hoà');
    await expect(page.locator('#categoryGroups')).toContainText('Đồ vải luân chuyển');
    await expect(page.locator('#categoryGroups')).toContainText('Khăn');
    await expect(page.locator('#categoryGroups')).toContainText('đã ngừng dùng');
  });

  test('adding a category submits the correct payload', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-categories', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
    });

    await page.goto('/admin/asset-config.html');
    await page.click('#openAddCategoryBtn');
    await page.selectOption('#categoryForm select[name="managementType"]', 'consumable');
    await page.fill('#categoryForm input[name="name"]', 'Nước rửa chén');
    await page.fill('#categoryForm input[name="defaultUnit"]', 'chai');
    await page.click('#categoryForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ managementType: 'consumable', name: 'Nước rửa chén', defaultUnit: 'chai' });
  });

  test('switching location tabs filters the list by type', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    await expect(page.locator('#locationList')).toContainText('Nhà tròn 1 (khu tài sản)');
    await expect(page.locator('#locationList')).not.toContainText('Buồng phòng');

    await page.click('#locationTypeToggle button[data-location-type="warehouse"]');
    await expect(page.locator('#locationList')).toContainText('Buồng phòng');
    await expect(page.locator('#locationList')).not.toContainText('Nhà tròn 1 (khu tài sản)');
  });

  test('a room-type location card shows the original room name (readonly) alongside its own asset name', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-config.html');
    const roomCard = page.locator('#locationList', { hasText: 'Nhà tròn 1 (khu tài sản)' });
    await expect(roomCard).toContainText('Circle House 1');
    await expect(roomCard).toContainText('Tên phòng gốc');
  });

  test('adding a room location includes roomId in the payload; adding a warehouse location does not require it', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-locations', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) });
    });

    await page.goto('/admin/asset-config.html');
    await page.click('#openAddLocationBtn');
    await expect(page.locator('#locationRoomWrap')).toBeVisible();
    await page.selectOption('#locationForm select[name="roomId"]', '4');
    await page.fill('#locationForm input[name="name"]', 'Circle House 1');
    await page.click('#locationForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ locationType: 'room', roomId: 4, name: 'Circle House 1' });
  });
});
