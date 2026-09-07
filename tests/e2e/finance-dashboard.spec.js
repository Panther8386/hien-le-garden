// tests/e2e/finance-dashboard.spec.js
const { test, expect } = require('@playwright/test');

function toEnvelope(transactions, overrides = {}) {
  const sumIncome = transactions.filter((t) => t.type === 'income' && !t.voidedAt).reduce((s, t) => s + t.amount, 0);
  const sumExpense = transactions.filter((t) => t.type === 'expense' && !t.voidedAt).reduce((s, t) => s + t.amount, 0);
  const categoryTotals = {};
  transactions.forEach((t) => {
    if (!categoryTotals[t.category]) categoryTotals[t.category] = { income: 0, expense: 0 };
    categoryTotals[t.category][t.type] += t.amount;
  });
  const chartRows = transactions.map((t) => ({ transactionDate: t.transactionDate, type: t.type, amount: t.amount, status: t.status, voidedAt: t.voidedAt }));
  return { transactions, total: transactions.length, page: 1, pageSize: 25, sumIncome, sumExpense, categoryTotals, chartRows, ...overrides };
}

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
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(transactions)) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    }),
    page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CATEGORIES) })),
  ]);
}

const DEFAULT_SUMMARY = { month: '2026-08', openingBalance: 1000000, openingBalanceSource: 'manual', totalIncome: 2000000, totalExpense: 500000, netChange: 1500000, closingBalance: 2500000 };
const DEFAULT_OPENING = { period: '2026-08', openingBalance: 1000000, setBy: 'quan_ly_a', setAt: '2026-08-01T00:00:00Z' };
const SAMPLE_TX = [
  { id: 1, type: 'income', category: 'ban_hang', amount: 2000000, note: 'Bán rau', transactionDate: '2026-08-10', status: 'paid', createdBy: 'quan_ly_a', createdAt: '2026-08-10T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
  { id: 2, type: 'expense', category: 'vat_tu', amount: 500000, note: 'Mua phân bón', transactionDate: '2026-08-12', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-12T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null },
];
const DEFAULT_CATEGORIES = [
  { id: 1, slug: 'cay_giong', label: 'Cây giống', type: 'expense', isActive: true },
  { id: 2, slug: 'vat_tu', label: 'Vật tư', type: 'expense', isActive: true },
  { id: 3, slug: 'nhan_cong', label: 'Nhân công', type: 'expense', isActive: true },
  { id: 4, slug: 'van_chuyen', label: 'Vận chuyển', type: 'expense', isActive: true },
  { id: 5, slug: 'bao_tri', label: 'Bảo trì', type: 'expense', isActive: true },
  { id: 6, slug: 'thuc_pham', label: 'Thực phẩm', type: 'expense', isActive: true },
  { id: 7, slug: 'am_thuc_lien_ket', label: 'Ẩm thực liên kết', type: 'expense', isActive: true },
  { id: 8, slug: 'khac', label: 'Chi phí khác', type: 'expense', isActive: true },
  { id: 9, slug: 'ban_hang', label: 'Dịch vụ khác', type: 'income', isActive: true },
  { id: 10, slug: 'dich_vu', label: 'Lưu trú Hiền Lê', type: 'income', isActive: true },
  { id: 11, slug: 'bep_hien_le', label: 'Bếp Hiền Lê', type: 'income', isActive: true },
  { id: 12, slug: 'hien_le_drinks', label: 'Hiền Lê Drinks', type: 'income', isActive: true },
  { id: 13, slug: 'hh_am_thuc_lien_ket', label: 'HH Ẩm thực liên kết', type: 'income', isActive: true },
  { id: 14, slug: 'gio_xanh_hien_le', label: 'Giờ xanh Hiền Lê', type: 'income', isActive: true },
];

test.describe('Finance dashboard (sổ thu chi)', () => {
  test('manager sees the add-transaction trigger and can see the balance stat cards', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#openAddTransactionBtn')).toBeVisible();
    await expect(page.locator('#financeStats')).toContainText('2.500.000');
    await expect(page.locator('#financeStats')).toContainText('1.000.000');
  });

  test('reception stays on the page but the API 403s hide all data and the write form', async ({ page }) => {
    // This codebase's established convention for a role-restricted admin page: no
    // client-side role redirect — only a truly unauthenticated visit (401 from
    // /api/auth/me) redirects to /admin. An authenticated-but-wrong-role visit stays
    // on the page, and every API call 403s, surfaced via the page's <p class="error">
    // elements. finance.html/js follows this exactly.
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));

    await page.goto('/admin/finance.html');
    await expect(page).toHaveURL(/\/admin\/finance/);
    await expect(page.locator('#openAddTransactionBtn')).toBeHidden();
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
    });

    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
    });

    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');
    await page.fill('#financeForm input[name="amount"]', '0');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-20');
    await page.click('#financeForm button[type="submit"]');

    await expect(page.locator('#financeFormError')).toContainText('số nguyên dương');
    expect(posted).toBe(false);
  });

  test('voiding a transaction requires confirmation and strikes it through in the table', async ({ page }) => {
    // Made the transactions GET mock stateful on the void flag below, matching this repo's
    // established convention for a void-then-reload flow. finance.js re-fetches the list
    // via GET after a successful void, exactly like a real backend would — a static mock
    // array can't reflect that, so without this the row never picks up its struck-through
    // style.
    let voided = false;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    // Registered before the /1/void route below so the latter (more specific, registered
    // later) takes priority for that URL — Playwright checks routes last-registered-first.
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') {
        const list = voided
          ? SAMPLE_TX.map((t) => (t.id === 1 ? { ...t, voidedBy: 'test_user', voidedAt: '2026-08-20T00:00:00Z' } : t))
          : SAMPLE_TX;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(list)) });
      }
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    });
    await page.route('**/api/finance/transactions/1/void', (route) => {
      voided = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/finance.html');
    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button[title="Huỷ"]').click();
    await expect(page.locator('#financeVoidOverlay')).toBeVisible();

    await page.click('#financeVoidCancelBtn');
    await expect(page.locator('#financeVoidOverlay')).toBeHidden();
    expect(voided).toBe(false);

    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button[title="Huỷ"]').click();
    await page.click('#financeVoidConfirmBtn');
    await expect.poll(() => voided).toBe(true);
    await expect(page.locator('#financeVoidOverlay')).toBeHidden();
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('td').first()).toHaveCSS('text-decoration-line', 'line-through');
  });

  test('filters re-fetch the transaction list with the selected query params', async ({ page }) => {
    let lastUrl = null;
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') lastUrl = route.request().url();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
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
    await page.click('#openAddTransactionBtn');

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
    await page.click('#openAddTransactionBtn');

    await page.click('#defaultTypeToggle button[data-default-type="income"]');
    await expect(page.locator('#defaultTypeToggle button[data-default-type="income"]')).toHaveClass(/active/);

    await page.reload();
    await page.click('#openAddTransactionBtn');
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
      const withReceipt = [...SAMPLE_TX, { id: 3, type: 'expense', category: 'vat_tu', amount: 100000, note: 'Có chứng từ', transactionDate: '2026-08-21', status: 'draft', createdBy: 'test_user', createdAt: '2026-08-21T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: null, voidedAt: null, receiptKey: 'finance-receipts/3/x-bill.pdf', receiptFilename: 'bill.pdf', receiptUploadedAt: '2026-08-21T00:00:00Z' }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(withReceipt)) });
    });
    await page.route('**/api/finance/transactions/3/attachment', (route) => {
      uploadedFilename = 'bill.pdf';
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptFilename: 'bill.pdf' }) });
    });

    await page.goto('/admin/finance.html');
    await page.click('#openAddTransactionBtn');
    await page.fill('#financeForm input[name="amount"]', '100000');
    await page.fill('#financeForm input[name="transactionDate"]', '2026-08-21');
    await page.fill('#financeForm input[name="note"]', 'Có chứng từ');
    await page.setInputFiles('#financeForm input[name="receipt"]', { name: 'bill.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') });
    await page.click('#financeForm button[type="submit"]');

    await expect.poll(() => uploadedFilename).toBe('bill.pdf');
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Có chứng từ' })).toContainText('📎');
  });

  test('manager sees the storage warning banner when receipt usage is over 9GB', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.route('**/api/finance/receipts-usage', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ totalBytes: 9800000000, thresholdBytes: 9663676416, overThreshold: true }) }));

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStorageWarning')).toBeVisible();
    await expect(page.locator('#financeStorageWarning')).toContainText('9GB');
  });

  test('observer never triggers a receipts-usage fetch (no banner, no request)', async ({ page }) => {
    let usageRequested = false;
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_sat_a', role: 'observer' }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/transactions**', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) }));
    await page.route('**/api/finance/receipts-usage', (route) => {
      usageRequested = true;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) });
    });

    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeStorageWarning')).toBeHidden();
    expect(usageRequested).toBe(false);
  });

  test('clicking "Sửa" opens the popup pre-filled with the row\'s data', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeFormOverlay')).toBeHidden();
    await page.locator('#financeTable tbody tr', { hasText: 'Bán rau' }).locator('button[title="Sửa"]').click();
    await expect(page.locator('#financeFormOverlay')).toBeVisible();
    await expect(page.locator('#financeFormTitle')).toHaveText('Sửa giao dịch');
    await expect(page.locator('#financeForm input[name="amount"]')).toHaveValue('2000000');
  });

  test('non-admin does not see the "Hiển thị các log đã ẩn" checkbox or Ẩn/Hiện button, even on a voided row', async ({ page }) => {
    const voidedTx = { id: 3, type: 'expense', category: 'vat_tu', amount: 50000, note: 'Nhập nhầm', transactionDate: '2026-08-05', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-05T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: 'admin_a', voidedAt: '2026-08-06T00:00:00Z', isHidden: false };
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: [...SAMPLE_TX, voidedTx] });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#showHiddenTransactionsWrap')).toBeHidden();
    await expect(page.locator('button[title="Ẩn"]')).toHaveCount(0);
  });

  test('admin sees the checkbox and Ẩn/Hiện button on voided rows; ticking it requests includeHidden=1', async ({ page }) => {
    const voidedTx = { id: 3, type: 'expense', category: 'vat_tu', amount: 50000, note: 'Nhập nhầm', transactionDate: '2026-08-05', status: 'confirmed', createdBy: 'quan_ly_a', createdAt: '2026-08-05T00:00:00Z', updatedBy: null, updatedAt: null, voidedBy: 'admin_a', voidedAt: '2026-08-06T00:00:00Z', isHidden: false };
    const all = [...SAMPLE_TX, voidedTx];
    await mockCommonRoutes(page, { role: 'admin', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: all });

    let includeHiddenRequested = false;
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
      const url = new URL(route.request().url());
      if (url.searchParams.get('includeHidden') === '1') includeHiddenRequested = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(all)) });
    });

    await page.goto('/admin/finance.html');
    await expect(page.locator('#showHiddenTransactionsWrap')).toBeVisible();
    await expect(page.locator('#financeTable tbody tr', { hasText: 'Nhập nhầm' }).locator('button[title="Ẩn"]')).toHaveCount(1);

    await page.locator('#showHiddenTransactions').check();
    await expect.poll(() => includeHiddenRequested).toBe(true);
  });

  test('changing pageSize and paging forward/back requests the correct page params', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });

    const requestedPages = [];
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() !== 'GET') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
      const url = new URL(route.request().url());
      requestedPages.push({ page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX, { total: 30, page: Number(url.searchParams.get('page')), pageSize: Number(url.searchParams.get('pageSize')) })) });
    });

    await page.goto('/admin/finance.html');
    await page.selectOption('#financePageSize', '10');
    await expect.poll(() => requestedPages.at(-1)).toMatchObject({ page: '1', pageSize: '10' });

    await page.click('#financeNextPageBtn');
    await expect.poll(() => requestedPages.at(-1)).toMatchObject({ page: '2', pageSize: '10' });

    await page.click('#financePrevPageBtn');
    await expect.poll(() => requestedPages.at(-1)).toMatchObject({ page: '1', pageSize: '10' });
  });

  test('"Tổng doanh thu (theo bộ lọc)" reflects the response\'s sumIncome', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#financeFilteredStats')).toContainText('2.000.000');
  });

  test('toggling to "Theo danh mục" renders 2 pie charts; toggling back restores the time chart controls', async ({ page }) => {
    await mockCommonRoutes(page, { role: 'manager', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: SAMPLE_TX });
    await page.goto('/admin/finance.html');
    await expect(page.locator('#chartGranularity')).toBeVisible();

    await page.click('#chartTypeToggle button[data-chart-type="category"]');
    await expect(page.locator('#chartGranularity')).toBeHidden();
    await expect(page.locator('#financePieIncome svg')).toBeVisible();
    await expect(page.locator('#financePieExpense svg')).toBeVisible();

    await page.click('#chartTypeToggle button[data-chart-type="time"]');
    await expect(page.locator('#chartGranularity')).toBeVisible();
    await expect(page.locator('#financeChart svg')).toBeVisible();
  });

  test('observer sees only "Thu" data: balance section and type filter hidden, no add-transaction trigger', async ({ page }) => {
    const incomeOnlyTx = [SAMPLE_TX[0]]; // server would only ever send observer the income row
    await mockCommonRoutes(page, { role: 'observer', summary: DEFAULT_SUMMARY, openingBalance: DEFAULT_OPENING, transactions: incomeOnlyTx });
    await page.goto('/admin/finance.html');

    await expect(page.locator('#openAddTransactionBtn')).toBeHidden();
    await expect(page.locator('#financeBalanceSection')).toBeHidden();
    await expect(page.locator('#filterType')).toBeHidden();
    await expect(page.locator('#financeTable tbody')).toContainText('Bán rau');
    await expect(page.locator('#financeTable tbody')).not.toContainText('Mua phân bón');
  });

  test('a reception account with canAddFinanceTransaction=true sees the add-transaction trigger', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception', canAddFinanceTransaction: true }) }));
    await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_SUMMARY) }));
    await page.route('**/api/finance/transactions**', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toEnvelope(SAMPLE_TX)) });
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 99, ok: true }) });
    });
    await page.route('**/api/finance/categories', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CATEGORIES) }));

    await page.goto('/admin/finance.html');
    await expect(page.locator('#openAddTransactionBtn')).toBeVisible();
    // The monthly balance editor stays manager/admin-only regardless of this flag.
    await expect(page.locator('#openingBalanceEditor')).toBeHidden();
  });
});
