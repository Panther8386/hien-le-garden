const { test, expect } = require('@playwright/test');
const { ALL_PAGES, HOME_PAGE } = require('../fixtures/pages');

for (const page of ALL_PAGES) {
  test.describe(`SEO basics — ${page.name}`, () => {
    test(`has a non-empty <title> and meta description`, async ({ page: browserPage }) => {
      await browserPage.goto(page.path);

      await expect(browserPage).toHaveTitle(/.+/);

      const description = browserPage.locator('meta[name="description"]');
      await expect(description).toHaveCount(1);
      const content = await description.getAttribute('content');
      expect(content?.trim().length).toBeGreaterThan(0);
    });
  });
}

test.describe('SEO basics — home page extras', () => {
  test('has a canonical link', async ({ page }) => {
    await page.goto(HOME_PAGE.path);
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveCount(1);
    const href = await canonical.getAttribute('href');
    expect(href?.trim().length).toBeGreaterThan(0);
  });

  test('has valid schema.org JSON-LD', async ({ page }) => {
    await page.goto(HOME_PAGE.path);
    const scripts = page.locator('script[type="application/ld+json"]');
    const count = await scripts.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const raw = await scripts.nth(i).textContent();
      expect(() => JSON.parse(raw || '')).not.toThrow();
      const parsed = JSON.parse(raw || '');
      expect(parsed['@context']).toBe('https://schema.org');
    }
  });
});
