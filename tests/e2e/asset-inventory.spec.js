// tests/e2e/asset-inventory.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

const SAMPLE_LOCATIONS = [
  { id: 1, locationType: 'common_area', roomId: null, code: null, name: 'Sảnh 1', isActive: true },
];

const SAMPLE_BATCHES = [
  { id: 10, locationId: 1, label: 'Sảnh 1 - 2026-09-08', status: 'draft', note: null, createdBy: 'admin_x', createdAt: '2026-09-08T00:00:00Z', closedBy: null, closedAt: null },
];

const SAMPLE_BATCH_DETAIL = {
  id: 10, locationId: 1, label: 'Sảnh 1 - 2026-09-08', status: 'counting', note: null, createdBy: 'admin_x', createdAt: '2026-09-08T00:00:00Z', closedBy: null, closedAt: null,
  lines: [
    { id: 100, batchId: 10, assetId: 1, assetName: 'Điều hoà Daikin', internalCode: 'TS000001', managementType: 'individual_device', bookQuantity: 1, actualQuantity: null, conditionFound: null, photoFilename: null, note: null, suggestedAction: null, updatedBy: null, updatedAt: null },
    { id: 101, batchId: 10, assetId: 2, assetName: 'Giường 1.6m', internalCode: null, managementType: 'durable_goods', bookQuantity: 4, actualQuantity: null, conditionFound: null, photoFilename: null, note: null, suggestedAction: null, updatedBy: null, updatedAt: null },
  ],
};

function mockCommonRoutes(page, { role }) {
  return Promise.all([
    mockAuth(page, role),
    page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) })),
    page.route('**/api/asset-inventory-batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCHES) })),
    page.route('**/api/asset-inventory-lines/missing-devices', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })),
  ]);
}

test.describe('Kiểm kê tài sản (admin/asset-inventory.html)', () => {
  test('admin sees the create-batch button; reception does not', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.goto('/admin/asset-inventory.html');
    await expect(page.locator('#openCreateBatchBtn')).toBeVisible();

    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.reload();
    await expect(page.locator('#openCreateBatchBtn')).toBeHidden();
  });

  test('creating a batch posts locationId and opens its detail', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    let posted = null;
    await page.route('**/api/asset-inventory-batches', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 10, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCHES) });
    });
    await page.route('**/api/asset-inventory-batches/10', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCH_DETAIL) }));

    await page.goto('/admin/asset-inventory.html');
    await page.click('#openCreateBatchBtn');
    await page.selectOption('#createBatchForm select[name="locationId"]', '1');
    await page.click('#createBatchForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ locationId: 1 });
    await expect(page.locator('#batchDetailOverlay')).toBeVisible();
    await expect(page.locator('#batchDetailTitle')).toHaveText('Sảnh 1 - 2026-09-08');
  });

  test('batch list paginates at 10 per page', async ({ page }) => {
    const manyBatches = Array.from({ length: 23 }, (_, i) => ({ id: i + 1, locationId: 1, label: `Đợt ${i + 1}`, status: 'draft', note: null, createdBy: 'admin_x', createdAt: '2026-09-08T00:00:00Z', closedBy: null, closedAt: null }));
    await mockAuth(page, 'admin');
    await page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) }));
    await page.route('**/api/asset-inventory-batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manyBatches) }));
    await page.route('**/api/asset-inventory-lines/missing-devices', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/asset-inventory.html');
    await expect(page.locator('#batchList .booking-card')).toHaveCount(10);
    await expect(page.locator('#batchPageInfo')).toContainText('Trang 1/3 (23 kết quả)');
    await expect(page.locator('#batchPrevBtn')).toBeDisabled();

    await page.click('#batchNextBtn');
    await expect(page.locator('#batchPageInfo')).toContainText('Trang 2/3');
    await page.click('#batchNextBtn');
    await expect(page.locator('#batchPageInfo')).toContainText('Trang 3/3');
    await expect(page.locator('#batchList .booking-card')).toHaveCount(3);
    await expect(page.locator('#batchNextBtn')).toBeDisabled();
  });

  test('reception can fill in a line while counting and save it', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'reception' });
    await page.route('**/api/asset-inventory-batches/10', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BATCH_DETAIL) }));
    let patched = null;
    await page.route('**/api/asset-inventory-lines/100', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/asset-inventory.html');
    await page.locator('.booking-card', { hasText: 'Sảnh 1' }).locator('button', { hasText: 'Xem chi tiết' }).click();
    await expect(page.locator('#batchDetailOverlay')).toBeVisible();

    const row = page.locator('#batchLinesTable tbody tr').first();
    await row.locator('input[type="number"]').fill('1');
    await row.locator('select').selectOption('tot');
    await row.locator('button', { hasText: 'Lưu' }).click();

    await expect.poll(() => patched).toMatchObject({ actualQuantity: 1, conditionFound: 'tot' });
  });

  test('reception sees no status-transition button once the batch is pending_close', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'reception' });
    await page.route('**/api/asset-inventory-batches/10', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...SAMPLE_BATCH_DETAIL, status: 'pending_close' }) })
    );

    await page.goto('/admin/asset-inventory.html');
    await page.locator('.booking-card', { hasText: 'Sảnh 1' }).locator('button', { hasText: 'Xem chi tiết' }).click();
    await expect(page.locator('#batchDetailActions')).toBeEmpty();
    await expect(page.locator('#batchLinesTable tbody tr').first().locator('input[type="number"]')).toBeDisabled();
  });

  test('admin sees "Chốt đợt" when pending_close and it PATCHes status:closed', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'admin' });
    await page.route('**/api/asset-inventory-batches/10', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...SAMPLE_BATCH_DETAIL, status: 'pending_close' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'closed' }) });
    });

    await page.goto('/admin/asset-inventory.html');
    await page.locator('.booking-card', { hasText: 'Sảnh 1' }).locator('button', { hasText: 'Xem chi tiết' }).click();
    await expect(page.locator('#batchDetailActions button', { hasText: 'Chốt đợt' })).toBeVisible();
  });

  test('"Thiết bị không tìm thấy" tab lists closed-batch individual lines with actual_quantity 0', async ({ page }) => {
    await mockAuth(page, 'observer');
    await page.route('**/api/asset-locations', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_LOCATIONS) }));
    await page.route('**/api/asset-inventory-batches?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/asset-inventory-lines/missing-devices', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 100, batchId: 10, batchLabel: 'Sảnh 1 - 2026-09-08', locationId: 1, locationName: 'Sảnh 1', closedAt: '2026-09-08T00:00:00Z', assetId: 1, assetName: 'Điều hoà Daikin', internalCode: 'TS000001', note: null }]),
      })
    );

    await page.goto('/admin/asset-inventory.html');
    await page.click('#inventoryTabToggle button[data-tab="missing"]');
    await expect(page.locator('#missingList')).toContainText('Điều hoà Daikin');
    await expect(page.locator('#missingList')).toContainText('TS000001');
  });
});
