'use strict';

const { test, expect } = require('@playwright/test');
const { loginAs, cleanupSession, closePool } = require('./helpers/auth');

let sessionToken;

test.beforeEach(async ({ page }) => {
  const { token } = await loginAs(page, { role: 'parent', name: 'Eric' });
  sessionToken = token;
});

test.afterEach(async () => {
  await cleanupSession(sessionToken);
});

test.afterAll(async () => {
  await closePool();
});

test('category overlay opens above transaction detail modal', async ({ page }) => {
  const detail = {
    id: 148,
    merchant_name: 'Uber',
    name: 'Uber 063015 SF**POOL**',
    effective_display_name: 'Uber',
    raw_display_name: 'Uber',
    raw_display_name_is_check_like: false,
    display_name_override: null,
    rename_rule: null,
    amount: 5.40,
    date: '2026-03-15',
    account_name: 'Plaid Checking',
    account_mask: '0000',
    category_name: 'Gas & Auto',
    category_color: '#64748b',
    category_icon: null,
    source: 'plaid',
    pending: false,
    source_removed: false,
    note: null,
    attachments: []
  };

  await page.route('**/api/auth/me', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 1, name: 'Eric', role: 'parent', avatar_emoji: '🧑' }) });
  });

  await page.route('**/api/categories', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: 2, name: 'Dining Out', color: '#f97316', icon: null },
      { id: 3, name: 'Entertainment', color: '#a855f7', icon: null },
      { id: 4, name: 'Gas & Auto', color: '#64748b', icon: null }
    ]) });
  });

  await page.route('**/api/transactions?**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        transactions: [{
          id: 148,
          merchant_name: 'Uber',
          name: 'Uber 063015 SF**POOL**',
          effective_display_name: 'Uber',
          raw_display_name: 'Uber',
          amount: 5.40,
          date: '2026-03-15',
          account_name: 'Plaid Checking',
          account_mask: '0000',
          category_name: 'Gas & Auto',
          category_color: '#64748b',
          category_icon: null,
          source: 'plaid',
          pending: false,
          is_hidden: false,
          account_sync_status: 'active'
        }],
        total: 1,
        sum: 5.40,
        limit: 50,
        offset: 0
      })
    });
  });

  await page.route('**/api/transactions/148', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ transaction: detail }) });
  });

  await page.goto('/transactions.html');
  await page.locator('.tx-row').first().click();
  await expect(page.locator('#tx-detail-overlay')).toBeVisible();
  await page.getByRole('button', { name: 'Reassign category' }).click();
  await expect(page.locator('#category-overlay')).toBeVisible();

  const z = await page.evaluate(() => ({
    category: getComputedStyle(document.getElementById('category-overlay')).zIndex,
    detail: getComputedStyle(document.getElementById('tx-detail-overlay')).zIndex
  }));

  expect(Number(z.category)).toBeGreaterThan(Number(z.detail));
});

test('parent can split a posted transaction with a balanced compact editor', async ({ page }) => {
  const detail = {
    id: 148,
    merchant_name: 'Costco',
    name: 'Costco',
    effective_display_name: 'Costco',
    raw_display_name: 'Costco',
    raw_display_name_is_check_like: false,
    display_name_override: null,
    rename_rule: null,
    amount: 179.10,
    date: '2026-07-19',
    account_name: 'Costco Visa',
    account_mask: '9690',
    category_id: 2,
    category_name: 'Groceries',
    category_color: '#22c55e',
    category_icon: null,
    category_allocations: [{ category_id: 2, category_name: 'Groceries', amount: 179.10, position: 1 }],
    is_split: false,
    source: 'plaid',
    pending: false,
    source_removed: false,
    note: null,
    attachments: []
  };

  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ id: 1, name: 'Eric', role: 'parent', avatar_emoji: '🧑' })
  }));
  await page.route('**/api/categories', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { id: 2, name: 'Groceries', color: '#22c55e', icon: null },
      { id: 3, name: 'Healthcare', color: '#ef4444', icon: null }
    ])
  }));
  await page.route('**/api/transactions?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transactions: [detail], total: 1, sum: 179.10, limit: 50, offset: 0 })
  }));
  await page.route('**/api/transactions/148', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ transaction: detail })
  }));

  let savedPayload;
  await page.route('**/api/transactions/148/allocations', async route => {
    savedPayload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, id: 148, allocations: savedPayload.allocations })
    });
  });

  await page.goto('/transactions.html');
  await page.locator('.tx-row').first().click();
  await page.getByRole('button', { name: 'Reassign category' }).click();
  await page.getByRole('button', { name: 'Split transaction' }).click();

  const rows = page.locator('.split-allocation-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByLabel('Split category').selectOption('2');
  await rows.nth(0).getByLabel('Allocation amount').fill('130.00');
  await rows.nth(1).getByLabel('Split category').selectOption('3');
  await rows.nth(1).getByLabel('Allocation amount').fill('49.10');

  await expect(page.locator('#split-editor-remaining')).toHaveText('Remaining $0.00');
  await expect(page.getByRole('button', { name: 'Save split' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save split' }).click();
  await expect(page.locator('#category-overlay')).toBeHidden();

  expect(savedPayload).toEqual({
    allocations: [
      { category_id: 2, amount: '130.00' },
      { category_id: 3, amount: '49.10' }
    ]
  });
});
