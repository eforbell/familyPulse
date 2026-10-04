'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');
const { app } = require('../server');
const {
  burnWindows,
  buildSankeyGraph,
  getSpendingBurn,
  getCashFlowSankey,
  householdToday
} = require('../lib/reports');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

describe('reports — burn windows', () => {
  it('aligns this month against last month by day, sized to the longer month', () => {
    const w = burnWindows('month_vs_last_month', '2026-03-10');
    assert.equal(w.current.start, '2026-03-01');
    assert.equal(w.current.end, '2026-04-01');
    assert.deepEqual(w.references, [{ start: '2026-02-01', end: '2026-03-01' }]);
    assert.equal(w.length, 31);
  });

  it('compares a month with the same month a year earlier', () => {
    const w = burnWindows('month_vs_last_year', '2026-01-15');
    assert.deepEqual(w.references, [{ start: '2025-01-01', end: '2025-02-01' }]);
    assert.equal(w.referenceLabel, 'January 2025');
  });

  it('averages the three complete months before this one', () => {
    const w = burnWindows('month_vs_average', '2026-02-03');
    assert.deepEqual(w.references.map(r => r.start), ['2025-11-01', '2025-12-01', '2026-01-01']);
  });

  it('starts weeks on Sunday', () => {
    const w = burnWindows('week_vs_last_week', '2026-10-07'); // a Wednesday
    assert.equal(w.current.start, '2026-10-04');
    assert.deepEqual(w.references, [{ start: '2026-09-27', end: '2026-10-04' }]);
  });

  it('rejects unknown modes', () => {
    assert.equal(burnWindows('fortnight', '2026-10-07'), null);
  });

  it('formats household today as YYYY-MM-DD in the household timezone', () => {
    // 03:00 UTC on Oct 5 is still Oct 4 in New York.
    const prev = process.env.HOUSEHOLD_TIMEZONE;
    process.env.HOUSEHOLD_TIMEZONE = 'America/New_York';
    try {
      assert.equal(householdToday(new Date('2026-10-05T03:00:00Z')), '2026-10-04');
    } finally {
      if (prev === undefined) delete process.env.HOUSEHOLD_TIMEZONE;
      else process.env.HOUSEHOLD_TIMEZONE = prev;
    }
  });
});

describe('reports — sankey graph', () => {
  const rows = [
    { id: 1, name: 'Gross Pay', icon: '💰', system_key: 'paycheck.gross_earnings', is_transfer_class: false, net: '-5000' },
    { id: 2, name: 'Federal Income Tax', icon: '🏛️', system_key: 'paycheck.federal_tax', is_transfer_class: false, net: '800' },
    { id: 3, name: 'Interest', icon: '', system_key: null, is_transfer_class: false, net: '-25.50' },
    { id: 4, name: 'Groceries', icon: '🛒', system_key: null, is_transfer_class: false, net: '900' },
    { id: 5, name: 'Dining Out', icon: '', system_key: null, is_transfer_class: false, net: '300' },
    { id: 6, name: '529 Contribution', icon: '🎓', system_key: null, is_transfer_class: true, net: '500' },
    { id: null, name: null, icon: null, system_key: null, is_transfer_class: false, net: '100' },
    { id: 7, name: 'Shopping', icon: '', system_key: null, is_transfer_class: false, net: '0' }
  ];

  function nodeValueIn(graph, id) {
    return graph.links.filter(l => l.target === id).reduce((s, l) => s + l.value, 0);
  }
  function nodeValueOut(graph, id) {
    return graph.links.filter(l => l.source === id).reduce((s, l) => s + l.value, 0);
  }

  it('classifies by sign and balances the hub with a Saved node', () => {
    const g = buildSankeyGraph(rows);
    assert.deepEqual(g.totals, { income: 5025.5, spent: 2600, net: 2425.5 });
    assert.ok(Math.abs(nodeValueIn(g, 'hub') - nodeValueOut(g, 'hub')) < 0.005);
    assert.equal(g.nodes.find(n => n.id === 'saved').value, 2425.5);
    assert.ok(!g.nodes.some(n => n.id === 'out:7'), 'zero-net categories are omitted');
  });

  it('groups payroll deductions and transfer-class categories under parent nodes', () => {
    const g = buildSankeyGraph(rows);
    assert.deepEqual(g.links.find(l => l.target === 'out:2'), { source: 'group:deductions', target: 'out:2', value: 800 });
    assert.deepEqual(g.links.find(l => l.target === 'out:6'), { source: 'group:savings', target: 'out:6', value: 500 });
    assert.equal(nodeValueOut(g, 'group:deductions'), nodeValueIn(g, 'group:deductions'));
    assert.equal(g.nodes.find(n => n.id === 'out:uncat').name, 'Uncategorized');
  });

  it('adds a shortfall source when spending exceeds income', () => {
    const g = buildSankeyGraph([
      { id: 1, name: 'Paycheck', net: '-1000' },
      { id: 2, name: 'Rent', net: '1500' }
    ]);
    assert.equal(g.totals.net, -500);
    assert.equal(g.nodes.find(n => n.id === 'src:shortfall').value, 500);
    assert.ok(!g.nodes.some(n => n.id === 'saved'));
    assert.equal(nodeValueIn(g, 'hub'), nodeValueOut(g, 'hub'));
  });

  it('folds the long tail of categories into one node', () => {
    const many = [{ id: 1, name: 'Paycheck', net: '-10000' }];
    for (let i = 0; i < 6; i++) many.push({ id: 100 + i, name: `Cat ${i}`, net: String(100 - i) });
    const g = buildSankeyGraph(many, { maxLeaves: 4 });
    const other = g.nodes.find(n => n.id === 'leaf:other');
    assert.equal(other.value, 96 + 95);
    assert.deepEqual(g.other_categories.map(o => o.name), ['Cat 4', 'Cat 5']);
    assert.equal(nodeValueIn(g, 'hub'), nodeValueOut(g, 'hub'));
  });
});

