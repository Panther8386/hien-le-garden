// tests/e2e/reception-reminders.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Reception reminders', () => {
  test('shows all three reminder lists when there is something to flag', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/reception/reminders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          pendingNoDeposit: [{ id: 1, guestName: 'Chờ Cọc', phone: '0900000001', createdAt: '2026-08-28T00:00:00Z', hoursWaiting: 5 }],
          arrivingToday: [{ id: 2, guestName: 'Khách Đến', phone: '0900000002', roomType: 'circle', checkIn: '2099-01-01' }],
          roomsNotCleaned: [{ id: 3, name: 'Circle House 1', roomType: 'circle', needsCleaningSince: '2026-08-28T00:00:00Z', minutesWaiting: 90 }],
          thresholds: { pendingDepositHours: 2, cleaningMinutes: 60 },
        }),
      })
    );

    await page.goto('/admin/reception.html');

    await expect(page.locator('#remindersSection')).toContainText('Chờ cọc quá 2 giờ (1)');
    await expect(page.locator('#remindersSection')).toContainText('Chờ Cọc');
    await expect(page.locator('#remindersSection')).toContainText('chờ 5 giờ');
    await expect(page.locator('#remindersSection')).toContainText('Khách sắp đến hôm nay (1)');
    await expect(page.locator('#remindersSection')).toContainText('Khách Đến');
    await expect(page.locator('#remindersSection')).toContainText('Phòng chưa dọn quá 60 phút (1)');
    await expect(page.locator('#remindersSection')).toContainText('Circle House 1');
    await expect(page.locator('#remindersSection')).toContainText('90 phút');
  });

  test('shows the all-clear message when there is nothing to flag', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/reception/reminders', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pendingNoDeposit: [], arrivingToday: [], roomsNotCleaned: [], thresholds: { pendingDepositHours: 2, cleaningMinutes: 60 } }),
      })
    );

    await page.goto('/admin/reception.html');
    await expect(page.locator('#remindersSection')).toContainText('Không có việc cần nhắc');
  });
});
