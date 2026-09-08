// tests/e2e/assets.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

const SAMPLE_CATEGORIES = [
  { id: 1, managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', isActive: true },
  { id: 2, managementType: 'durable_goods', name: 'Giường', defaultUnit: 'cái', isActive: true },
];

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'room', roomId: 4, code: 'P04', name: 'Nhà tròn 1', isActive: true },
];

const SAMPLE_ASSETS = [
  { id: 1, categoryId: 1, managementType: 'individual_device', internalCode: 'TS000001', name: 'Điều hoà Daikin', brand: 'Daikin', serialNumber: null, sourceType: 'handover_a', sourceRowId: 5, acquiredDate: null, purchasePrice: null, locationId: null, holder: null, quantity: 1, physicalCondition: 'tot', operationalStatus: 'san_sang', lifecycleStatus: 'dang_quan_ly', photoKey: null, photoFilename: null, note: null },
  { id: 2, categoryId: 2, managementType: 'durable_goods', internalCode: null, name: 'Giường 1.6m', brand: null, serialNumber: null, sourceType: 'handover_a', sourceRowId: 6, acquiredDate: null, purchasePrice: null, locationId: null, holder: null, quantity: 11, physicalCondition: 'tot', operationalStatus: 'san_sang', lifecycleStatus: 'dang_quan_ly', photoKey: null, photoFilename: null, note: null },
];

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    mockAuth(page, role),
    page.route('**/api/asset-categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) })),
    page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) })),
    page.route('**/api/assets**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
  ]);
}

test.describe('Danh mục tài sản (admin/assets.html)', () => {
  test('admin sees add button and Sửa buttons; reception does not', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await expect(page.locator('#openAddAssetBtn')).toBeVisible();
    await expect(page.locator('button', { hasText: 'Sửa' }).first()).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.reload();
    await expect(page.locator('#openAddAssetBtn')).toBeHidden();
    await expect(page.locator('button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('list renders both individual and quantity-tracked assets with their info', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await expect(page.locator('#assetList')).toContainText('Điều hoà Daikin');
    await expect(page.locator('#assetList')).toContainText('TS000001');
    await expect(page.locator('#assetList')).toContainText('Giường 1.6m');
    await expect(page.locator('#assetList')).toContainText('Số lượng: 11');
  });

  test('opening the add form and picking an individual_device category hides the quantity field', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await page.click('#openAddAssetBtn');
    await page.selectOption('#assetForm select[name="categoryId"]', '1');
    await expect(page.locator('#assetQuantityWrap')).toBeHidden();
    await page.selectOption('#assetForm select[name="categoryId"]', '2');
    await expect(page.locator('#assetQuantityWrap')).toBeVisible();
  });

  test('editing an individual_device asset shows its internal code and renders a QR canvas', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await expect(page.locator('.booking-card', { hasText: 'Điều hoà Daikin' })).toBeVisible();
    await page.locator('.booking-card', { hasText: 'Điều hoà Daikin' }).locator('button', { hasText: 'Sửa' }).click();
    await expect(page.locator('#assetFormOverlay')).toBeVisible();
    await expect(page.locator('#assetQrSection')).toBeVisible();
    await expect(page.locator('#assetInternalCode')).toHaveText('TS000001');
    // The canvas is rendered by qrcode.min.js library, check that it exists with expected size
    await expect(page.locator('#assetQrCode canvas')).toHaveAttribute('width', '128');
    await expect(page.locator('#assetQrCode canvas')).toHaveAttribute('height', '128');
  });

  test('editing a durable_goods asset hides the QR section', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/assets.html');
    await page.locator('.booking-card', { hasText: 'Giường 1.6m' }).locator('button', { hasText: 'Sửa' }).click();
    await expect(page.locator('#assetQrSection')).toBeHidden();
  });

  test('adding a new asset submits the correct payload', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/assets', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
    });

    await page.goto('/admin/assets.html');
    await page.click('#openAddAssetBtn');
    await page.selectOption('#assetForm select[name="categoryId"]', '2');
    await page.fill('#assetForm input[name="name"]', 'Nệm mới');
    await page.selectOption('#assetForm select[name="sourceType"]', 'purchased_b');
    await page.fill('#assetForm input[name="quantity"]', '3');
    await page.click('#assetForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ categoryId: 2, name: 'Nệm mới', sourceType: 'purchased_b', quantity: 3 });
  });

  test('filtering by category re-fetches with the categoryId param', async ({ page }) => {
    let requestedUrl = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/assets**', (route) => {
      requestedUrl = route.request().url();
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    });

    await page.goto('/admin/assets.html');
    await page.selectOption('#filterCategory', '1');
    await expect.poll(() => requestedUrl).toContain('categoryId=1');
  });

  test('the Xoá button appears only with canDeleteAsset, independent of role, and DELETEs on confirm', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canDeleteAsset: true }) }));
    await page.route('**/api/asset-categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));
    await page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) }));
    await page.route('**/api/assets**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) }));

    let deletedId = null;
    await page.route('**/api/assets/1', (route) => {
      if (route.request().method() === 'DELETE') {
        deletedId = 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ASSETS) });
    });

    await page.goto('/admin/assets.html');
    const card = page.locator('.booking-card', { hasText: 'Điều hoà Daikin' });
    await expect(card.locator('button', { hasText: 'Sửa' })).toHaveCount(0); // reception, no edit rights
    await card.locator('button', { hasText: 'Xoá' }).click();

    await expect(page.locator('#assetDeleteOverlay')).toBeVisible();
    await expect(page.locator('#assetDeleteSummary')).toContainText('TS000001');
    await page.click('#assetDeleteConfirmBtn');

    await expect.poll(() => deletedId).toBe(1);
    await expect(page.locator('#assetDeleteOverlay')).toBeHidden();
  });
});
