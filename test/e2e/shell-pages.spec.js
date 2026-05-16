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

test.describe('Migrated parent shell pages', () => {
  test('dashboard renders sovereign frame and transaction section', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('header.app-header')).toBeVisible();
    await expect(page.locator('#net-position-card')).toBeVisible();
    await expect(page.locator('#tx-list')).toBeAttached();
    await expect(page.locator('text=Dashboard').first()).toBeVisible();
  });

  test('transactions page renders filter shell and list', async ({ page }) => {
    await page.goto('/transactions.html');
    await expect(page.locator('header.app-header')).toBeVisible();
    await expect(page.locator('#filter-bar')).toBeVisible();
    await expect(page.locator('#filter-chips')).toBeVisible();
    await expect(page.locator('#tx-list')).toBeAttached();
  });

  test('accounts page renders hero and account grid', async ({ page }) => {
    await page.goto('/accounts.html');
    await expect(page.locator('header.app-header')).toBeVisible();
    await expect(page.locator('#net-position-card')).toBeVisible();
    await expect(page.locator('#accounts-grid')).toBeAttached();

    const backgroundImage = await page.locator('#net-position-card').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(backgroundImage.includes('gradient')).toBe(false);
  });

  test('settings page renders institutions and theme controls', async ({ page }) => {
    await page.goto('/settings.html');
    await expect(page.locator('header.app-header')).toBeVisible();
    await expect(page.locator('#items-list')).toBeAttached();
    await expect(page.locator('#theme-switch')).toBeVisible();
  });

  test('admin page renders category/rule lists and category modal opens', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('header.app-header')).toBeVisible();
    await expect(page.locator('#category-admin-list')).toBeAttached();
    await expect(page.locator('#rules-admin-list')).toBeAttached();

    await page.getByRole('button', { name: '+ New' }).first().click();
    await expect(page.locator('#category-form-overlay')).toBeVisible();
    await expect(page.locator('#cat-name')).toBeVisible();
    await page.locator('#category-form-overlay .modal-close').click();
    await expect(page.locator('#category-form-overlay')).toBeHidden();
  });
});
