// @ts-check
const { defineConfig } = require('@playwright/test');

const V3_PORT = 4173;
const V4_PORT = 4174;

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  webServer: [
    {
      command: `npx http-server v3 -p ${V3_PORT} -s -c-1`,
      port: V3_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Static-only preview: enough for these specs, which mock every
      // /api/* call via page.route() rather than hitting a live backend.
      // For a real backend, run `wrangler pages dev` inside v4/ instead.
      command: `npx http-server v4 -p ${V4_PORT} -s -c-1`,
      port: V4_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],

  projects: [
    {
      name: 'v3',
      use: { baseURL: `http://localhost:${V3_PORT}` },
      metadata: { version: 'v3' },
      // v3 has no CRM/admin pages (only v4 does) — exclude those specs here.
      testMatch: /^(?!.*[\\/]crm-[^\\/]*\.spec\.js$).+\.spec\.js$/,
    },
    {
      name: 'v4',
      use: { baseURL: `http://localhost:${V4_PORT}` },
      metadata: { version: 'v4' },
      // clean-urls.spec.js relies on _redirects rewrites, which the local
      // http-server does not honor; it only runs against the real
      // deployment via the v4-live project below.
      testMatch: /^(?!.*[\\/]clean-urls\.spec\.js$).+\.spec\.js$/,
    },
    {
      // Runs clean-urls.spec.js against the real Cloudflare Pages deployment,
      // since _redirects rewrites are not honored by the local http-server
      // used by the other projects above. Not run automatically; see
      // tests/e2e/clean-urls.spec.js for manual invocation instructions.
      name: 'v4-live',
      use: { baseURL: 'https://hien-le-garden-v4.pages.dev' },
      metadata: { version: 'v4-live' },
      testMatch: /clean-urls\.spec\.js/,
    },
  ],
});
