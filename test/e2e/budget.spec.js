'use strict';

const { test, expect } = require('@playwright/test');
const { loginAs, cleanupSession, closePool } = require('./helpers/auth');

let sessionToken;

test.afterAll(async () => {
  await closePool();
});

test.describe('Budget page (parent)', () => {

  test.beforeEach(async ({ page }) => {
    const { token } = await loginAs(page, { role: 'parent', name: 'Eric' });
    sessionToken = token;
  });

  test.afterEach(async () => {
    await cleanupSession(sessionToken);
  });

  test('summary hero loads with income, spending, and net', async ({ page }) => {
    await page.goto('/budget.html');
    await expect(page.locator('#summary-hero')).toBeVisible();

    // Wait for loading to finish (loading-pulse class removed)
    await expect(page.locator('#summary-hero')).not.toHaveClass(/loading-pulse/, { timeout: 10_000 });

    await expect(page.locator('#summary-income')).toBeVisible();
    await expect(page.locator('#summary-spending')).toBeVisible();
    await expect(page.locator('#summary-net')).toBeVisible();
    await expect(page.locator('#commitment-strip')).toBeVisible();

    const backgroundImage = await page.locator('#summary-hero').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(backgroundImage.includes('gradient')).toBe(false);
  });

  test('month navigation changes the label', async ({ page }) => {
    await page.goto('/budget.html');
    await expect(page.locator('#month-label')).toBeVisible();

    // Wait for initial data load
    await expect(page.locator('#summary-hero')).not.toHaveClass(/loading-pulse/, { timeout: 10_000 });

    const initialLabel = await page.locator('#month-label').textContent();

    // Click previous month
    await page.locator('#prev-month-btn').click();

    // Label should change
    await expect(page.locator('#month-label')).not.toHaveText(initialLabel);
  });

  test('category grid renders', async ({ page }) => {
    await page.goto('/budget.html');
    await expect(page.locator('#budget-grid')).toBeAttached();

    // Wait for budget data to load
    await expect(page.locator('#summary-hero')).not.toHaveClass(/loading-pulse/, { timeout: 10_000 });
  });

});

test.describe('Budget page (kid redirect)', () => {

  test('kid is redirected to their dashboard', async ({ page }) => {
    const { token } = await loginAs(page, { role: 'kid', name: 'Jordan' });
    sessionToken = token;

    await page.goto('/budget.html');

    // Kid should be redirected to /kids/:name
    await expect(page).toHaveURL(/\/kids\//, { timeout: 5_000 });
  });

});
