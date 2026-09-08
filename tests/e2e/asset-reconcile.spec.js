// tests/e2e/asset-reconcile.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_DOCUMENTS = [
  { id: 1, title: 'Phụ lục II — Danh mục tài sản hiện tại của Bên A', contractRef: '0107/HĐHTKD-HLG/2026' },
];

const SAMPLE_ROWS = [
  { id: 5, sourceDocumentId: 1, sourceGroupLabel: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 11, rawName: 'Điều hoà Daikin 2.5HP', rawUnit: 'bộ', rawQuantity: '1', rawCondition: 'Tốt', rawNote: 'Vip1', reconciledCount: 0 },
  { id: 6, sourceDocumentId: 1, sourceGroupLabel: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 8, rawName: 'Giường 1.6m', rawUnit: 'Cái', rawQuantity: '11', rawCondition: 'Tốt', rawNote: null, reconciledCount: 4 },
];

const SAMPLE_CATEGORIES = [
  { id: 1, managementType: 'individual_device', name: 'Điều hoà', defaultUnit: 'bộ', isActive: true },
  { id: 2, managementType: 'durable_goods', name: 'Giường', defaultUnit: 'cái', isActive: true },
];

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'room', roomId: 4, code: 'P04', name: 'Nhà tròn 1', isActive: true },
];

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) })),
    page.route('**/api/asset-source-documents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_DOCUMENTS) })),
    page.route('**/api/asset-source-rows**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROWS) })),
    page.route('**/api/asset-categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) })),
    page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) })),
  ]);
}

test.describe('Hồ sơ nguồn — luồng đối chiếu (admin/asset-source-data.html)', () => {
  test('shows "Đã tạo" as X/N when raw quantity is known, and the reconcile button for admin', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-source-data.html');
    const row = page.locator('#sourceRowsTable tbody tr', { hasText: 'Giường 1.6m' });
    await expect(row).toContainText('4/11');
    await expect(row.locator('button', { hasText: 'Tạo tài sản' })).toBeVisible();
  });

  test('reception does not see the "Tạo tài sản" button', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'reception' });
    await page.goto('/admin/asset-source-data.html');
    // Check specifically for action buttons in the table, not the form submit button
    await expect(page.locator('#sourceRowsTable tbody button', { hasText: 'Tạo tài sản' })).toHaveCount(0);
  });

  test('the reconcile popup toggles between "Số lượng tạo" and "Số lượng" based on category type', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-source-data.html');
    const row = page.locator('#sourceRowsTable tbody tr', { hasText: 'Điều hoà Daikin' });
    await row.locator('button', { hasText: 'Tạo tài sản' }).click();

    await page.selectOption('#reconcileForm select[name="categoryId"]', '1');
    await expect(page.locator('#reconcileCountWrap')).toBeVisible();
    await expect(page.locator('#reconcileQuantityWrap')).toBeHidden();

    await page.selectOption('#reconcileForm select[name="categoryId"]', '2');
    await expect(page.locator('#reconcileCountWrap')).toBeHidden();
    await expect(page.locator('#reconcileQuantityWrap')).toBeVisible();
  });

  test('submitting the reconcile form posts the correct payload', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-source-rows/5/reconcile', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, createdIds: [10] }) });
    });

    await page.goto('/admin/asset-source-data.html');
    const row = page.locator('#sourceRowsTable tbody tr', { hasText: 'Điều hoà Daikin' });
    await row.locator('button', { hasText: 'Tạo tài sản' }).click();
    await page.selectOption('#reconcileForm select[name="categoryId"]', '1');
    await page.selectOption('#reconcileForm select[name="locationId"]', '1');
    await page.fill('#reconcileForm input[name="count"]', '1');
    await page.click('#reconcileForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ categoryId: 1, locationId: 1, count: 1 });
  });
});
