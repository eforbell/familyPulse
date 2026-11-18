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

// Bug #169: kid rows rendered 3 cells into the parent's 4-column .tx-row grid,
// so the merchant landed in the 32px avatar column ("Fi…") and dates wrapped.
test('kid transaction rows give the merchant the wide column at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const json = body => route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  const tx = (id, merchant, amount, category) => ({
    id, merchant_name: merchant, name: merchant.toUpperCase(), amount, date: '2026-11-14',
    category_name: category, category_color: '#ec4899', pending: false
  });
  const longName = 'Neighborhood Community Center After School Snack Bar And Arcade';

  await page.route('**/api/auth/me', json({ id: 2, name: 'Jordan', role: 'kid', avatar_emoji: '🧒' }));
  await page.route('**/api/categories', json([]));
  await page.route('**/api/kids/report-card', json({ report: null }));
  await page.route('**/api/kids/dashboard', json({
    member: { name: 'Jordan', emoji: '🧒' },
    accounts: [{ id: 1, name: 'Kid Checking' }],
    balance_total: 50,
    depository_balance_label: 'Available',
    month_spending: 30.78,
    budget: null,
    category_breakdown: [],
    recent_transactions: [tx(301, 'Five Below', 18.22, 'Shopping'), tx(302, longName, 8.46, null)]
  }));
  await page.route('**/api/transactions/301', json({
    transaction: { ...tx(301, 'Five Below', 18.22, 'Shopping'), source: 'plaid', attachments: [] }
  }));

  await page.goto('/kids/Jordan');
  const rows = page.locator('#tx-list .tx-row');
  await expect(rows).toHaveCount(2);

  const layout = await rows.evaluateAll(els => els.map(row => {
    const box = el => row.querySelector(el).getBoundingClientRect();
    const merchant = row.querySelector('.tx-merchant');
    return {
      mainWidth: box('.tx-main').width,
      detailHeight: box('.tx-detail').height,
      truncated: merchant.scrollWidth > merchant.clientWidth,
      amountRight: box('.tx-amount').right,
      rowRight: row.getBoundingClientRect().right
    };
  }));

  for (const r of layout) {
    expect(r.mainWidth).toBeGreaterThan(150);
    // Date and category badge share one line rather than wrapping word by word.
    expect(r.detailHeight).toBeLessThan(40);
    expect(r.amountRight).toBeLessThanOrEqual(r.rowRight);
  }
  expect(layout[0].truncated).toBe(false);
  expect(layout[1].truncated).toBe(true);
  await expect(rows.first().locator('.tx-merchant')).toHaveText('Five Below');
  await expect(rows.nth(1).locator('.tx-icon')).toHaveText('N');

  await rows.first().click();
  await expect(page.locator('#kid-tx-detail-overlay')).toBeVisible();
});
