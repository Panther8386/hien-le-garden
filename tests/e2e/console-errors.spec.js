const { test, expect } = require('@playwright/test');
const { ALL_PAGES } = require('../fixtures/pages');

for (const page of ALL_PAGES) {
  test(`no console errors on load — ${page.name}`, async ({ page: browserPage }) => {
    const errors = [];
    browserPage.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    browserPage.on('pageerror', (err) => errors.push(err.message));

    // Not 'networkidle': the home page has a looping autoplay <video>,
    // which keeps network activity going forever and would time out.
    await browserPage.goto(page.path, { waitUntil: 'load' });
    await browserPage.waitForTimeout(1000);

    expect(errors, `Console errors on ${page.path}`).toEqual([]);
  });
}
