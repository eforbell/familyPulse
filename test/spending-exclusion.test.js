'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { app } = require('../server');
const { getMonthlyBudgetSummary, getBudgetTrends } = require('../lib/budget-calculator');
const { getCashFlowSankey } = require('../lib/reports');
const { detectAnomalies } = require('../lib/anomaly-detector');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PERIOD = '2034-05';

let server;
let baseUrl;
let accountId;
let groceriesId;
let federalTaxId;
let grossPayId;
let reimbursableId;

async function categoryBySystemKey(key) {
  return (await pool.query('SELECT * FROM categories WHERE system_key = $1', [key])).rows[0];
}

async function putCategory(id, body) {
  return fetch(`${baseUrl}/api/categories/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// Mirror the Date patching in budget-api.test.js so getBudgetTrends treats
// PERIOD as the current month.
async function withCurrentMonth(year, monthIndex, fn) {
  const RealDate = global.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(year, monthIndex, 15);
      return new RealDate(...args);
    }
    static now() { return new RealDate(year, monthIndex, 15).getTime(); }
  }
  global.Date = FakeDate;
  try { return await fn(); } finally { global.Date = RealDate; }
}

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { rows: [item] } = await pool.query(`
    INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
    VALUES ('test-token-spending-excl', 'test-item-spending-excl', 'ins_spending_excl', 'Exclusion Bank', 'good')
    ON CONFLICT (item_id) DO UPDATE SET status = 'good'
    RETURNING id
  `);
  const { rows: [acct] } = await pool.query(`
    INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, current_balance)
    VALUES ('acct-spending-excl', $1, 'Exclusion Checking', 'depository', 'checking', 1000)
    ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Exclusion Checking'
    RETURNING id
  `, [item.id]);
  accountId = acct.id;

  groceriesId = (await pool.query("SELECT id FROM categories WHERE name = 'Groceries'")).rows[0].id;
  federalTaxId = (await categoryBySystemKey('paycheck.federal_tax')).id;
  grossPayId = (await categoryBySystemKey('paycheck.gross_earnings')).id;

  // A $4,000 net paycheck split into $5,000 gross and $1,000 federal tax,
  // plus a $200 grocery run.
  const { rows: [paycheck] } = await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, is_transfer, source, category_id)
    VALUES ('spending-excl-paycheck', $1, -4000, '2034-05-10', 'ACME PAYROLL', false, false, 'test', $2)
    RETURNING id
  `, [accountId, grossPayId]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [paycheck.id]);
    await client.query(`
      INSERT INTO transaction_allocations (transaction_id, category_id, amount, position)
      VALUES ($1, $2, -5000, 1), ($1, $3, 1000, 2)
    `, [paycheck.id, grossPayId, federalTaxId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await pool.query(`
    INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, is_transfer, source, category_id)
    VALUES ('spending-excl-groceries', $1, 200, '2034-05-12', 'Grocer', false, false, 'test', $2)
  `, [accountId, groceriesId]);

  // An ordinary, budgeted category the household excludes: real bank
  // spending that runs ~$100/month, then spikes to $1,500.
  const { rows: [reimbursable] } = await pool.query(`
    INSERT INTO categories (name, color, budget_amount, exclude_from_spending)
    VALUES ('Test Excl Reimbursable', '#64748b', 1500, true)
    RETURNING id
  `);
  reimbursableId = reimbursable.id;
  const history = [['2034-02-10', 100], ['2034-03-10', 100], ['2034-04-10', 100], ['2034-05-15', 1500]];
  for (const [date, amount] of history) {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, is_transfer, source, category_id)
      VALUES ($1, $2, $3, $4, 'Work trip', false, false, 'test', $5)
    `, [`spending-excl-reimb-${date}`, accountId, amount, date, reimbursableId]);
  }
});

after(async () => {
  await pool.query('UPDATE categories SET exclude_from_spending = true WHERE id = $1', [federalTaxId]);
  await pool.query('UPDATE categories SET exclude_from_spending = false WHERE id = $1', [groceriesId]);
  await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'spending-excl-%'");
  await pool.query('DELETE FROM anomalies WHERE category_id = $1', [reimbursableId]);
  await pool.query('DELETE FROM categories WHERE id = $1', [reimbursableId]);
  await pool.query('DELETE FROM budget_snapshots WHERE period = $1', [PERIOD]);
  await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-spending-excl'");
  await pool.query("DELETE FROM items WHERE item_id = 'test-item-spending-excl'");
  server.close();
  await pool.end();
});

describe('exclude_from_spending — migration defaults', () => {
  it('excludes payroll deductions but not gross pay or ordinary categories', async () => {
    const { rows } = await pool.query(
      "SELECT system_key, exclude_from_spending FROM categories WHERE system_key LIKE 'paycheck.%'"
    );
    assert.equal(rows.length, 7);
    for (const r of rows) {
      assert.equal(r.exclude_from_spending, r.system_key !== 'paycheck.gross_earnings', r.system_key);
    }
    const { rows: [groceries] } = await pool.query('SELECT exclude_from_spending FROM categories WHERE id = $1', [groceriesId]);
    assert.equal(groceries.exclude_from_spending, false);
  });
});

describe('exclude_from_spending — spending views', () => {
  it('drops excluded categories from Budget cards but leaves bank-basis totals alone', async () => {
    const summary = await getMonthlyBudgetSummary(PERIOD);
    assert.ok(!summary.categories.some(c => c.id === federalTaxId), 'federal tax hidden from Budget cards');
    assert.ok(!summary.categories.some(c => c.id === reimbursableId), 'excluded budget card hidden');
    assert.equal(summary.categories.find(c => c.id === groceriesId).spent, 200);
    assert.equal(summary.spending.actual, 1700);
    assert.equal(summary.income.current, 4000);
  });

  it('compares the budget against spending in the same categories', async () => {
    const summary = await getMonthlyBudgetSummary(PERIOD);
    // The excluded $1,500 budget is gone from budgeted, so the matching $1,500
    // of bank spending must leave the comparison too. Payroll deductions never
    // reached bank spending, so they are not subtracted.
    assert.equal(summary.spending.excluded, 1500);
    assert.equal(summary.spending.in_budgeted_categories, 200);
    assert.ok(!summary.categories.some(c => c.budgeted === 1500));
  });

  it('raises no anomalies for excluded categories and hides ones detected earlier', async () => {
    await pool.query('DELETE FROM anomalies WHERE category_id = $1', [reimbursableId]);
    await detectAnomalies(PERIOD);
    let { rows } = await pool.query('SELECT 1 FROM anomalies WHERE category_id = $1', [reimbursableId]);
    assert.equal(rows.length, 0, 'excluded category produced an anomaly');

    // Sanity check: the same spike is flagged while the category is included.
    await pool.query('UPDATE categories SET exclude_from_spending = false WHERE id = $1', [reimbursableId]);
    await detectAnomalies(PERIOD);
    ({ rows } = await pool.query('SELECT 1 FROM anomalies WHERE category_id = $1', [reimbursableId]));
    assert.ok(rows.length > 0, 'spike should be detected while included');

    // Excluding it afterwards hides the already-detected anomaly.
    await pool.query('UPDATE categories SET exclude_from_spending = true WHERE id = $1', [reimbursableId]);
    const body = await (await fetch(`${baseUrl}/api/anomalies?period=${PERIOD}`)).json();
    assert.ok(!body.anomalies.some(a => a.category_id === reimbursableId));
  });

  it('drops excluded categories from the doughnut and Category Trends data', async () => {
    const trends = await withCurrentMonth(2034, 4, () => getBudgetTrends(1));
    assert.equal(trends.periods[0], PERIOD);
    const cats = trends.monthly[0].categories;
    assert.ok(!cats.some(c => c.id === federalTaxId));
    assert.equal(cats.find(c => c.id === groceriesId).spent, 200);
  });

  it('keeps excluded categories in the cash flow Sankey', async () => {
    const sankey = await getCashFlowSankey('last_month', { today: '2034-06-02' });
    assert.equal(sankey.nodes.find(n => n.id === `out:${federalTaxId}`).value, 1000);
    assert.equal(sankey.nodes.find(n => n.id === `src:${grossPayId}`).value, 5000);
    assert.equal(sankey.totals.net, 4000 - 200 - 1500);
  });

  it('applies a toggle immediately in both directions', async () => {
    assert.equal((await putCategory(groceriesId, { exclude_from_spending: true })).status, 200);
    let summary = await getMonthlyBudgetSummary(PERIOD);
    assert.ok(!summary.categories.some(c => c.id === groceriesId));

    // A household may opt a payroll deduction back into spending.
    assert.equal((await putCategory(federalTaxId, { exclude_from_spending: false })).status, 200);
    summary = await getMonthlyBudgetSummary(PERIOD);
    assert.equal(summary.categories.find(c => c.id === federalTaxId).spent, 1000);
  });
});

describe('PUT /api/categories/:id — partial updates', () => {
  it('a single-flag update keeps the budget amount and icon', async () => {
    await pool.query("UPDATE categories SET budget_amount = 600, icon = '🛒' WHERE id = $1", [groceriesId]);
    for (const body of [{ exclude_from_spending: false }, { exclude_from_baseline: false }]) {
      const res = await putCategory(groceriesId, body);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(parseFloat(data.budget_amount), 600, JSON.stringify(body));
      assert.equal(data.icon, '🛒', JSON.stringify(body));
    }
  });

  it('still clears budget and icon when the request sends null', async () => {
    const data = await (await putCategory(groceriesId, { budget_amount: null, icon: null })).json();
    assert.equal(data.budget_amount, null);
    assert.equal(data.icon, null);
    await pool.query("UPDATE categories SET icon = '🛒' WHERE id = $1", [groceriesId]);
  });
});
