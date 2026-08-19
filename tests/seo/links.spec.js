const { test, expect } = require('@playwright/test');
const { ALL_PAGES } = require('../fixtures/pages');

// Attributes that can point at a local asset or another local page.
const ATTR_SELECTORS = [
  ['a[href]', 'href'],
  ['img[src]', 'src'],
  ['link[rel="stylesheet"][href]', 'href'],
  ['link[rel="icon"][href]', 'href'],
  ['link[rel="manifest"][href]', 'href'],
  ['script[src]', 'src'],
  ['source[src]', 'src'],
  ['video[src]', 'src'],
];

function isInternal(url) {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return false;
  if (/^(https?:)?\/\//i.test(trimmed)) return false; // external / protocol-relative
  if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) return false;
  return true;
}

for (const page of ALL_PAGES) {
  test(`no broken internal links or assets — ${page.name}`, async ({ page: browserPage, request, baseURL }) => {
    await browserPage.goto(page.path);

    const urls = new Set();
    for (const [selector, attr] of ATTR_SELECTORS) {
      const values = await browserPage.$$eval(
        selector,
        (els, attrName) => els.map((el) => el.getAttribute(attrName)),
        attr
      );
      for (const value of values) {
        if (isInternal(value)) {
          const resolved = new URL(value.split('#')[0], baseURL + page.path).toString();
          urls.add(resolved);
        }
      }
    }

    const broken = [];
    for (const url of urls) {
      const response = await request.get(url);
      if (!response.ok()) {
        broken.push(`${url} -> ${response.status()}`);
      }
    }

    expect(broken, `Broken internal links/assets on ${page.path}`).toEqual([]);
  });
}
