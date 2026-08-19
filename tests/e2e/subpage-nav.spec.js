const { test, expect } = require('@playwright/test');
const { SUB_PAGES } = require('../fixtures/pages');

for (const page of SUB_PAGES) {
  test(`"← Trang chủ" link returns to the home page — ${page.name}`, async ({ page: browserPage, baseURL }) => {
    await browserPage.goto(page.path);

    const backLink = browserPage.locator('.sub-nav-back');
    await expect(backLink).toBeVisible();

    await backLink.click();
    await expect(browserPage).toHaveURL(new URL('/', baseURL).toString());
  });
}
