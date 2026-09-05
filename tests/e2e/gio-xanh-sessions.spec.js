// tests/e2e/gio-xanh-sessions.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role }) }));
}

const CATALOG_ITEMS = [
  { id: 22, category: 'luu_tru', subgroup: 'Giờ Xanh Hiền Lê', name: 'Giờ Đầu Tiên', priceType: 'fixed', priceMin: 130000, priceMax: null, priceLabel: null, unitCapacity: '1 giờ', note: null, roomTypeKey: null, displayOrder: 7, isActive: true, isScheduled: false, termsAndConditions: null },
];

const MENU_ITEMS = [
  { id: 1, name: 'Cà phê đen', category: 'do_uong', price: 25000, displayOrder: 1, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z' },
];

function baseSession(overrides) {
  return {
    id: 42, roomId: 3, roomName: 'Circle House 1', guestName: 'Nguyễn Văn A', phone: '0900000001', status: 'open',
    openedBy: 'le_tan_a', openedAt: '2026-09-04T08:00:00Z',
    closedBy: null, closedAt: null, paymentMethod: null, totalAmount: null,
    items: [],
    ...overrides,
  };
}

test.describe('Gio-xanh session detail page', () => {
  test('adding a combo giờ line and a món ăn line updates the total together', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));

    let session = baseSession();
    let nextItemId = 1;
    await page.route('**/api/gio-xanh-sessions/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    });
    await page.route('**/api/gio-xanh-sessions/42/items', (route) => {
      const body = route.request().postDataJSON();
      const isCombo = body.source === 'gio_combo';
      const src = isCombo ? CATALOG_ITEMS.find((c) => c.id === body.sourceId) : MENU_ITEMS.find((m) => m.id === body.sourceId);
      const unitPrice = isCombo ? src.priceMin : src.price;
      const item = { id: nextItemId++, source: body.source, sourceId: body.sourceId, name: src.name, unitPrice, quantity: body.quantity, amount: unitPrice * body.quantity, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null };
      session = { ...session, items: [...session.items, item] };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: item.id, ok: true }) });
    });

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#pageTitle')).toContainText('Circle House 1');
    await expect(page.locator('#pageTitle')).toContainText('Nguyễn Văn A');

    await page.selectOption('select[name="comboId"]', '22');
    await page.fill('#addComboForm input[name="quantity"]', '1');
    await page.click('#addComboForm button[type="submit"]');
    await expect(page.locator('#sessionTotal')).toContainText('130.000');

    await page.selectOption('select[name="menuItemId"]', '1');
    await page.fill('#addMenuItemForm input[name="quantity"]', '1');
    await page.click('#addMenuItemForm button[type="submit"]');
    await expect(page.locator('#sessionTotal')).toContainText('155.000');
  });

  test('voiding a line item removes it from the total', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));

    let session = baseSession({
      items: [
        { id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null },
        { id: 2, source: 'mon_an_uong', sourceId: 1, name: 'Cà phê đen', unitPrice: 25000, quantity: 1, amount: 25000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:06:00Z', voidedBy: null, voidedAt: null },
      ],
    });
    await page.route('**/api/gio-xanh-sessions/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    });
    await page.route('**/api/gio-xanh-sessions/42/items/*', (route) => {
      const itemId = Number(route.request().url().split('/').pop());
      session = { ...session, items: session.items.map((i) => (i.id === itemId ? { ...i, status: 'voided' } : i)) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#sessionTotal')).toContainText('155.000');

    await page.locator('#itemsList button:has-text("Huỷ dòng")').first().click();
    await expect(page.locator('#sessionTotal')).toContainText('25.000');
  });

  test('close button stays disabled until a payment method is chosen', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    const session = baseSession({ items: [{ id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/gio-xanh-sessions/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#closeBtn')).toBeDisabled();
    await page.check('input[name="paymentMethod"][value="cash"]');
    await expect(page.locator('#closeBtn')).toBeEnabled();
  });

  test('closing the session posts the chosen payment method and shows the print button', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG_ITEMS) }));
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    let session = baseSession({ items: [{ id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    let closedBody = null;
    await page.route('**/api/gio-xanh-sessions/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    });
    await page.route('**/api/gio-xanh-sessions/42/close', (route) => {
      closedBody = route.request().postDataJSON();
      session = { ...session, status: 'closed', paymentMethod: closedBody.paymentMethod, closedAt: '2026-09-04T09:00:00Z', totalAmount: 130000 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, totalAmount: 130000, financeTransactionId: 9 }) });
    });

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await page.check('input[name="paymentMethod"][value="transfer"]');
    await page.click('#closeBtn');

    await expect.poll(() => closedBody).toMatchObject({ paymentMethod: 'transfer' });
    await expect(page.locator('#printBtn')).toBeVisible();
  });

  test('observer sees no action controls', async ({ page }) => {
    await mockAuth(page, 'observer');
    const session = baseSession({ items: [{ id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/gio-xanh-sessions/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto('/admin/gio-xanh-detail.html?sessionId=42');
    await expect(page.locator('#addComboForm')).toBeHidden();
    await expect(page.locator('#addMenuItemForm')).toBeHidden();
    await expect(page.locator('#closeSection')).toBeHidden();
  });

  test('admin sees the "Hiển thị các log đã ẩn" checkbox on the board', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/gio-xanh-sessions?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/gio-xanh.html');
    await expect(page.locator('#showHiddenSessionsWrap')).toBeVisible();
  });

  test('non-admin roles do not see the "Hiển thị các log đã ẩn" checkbox', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/gio-xanh-sessions?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/gio-xanh.html');
    await expect(page.locator('#showHiddenSessionsWrap')).toBeHidden();
  });

  test('ticking the checkbox re-fetches session history with includeHidden=1', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/gio-xanh-sessions?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/gio-xanh.html');
    const includeHiddenRequest = page.waitForRequest((req) => req.url().includes('status=closed') && req.url().includes('includeHidden=1'));
    await page.locator('#showHiddenSessions').check();
    await includeHiddenRequest;
  });

  test('clicking "Ẩn" on a closed session in history calls the hide endpoint', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/gio-xanh-sessions?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/gio-xanh-sessions?status=closed*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, roomName: 'Circle House 1', guestName: 'Khách Cũ', status: 'closed', openedAt: '2026-09-01T08:00:00Z', currentTotal: 130000, isHidden: false }]) })
    );
    await page.route('**/api/gio-xanh-sessions?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/rooms', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let hideBody = null;
    await page.route('**/api/gio-xanh-sessions/9/hide', (route) => {
      hideBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/gio-xanh.html');
    await page.locator('#sessionHistoryGrid .gio-xanh-card', { hasText: 'Khách Cũ' }).locator('button', { hasText: 'Ẩn' }).click();

    await expect.poll(() => hideBody).toMatchObject({ hidden: true });
  });
});

