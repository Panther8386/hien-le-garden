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
    test(`${c.url} serves content without a 404`, async ({ page, baseURL }) => {
      // Track same-origin subresource failures. Attached before goto() so it
      // catches failures during the initial navigation too, and checks the
      // actual HTTP status rather than relying on 'requestfailed' — that
      // event only fires for network-level errors (DNS, connection reset,
      // etc.), never for HTTP-level error statuses like a 404. This is what
      // actually catches a 404'd /admin/nav-drawer.js or /admin/admin.css
      // being requested under a clean URL like /manager/dashboard.
      // /api/* calls are expected to 401 for an unauthenticated visitor —
      // that's the auth gate working correctly, not an asset failure. Only
      // flag same-origin, non-API responses (the actual page/script/style
      // assets this check exists to catch a 404 on).
      const siteOrigin = new URL(baseURL).origin;
      const failed = [];
      page.on('response', (res) => {
        const url = new URL(res.url());
        if (res.status() >= 400 && url.origin === siteOrigin && !url.pathname.startsWith('/api/')) {
          failed.push(`${res.status()} ${res.url()}`);
        }
      });

      const response = await page.goto(c.url);
      expect(response.status()).toBeLessThan(400);
      // Every unauthenticated visit to a role page bounces to /admin via
      // each page's own client-side auth check.
      if (c.expectRedirectToLogin) {
        await page.waitForURL('**/admin');
      }
      // Confirm the page's own JS/CSS assets actually loaded (no 404s for
      // nav-drawer.js/admin.css under this clean URL).
      await page.waitForLoadState('networkidle');
      expect(failed).toEqual([]);
    });
  }
});
