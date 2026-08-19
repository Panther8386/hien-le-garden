const { test, expect } = require('@playwright/test');
const { HOME_PAGE } = require('../fixtures/pages');

test.describe('Home page interactions', () => {
  test('gallery lightbox opens, navigates, and closes', async ({ page }) => {
    await page.goto(HOME_PAGE.path);

    const galleryItems = page.locator('.gallery-item');
    await expect(galleryItems.first()).toBeVisible();
    const total = await galleryItems.count();

    await galleryItems.first().click();
    const lightbox = page.locator('#lightbox');
    await expect(lightbox).toHaveClass(/open/);
    await expect(page.locator('#lightboxCounter')).toHaveText(`1 / ${total}`);

    await page.locator('#lightboxNext').click();
    await expect(page.locator('#lightboxCounter')).toHaveText(`2 / ${total}`);

    await page.locator('#lightboxPrev').click();
    await expect(page.locator('#lightboxCounter')).toHaveText(`1 / ${total}`);

    await page.locator('#lightboxClose').click();
    await expect(lightbox).not.toHaveClass(/open/);
  });

  test('gallery lightbox closes on Escape key', async ({ page }) => {
    await page.goto(HOME_PAGE.path);
    await page.locator('.gallery-item').first().click();
    const lightbox = page.locator('#lightbox');
    await expect(lightbox).toHaveClass(/open/);

    await page.keyboard.press('Escape');
    await expect(lightbox).not.toHaveClass(/open/);
  });

  test('FAQ accordion opens one answer and closes others', async ({ page }) => {
    await page.goto(HOME_PAGE.path);

    const questions = page.locator('.faq-question');
    const answers = page.locator('.faq-answer');
    const count = await questions.count();
    expect(count).toBeGreaterThanOrEqual(2);

    await questions.nth(0).click();
    await expect(questions.nth(0)).toHaveClass(/open/);
    await expect(answers.nth(0)).toHaveClass(/open/);

    await questions.nth(1).click();
    await expect(questions.nth(1)).toHaveClass(/open/);
    await expect(answers.nth(1)).toHaveClass(/open/);
    await expect(questions.nth(0)).not.toHaveClass(/open/);
    await expect(answers.nth(0)).not.toHaveClass(/open/);
  });

  test('fade-in sections become visible on scroll', async ({ page }) => {
    await page.goto(HOME_PAGE.path);

    // Reveal is implemented either via GSAP ScrollTrigger (opacity set
    // inline) or, if GSAP fails to load, a CSS 'visible' class fallback.
    // Checking computed opacity covers both without depending on which
    // path ran. Use the last '.fade-in' element (FAQ section) so it is
    // guaranteed to start outside the initial viewport.
    const target = page.locator('.fade-in').last();
    await expect(target).not.toHaveCSS('opacity', '1');

    await target.scrollIntoViewIfNeeded();
    await expect(target).toHaveCSS('opacity', '1');
  });
});

test.describe('Home page mobile navigation', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('hamburger opens and closes the mobile nav overlay', async ({ page }) => {
    await page.goto(HOME_PAGE.path);

    const hamburger = page.locator('#hamburger');
    const overlay = page.locator('#mobileNav');

    await expect(overlay).not.toHaveClass(/open/);
    await hamburger.click();
    await expect(overlay).toHaveClass(/open/);

    await page.locator('#mobileClose').click();
    await expect(overlay).not.toHaveClass(/open/);
  });
});