test.describe('Gio-xanh invoice print page', () => {
  test('renders both combo giờ and món ăn lines and total, print button calls window.print()', async ({ page }) => {
    await mockAuth(page, 'reception');
    const session = baseSession({
      status: 'closed', paymentMethod: 'cash', closedAt: '2026-09-04T09:00:00Z', totalAmount: 155000,
      items: [
        { id: 1, source: 'gio_combo', sourceId: 22, name: 'Giờ Đầu Tiên', unitPrice: 130000, quantity: 1, amount: 130000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null },
        { id: 2, source: 'mon_an_uong', sourceId: 1, name: 'Cà phê đen', unitPrice: 25000, quantity: 1, amount: 25000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:06:00Z', voidedBy: null, voidedAt: null },
      ],
    });
    await page.route('**/api/gio-xanh-sessions/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto('/admin/gio-xanh-print.html?sessionId=42');
    await expect(page.locator('#formPrint')).toContainText('Giờ Đầu Tiên');
    await expect(page.locator('#formPrint')).toContainText('Cà phê đen');
    await expect(page.locator('#formPrint')).toContainText('155.000');
    await expect(page.locator('#formPrint')).toContainText('Nguyễn Văn A');

    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printBtn');
    const called = await page.evaluate(() => window.__printCalled);
    expect(called).toBe(true);
  });
});
