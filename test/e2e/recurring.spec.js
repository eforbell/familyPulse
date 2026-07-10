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

test.describe('Recurring page', () => {
  test('loads summary and recurring sections for a parent', async ({ page }) => {
    await page.goto('/recurring.html');

    await expect(page.locator('#recurring-summary')).toBeVisible();
    await expect(page.locator('#recurring-summary')).not.toHaveClass(/loading-pulse/, { timeout: 10_000 });
    await expect(page.locator('#bill-calendar')).toBeVisible();
    const backgroundImage = await page.locator('#recurring-summary').evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(backgroundImage.includes('gradient')).toBe(false);
    await expect(page.locator('#recurring-list')).toBeVisible();
    await expect(page.locator('#recurring-stale')).toBeVisible();
  });

  test('parent can view recurring history and toggle status', async ({ page }) => {
    let currentStatus = 'active';
    const recurringRow = () => ({
      id: 101,
      merchant_name: 'Netflix',
      cashflow_type: 'expense',
      frequency: 'monthly',
      confidence: 'high',
      status: currentStatus,
      account_name: 'Household Checking',
      latest_amount: 22.99,
      prior_amount: 15.49,
      price_change_pct: 48.42,
      price_change_direction: 'up',
      price_change_date: '2026-04-05',
      first_seen_date: '2026-01-05',
      last_seen_date: '2026-04-05',
      expected_next_date: '2026-05-05',
      interval_days: 30,
      tolerance_days: 3
    });

    await page.route('**/api/recurring/summary', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          committed_monthly_total: currentStatus === 'active' ? 22.99 : 0,
          recurring_income_monthly_total: 0,
          active_count: currentStatus === 'active' ? 1 : 0,
          price_increase_count: 1,
          stale_count: currentStatus === 'active' ? 0 : 1
        })
      });
    });

    await page.route('**/api/recurring/calendar?days=30', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          days: 30,
          calendar: currentStatus === 'active' ? [{
            merchant_name: 'Netflix',
            expected_amount: 22.99,
            expected_date: '2026-05-05',
            account_name: 'Household Checking',
            frequency: 'monthly',
            confidence: 'high'
          }] : []
        })
      });
    });

    await page.route('**/api/recurring/101/history', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          history: [
            { amount: 22.99, transaction_date: '2026-04-05' },
            { amount: 15.49, transaction_date: '2026-03-05' }
          ]
        })
      });
    });

    await page.route('**/api/recurring/101', async route => {
      if (route.request().method() === 'PATCH') {
        const body = JSON.parse(route.request().postData() || '{}');
        currentStatus = body.status || currentStatus;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ recurring: recurringRow() })
        });
        return;
      }
      await route.continue();
    });

    await page.route('**/api/recurring', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recurring: [recurringRow()] })
      });
    });

    await page.goto('/recurring.html');

    await page.getByRole('button', { name: 'View Details' }).click();
    await expect(page.locator('#recurring-detail-overlay')).toBeVisible();
    await expect(page.locator('#recurring-detail-title')).toHaveText('Netflix');
    await expect(page.locator('#recurring-detail-history')).toContainText('Apr 5');
    await expect(page.locator('#recurring-detail-history')).toContainText('$22.99');

    await page.getByRole('button', { name: 'Paused' }).click();
    await expect(page.locator('#recurring-detail-feedback')).toContainText('Status updated to paused.');
    await expect(page.locator('#recurring-stale')).toContainText('Netflix');
    await expect(page.locator('#recurring-list')).not.toContainText('Netflix');
  });


  test('renders and dismisses recurring health alerts on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    let alerts = [{
      id: 501,
      recurring_expense_id: 101,
      event_type: 'recurring_missed_income',
      title: 'Expected income is late',
      message: 'ACME Payroll was expected Jul 5 and is 2 days late.',
      merchant_name: 'ACME Payroll',
      occurred_on: '2026-07-07'
    }];

    await page.route('**/api/recurring/summary', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          committed_monthly_total: 0,
          recurring_income_monthly_total: 2500,
          active_count: 1,
          price_increase_count: 0,
          stale_count: 0
        })
      });
    });

    await page.route('**/api/recurring/calendar?days=30', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ days: 30, calendar: [] }) });
    });

    await page.route('**/api/recurring/alerts?limit=10', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ alerts }) });
    });

    await page.route('**/api/recurring/alerts/501/dismiss', async route => {
      alerts = [];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 501 }) });
    });

    await page.route('**/api/recurring', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recurring: [{
          id: 101,
          merchant_name: 'ACME Payroll',
          cashflow_type: 'income',
          frequency: 'biweekly',
          confidence: 'high',
          status: 'active',
          account_name: 'Household Checking',
          latest_amount: 2500,
          prior_amount: 2500,
          price_change_pct: 0,
          price_change_direction: null,
          first_seen_date: '2026-01-01',
          last_seen_date: '2026-06-21',
          expected_next_date: '2026-07-05',
          interval_days: 14,
          tolerance_days: 2
        }] })
      });
    });

    await page.goto('/recurring.html');

    await expect(page.locator('#recurring-alerts-section')).toBeVisible();
    await expect(page.locator('.recurring-alert-card')).toContainText('Expected income is late');
    const flexDirection = await page.locator('.recurring-alert-card').evaluate(el => getComputedStyle(el).flexDirection);
    expect(flexDirection).toBe('column');

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('#recurring-alerts-section')).toBeHidden();
  });

  test('kid is redirected away from recurring page', async ({ page }) => {
    await cleanupSession(sessionToken);
    const { token } = await loginAs(page, { role: 'kid', name: 'Jordan' });
    sessionToken = token;

    await page.goto('/recurring.html');
    await expect(page).toHaveURL(/\/kids\//, { timeout: 5_000 });
  });
});
