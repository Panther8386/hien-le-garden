// @ts-check
const { defineConfig } = require('@playwright/test');

const V3_PORT = 4173;
const V4_PORT = 4174;
const CRM_PORT = 4175;

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
      command: `npx http-server v4 -p ${V4_PORT} -s -c-1`,
      port: V4_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `npx http-server crm/public -p ${CRM_PORT} -s -c-1`,
      port: CRM_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],

  projects: [
    {
      name: 'v3',
      use: { baseURL: `http://localhost:${V3_PORT}` },
      metadata: { version: 'v3' },
      // Excludes crm-*.spec.js. Anchored to the filename (preceded by a path
      // separator, ending at .spec.js) rather than a bare substring match,
      // because this worktree's own directory name ("v4-crm-loyalty")
      // contains "crm-" and an unanchored pattern would match every spec's
      // absolute path regardless of filename.
      testMatch: /^(?!.*[\\/]crm-[^\\/]*\.spec\.js$).+\.spec\.js$/,
    },
    {
      name: 'v4',
      use: { baseURL: `http://localhost:${V4_PORT}` },
      metadata: { version: 'v4' },
      testMatch: /^(?!.*[\\/]crm-[^\\/]*\.spec\.js$).+\.spec\.js$/,
    },
    {
      name: 'crm',
      use: { baseURL: `http://localhost:${CRM_PORT}` },
      testMatch: /[\\/]crm-[^\\/]*\.spec\.js$/,
    },
  ],
});
