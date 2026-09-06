// Shared Playwright screenshot-capture helper for the Hiền Lê Garden V4 user guides.
// Run from D:\VDX\HienLeGarden\LandingPage (repo root) so node_modules resolves.
const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const BASE = 'http://localhost:4200';

async function mockRoutes(page, routes) {
  for (const r of routes) {
    await page.route(r.url, (route) => {
      if (r.method && route.request().method() !== r.method) return route.continue();
      return route.fulfill({
        status: r.status || 200,
        contentType: 'application/json',
        body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      });
    });
  }
}

async function runShots(outDir, shots) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: shot.viewport || { width: 1360, height: 900 } });
    if (shot.routes) await mockRoutes(page, shot.routes);
    await page.goto(BASE + shot.path, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(shot.settleMs || 600);
    if (shot.before) await shot.before(page);
    const outPath = path.join(outDir, shot.name + '.png');
    if (shot.clip) {
      await page.locator(shot.clip).screenshot({ path: outPath });
    } else {
      await page.screenshot({ path: outPath, fullPage: shot.fullPage !== false });
    }
    console.log('✓', shot.name);
    await page.close();
  }
  await browser.close();
}

const fx = require('./fixtures');

// Full realistic mock of every common admin-area GET endpoint, parameterized by
// role/username. Individual shots can layer extra `routes` on top (registered
// after this, so they win per Playwright's last-registered-first-matched rule).
async function mockCommonAdmin(page, { role, username }) {
  await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username, role, canManageRoomLayout: role === 'admin' || role === 'manager' }) }));
  await page.route('**/api/rooms**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.rooms) }));
  await page.route('**/api/rooms/layout-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/catalog?all=1', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.catalog) }));
  await page.route('**/api/catalog', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.catalog) }));
  await page.route('**/api/catalog/*/slot-templates**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/catalog/*/slot-availability**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 1, label: 'Suất tối', startTime: '19:00', capacity: 30, booked: 12, remaining: 18 }]) }));
  await page.route('**/api/reception/reminders**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  // Register the catch-all FIRST: Playwright resolves overlapping page.route patterns
  // in reverse registration order (most-recently-registered wins), so the more specific
  // status= routes must be registered AFTER this one to actually take precedence.
  await page.route('**/api/bookings**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([...fx.bookingsPending, ...fx.bookingsConfirmed, ...fx.bookingsCheckedIn]) }));
  await page.route('**/api/bookings?status=pending**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.bookingsPending) }));
  await page.route('**/api/bookings?status=confirmed**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.bookingsConfirmed) }));
  await page.route('**/api/bookings?status=checked_in**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.bookingsCheckedIn) }));
  await page.route('**/api/customers**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.customers) }));
  await page.route('**/api/finance/transactions**', (route) => {
    const transactions = fx.financeTransactions;
    const isSettled = (t) => !t.voidedAt && (t.status === 'confirmed' || t.status === 'paid');
    const sumIncome = transactions.filter((t) => t.type === 'income' && isSettled(t)).reduce((s, t) => s + t.amount, 0);
    const sumExpense = transactions.filter((t) => t.type === 'expense' && isSettled(t)).reduce((s, t) => s + t.amount, 0);
    const categoryTotals = {};
    transactions.filter(isSettled).forEach((t) => {
      if (!categoryTotals[t.category]) categoryTotals[t.category] = { income: 0, expense: 0 };
      categoryTotals[t.category][t.type] += t.amount;
    });
    const chartRows = transactions.map((t) => ({ transactionDate: t.transactionDate, type: t.type, amount: t.amount, status: t.status, voidedAt: t.voidedAt }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transactions, total: transactions.length, page: 1, pageSize: 25, sumIncome, sumExpense, categoryTotals, chartRows }) });
  });
  await page.route('**/api/finance/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.financeSummary) }));
  await page.route('**/api/finance/opening-balance**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.financeOpeningBalance) }));
  await page.route('**/api/dashboard/summary**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.dashboardSummary) }));
  await page.route('**/api/audit-log**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.auditLog) }));
  await page.route('**/api/users**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.users) }));
  await page.route('**/api/cancellation-policy**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.cancellationPolicies) }));
  await page.route('**/api/templates**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fx.templates) }));
  await page.route('**/api/experience-booking-settings**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ suggestionWindowDays: 14, maxSuggestions: 5, updatedAt: '2026-08-01T00:00:00Z' }) }));
  await page.route('**/api/reminder-settings**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ daysBeforeCheckIn: 1, updatedAt: '2026-08-01T00:00:00Z' }) }));
  await page.route('**/api/notification-settings**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ telegramEnabled: true, updatedAt: '2026-08-01T00:00:00Z' }) }));
  await page.route('**/api/gift-inventory**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ remaining: 12 }) }));
  await page.route('**/api/policy**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

async function runAdminShots(outDir, role, username, shots) {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: shot.viewport || { width: 1360, height: 900 } });
    await mockCommonAdmin(page, { role, username });
    if (shot.routes) await mockRoutes(page, shot.routes);
    await page.goto(BASE + shot.path, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(shot.settleMs || 700);
    if (shot.before) await shot.before(page);
    const outPath = path.join(outDir, shot.name + '.png');
    if (shot.clip) {
      await page.locator(shot.clip).first().screenshot({ path: outPath });
    } else {
      await page.screenshot({ path: outPath, fullPage: shot.fullPage !== false });
    }
    console.log('✓', shot.name);
    await page.close();
  }
  await browser.close();
}

module.exports = { runShots, runAdminShots, mockCommonAdmin, BASE };
