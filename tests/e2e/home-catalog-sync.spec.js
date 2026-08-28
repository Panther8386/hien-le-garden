// tests/e2e/home-catalog-sync.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Homepage reads room prices and cancellation policy from the API', () => {
  test('updates the booking select and room card price tags from /api/catalog', async ({ page }) => {
    await page.route('**/api/catalog', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Triangle House', priceType: 'fixed', priceMin: 350000, priceMax: null, priceLabel: null, unitCapacity: '2–3 người', note: '', roomTypeKey: 'triangle', displayOrder: 1, isActive: true },
        ]),
      })
    );
    await page.route('**/api/cancellation-policy?public=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/');
    await expect(page.locator('#roomType option[value="triangle"]')).toHaveText('Triangle House — 350.000đ/đêm');
    await expect(page.locator('.room-card[data-room-type="triangle"] .room-price-tag')).toHaveText('350k/đêm');
  });

  test('rebuilds the FAQ chatbot refund answer from /api/cancellation-policy', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/cancellation-policy?public=1', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, minDaysBeforeCheckin: 7, refundPercent: 100, label: null }]) })
    );

    await page.goto('/');
    await page.click('#aiConciergeBtn');
    await page.fill('#aiInput', 'chính sách hoàn tiền khi hủy?');
    await page.click('#aiSendBtn');
    await expect(page.locator('#aiMessages')).toContainText('7 ngày');
    await expect(page.locator('#aiMessages')).toContainText('100%');
  });

  test('shows the default message when no cancellation tiers are configured', async ({ page }) => {
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
    await page.route('**/api/cancellation-policy?public=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/');
    await page.click('#aiConciergeBtn');
    await page.fill('#aiInput', 'hủy đặt phòng hoàn tiền không?');
    await page.click('#aiSendBtn');
    await expect(page.locator('#aiMessages')).toContainText('đang được cập nhật');
  });
});
