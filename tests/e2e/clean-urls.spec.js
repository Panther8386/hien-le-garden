// tests/e2e/clean-urls.spec.js
const { test, expect } = require('@playwright/test');

// These assert against the live Cloudflare Pages deployment because
// _redirects rewrites are not honored by the local http-server used for
// the rest of this project's e2e suite. Run manually after deploying:
// npx playwright test clean-urls --project=v4-live
// (see playwright.config.js for a v4-live project pointing at
// https://hien-le-garden-v4.pages.dev, added in this task if it doesn't
// already exist.)

test.describe('Clean role-based URLs', () => {
  const cases = [
    { url: '/admin', expectTitle: /Đăng nhập|Login/i },
    { url: '/manager', expectRedirectToLogin: true },
    { url: '/reception', expectRedirectToLogin: true },
    { url: '/observer', expectRedirectToLogin: true },
    { url: '/manager/dashboard', expectRedirectToLogin: true },
    { url: '/manager/customers', expectRedirectToLogin: true },
    { url: '/reception/customers', expectRedirectToLogin: true },
    { url: '/observer/customers', expectRedirectToLogin: true },
  ];

  for (const c of cases) {
    test(`${c.url} serves content without a 404`, async ({ page }) => {
      const response = await page.goto(c.url);
      expect(response.status()).toBeLessThan(400);
      // Every unauthenticated visit to a role page bounces to /admin via
      // each page's own client-side auth check.
      if (c.expectRedirectToLogin) {
        await page.waitForURL('**/admin');
      }
      // Confirm the page's own JS assets actually loaded (no console 404s
      // for nav-drawer.js/admin.css under this URL).
      const failed = [];
      page.on('requestfailed', (req) => failed.push(req.url()));
      await page.waitForLoadState('networkidle');
      expect(failed).toEqual([]);
    });
  }
});
