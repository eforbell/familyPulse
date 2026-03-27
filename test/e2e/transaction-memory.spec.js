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

test.describe('Transaction memory detail', () => {
  test('parent can open detail, save note, and upload attachment', async ({ page }) => {
    let detail = {
      id: 101,
      merchant_name: 'Home Depot',
      name: 'HOME DEPOT',
      amount: 120.45,
      date: '2026-03-20',
      account_name: 'Household Checking',
      account_mask: '1111',
      category_name: 'Home',
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
        body: JSON.stringify([{ id: 7, name: 'Home', color: '#10b981', icon: '🏠' }])
      });
    });

    await page.route('**/api/transactions?**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transactions: [{
            id: 101,
            merchant_name: 'Home Depot',
            name: 'HOME DEPOT',
            amount: 120.45,
            date: '2026-03-20',
            account_name: 'Household Checking',
            account_mask: '1111',
            category_name: 'Home',
            category_color: '#10b981',
            category_icon: '🏠',
            source: 'plaid',
            pending: false,
            is_hidden: false,
            account_sync_status: 'active'
          }],
          total: 1,
          sum: 120.45,
          limit: 50,
          offset: 0
        })
      });
    });

    await page.route('**/api/transactions/101', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ transaction: detail })
        });
        return;
      }
      await route.continue();
    });

    await page.route('**/api/transactions/101/note', async route => {
      if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData() || '{}');
        detail = {
          ...detail,
          note: {
            text: body.note,
            updated_at: '2026-03-27T12:00:00.000Z',
            updated_by_name: 'Eric'
          }
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

    await page.route('**/api/transactions/101/attachments', async route => {
      if (route.request().method() === 'POST') {
        detail = {
          ...detail,
          attachments: [{
            id: 900,
            transaction_id: 101,
            original_filename: 'receipt.pdf',
            mime_type: 'application/pdf',
            byte_size: 2048,
            created_at: '2026-03-27T12:00:00.000Z',
            uploaded_by_name: 'Eric'
          }]
        };
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, attachments: detail.attachments })
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/transactions.html');

    await page.locator('.tx-row').first().click();
    await expect(page.locator('#tx-detail-overlay')).toBeVisible();
    await expect(page.locator('#tx-detail-title')).toHaveText('Home Depot');

    await page.locator('#tx-note-input').fill('Keep for warranty claim');
    await page.getByRole('button', { name: 'Save Note' }).click();
    await expect(page.locator('#tx-detail-feedback')).toContainText('Note saved.');
    await expect(page.locator('#tx-note-meta')).toContainText('Eric');

    await page.setInputFiles('#tx-attachment-input', {
      name: 'receipt.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4')
    });
    await page.getByRole('button', { name: 'Upload' }).click();
    await expect(page.locator('#tx-detail-feedback')).toContainText('Attachments uploaded.');
    await expect(page.locator('#tx-attachment-list')).toContainText('receipt.pdf');
    await expect(page.locator('#tx-attachment-list')).toContainText('2 KB');
  });

  test('kid sees transaction note and attachments read-only on kids dashboard', async ({ page }) => {
    await cleanupSession(sessionToken);
    const { token } = await loginAs(page, { role: 'kid', name: 'Jordan' });
    sessionToken = token;

    await page.route('**/api/auth/me', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 2, name: 'Jordan', role: 'kid', avatar_emoji: '🧒' })
      });
    });

    await page.route('**/api/categories', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 7, name: 'Fun', color: '#10b981', icon: '🎮' }])
      });
    });

    await page.route('**/api/kids/dashboard', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          member: { name: 'Jordan', emoji: '🧒' },
          accounts: [{ id: 1, name: 'Kid Checking' }],
          balance_total: 50,
          depository_balance_label: 'Available',
          month_spending: 14.25,
          budget: null,
          category_breakdown: [],
          recent_transactions: [{
            id: 202,
            merchant_name: 'Arcade',
            name: 'ARCADE',
            amount: 14.25,
            date: '2026-03-21',
            account_name: 'Kid Checking',
            account_mask: '2222',
            category_name: 'Fun',
            category_color: '#10b981',
            category_icon: '🎮',
            source: 'plaid',
            pending: false,
            is_hidden: false,
            account_sync_status: 'active'
          }]
        })
      });
    });

    await page.route('**/api/kids/report-card', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ report: null })
      });
    });

    await page.route('**/api/transactions/202', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          transaction: {
            id: 202,
            merchant_name: 'Arcade',
            name: 'ARCADE',
            amount: 14.25,
            date: '2026-03-21',
            account_name: 'Kid Checking',
            account_mask: '2222',
            category_name: 'Fun',
            source: 'plaid',
            pending: false,
            source_removed: false,
            note: {
              text: 'Birthday outing',
              updated_at: '2026-03-27T12:00:00.000Z',
              updated_by_name: 'Eric'
            },
            attachments: [{
              id: 901,
              transaction_id: 202,
              original_filename: 'arcade.jpg',
              mime_type: 'image/jpeg',
              byte_size: 1024,
              created_at: '2026-03-27T12:00:00.000Z',
              uploaded_by_name: 'Eric'
            }]
          }
        })
      });
    });

    await page.goto('/kids/jordan');

    await page.locator('.tx-row').first().click();
    await expect(page.locator('#kid-tx-detail-overlay')).toBeVisible();
    await expect(page.locator('#kid-tx-note-readonly')).toContainText('Birthday outing');
    await expect(page.locator('#kid-tx-attachment-list')).toContainText('arcade.jpg');
    await expect(page.locator('#kid-tx-attachment-list')).toContainText('1 KB');
  });
});
