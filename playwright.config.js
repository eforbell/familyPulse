'use strict';

const dotenv = require('dotenv');
const path = require('path');
const { defineConfig } = require('@playwright/test');

dotenv.config({ path: path.join(__dirname, '.env.test'), override: true });

module.exports = defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.js',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './test/e2e/helpers/global-setup.js',
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://127.0.0.1:3099',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3099/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    env: { ...process.env, NODE_ENV: 'test', PORT: '3099' },
  },
});
