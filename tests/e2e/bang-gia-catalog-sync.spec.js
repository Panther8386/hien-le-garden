// tests/e2e/bang-gia-catalog-sync.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Bảng giá reads from the catalog API', () => {
  test('renders rows from /api/catalog into the correct tab tables', async ({ page }) => {
    await page.route('**/api/catalog', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Triangle House Mock', priceType: 'fixed', priceMin: 300000, priceMax: null, priceLabel: null, unitCapacity: '2–3 người', note: 'note-a', roomTypeKey: 'triangle', displayOrder: 1, isActive: true },
          { id: 2, category: 'luu_tru', subgroup: 'Thuê Theo Giờ', name: 'Giờ Đầu Mock', priceType: 'fixed', priceMin: 130000, priceMax: null, priceLabel: null, unitCapacity: '1 giờ', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
          { id: 3, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê Mock', priceType: 'range', priceMin: 30000, priceMax: 80000, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
          { id: 4, category: 'su_kien_team_building', subgroup: null, name: 'Sự kiện Mock', priceType: 'label', priceMin: null, priceMax: null, priceLabel: 'Theo giá thị trường', unitCapacity: '—', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
        ]),
      })
    );

    await page.goto('/bang-gia/');
    await expect(page.locator('#tbody-overnight')).toContainText('Triangle House Mock');
    await expect(page.locator('#tbody-overnight')).toContainText('300.000 đ');
    await expect(page.locator('#tbody-hourly')).toContainText('Giờ Đầu Mock');

    await page.click('.pricing-tab[data-tab="activities"]');
    await expect(page.locator('#tbody-activities')).toContainText('30.000–80.000 đ');

    await page.click('.pricing-tab[data-tab="events"]');
    await expect(page.locator('#tbody-events')).toContainText('Theo giá thị trường');
  });

  test('shows a fallback message when the catalog fetch fails', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 500 }));
    await page.goto('/bang-gia/');
    await expect(page.locator('#tbody-overnight')).toContainText('Không tải được bảng giá');
  });
});
