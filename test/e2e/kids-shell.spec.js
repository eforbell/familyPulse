'use strict';

const { test, expect } = require('@playwright/test');
const { loginAs, cleanupSession, closePool } = require('./helpers/auth');

let sessionToken;

test.beforeEach(async ({ page }) => {
  const { token } = await loginAs(page, { role: 'kid', name: 'Jordan' });
  sessionToken = token;
});

test.afterEach(async () => {
  await cleanupSession(sessionToken);
});

test.afterAll(async () => {
  await closePool();
});

test('kid dashboard renders sovereign shell and transaction detail overlay', async ({ page }) => {
  await page.goto('/kids/Jordan');
  await expect(page.locator('header.app-header')).toBeVisible();
  await expect(page.locator('#balance-card')).toBeVisible();
  const txList = page.locator('#tx-list');
  const noAccounts = page.locator('text=No accounts linked yet');
  const hasTxList = await txList.count();
  const hasNoAccounts = await noAccounts.count();
  expect(hasTxList > 0 || hasNoAccounts > 0).toBe(true);

  const rows = page.locator('.tx-row');
  if (await rows.count()) {
    await rows.first().click();
    await expect(page.locator('#kid-tx-detail-overlay')).toBeVisible();
    await expect(page.locator('#kid-tx-detail-title')).toBeVisible();
    await page.locator('#kid-tx-detail-overlay .modal-close').click();
    await expect(page.locator('#kid-tx-detail-overlay')).toBeHidden();
  }
});
