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
    await page.waitForURL('**/admin/');
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

  test('date filter re-fetches room status for the chosen date', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let requestedDate = null;
    await page.route('**/api/rooms?**', (route) => {
      requestedDate = new URL(route.request().url()).searchParams.get('date');
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Triangle 1', roomType: 'triangle', status: 'empty', needsCleaning: false }]) });
    });
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await page.locator('#roomDateFilter').fill('2026-09-15');
    await expect.poll(() => requestedDate).toBe('2026-09-15');
  });

  test('an account without the layout flag cannot drag rooms', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, name: 'Triangle 1', roomType: 'triangle', status: 'empty', needsCleaning: false }]) }));
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    const card = page.locator('.room-card').first();
    await expect(card).not.toHaveClass(/room-draggable/);
    await expect(page.locator('#saveRoomOrderBtn')).toBeHidden();
  });

  test('an account with the layout flag can drag and must explicitly save', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'vinhdx', role: 'manager', canManageRoomLayout: true }) }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { id: 1, name: 'Triangle 1', roomType: 'triangle', status: 'empty', needsCleaning: false },
          { id: 2, name: 'Triangle 2', roomType: 'triangle', status: 'empty', needsCleaning: false },
        ]),
      })
    );
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    let reorderCalled = false;
    await page.route('**/api/rooms/reorder', (route) => {
      reorderCalled = true;
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await page.locator('.room-card').first().scrollIntoViewIfNeeded();
    const cards = page.locator('.room-card');
    await expect(cards.first()).toHaveClass(/room-draggable/);

    const firstBox = await cards.nth(0).boundingBox();
    const secondBox = await cards.nth(1).boundingBox();
    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2, { steps: 5 });
    await page.mouse.up();

    expect(reorderCalled).toBe(false);
    await expect(page.locator('#saveRoomOrderBtn')).toBeVisible();
    await page.click('#saveRoomOrderBtn');
    await expect.poll(() => reorderCalled).toBe(true);
  });

  test('observer never sees the deposit input', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer', canManageRoomLayout: false }) }));
    // Register the catch-all before the specific route: Playwright resolves overlapping
    // page.route patterns in reverse registration order, so the more specific route
    // (registered last) must come after the catch-all to take precedence for status=pending.
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, guestName: 'Khách A', phone: null, roomType: 'triangle', checkIn: '2026-09-01', checkOut: '2026-09-02', status: 'pending', depositAmount: 0 }]) })
    );
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#pendingList')).toContainText('Khách A');
    await expect(page.locator('#pendingList input[type="number"]')).toHaveCount(0);
  });
});
