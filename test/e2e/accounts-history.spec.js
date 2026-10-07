'use strict';

const { test, expect } = require('@playwright/test');
const { loginAs, cleanupSession, closePool } = require('./helpers/auth');

let sessionToken;

const dates = ['2026-07-07', '2026-07-14', '2026-07-21'];
const history = (over = {}) => ({
  range: '3m', label: '3 months', start: dates[0], end: dates[2], step_days: 7, dates,
  net: [1000, 1100, 1250],
  accounts: [{ id: 1, name: 'Checking', type: 'depository', mask: '1111', data_from: dates[0], values: [1000, 1100, 1250] }],
  partial_accounts: [],
  ...over
});

async function mockHistory(page, body) {
  await page.route('**/api/accounts/history?**', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
}

test.beforeEach(async ({ page }) => {
  const { token } = await loginAs(page, { role: 'parent', name: 'Eric' });
  sessionToken = token;
});
test.afterEach(async () => { await cleanupSession(sessionToken); });
test.afterAll(async () => { await closePool(); });

test('draws net and account lines on one chart', async ({ page }) => {
  await mockHistory(page, history());
  await page.goto('/accounts.html');
  await expect(page.locator('#history-chart svg')).toBeVisible();
  await expect(page.locator('#history-chart .hc-line')).toHaveCount(2);
  await expect(page.locator('#history-note')).toBeHidden();
});

test('a single data point shows the empty message instead of a blank chart', async ({ page }) => {
  await mockHistory(page, history({
    dates: ['2026-07-21'], net: [1250],
    accounts: [{ id: 1, name: 'Checking', type: 'depository', mask: null, data_from: '2026-07-21', values: [1250] }]
  }));
  await page.goto('/accounts.html');
  await expect(page.locator('#history-chart')).toContainText('Not enough synced history');
  await expect(page.locator('#history-chart .hc-line')).toHaveCount(0);
});

test('limited-history note stays one short line and points to the operator guide', async ({ page }) => {
  await mockHistory(page, history({
    partial_accounts: [
      { id: 2, name: 'Imported Checking', data_from: null, reason: 'unknown_balance' },
      { id: 3, name: 'New Card', data_from: '2026-07-21', reason: 'starts_late' }
    ]
  }));
  await page.goto('/accounts.html');
  const note = page.locator('#history-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('2 accounts have limited history');
  await expect(note).toContainText('operator guide');
  expect((await note.innerText()).length).toBeLessThan(120);
});

test('privacy mode blurs history amounts and the chart', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pulse-privacy-mode', 'on'));
  await mockHistory(page, history());
  await page.goto('/accounts.html');
  await expect(page.locator('html')).toHaveClass(/privacy-mode/);
  await expect(page.locator('#history-chart svg')).toBeVisible();
  const filter = sel => page.locator(sel).first().evaluate(el => getComputedStyle(el).filter);
  expect(await filter('.history-net-delta')).not.toBe('none');
  expect(await filter('.hc-ylabels span')).not.toBe('none');
  expect(await filter('.hc-plot svg')).not.toBe('none');
});
