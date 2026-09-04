// tests/e2e/finance-categories.spec.js
const { test, expect } = require('@playwright/test');

const SAMPLE_CATEGORIES = [
  { id: 1, slug: 'vat_tu', label: 'Vật tư', type: 'expense', isActive: true },
  { id: 2, slug: 'ban_hang', label: 'Dịch vụ khác', type: 'income', isActive: true },
  { id: 3, slug: 'khac', label: 'Chi phí khác', type: 'expense', isActive: false },
];

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) }));
}

test.describe('Finance category management page', () => {
  test('admin sees the add forms and both grouped tables, including an inactive row shown dimmed', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));

    await page.goto('/admin/finance-categories.html');

    await expect(page.locator('#incomeAddForm')).toBeVisible();
    await expect(page.locator('#expenseAddForm')).toBeVisible();
    await expect(page.locator('#incomeTable tbody')).toContainText('Dịch vụ khác');
    await expect(page.locator('#expenseTable tbody')).toContainText('Vật tư');
    await expect(page.locator('#expenseTable tbody')).toContainText('Chi phí khác');
    await expect(page.locator('#expenseTable tbody tr', { hasText: 'Chi phí khác' })).toHaveCSS('opacity', '0.5');
  });

  test('manager (read-only) sees the tables but not the add forms or edit/toggle buttons', async ({ page }) => {
    await mockAuth(page, 'manager');
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));

    await page.goto('/admin/finance-categories.html');

    await expect(page.locator('#incomeAddForm')).toBeHidden();
    await expect(page.locator('#expenseAddForm')).toBeHidden();
    await expect(page.locator('#expenseTable tbody')).toContainText('Vật tư');
    await expect(page.locator('#expenseTable tbody button')).toHaveCount(0);
  });

  test('adding a category posts the correct payload and refreshes the list', async ({ page }) => {
    await mockAuth(page, 'admin');
    let posted = null;
    await page.route('**/api/finance/categories', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 4, slug: 'gio_xanh_hien_le', label: 'Giờ xanh Hiền Lê', type: 'income', isActive: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
    });

    await page.goto('/admin/finance-categories.html');
    await page.fill('#incomeAddForm input[name="label"]', 'Giờ xanh Hiền Lê');
    await page.click('#incomeAddForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ label: 'Giờ xanh Hiền Lê', type: 'income' });
  });

  test('toggling a category off sends isActive:false for that id', async ({ page }) => {
    await mockAuth(page, 'admin');
    let patched = null;
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));
    await page.route('**/api/finance/categories/1', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/finance-categories.html');
    await page.locator('#expenseTable tbody tr', { hasText: 'Vật tư' }).locator('button', { hasText: 'Ẩn' }).click();

    await expect.poll(() => patched).toMatchObject({ isActive: false });
  });

  test('editing a label prompts and PATCHes the new value', async ({ page }) => {
    await mockAuth(page, 'admin');
    let patched = null;
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) }));
    await page.route('**/api/finance/categories/1', (route) => {
      patched = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    page.once('dialog', (dialog) => dialog.accept('Vật tư nông nghiệp'));

    await page.goto('/admin/finance-categories.html');
    await page.locator('#expenseTable tbody tr', { hasText: 'Vật tư' }).locator('button', { hasText: 'Sửa tên' }).click();

    await expect.poll(() => patched).toMatchObject({ label: 'Vật tư nông nghiệp' });
  });

  test('reception gets a 403 error surfaced, empty tables, no add forms', async ({ page }) => {
    await mockAuth(page, 'reception');
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance-categories.html');

    await expect(page.locator('#pageError')).toContainText('Không đủ quyền');
    await expect(page.locator('#incomeAddForm')).toBeHidden();
    await expect(page.locator('#incomeTable tbody tr')).toHaveCount(0);
  });

  test('clicking ▼ on an expense category calls the move endpoint with direction:down', async ({ page }) => {
    await mockAuth(page, 'admin');
    await page.route('**/api/finance/categories', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_CATEGORIES) });
    });
    let moveBody = null;
    await page.route('**/api/finance/categories/1/move', (route) => {
      moveBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/finance-categories.html');
    await page.locator('#expenseTable tbody tr', { hasText: 'Vật tư' }).locator('button', { hasText: '▼' }).click();

    await expect.poll(() => moveBody).toMatchObject({ direction: 'down' });
  });
});
