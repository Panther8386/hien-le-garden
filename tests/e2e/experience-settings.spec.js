// tests/e2e/experience-settings.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Experience-settings config on catalog.html', () => {
  test('an admin can view and save the suggestion-window settings', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/catalog?all=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    let saved = null;
    await page.route('**/api/experience-booking-settings', (route) => {
      if (route.request().method() === 'PATCH') {
        saved = route.request().postDataJSON();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suggestionWindowDays: 14, maxSuggestions: 5, updatedAt: '2026-08-29T00:00:00Z' }) });
    });

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#experienceSettingsSection')).toBeVisible();
    await expect(page.locator('input[name="suggestionWindowDays"]')).toHaveValue('14');
    await expect(page.locator('input[name="maxSuggestions"]')).toHaveValue('5');

    await page.fill('input[name="suggestionWindowDays"]', '10');
    await page.fill('input[name="maxSuggestions"]', '3');
    await page.click('#experienceSettingsForm button[type="submit"]');

    await expect.poll(() => saved).toEqual({ suggestionWindowDays: 10, maxSuggestions: 3 });
  });

  test('a reception account never sees the experience-settings section', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/catalog?all=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

    await page.goto('/admin/catalog.html');
    await expect(page.locator('#experienceSettingsSection')).toBeHidden();
  });
});

// Ruling recorded during Task 4's review (see the SDD ledger): the plan as originally
// written never covered catalog.html's slot-template CRUD UI (add/edit/deactivate-toggle).
// This describe block closes that gap. It lives in this same file since both cover
// admin-only catalog.html behavior, and Step 4 below already runs this whole file.
test.describe('Slot-template CRUD on catalog.html', () => {
  test('admin can add, edit, and deactivate a slot template', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role: 'admin' }) }));
    await page.route('**/api/experience-booking-settings', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suggestionWindowDays: 14, maxSuggestions: 5, updatedAt: '2026-08-29T00:00:00Z' }) }));
    await page.route('**/api/catalog?all=1', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 15, category: 'luu_tru', subgroup: null, name: 'Chèo thuyền kayak', priceType: 'fixed', priceMin: 200000, priceMax: null, priceLabel: null, unitCapacity: '/ suất', note: '', roomTypeKey: null, displayOrder: 1, isActive: true, isScheduled: true, termsAndConditions: null }]),
    }));

    const templates = [];
    let nextId = 100;
    await page.route('**/api/catalog/15/slot-templates', (route) => {
      const request = route.request();
      if (request.method() === 'POST') {
        const body = request.postDataJSON();
        const created = { id: nextId++, label: body.label, daysOfWeek: body.daysOfWeek.join(','), startTime: body.startTime, capacity: body.capacity, isActive: true };
        templates.push(created);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(templates) });
    });
    await page.route('**/api/catalog/15/slot-templates/*', (route) => {
      const id = Number(route.request().url().split('/').pop());
      const body = route.request().postDataJSON();
      const template = templates.find((t) => t.id === id);
      if (body.daysOfWeek !== undefined) template.daysOfWeek = body.daysOfWeek.join(',');
      if (body.label !== undefined) template.label = body.label;
      if (body.startTime !== undefined) template.startTime = body.startTime;
      if (body.capacity !== undefined) template.capacity = body.capacity;
      if (body.isActive !== undefined) template.isActive = body.isActive;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(template) });
    });

    await page.goto('/admin/catalog.html');
    await page.locator('#catalogTable button', { hasText: 'Sửa' }).click();
    await expect(page.locator('#slotTemplatesSection')).toBeVisible();
    await expect(page.locator('#slotTemplatesTable tbody tr')).toHaveCount(0);

    // Add a slot template
    await page.fill('#slotTemplateForm input[name="label"]', 'Suất sáng');
    await page.locator('#slotTemplateForm input[name="dow"][value="6"]').check();
    await page.fill('#slotTemplateForm input[name="startTime"]', '08:00');
    await page.fill('#slotTemplateForm input[name="capacity"]', '12');
    await page.click('#slotTemplateSubmitBtn');

    await expect(page.locator('#slotTemplatesTable tbody tr')).toHaveCount(1);
    const row = page.locator('#slotTemplatesTable tbody tr').first();
    await expect(row).toContainText('Suất sáng');
    await expect(row).toContainText('12');
    await expect(row).toContainText('Đang áp dụng');

    // Edit it
    await row.locator('button', { hasText: 'Sửa' }).click();
    await expect(page.locator('#slotTemplateForm input[name="capacity"]')).toHaveValue('12');
    await page.fill('#slotTemplateForm input[name="capacity"]', '20');
    await page.click('#slotTemplateSubmitBtn');
    await expect(row).toContainText('20');

    // Deactivate it
    await row.locator('button', { hasText: 'Tắt' }).click();
    await expect(row).toContainText('Đã tắt');
    await expect(row.locator('button', { hasText: 'Bật lại' })).toBeVisible();
  });
});
