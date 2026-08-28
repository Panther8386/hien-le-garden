const { test, expect } = require('@playwright/test');
const { ALL_PAGES } = require('../fixtures/pages');

// Pages that read live pricing/policy data (e.g. home, bang-gia) fetch
// /api/catalog and /api/cancellation-policy on load. This suite runs against
// a static-file-only local server with no backend for those routes (real
// deployments serve them via Cloudflare Pages Functions), so each such fetch
// logs an expected browser-level "Failed to load resource: ... 404" console
// message. We count the actual /api/* 404 responses via the network layer
// and forgive exactly that many matching generic console messages, so any
// other console error (a real bug, a broken asset, a JS exception) still
// fails the test.
const RESOURCE_404_MESSAGE = 'Failed to load resource: the server responded with a status of 404 (Not Found)';

for (const page of ALL_PAGES) {
  test(`no console errors on load — ${page.name}`, async ({ page: browserPage }) => {
    const errors = [];
    let expectedApi404s = 0;
    browserPage.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    browserPage.on('pageerror', (err) => errors.push(err.message));
    browserPage.on('response', (res) => {
      if (res.status() === 404 && new URL(res.url()).pathname.startsWith('/api/')) {
        expectedApi404s++;
      }
    });

    // Not 'networkidle': the home page has a looping autoplay <video>,
    // which keeps network activity going forever and would time out.
    await browserPage.goto(page.path, { waitUntil: 'load' });
    await browserPage.waitForTimeout(1000);

    let remaining = expectedApi404s;
    const unexpected = errors.filter((msg) => {
      if (msg === RESOURCE_404_MESSAGE && remaining > 0) {
        remaining--;
        return false;
      }
      return true;
    });

    expect(unexpected, `Console errors on ${page.path}`).toEqual([]);
  });
}
