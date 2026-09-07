// tests/e2e/asset-source-data.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_DOCUMENTS = [
  { id: 1, title: 'Phụ lục II — Danh mục tài sản hiện tại của Bên A', contractRef: '0107/HĐHTKD-HLG/2026', documentDate: null, note: null, createdBy: 'system', createdAt: '2026-09-07T00:00:00Z' },
];

const SAMPLE_ROWS = [
  { id: 1, sourceDocumentId: 1, sourceGroupLabel: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 1, rawName: 'Phòng lưu trú gia đình', rawUnit: 'phòng', rawQuantity: '15', rawCondition: 'Tốt', rawNote: null, createdAt: '2026-09-07T00:00:00Z' },
  { id: 2, sourceDocumentId: 1, sourceGroupLabel: 'A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG', stt: 2, rawName: 'Phòng tập thể (dormitory)', rawUnit: 'phòng', rawQuantity: '01', rawCondition: 'Tốt', rawNote: null, createdAt: '2026-09-07T00:00:00Z' },
  { id: 3, sourceDocumentId: 1, sourceGroupLabel: 'B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG', stt: 7, rawName: 'Giường 1.4m', rawUnit: 'cái', rawQuantity: null, rawCondition: 'Tốt', rawNote: null, createdAt: '2026-09-07T00:00:00Z' },
];

test.describe('Hồ sơ nguồn (admin/asset-source-data.html)', () => {
  test('renders rows grouped by source group label, shows "Chưa xác định" for a null quantity, preserves "01"', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/asset-source-documents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_DOCUMENTS) }));
    await page.route('**/api/asset-source-rows**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROWS) }));

    await page.goto('/admin/asset-source-data.html');

    await expect(page.locator('#sourceRowsTable')).toContainText('A. CÔNG TRÌNH & KẾT CẤU XÂY DỰNG');
    await expect(page.locator('#sourceRowsTable')).toContainText('B. NỘI THẤT & THIẾT BỊ TRONG PHÒNG');

    const row2 = page.locator('#sourceRowsTable tbody tr', { hasText: 'Phòng tập thể (dormitory)' });
    await expect(row2).toContainText('01');

    const row7 = page.locator('#sourceRowsTable tbody tr', { hasText: 'Giường 1.4m' });
    await expect(row7).toContainText('Chưa xác định');
  });

  test('changing the document selector re-fetches source rows for the selected documentId', async ({ page }) => {
    const documents = [...SAMPLE_DOCUMENTS, { id: 2, title: 'Phụ lục khác', contractRef: null, documentDate: null, note: null, createdBy: 'system', createdAt: '2026-09-07T00:00:00Z' }];
    let lastRequestedId = null;
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/asset-source-documents', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(documents) }));
    await page.route('**/api/asset-source-rows**', (route) => {
      const url = new URL(route.request().url());
      lastRequestedId = url.searchParams.get('documentId');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_ROWS) });
    });

    await page.goto('/admin/asset-source-data.html');
    await expect.poll(() => lastRequestedId).toBe('1');

    await page.selectOption('#documentSelect', '2');
    await expect.poll(() => lastRequestedId).toBe('2');
  });
});
