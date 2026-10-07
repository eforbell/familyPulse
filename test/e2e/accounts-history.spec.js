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

const multi = () => history({
  net: [900, 1000, 1100],
  accounts: [
    { id: 1, name: 'Checking', type: 'depository', mask: null, data_from: dates[0], values: [500, 600, 700] },
    { id: 2, name: 'Savings', type: 'depository', mask: null, data_from: dates[0], values: [1000, 1000, 1000] },
    { id: 3, name: 'Visa', type: 'credit', mask: null, data_from: dates[0], values: [-600, -600, -600] }
  ]
});

test('hover lists net first, then accounts sorted by balance high to low', async ({ page }) => {
  await mockHistory(page, multi());
  await page.goto('/accounts.html');
  const svg = page.locator('#history-chart svg');
  await expect(svg).toBeVisible();
  const box = await svg.boundingBox();
  await page.mouse.move(box.x + box.width - 2, box.y + 40);
  const names = await page.locator('.hc-tip-row > span').allInnerTexts();
  expect(names).toEqual(['Net position', 'Savings', 'Checking', 'Visa']);
});

test('axes carry multiple tick marks', async ({ page }) => {
  // A realistic 3-month weekly series (the 2-week fixture only spans one calendar tick).
  const wk = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 6, 7 + i * 7)).toISOString().slice(0, 10));
  const ramp = base => wk.map((_, i) => base + i * 100);
  await mockHistory(page, history({
    dates: wk, start: wk[0], end: wk[13], net: ramp(1000),
    accounts: [{ id: 1, name: 'Checking', type: 'depository', mask: null, data_from: wk[0], values: ramp(1000) }]
  }));
  await page.goto('/accounts.html');
  await expect(page.locator('#history-chart svg')).toBeVisible();
  expect(await page.locator('.hc-ylabels span').count()).toBeGreaterThanOrEqual(5);
  expect(await page.locator('.hc-xlabels span').count()).toBeGreaterThanOrEqual(4);
});

test('stacked view builds layers toward the net line and remembers the choice', async ({ page }) => {
  await mockHistory(page, multi());
  await page.goto('/accounts.html');
  await expect(page.locator('#history-chart .hc-layer')).toHaveCount(0);
  await page.click('#history-view button[data-view="stacked"]');
  // Checking + Savings above zero, Visa below zero.
  await expect(page.locator('#history-chart .hc-layer')).toHaveCount(3);
  await expect(page.locator('#history-chart .hc-line.hc-net')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#history-view button[data-view="stacked"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#history-chart .hc-layer')).toHaveCount(3);
});
