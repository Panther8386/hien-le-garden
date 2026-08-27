// tests/e2e/reception-ops-board.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Reception daily ops board', () => {
  test('lists a pending request and confirms it into a chosen room', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 7, guestName: 'Nguyễn Văn A', phone: '0900000001', roomType: 'circle', checkIn: '2099-01-01', checkOut: '2099-01-03', status: 'pending' }]) })
    );
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/availability**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roomType: 'circle', totalRooms: 5, bookedCount: 1, available: 4, availableRooms: [{ id: 3, name: 'Circle House 3' }] }) })
    );

    let confirmed = false;
    await page.route('**/api/bookings/7/confirm', (route) => {
      confirmed = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#pendingList')).toContainText('Nguyễn Văn A');

    await page.click('#pendingList >> text=Xác nhận');
    await expect(page.locator('#confirmOverlay')).toBeVisible();
    await page.selectOption('#confirmRoomSelect', '3');
    await page.click('#confirmSubmitBtn');

    await expect(page.locator('#confirmOverlay')).toBeHidden();
    expect(confirmed).toBe(true);
  });

  test('redirects to login.html when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/reception.html');
    await page.waitForURL('**/admin/login.html');
  });

  test('observer sees a read-only ops board', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer' }) }));
    // Register the catch-all before the specific route: Playwright resolves overlapping
    // page.route patterns in reverse registration order, so the more specific route
    // (registered last) must come after the catch-all to take precedence for status=pending.
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, guestName: 'Khách A', phone: '0900000001', roomType: 'triangle', checkIn: '2026-09-01', checkOut: '2026-09-02', status: 'pending' }]) })
    );
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Triangle 1', roomType: 'triangle', needsCleaning: false, status: 'empty' }]) }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#newBookingSection')).toBeHidden();
    await expect(page.locator('#promoLookupSection')).toBeHidden();
    await expect(page.locator('#pendingList')).toContainText('Khách A');
    await expect(page.locator('#pendingList button')).toHaveCount(0);
  });
});
