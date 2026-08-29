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

  test('cancelling a booking with a deposit shows the computed refund suggestion', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, guestName: 'Trần Thị B', phone: '0900000009', roomType: 'circle', checkIn: '2099-02-01', checkOut: '2099-02-03', status: 'confirmed' }]) })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/9/cancel', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, refundPercentApplied: 50, refundAmount: 150000 }) }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trần Thị B');
    await page.click('#upcomingConfirmedList >> text=Hủy đặt phòng');

    await expect(page.locator('#opsError')).toContainText('50%');
    await expect(page.locator('#opsError')).toContainText('150.000');
  });

  test('adding a service line updates the card total and item list', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 5, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê', priceType: 'fixed', priceMin: 30000, priceMax: null, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true }]) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let serviceAdded = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 11, guestName: 'Lê Thị C', phone: '0900000011', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          services: serviceAdded ? [{ id: 1, bookingId: 11, name: 'Cà phê', unitPrice: 30000, quantity: 2, amount: 60000, status: 'posted', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }] : [],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/11/services', (route) => {
      serviceAdded = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 1, ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Lê Thị C');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('5');
    await page.locator('.add-service-form input[type="number"]').nth(1).fill('2');
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    await expect(page.locator('#upcomingConfirmedList')).toContainText('Cà phê ×2');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 60.000 đ');
  });

  test('the paid checkbox toggles the payment-method checkbox and is sent on submit', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 5, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê', priceType: 'fixed', priceMin: 30000, priceMax: null, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true }]) }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let posted = null;
    let serviceAdded = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 15, guestName: 'Ngô Thị F', phone: '0900000015', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          services: serviceAdded ? [{ id: 2, bookingId: 15, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: 'posted', paymentStatus: 'paid', paymentMethod: 'transfer', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }] : [],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/15/services', (route) => {
      posted = route.request().postDataJSON();
      serviceAdded = true;
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 2, ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Ngô Thị F');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('5');

    const paidCheckbox = page.locator('.add-service-form .checkbox-label', { hasText: 'Đã thanh toán' }).locator('input[type="checkbox"]');
    const methodLabel = page.locator('.add-service-form .checkbox-label', { hasText: 'Tiền mặt' });
    const methodCheckbox = methodLabel.locator('input[type="checkbox"]');

    await expect(methodLabel).toBeHidden();
    await paidCheckbox.check();
    await expect(methodLabel).toBeVisible();
    await expect(methodCheckbox).toBeChecked();
    await methodCheckbox.uncheck();

    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    expect(posted).toMatchObject({ serviceCatalogId: 5, paid: true, paymentMethod: 'transfer' });
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Đã thanh toán (Chuyển khoản)');
  });

  test('selecting a scheduled catalog item reveals the date/slot picker populated from live availability', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 9, category: 'fnb_hoat_dong', subgroup: null, name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000, priceMax: null, priceLabel: null, unitCapacity: '/ buổi', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 20, guestName: 'Trải Nghiệm A', phone: '0900000020', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/9/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 18, remaining: 12 }]),
    }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trải Nghiệm A');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('9');

    const dateInput = page.locator('.add-service-form input[type="date"]');
    await expect(dateInput).toBeVisible();
    await dateInput.fill('2099-03-15');

    const slotSelect = page.locator('.add-service-form select').nth(1);
    await expect(slotSelect).toContainText('19:00 — còn 12/30 chỗ');
  });

  test('shows alternative slots when a registration exceeds remaining capacity', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 9, category: 'fnb_hoat_dong', subgroup: null, name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000, priceMax: null, priceLabel: null, unitCapacity: '/ buổi', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 21, guestName: 'Trải Nghiệm B', phone: '0900000021', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/9/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 25, remaining: 5 }]),
    }));
    await page.route('**/api/bookings/21/services', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'Suất này chỉ còn 5 chỗ, không đủ cho 10 khách',
        alternatives: [{ date: '2099-03-16', slotTemplateId: 8, label: 'Suất tối', startTime: '19:00', remaining: 25 }],
      }),
    }));

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('9');
    await page.locator('.add-service-form input[type="date"]').fill('2099-03-15');
    await page.locator('.add-service-form select').nth(1).selectOption('7');
    await page.locator('.add-service-form input[type="number"]').nth(1).fill('10');
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    await expect(page.locator('.add-service-form')).toContainText('Suất này chỉ còn 5 chỗ');
    await expect(page.locator('.add-service-form')).toContainText('16/03 — 19:00 (còn 25 chỗ)');
  });

  test('requires terms acceptance for a scheduled item with configured terms before submit', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 10, category: 'fnb_hoat_dong', subgroup: null, name: 'Cắm trại qua đêm', priceType: 'fixed', priceMin: 300000, priceMax: null, priceLabel: null, unitCapacity: '/ đêm', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: 'Trẻ em dưới 12 tuổi cần người lớn đi kèm.' }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 22, guestName: 'Trải Nghiệm C', phone: '0900000022', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/10/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 12, label: 'Suất đêm', startTime: '18:00', capacity: 10, booked: 2, remaining: 8 }]),
    }));

    let posted = null;
    await page.route('**/api/bookings/22/services', (route) => {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 5, ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('10');
    await page.locator('.add-service-form input[type="date"]').fill('2099-03-15');
    await page.locator('.add-service-form select').nth(1).selectOption('12');

    await expect(page.locator('.add-service-form blockquote')).toContainText('Trẻ em dưới 12 tuổi cần người lớn đi kèm.');

    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();
    await expect(page.locator('.add-service-form')).toContainText('Vui lòng xác nhận đã thông báo điều khoản dịch vụ cho khách');
    expect(posted).toBeNull();

    await page.locator('.add-service-form .checkbox-label', { hasText: 'Đã giải thích' }).locator('input[type="checkbox"]').check();
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();

    expect(posted).toMatchObject({ serviceCatalogId: 10, experienceDate: '2099-03-15', slotTemplateId: 12, termsAccepted: true });
  });

  test('never shows the terms block for a scheduled item with no configured terms', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 9, category: 'fnb_hoat_dong', subgroup: null, name: 'Đốt lửa trại', priceType: 'fixed', priceMin: 500000, priceMax: null, priceLabel: null, unitCapacity: '/ buổi', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 23, guestName: 'Trải Nghiệm D', phone: '0900000023', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed', services: [] }]),
    }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/catalog/9/slot-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 7, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 0, remaining: 30 }]),
    }));
    await page.route('**/api/bookings/23/services', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 6, ok: true }) }));

    await page.goto('/admin/reception.html');
    await page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' }).click();
    await page.locator('.add-service-form select').first().selectOption('9');
    await page.locator('.add-service-form input[type="date"]').fill('2099-03-15');
    await page.locator('.add-service-form select').nth(1).selectOption('7');

    await expect(page.locator('.add-service-form blockquote')).toBeHidden();
    await page.locator('.add-service-form button', { hasText: 'Thêm' }).click();
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Trải Nghiệm D');
  });

  test('voiding a service line strikes it through and drops it from the total', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let voided = false;
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 12, guestName: 'Phạm Văn D', phone: '0900000012', roomType: 'circle', checkIn: '2099-03-01', checkOut: '2099-03-03', status: 'confirmed',
          services: [{ id: 7, bookingId: 12, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: voided ? 'voided' : 'posted', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: voided ? 'hienle' : null, voidedAt: voided ? '2026-08-28T01:00:00Z' : null }],
        }]),
      })
    );
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings/12/services/7', (route) => {
      voided = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 30.000 đ');
    await page.locator('#upcomingConfirmedList .service-line button', { hasText: 'Huỷ' }).click();

    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 0 đ');
  });

  test('a pending booking never shows the add-service control', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception', canManageRoomLayout: false }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=pending', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 13, guestName: 'Khách Chờ', phone: '0900000013', roomType: 'circle', checkIn: '2099-04-01', checkOut: '2099-04-03', status: 'pending', services: [] }]) })
    );
    await page.route('**/api/bookings?status=confirmed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=checked_in*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#pendingList')).toContainText('Khách Chờ');
    await expect(page.locator('#pendingList button', { hasText: '+ Thêm dịch vụ' })).toHaveCount(0);
  });

  test('observer sees the service list and total but no add/void controls', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat', role: 'observer' }) }));
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/bookings?status=confirmed*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{
          id: 14, guestName: 'Khách E', phone: '0900000014', roomType: 'circle', checkIn: '2099-05-01', checkOut: '2099-05-03', status: 'confirmed',
          services: [{ id: 9, bookingId: 14, name: 'Cà phê', unitPrice: 30000, quantity: 1, amount: 30000, status: 'posted', createdBy: 'hienle', createdAt: '2026-08-28T00:00:00Z', voidedBy: null, voidedAt: null }],
        }]),
      })
    );
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

    await page.goto('/admin/reception.html');
    await expect(page.locator('#upcomingConfirmedList')).toContainText('Tổng dịch vụ: 30.000 đ');
    await expect(page.locator('#upcomingConfirmedList button', { hasText: '+ Thêm dịch vụ' })).toHaveCount(0);
    await expect(page.locator('#upcomingConfirmedList button', { hasText: 'Huỷ' })).toHaveCount(0);
  });
});
