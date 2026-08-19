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
    },
    {
      name: 'v4',
      use: { baseURL: `http://localhost:${V4_PORT}` },
      metadata: { version: 'v4' },
    },
  ],
});
