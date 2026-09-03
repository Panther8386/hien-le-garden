// tests/e2e/finance-dashboard.spec.js
const { test, expect } = require('@playwright/test');

function mockCommonRoutes(page, { role, summary, openingBalance, transactions }) {
  return Promise.all([
    page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'test_user', role }) })),
    page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summary) })),
    page.route('**/api/finance/opening-balance**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(openingBalance) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }),
    page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(transactions) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
  ]);
}

const DEFAULT_SUMMARY = { month: '2026-08', openingBalance: 1000000, openingBalanceSource: 'manual', totalIncome: 2000000, totalExpense: 500000, netChange: 1500000, closingBalance: 2500000 };
const DEFAULT_OPENING = { period: '2026-08', openingBalance: 1000000, setBy: 'quan_ly_a', setAt: '2026-08-01T00:00:00Z' };
const SAMPLE_TX = [
  { id: 1, type: 'income', category: 'ban_hang', amount: 2000000, note: 'Bán rau', transactionDate: '2026-08-10', status: 'paid', createdBy: 'quan_ly_a', createdAt: '2026-08-10T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
  { id: 2, type: 'expense', category: 'vat_tu', amount: 500000, note: 'Mua phân bón', transactionDate: '2026-08-12', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-12T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
];

test.describe('Finance dashboard (sổ thu chi)', () => {
  test('manager sees the add-transaction form and can see the balance stat cards', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#addTransactionSection')).toBeVisible();
    await expect(page.locator('#financeStats')).toContainText('2.500.000');
    await expect(page.locator('#financeStats')).toContainText('1.000.000');
  });

  test('observer does not see the add-transaction form or opening-balance editor', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'observer', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#addTransactionSection')).toBeHidden();
    await expect(page.locator('#openingBalanceEditor')).toBeEmpty();
  });

  test('observer sees only income: one "Tổng thu" stat card, no expense rows, no "Chi" filter option', async ({ page }) => {
    // Matches the real backend contract for this role exactly: GET /api/finance/summary
    // returns only {month, totalIncome} (every expense-derived field stripped server-side),
    // GET /api/finance/transactions never returns a type:'expense' row, and
    // GET /api/finance/opening-balance now 403s outright for observer.
    const observerSummary = { month: '2026-08', totalIncome: 2000000 };
    const incomeOnlyTx = SAMPLE_TX.filter((t) => t.type === 'income');
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat_a', role: 'observer' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(observerSummary) }));
    await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(incomeOnlyTx) }));

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStats')).toContainText('2.000.000');
    await expect(page.locator('#financeStats .stat-card')).toHaveCount(1);
    await expect(page.locator('#financeError')).toBeEmpty();
    await expect(page.locator('#financeTable tbody')).toContainText('Bán rau');
    await expect(page.locator('#financeTable tbody')).not.toContainText('Mua phân bón');
    await expect(page.locator('#filterType option[value="expense"]')).toHaveCount(0);
  });

  test('reception stays on the page but the API 403s hide all data and the write form', async ({ page }) => {
    // This codebase's established convention for a role-restricted admin page (confirmed in
    // admin/audit-log.js and admin/manager.js) is: no client-side role redirect — only a truly
    // unauthenticated visit (401 from /api/auth/me) redirects to /admin. An authenticated-but-
    // wrong-role visit stays on the page, and every API call 403s, surfaced as an error message
    // via the page's existing <p class="error"> elements. finance.html/js follows this exactly.
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance.html');
    await expect(page).toHaveURL(/\/admin\/finance/);
    await expect(page.locator('#addTransactionSection')).toBeHidden();
    await expect(page.locator('#openingBalanceEditor')).toBeEmpty();
    await expect(page.locator('#listError')).toContainText('Không đủ quyền');
    await expect(page.locator('#financeError')).toContainText('Không đủ quyền');
  });

  test('adding a transaction submits the correct payload and refreshes the list', async ({ page }) => {
    let posted = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions', (route) => {
      if (route.request().method() === 'POST') {
        posted = route.request().postDataJSON();
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX) });
    });

    await page.goto('/admin/finance.html');
    await page.selectOption('#financeForm select[name="type"]', 'expense');
    await page.selectOption('#financeForm select[name="category"]', 'nhan_cong');
    await page.fill('#financeForm input[name="amount"]', '300000');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-20');
    await page.fill('#financeForm input[name="note"]', 'Công tưới cây');
    await page.click('#financeForm button[type="submit"]');

    await expect.poll(() => posted).toMatchObject({ type: 'expense', category: 'nhan_cong', amount: 300000, transactionDate: '2026-08-20', note: 'Công tưới cây' });
  });

  test('rejects a non-positive amount client-side without submitting', async ({ page }) => {
    let posted = false;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions', (route) => {
      if (route.request().method() === 'POST') posted = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX) });
    });

    await page.goto('/admin/finance.html');
    await page.fill('#financeForm input[name="amount"]', '0');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-20');
    await page.click('#financeForm button[type="submit"]');

    await expect(page.locator('#financeFormError')).toContainText('số nguyên dương');
    expect(posted).toBe(false);
  });

  test('voiding a transaction strikes it through in the table', async ({ page }) => {
    // Made the transactions GET mock stateful on the void flag below, matching this repo's
    // established convention for a void-then-reload flow (see reception-ops-board.spec.js's
    // `let voided = false;` pattern). finance.js re-fetches the list via GET after a successful
    // void, exactly like a real backend would return updated data; a static mock array can't
    // reflect that, so without this the row never picks up its struck-through style.
    let voided = false;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    // Registered before the /1/void route below so the latter (more specific, registered
    // later) takes priority for that URL — Playwright checks routes last-registered-first.
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') {
        const list = voided
          ? SAMPLE_TX.map((t) => (t.id === 1 ? { ...t, voidedBy: 'test_user', voidedAt: '2026-08-20T00:00:00Z' } : t))
          : SAMPLE_TX;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    });
    await page.route('**/api/finance/transactions/1/void', (route) => {
      voided = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/finance.html');
    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button', { hasText: 'Huỷ' }).click();

    await expect(page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('td').first()).toHaveCSS('text-decoration-line', 'line-through');
  });

  test('filters re-fetch the transaction list with the selected query params', async ({ page }) => {
    let lastUrl = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') lastUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SAMPLE_TX) });
    });

    await page.goto('/admin/finance.html');
    await page.selectOption('#filterType', 'expense');

    await expect.poll(() => lastUrl).toContain('type=expense');
  });

  test('the chart granularity toggle switches the active button', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await page.click('#chartGranularity button[data-granularity="day"]');
    await expect(page.locator('#chartGranularity button[data-granularity="day"]')).toHaveClass(/active/);
    await expect(page.locator('#financeChart svg')).toBeVisible();
  });

  test('mobile viewport shows the card list instead of the table', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeTableWrap')).toBeHidden();
    await expect(page.locator('#financeCardList')).toBeVisible();
    await expect(page.locator('#financeCardList')).toContainText('Bán rau');
  });

  test('category dropdown re-filters when the type changes, dropping a now-invalid selection', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await page.selectOption('#financeForm select[name="type"]', 'expense');
    await expect(page.locator('#financeForm select[name="category"] option[value="thuc_pham"]')).toHaveCount(1);
    await expect(page.locator('#financeForm select[name="category"] option[value="ban_hang"]')).toHaveCount(0);

    await page.selectOption('#financeForm select[name="type"]', 'income');
    await expect(page.locator('#financeForm select[name="category"] option[value="ban_hang"]')).toHaveCount(1);
    await expect(page.locator('#financeForm select[name="category"] option[value="thuc_pham"]')).toHaveCount(0);
  });

  test('the default Thu/Chi toggle persists across a reload via localStorage', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await page.click('#defaultTypeToggle button[data-default-type="income"]');
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);

    await page.reload();
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);
    await expect(page.locator('#financeForm select[name="type"]')).toHaveValue('income');
  });

  test('uploading a receipt file shows the 📎 indicator after the transaction is created', async ({ page }) => {
    let uploadedFilename = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 3, ok: true }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...SAMPLE_TX, { id: 3, type: 'expense', category: 'vat_tu', amount: 100000, note: 'Có chứng từ', transactionDate: '2026-08-21', status: 'draft', createdBy: 'test_user', createdAt: '2026-08-21T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null, receiptKey: 'finance-receipts/3/x-bill.pdf', receiptFilename: 'bill.pdf', receiptUploadedAt: '2026-08-21T00:00:00Z' }]) });
    });
    await page.route('**/api/finance/transactions/3/attachment', (route) => {
      uploadedFilename = 'bill.pdf';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptFilename: 'bill.pdf' }) });
    });

    await page.goto('/admin/finance.html');
    await page.fill('#financeForm input[name="amount"]', '100000');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-21');
    await page.fill('#financeForm input[name="note"]', 'Có chứng từ');
    await page.setInputFiles('#financeForm input[name="receipt"]', { name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await page.click('#financeForm button[type="submit"]');

    await expect.poll(() => uploadedFilename).toBe('bill.pdf');
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Có chứng từ' })).toContainText('📎');
  });
});
