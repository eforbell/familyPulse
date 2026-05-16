'use strict';

const { test, expect } = require('@playwright/test');
const { loginAs, cleanupSession, closePool } = require('./helpers/auth');

let sessionToken;

test.beforeEach(async ({ page }) => {
  const { token } = await loginAs(page, { role: 'parent', name: 'Eric' });
  sessionToken = token;
  await page.addInitScript(() => localStorage.setItem('pulse-privacy-mode', 'on'));
});

test.afterEach(async () => {
  await cleanupSession(sessionToken);
});

test.afterAll(async () => {
  await closePool();
});

test('privacy mode blurs dashboard and transactions amounts', async ({ page }) => {
  await page.route('**/api/accounts/dashboard', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      net_position: 43600, liquid_total: 43600, credit_total: 0, account_count: 6, historical_account_count: 3, groups: { Household: [] }, historical_groups: {}
    }) });
  });

  await page.route('**/api/categories', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 4, name: 'Gas & Auto', color: '#64748b', icon: null }]) });
  });

  await page.route('**/api/transactions?**', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      transactions: [{ id: 148, merchant_name: 'Uber', name: 'Uber', effective_display_name: 'Uber', raw_display_name: 'Uber', amount: 5.40, date: '2026-03-15', account_name: 'Plaid Checking', account_mask: '0000', category_name: 'Gas & Auto', category_color: '#64748b', category_icon: null, source: 'plaid', pending: false, is_hidden: false, account_sync_status: 'active' }],
      total: 1, sum: 5.40, limit: 50, offset: 0
    }) });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/privacy-mode/);
  const dashFilter = await page.locator('#net-amount').evaluate((el) => getComputedStyle(el).filter);

  await page.goto('/transactions.html');
  await expect(page.locator('html')).toHaveClass(/privacy-mode/);
  await expect(page.locator('.tx-amount').first()).toBeVisible();
  const txFilter = await page.locator('.tx-amount').first().evaluate((el) => getComputedStyle(el).filter);

  expect(dashFilter).not.toBe('none');
  expect(txFilter).not.toBe('none');
});
