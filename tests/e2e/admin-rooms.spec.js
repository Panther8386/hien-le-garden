// tests/e2e/admin-rooms.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Quản lý phòng', () => {
  test('admin can edit a room price and see it reflected', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));

    let priceWeekday = null;
    let priceWeekend = null;
    await page.route('**/api/rooms', (route) => {
      const rooms = [{ id: 1, name: 'VIP House 1', roomType: 'vip', priceWeekday, priceWeekend }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rooms) });
    });
    await page.route('**/api/rooms/1/price', (route) => {
      const body = route.request().postDataJSON();
      priceWeekday = body.priceWeekday;
      priceWeekend = body.priceWeekend;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/holidays', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/admin/rooms.html');
    await expect(page.locator('#roomsTable tbody tr')).toContainText('—');
    await page.click('#roomsTable tbody tr button:has-text("Sửa")');
    await page.locator('#roomsTable tbody tr input').nth(0).fill('700000');
    await page.locator('#roomsTable tbody tr input').nth(1).fill('900000');
    await page.click('#roomsTable tbody tr button:has-text("Lưu")');
    await expect(page.locator('#roomsTable tbody tr')).toContainText('700.000');
    await expect(page.locator('#roomsTable tbody tr')).toContainText('900.000');
  });

  test('a non-admin role sees room prices and holidays read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan', role: 'reception' }) }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'VIP House 1', roomType: 'vip', priceWeekday: 700000, priceWeekend: 900000 }]) }));
    await page.route('**/api/holidays', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Quốc khánh', startDate: '2026-09-02', endDate: '2026-09-02' }]) }));

    await page.goto('/admin/rooms.html');
    await expect(page.locator('#roomsTable tbody')).toContainText('700.000');
    await expect(page.locator('#holidaysTable tbody')).toContainText('Quốc khánh');
    await expect(page.locator('#roomsTable tbody tr button', { hasText: 'Sửa' })).toHaveCount(0);
    await expect(page.locator('#addHolidayBtn')).toBeHidden();
    await expect(page.locator('#holidaysTable tbody tr button', { hasText: 'Xoá' })).toHaveCount(0);
  });

  test('admin can add and delete a holiday', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    let holidays = [];
    await page.route('**/api/holidays', (route) => {
      if (route.request().method() === 'POST') {
        holidays = [{ id: 1, name: 'Test Holiday E2E', startDate: '2027-05-01', endDate: '2027-05-02' }];
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(holidays) });
    });
    await page.route('**/api/holidays/1', (route) => {
      if (route.request().method() === 'DELETE') {
        holidays = [];
        return route.fulfill({ status: 204 });
      }
      return route.continue();
    });

    await page.goto('/admin/rooms.html');
    await expect(page.locator('#holidaysEmptyState')).toBeVisible();
    await page.click('#addHolidayBtn');
    await page.fill('#holidayForm input[name="name"]', 'Test Holiday E2E');
    await page.fill('#holidayForm input[name="startDate"]', '2027-05-01');
    await page.fill('#holidayForm input[name="endDate"]', '2027-05-02');
    await page.click('#holidaySubmitBtn');
    await expect(page.locator('#holidaysTable tbody')).toContainText('Test Holiday E2E');

    await page.click('#holidaysTable tbody tr button:has-text("Xoá")');
    await expect(page.locator('#holidaysTable tbody')).not.toContainText('Test Holiday E2E');
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/rooms.html');
    await page.waitForURL('**/admin/');
  });
});
