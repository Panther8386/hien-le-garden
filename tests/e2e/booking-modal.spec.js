// tests/e2e/booking-modal.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Homepage booking modal', () => {
  test('shows live availability and submits a booking request', async ({ page }) => {
    await page.route('**/api/availability**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roomType: 'circle', totalRooms: 5, bookedCount: 2, available: 3, availableRooms: [] }) })
    );
    await page.route('**/api/bookings', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 42 }) });
      }
      return route.continue();
    });

    await page.goto('/');
    await page.click('.fab-book');
    await expect(page.locator('#bmOverlay')).toHaveClass(/open/);

    await page.fill('#bmGuestName', 'Nguyễn Văn A');
    await page.fill('#bmPhone', '0900000001');
    await page.selectOption('#bmRoom', 'circle');
    await expect(page.locator('#bmAvailability')).toContainText('Còn 3/5 phòng');

    await page.click('.bm-submit');
    await expect(page.locator('#bmConfirmState')).toHaveClass(/show/);
    await expect(page.locator('.bm-contact-title')).toContainText('Yêu cầu đã được gửi');
  });

  test('shows an inline error when the request fails', async ({ page }) => {
    await page.route('**/api/availability**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roomType: 'circle', totalRooms: 5, bookedCount: 5, available: 0, availableRooms: [] }) })
    );
    await page.route('**/api/bookings', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Thiếu thông tin bắt buộc' }) });
      }
      return route.continue();
    });

    await page.goto('/');
    await page.click('.fab-book');
    await page.fill('#bmGuestName', 'Nguyễn Văn A');
    await page.fill('#bmPhone', '0900000001');
    await page.selectOption('#bmRoom', 'circle');
    await expect(page.locator('#bmAvailability')).toContainText('Đã hết');

    await page.click('.bm-submit');
    await expect(page.locator('#bmSubmitError')).toContainText('Thiếu thông tin bắt buộc');
    await expect(page.locator('#bmConfirmState')).not.toHaveClass(/show/);
  });
});
