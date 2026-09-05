// tests/e2e/dine-in-orders.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role }) }));
}

const MENU_ITEMS = [
  { id: 1, name: 'Mì Quảng', category: 'mon_an', price: 45000, displayOrder: 1, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z' },
  { id: 2, name: 'Cà phê đen', category: 'do_uong', price: 25000, displayOrder: 1, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z' },
];

function baseOrder(overrides) {
  return {
    id: 42, tableLabel: 'Bàn 3', note: null, status: 'open',
    openedBy: 'le_tan_a', openedAt: '2026-09-04T08:00:00Z',
    closedBy: null, closedAt: null, paymentMethod: null, totalAmount: null,
    items: [],
    ...overrides,
  };
}

test.describe('Dine-in order detail page', () => {
  test('adding items updates the total, voiding a line removes it from the total', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));

    let order = baseOrder();
    let nextItemId = 1;
    await page.route('**/api/dine-in-orders/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) });
    });
    await page.route('**/api/dine-in-orders/42/items', (route) => {
      const body = route.request().postDataJSON();
      const menuItem = MENU_ITEMS.find((m) => m.id === body.menuItemId);
      const item = { id: nextItemId++, menuItemId: menuItem.id, name: menuItem.name, unitPrice: menuItem.price, quantity: body.quantity, amount: menuItem.price * body.quantity, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null };
      order = { ...order, items: [...order.items, item] };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: item.id, ok: true }) });
    });
    await page.route('**/api/dine-in-orders/42/items/*', (route) => {
      const itemId = Number(route.request().url().split('/').pop());
      order = { ...order, items: order.items.map((i) => (i.id === itemId ? { ...i, status: 'voided' } : i)) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await expect(page.locator('#pageTitle')).toContainText('Bàn 3');

    await page.selectOption('select[name="menuItemId"]', '1');
    await page.fill('input[name="quantity"]', '2');
    await page.click('#addItemForm button[type="submit"]');
    await expect(page.locator('#orderTotal')).toContainText('90.000');

    await page.selectOption('select[name="menuItemId"]', '2');
    await page.fill('input[name="quantity"]', '1');
    await page.click('#addItemForm button[type="submit"]');
    await expect(page.locator('#orderTotal')).toContainText('115.000');

    await page.click('#itemsList button:has-text("Huỷ dòng")');
    await expect(page.locator('#orderTotal')).toContainText('25.000');
  });

  test('close button stays disabled until a payment method is chosen', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    const order = baseOrder({ items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/dine-in-orders/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) }));

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await expect(page.locator('#closeBtn')).toBeDisabled();
    await page.check('input[name="paymentMethod"][value="cash"]');
    await expect(page.locator('#closeBtn')).toBeEnabled();
  });

  test('closing the order posts the chosen payment method and shows the print button', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    let order = baseOrder({ items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    let closedBody = null;
    await page.route('**/api/dine-in-orders/42', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) });
    });
    await page.route('**/api/dine-in-orders/42/close', (route) => {
      closedBody = route.request().postDataJSON();
      order = { ...order, status: 'closed', paymentMethod: closedBody.paymentMethod, closedAt: '2026-09-04T09:00:00Z', totalAmount: 45000 };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, totalAmount: 45000, financeTransactionId: 7 }) });
    });

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await page.check('input[name="paymentMethod"][value="cash"]');
    await page.click('#closeBtn');

    await expect.poll(() => closedBody).toMatchObject({ paymentMethod: 'cash' });
    await expect(page.locator('#printBtn')).toBeVisible();
  });

  test('observer sees no action controls', async ({ page }) => {
    await mockAuth(page, 'observer');
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MENU_ITEMS) }));
    const order = baseOrder({ items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }] });
    await page.route('**/api/dine-in-orders/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) }));

    await page.goto('/admin/dine-in-order-detail.html?orderId=42');
    await expect(page.locator('#addItemForm')).toBeHidden();
    await expect(page.locator('#closeSection')).toBeHidden();
  });

  test('admin sees the "Hiển thị các log đã ẩn" checkbox on the board', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/dine-in-orders?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/dine-in-orders.html');
    await expect(page.locator('#showHiddenOrdersWrap')).toBeVisible();
  });

  test('non-admin roles do not see the "Hiển thị các log đã ẩn" checkbox', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/dine-in-orders?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/dine-in-orders.html');
    await expect(page.locator('#showHiddenOrdersWrap')).toBeHidden();
  });

  test('ticking the checkbox re-fetches order history with includeHidden=1', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/dine-in-orders?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=closed*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/dine-in-orders.html');
    const includeHiddenRequest = page.waitForRequest((req) => req.url().includes('status=closed') && req.url().includes('includeHidden=1'));
    await page.locator('#showHiddenOrders').check();
    await includeHiddenRequest;
  });

  test('clicking "Ẩn" on a closed order in history calls the hide endpoint', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/dine-in-orders?status=open', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**/api/dine-in-orders?status=closed*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 9, tableLabel: 'Bàn 2', status: 'closed', openedAt: '2026-09-01T08:00:00Z', currentTotal: 45000, isHidden: false }]) })
    );
    await page.route('**/api/dine-in-orders?status=voided*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let hideBody = null;
    await page.route('**/api/dine-in-orders/9/hide', (route) => {
      hideBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-orders.html');
    await page.locator('#orderHistoryGrid .dine-order-card', { hasText: 'Bàn 2' }).locator('button', { hasText: 'Ẩn' }).click();

    await expect.poll(() => hideBody).toMatchObject({ hidden: true });
  });
});

test.describe('Dine-in order invoice print page', () => {
  test('renders items and total, print button calls window.print()', async ({ page }) => {
    await mockAuth(page, 'reception');
    const order = baseOrder({
      status: 'closed', paymentMethod: 'cash', closedAt: '2026-09-04T09:00:00Z', totalAmount: 45000,
      items: [{ id: 1, menuItemId: 1, name: 'Mì Quảng', unitPrice: 45000, quantity: 1, amount: 45000, status: 'posted', createdBy: 'le_tan_a', createdAt: '2026-09-04T08:05:00Z', voidedBy: null, voidedAt: null }],
    });
    await page.route('**/api/dine-in-orders/42', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(order) }));

    await page.goto('/admin/dine-in-order-print.html?orderId=42');
    await expect(page.locator('#formPrint')).toContainText('Mì Quảng');
    await expect(page.locator('#formPrint')).toContainText('45.000');
    await expect(page.locator('#formPrint')).toContainText('Bàn 3');

    await page.evaluate(() => { window.__printCalled = false; window.print = () => { window.__printCalled = true; }; });
    await page.click('#printBtn');
    const called = await page.evaluate(() => window.__printCalled);
    expect(called).toBe(true);
  });
});
