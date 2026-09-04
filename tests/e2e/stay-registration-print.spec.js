// tests/e2e/stay-registration-print.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_BOOKING = {
  id: 42, guestName: 'Nguyễn Văn A', phone: '0900000001', email: null,
  roomType: 'triangle', roomId: 3, roomName: 'Triangle House 2',
  checkIn: '2026-09-10', checkOut: '2026-09-12', guestsCount: 2,
  notes: null, status: 'checked_in', idNumber: null, nationality: null,
};

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role }) }));
}

test.describe('Stay registration print page', () => {
  test('loads booking details and renders the printable form', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/bookings/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BOOKING) }));

    await page.goto('/admin/stay-registration-print.html?bookingId=42');

    await expect(page.locator('#formPrint')).toContainText('Nguyễn Văn A');
    await expect(page.locator('#formPrint')).toContainText('Triangle House 2');
    await expect(page.locator('#formPrint')).toContainText('PHIẾU ĐĂNG KÝ LƯU TRÚ');
  });

  test('saving the identity form PATCHes the booking and updates the preview', async ({ page }) => {
    await mockAuth(page, 'reception');
    let patched = null;
    await page.route('**/api/bookings/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BOOKING) });
    });
    await page.route('**/api/bookings/42/identity', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/stay-registration-print.html?bookingId=42');
    await page.fill('#idNumberInput', '079123456789');
    await page.fill('#nationalityInput', 'Việt Nam');
    await page.click('#saveIdentityBtn');

    await expect.poll(() => patched).toMatchObject({ idNumber: '079123456789', nationality: 'Việt Nam' });
    await expect(page.locator('#formPrint')).toContainText('079123456789');
    await expect(page.locator('#formPrint')).toContainText('Việt Nam');
  });

  test('the print button calls window.print()', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/bookings/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_BOOKING) }));

    await page.goto('/admin/stay-registration-print.html?bookingId=42');
    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printBtn');

    const called = await page.evaluate(() => window.__printCalled);
    expect(called).toBe(true);
  });

  test('a 404 from the booking fetch shows an error instead of a blank page', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/bookings/999', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Không tìm thấy đặt phòng' }) }));

    await page.goto('/admin/stay-registration-print.html?bookingId=999');

    await expect(page.locator('#pageError')).toContainText('Không tìm thấy đặt phòng');
  });
});
