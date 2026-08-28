const { test, expect } = require('@playwright/test');
const { ALL_PAGES } = require('../fixtures/pages');

// Pages that read live pricing/policy data (e.g. home, bang-gia) fetch
// /api/catalog and /api/cancellation-policy on load. This suite runs against
// a static-file-only local server with no backend for those routes (real
// deployments serve them via Cloudflare Pages Functions), so each such fetch
// logs an expected browser-level "Failed to load resource: ... 404" console
// message. We record the URL of every 404 response and assert each one is
// under /api/ — failing the test outright if a non-API resource 404s, since
// that's a real broken asset, not an expected backend gap. Only once every
// 404 is proven to be an expected API call do we unconditionally filter out
// RESOURCE_404_MESSAGE console entries, so any other console error (a real
// bug, a broken asset, a JS exception) still fails the test.
const RESOURCE_404_MESSAGE = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

for (const page of ALL_PAGES) {
  test(`no console errors on load — ${page.name}`, async ({ page: browserPage }) => {
    const errors = [];
    const notFoundUrls = [];
    browserPage.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    browserPage.on('pageerror', (err) => errors.push(err.message));
    browserPage.on('response', (res) => {
      if (res.status() === 404) notFoundUrls.push(res.url());
    });

    // Not 'networkidle': the home page has a looping autoplay <video>,
    // which keeps network activity going forever and would time out.
    await browserPage.goto(page.path, { waitUntil: 'load' });
    await browserPage.waitForTimeout(1000);

    for (const url of notFoundUrls) {
      expect(new URL(url).pathname, `Unexpected 404 for non-API resource on ${page.path}: ${url}`).toMatch(/^\/api\//);
    }

    const unexpected = errors.filter((msg) => msg !== RESOURCE_404_MESSAGE);

    expect(unexpected, `Console errors on ${page.path}`).toEqual([]);
  });
}
