// tests/e2e/admin-catalog.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Admin service catalog', () => {
  const catalogItems = [
    { id: 1, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Triangle House', priceType: 'fixed', priceMin: 300000, priceMax: null, priceLabel: null, unitCapacity: '2–3 người', note: '', roomTypeKey: 'triangle', displayOrder: 1, isActive: true },
    { id: 2, category: 'fnb_hoat_dong', subgroup: null, name: 'Cà phê', priceType: 'range', priceMin: 30000, priceMax: 80000, priceLabel: null, unitCapacity: '/ phần', note: '', roomTypeKey: null, displayOrder: 1, isActive: true },
  ];

  test('admin sees edit/delete controls and can add a service', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));

    let created = false;
    await page.route('**/api/catalog*', (route) => {
      if (route.request().method() === 'POST') {
        created = true;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      const items = created ? [...catalogItems, { id: 3, category: 'luu_tru', subgroup: 'Lưu Trú Theo Đêm', name: 'Trà đá', priceType: 'fixed', priceMin: 20000, priceMax: null, priceLabel: null, unitCapacity: '', note: '', roomTypeKey: null, displayOrder: 2, isActive: true }] : catalogItems;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    });

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#catalogTable tbody')).toContainText('Triangle House');
    await expect(page.locator('#addServiceBtn')).toBeVisible();
    await expect(page.locator('#catalogTable tbody tr button', { hasText: 'Sửa' }).first()).toBeVisible();

    await page.click('#addServiceBtn');
    await page.fill('input[name="name"]', 'Trà đá');
    await page.fill('input[name="priceMin"]', '20000');
    // Giá B left empty -> implied fixed price, per the plan's A/B inference rule.
    await page.click('#catalogSubmitBtn');

    await expect(page.locator('#catalogTable tbody')).toContainText('Trà đá');
  });

  test('filling both Giá A and Giá B (B > A) submits a range price', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));
    await page.route('**/api/catalog*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogItems) }));

    let posted = null;
    await page.route('**/api/catalog', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogItems) });
    });

    await page.goto('/admin/catalog.html');
    await page.click('#addServiceBtn');
    await page.fill('input[name="name"]', 'Đốt lửa trại');
    await page.fill('input[name="priceMin"]', '500000');
    await page.fill('input[name="priceMax"]', '1000000');
    await page.click('#catalogSubmitBtn');

    expect(posted).toMatchObject({ priceType: 'range', priceMin: 500000, priceMax: 1000000 });
  });

  test('a Giá B not greater than Giá A shows a validation error instead of submitting', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'Vinhdx', role: 'admin' }) }));
    await page.route('**/api/catalog*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogItems) }));

    await page.goto('/admin/catalog.html');
    await page.click('#addServiceBtn');
    await page.fill('input[name="name"]', 'Giá sai');
    await page.fill('input[name="priceMin"]', '100000');
    await page.fill('input[name="priceMax"]', '100000');
    await page.click('#catalogSubmitBtn');

    await expect(page.locator('#formError')).toContainText('Giá B phải lớn hơn Giá A');
    await expect(page.locator('#catalogForm')).toBeVisible();
  });

  test('a non-admin role sees the data read-only', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'hienle', role: 'reception' }) }));
    await page.route('**/api/catalog*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogItems) }));

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#catalogTable tbody')).toContainText('Triangle House');
    await expect(page.locator('#addServiceBtn')).toBeHidden();
    await expect(page.locator('#catalogTable tbody tr button', { hasText: 'Sửa' })).toHaveCount(0);
  });

  test('redirects to login when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/catalog.html');
    await page.waitForURL('**/admin/');
  });
});
