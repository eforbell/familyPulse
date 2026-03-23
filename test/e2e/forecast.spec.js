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

test.describe('Forecast page', () => {

  test('loads and shows forecast content or empty state', async ({ page }) => {
    await page.goto('/forecast.html');

    // Should not stay on loading forever
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    // Either forecast content or empty state should be visible
    const content = page.locator('#forecast-content');
    const empty = page.locator('#forecast-empty');
    const isContentVisible = await content.isVisible();
    const isEmptyVisible = await empty.isVisible();
    expect(isContentVisible || isEmptyVisible).toBe(true);
  });

  test('hero section shows balance and outlook', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    // Skip if no forecast data
    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    await expect(page.locator('#hero-balance')).toBeVisible();
    await expect(page.locator('#hero-outlook')).toBeVisible();
    await expect(page.locator('#hero-danger')).toBeVisible();

    // Balance should be a dollar amount
    const balanceText = await page.locator('#hero-balance').textContent();
    expect(balanceText).toMatch(/\$/);
  });

  test('chart canvas is rendered', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    await expect(page.locator('#forecast-chart')).toBeAttached();
  });

  test('monthly outlook cards are present', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    const cards = page.locator('.monthly-card');
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
  });

  test('planned expenses section has add button', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    const addBtn = page.locator('button', { hasText: '+ Add' });
    await expect(addBtn).toBeVisible();
  });

  test('add planned expense modal opens and closes', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    // Open modal
    await page.locator('button', { hasText: '+ Add' }).click();
    await expect(page.locator('#planned-overlay')).toBeVisible();
    await expect(page.locator('#planned-name')).toBeVisible();

    // Close modal
    await page.locator('button', { hasText: 'Cancel' }).click();
    await expect(page.locator('#planned-overlay')).toBeHidden();
  });

  test('refresh button triggers forecast recomputation', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    const refreshBtn = page.locator('#refresh-btn');
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    // Button should show "Refreshing..." then go back to "Refresh"
    await expect(refreshBtn).toHaveText('Refresh', { timeout: 10_000 });
  });

  test('forecast assumptions section is expandable', async ({ page }) => {
    await page.goto('/forecast.html');
    await expect(page.locator('#forecast-loading')).toBeHidden({ timeout: 10_000 });

    if (await page.locator('#forecast-empty').isVisible()) {
      test.skip();
      return;
    }

    const details = page.locator('.assumptions-details');
    await expect(details).toBeAttached();

    // Click to expand
    await details.locator('summary').click();
    await expect(page.locator('#assumptions-body')).toBeVisible();
  });

  test('nav includes Forecast entry', async ({ page }) => {
    await page.goto('/forecast.html');
    const navLink = page.locator('nav a[href="forecast.html"], nav a[data-id="forecast"]');
    // Check sidebar or bottom nav has the forecast link
    const forecastNav = page.locator('text=Forecast');
    await expect(forecastNav.first()).toBeAttached();
  });
});
