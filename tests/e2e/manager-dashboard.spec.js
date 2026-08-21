// tests/e2e/manager-dashboard.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Manager dashboard', () => {
  test('renders today and month figures from the summary endpoint', async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'quan_ly_a', role: 'manager' }) })
    );
    await page.route('**/api/dashboard/summary**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          month: '2026-08',
          today: { roomsOccupied: 9, roomsNeedCleaning: 2, roomsEmpty: 5, arrivalsToday: 3, departuresToday: 2 },
          monthSummary: {
            occupancyRate: 0.62,
            estimatedRevenueVnd: 18400000,
            statusFunnel: { pending: 4, confirmed: 6, checked_in: 3, checked_out: 20, cancelled: 2 },
            sourceBreakdown: { website: 14, phone: 9, zalo: 8, walk_in: 4 },
          },
        }),
      })
    );

    await page.goto('/admin/dashboard.html');

    await expect(page.locator('#todayStats')).toContainText('9');
    await expect(page.locator('#todayStats')).toContainText('Đang có khách');
    await expect(page.locator('#monthStats')).toContainText('62%');
    await expect(page.locator('#funnelTable')).toContainText('Chờ xử lý');
    await expect(page.locator('#funnelTable')).toContainText('4');
    await expect(page.locator('#sourceTable')).toContainText('Website');
    await expect(page.locator('#sourceTable')).toContainText('14');
  });

  test('redirects to login.html when not authenticated', async ({ page }) => {
    await page.route('**/api/auth/me', (route) => route.fulfill({ status: 401 }));
    await page.goto('/admin/dashboard.html');
    await page.waitForURL('**/admin/login.html');
  });

  test('shows an inline error when logged in as reception (403, not manager)', async ({ page }) => {
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'le_tan_a', role: 'reception' }) })
    );
    await page.route('**/api/dashboard/summary**', (route) =>
      route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Không đủ quyền' }) })
    );

    await page.goto('/admin/dashboard.html');
    await expect(page.locator('#dashboardError')).toHaveText('Không đủ quyền');
  });
});
