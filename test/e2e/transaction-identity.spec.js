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

test.describe('Transaction identity overrides', () => {
  test('parent can rename a transaction display name in the detail overlay', async ({ page }) => {
    let detail = {
      id: 301,
      merchant_name: 'Crateandbar',
      name: 'CRATEANDBAR 00482',
      effective_display_name: 'Crateandbar',
      raw_display_name: 'Crateandbar',
      raw_display_name_is_check_like: false,
      display_name_override: null,
      rename_rule: null,
      amount: 52.19,
      date: '2026-03-24',
      account_name: 'Household Checking',
      account_mask: '1111',
      category_name: 'Shopping',
      source: 'plaid',
      pending: false,
      source_removed: false,
      note: null,
      attachments: []
    };

    await page.route('**/api/auth/me', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, name: 'Eric', role: 'parent', avatar_emoji: '🧑' })
      });
    });

    await page.route('**/api/accounts/dashboard', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ groups: { Household: [] }, historical_groups: {} })
      });
    });

    await page.route('**/api/categories', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 9, name: 'Shopping', color: '#10b981', icon: '🛍️' }])
      });
    });

    await page.route('**/api/transactions?**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [{
            id: 301,
            merchant_name: 'Crateandbar',
            name: 'CRATEANDBAR 00482',
            effective_display_name: detail.effective_display_name,
            raw_display_name: detail.raw_display_name,
            amount: 52.19,
            date: '2026-03-24',
            account_name: 'Household Checking',
            account_mask: '1111',
            category_name: 'Shopping',
            category_color: '#10b981',
            category_icon: '🛍️',
            source: 'plaid',
            pending: false,
            is_hidden: false,
            account_sync_status: 'active'
          }],
          total: 1,
          sum: 52.19,
          limit: 50,
          offset: 0
        })
      });
    });

    await page.route('**/api/transactions/301', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transaction: detail })
      });
    });

    await page.route('**/api/transactions/301/display-name', async route => {
      if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData() || '{}');
        detail = {
          ...detail,
          display_name_override: body.display_name.trim() || null,
          effective_display_name: body.display_name.trim() || 'Crateandbar',
          rename_rule: body.apply_to_future
            ? {
                id: 14,
                raw_source_text: 'Crateandbar',
                display_name: body.display_name.trim(),
                enabled: true,
                match_type: 'exact'
              }
            : null,
          display_name_override_updated_at: '2026-03-27T12:00:00.000Z',
          display_name_override_updated_by_name: 'Eric'
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, transaction: detail })
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/transactions.html');

    await page.locator('.tx-row').first().click();
    await expect(page.locator('#tx-detail-title')).toHaveText('Crateandbar');
    await expect(page.locator('#tx-display-name-rule-check')).toBeChecked();
    await page.locator('#tx-display-name-input').fill('Crate & Barrel');
    await page.getByRole('button', { name: 'Save Name' }).click();
    await expect(page.locator('#tx-detail-feedback')).toContainText('Display name saved.');
    await expect(page.locator('#tx-detail-title')).toHaveText('Crate & Barrel');
    await expect(page.locator('#tx-detail-raw')).toContainText('Crateandbar');
  });

  test('check-style transactions default future rename off', async ({ page }) => {
    const detail = {
      id: 302,
      merchant_name: 'Check #1024',
      name: 'CHECK #1024',
      effective_display_name: 'Check #1024',
      raw_display_name: 'Check #1024',
      raw_display_name_is_check_like: true,
      display_name_override: null,
      rename_rule: null,
      amount: 125,
      date: '2026-03-24',
      account_name: 'Household Checking',
      account_mask: '1111',
      category_name: 'Uncategorized',
      source: 'plaid',
      pending: false,
      source_removed: false,
      note: null,
      attachments: []
    };

    await page.route('**/api/auth/me', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 1, name: 'Eric', role: 'parent', avatar_emoji: '🧑' })
      });
    });

    await page.route('**/api/accounts/dashboard', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ groups: { Household: [] }, historical_groups: {} })
      });
    });

    await page.route('**/api/categories', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 1, name: 'Uncategorized', color: '#6b7280', icon: '•' }])
      });
    });

    await page.route('**/api/transactions?**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [{
            id: 302,
            merchant_name: 'Check #1024',
            name: 'CHECK #1024',
            effective_display_name: 'Check #1024',
            raw_display_name: 'Check #1024',
            amount: 125,
            date: '2026-03-24',
            account_name: 'Household Checking',
            account_mask: '1111',
            category_name: 'Uncategorized',
            category_color: '#6b7280',
            category_icon: '•',
            source: 'plaid',
            pending: false,
            is_hidden: false,
            account_sync_status: 'active'
          }],
          total: 1,
          sum: 125,
          limit: 50,
          offset: 0
        })
      });
    });

    await page.route('**/api/transactions/302', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transaction: detail })
      });
    });

    await page.goto('/transactions.html');
    await page.locator('.tx-row').first().click();
    await expect(page.locator('#tx-display-name-rule-check')).not.toBeChecked();
    await expect(page.locator('#tx-display-name-rule-hint')).toContainText('Check-style text defaults to one-off rename only.');
  });
});