describe('reports — database', () => {
  let server;
  let baseUrl;
  let sessionToken;
  let accountId;
  let groceriesId;
  let incomeId;

  async function insertTx(id, amount, date, { pending = false, isTransfer = false, categoryId = null } = {}) {
    await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, is_transfer, source, category_id)
      VALUES ($1, $2, $3, $4, $1, $5, $6, 'test', $7)
      ON CONFLICT (plaid_transaction_id) DO NOTHING
    `, [`reports-${id}`, accountId, amount, date, pending, isTransfer, categoryId]);
  }

  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const { rows: [parent] } = await pool.query("SELECT id FROM family_members WHERE role = 'parent' LIMIT 1");
    sessionToken = crypto.randomUUID();
    await pool.query('INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3)',
      [sessionToken, parent.id, new Date(Date.now() + 86400000)]);

    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-reports', 'test-item-reports', 'ins_reports', 'Reports Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);
    const { rows: [acct] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, current_balance)
      VALUES ('acct-reports', $1, 'Reports Checking', 'depository', 'checking', 1000)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = 'Reports Checking'
      RETURNING id
    `, [item.id]);
    accountId = acct.id;

    groceriesId = (await pool.query("SELECT id FROM categories WHERE name = 'Groceries'")).rows[0].id;
    incomeId = (await pool.query("SELECT id FROM categories WHERE name = 'Income'")).rows[0].id;

    // A far-future window nothing else in the suite writes to.
    await insertTx('ref-1', 100, '2031-02-01', { categoryId: groceriesId });
    await insertTx('ref-2', 50, '2031-02-10', { categoryId: groceriesId });
    await insertTx('ref-3', 200, '2031-02-28', { categoryId: groceriesId });
    await insertTx('cur-1', 40, '2031-03-01', { categoryId: groceriesId });
    await insertTx('cur-2', 60, '2031-03-05', { categoryId: groceriesId });
    await insertTx('cur-future', 999, '2031-03-20', { categoryId: groceriesId });
    await insertTx('cur-pending', 500, '2031-03-04', { pending: true, categoryId: groceriesId });
    await insertTx('cur-transfer', 700, '2031-03-04', { isTransfer: true });
    await insertTx('cur-income', -2000, '2031-03-02', { categoryId: incomeId });
  });

  after(async () => {
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id LIKE 'reports-%'");
    await pool.query("DELETE FROM accounts WHERE plaid_account_id = 'acct-reports'");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-reports'");
    await pool.query('DELETE FROM sessions WHERE token = $1', [sessionToken]);
    server.close();
    await pool.end();
  });

  it('builds cumulative burn series through today only, excluding pending, transfers and income', async () => {
    const burn = await getSpendingBurn('month_vs_last_month', { today: '2031-03-06' });
    assert.equal(burn.today_index, 5);
    assert.deepEqual(burn.current.series, [40, 40, 40, 40, 100, 100]);
    assert.equal(burn.current.total, 100);
    assert.equal(burn.labels.length, 31);
    // Feb has 28 days: the reference carries its final total through day 31.
    assert.equal(burn.reference.series[0], 100);
    assert.equal(burn.reference.series[9], 150);
    assert.equal(burn.reference.series[27], 350);
    assert.equal(burn.reference.series[30], 350);
    assert.equal(burn.reference.to_date, 100);
    assert.equal(burn.delta_to_date, 0);
  });

  it('builds a balanced sankey from allocations for the window', async () => {
    const sankey = await getCashFlowSankey('last_month', { today: '2031-04-02' });
    assert.equal(sankey.start, '2031-03-01');
    assert.equal(sankey.end, '2031-03-31');
    assert.equal(sankey.totals.income, 2000);
    assert.equal(sankey.totals.spent, 40 + 60 + 999);
    assert.equal(sankey.nodes.find(n => n.id === 'saved').value, 2000 - 1099);
  });

  it('serves both reports to parents and validates parameters', async () => {
    const headers = { Cookie: `fp_session=${sessionToken}` };
    const burn = await fetch(`${baseUrl}/api/reports/spending-burn?mode=year_vs_last_year`, { headers });
    assert.equal(burn.status, 200);
    const burnBody = await burn.json();
    assert.equal(burnBody.mode, 'year_vs_last_year');
    assert.equal(burnBody.labels.length, burnBody.reference.series.length);

    const sankey = await fetch(`${baseUrl}/api/reports/cash-flow-sankey?range=last_12_months`, { headers });
    assert.equal(sankey.status, 200);
    assert.ok(Array.isArray((await sankey.json()).nodes));

    assert.equal((await fetch(`${baseUrl}/api/reports/spending-burn?mode=nope`, { headers })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/reports/cash-flow-sankey?range=nope`, { headers })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/reports/spending-burn`)).status, 401);
  });
});
