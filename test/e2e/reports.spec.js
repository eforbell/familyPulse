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

test.describe('Reports page', () => {

  test('loads with 3 chart sections visible', async ({ page }) => {
    await page.goto('/reports.html');
    await expect(page.locator('#reports-content')).toBeVisible();
    await expect(page.locator('#income-spending-chart')).toBeAttached();
    await expect(page.locator('#category-doughnut-chart')).toBeAttached();
    await expect(page.locator('#category-trends-chart')).toBeAttached();
  });

  test('doughnut month selector switches without error', async ({ page }) => {
    await page.goto('/reports.html');
    const select = page.locator('#doughnut-month-select');
    await expect(select).toBeVisible();

    // Wait for options to populate
    await expect(select.locator('option')).not.toHaveCount(0);

    // Select the second option (previous month)
    const options = await select.locator('option').allTextContents();
    if (options.length > 1) {
      await select.selectOption({ index: 1 });
    }

    // Canvas should still be attached after switch
    await expect(page.locator('#category-doughnut-chart')).toBeAttached();

    // No JS errors should have occurred — page should still be functional
    await expect(page.locator('#reports-content')).toBeVisible();
  });

  test('theme toggle re-renders charts', async ({ page }) => {
    await page.goto('/reports.html');
    await expect(page.locator('#income-spending-chart')).toBeAttached();

    // Switch to light theme
    await page.evaluate(() => PulseTheme.setPreference('light'));
    const theme = await page.locator('html').getAttribute('data-theme');
    expect(theme).toBe('light');

    // All 3 canvases should still be attached after theme change
    await expect(page.locator('#income-spending-chart')).toBeAttached();
    await expect(page.locator('#category-doughnut-chart')).toBeAttached();
    await expect(page.locator('#category-trends-chart')).toBeAttached();

    // Switch back to dark
    await page.evaluate(() => PulseTheme.setPreference('dark'));
    const themeDark = await page.locator('html').getAttribute('data-theme');
    expect(themeDark).toBe('dark');
  });

  test('Ask Pulse and What-If sections are interactive', async ({ page }) => {
    await page.goto('/reports.html');
    await expect(page.locator('#report-ask-input')).toBeVisible();
    await expect(page.locator('#report-whatif-input')).toBeVisible();

    // Ask button is present and clickable
    const askBtn = page.locator('button', { hasText: 'Ask' });
    await expect(askBtn).toBeVisible();

    // Forecast button is present
    const forecastBtn = page.locator('button', { hasText: 'Forecast' });
    await expect(forecastBtn).toBeVisible();
  });

  test('history section loads', async ({ page }) => {
    await page.goto('/reports.html');
    const historyList = page.locator('#query-history-list');
    await expect(historyList).toBeAttached();

    // Wait for loading state to resolve (either shows entries or empty state)
    await expect(historyList.locator('.loading-pulse')).not.toBeVisible({ timeout: 10_000 });
  });

});
