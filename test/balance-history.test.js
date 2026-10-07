'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildBalanceHistory, buildSampleDates, rangeStart } = require('../lib/balance-history');

const TODAY = '2026-10-07';

describe('balance history reconstruction', () => {
  it('walks deposits back through Plaid-signed transactions', () => {
    // Today $1000. Spent $100 on 10-05 (+100), received $400 on 10-01 (-400).
    const h = buildBalanceHistory({
      range: '3m', today: TODAY,
      accounts: [{ id: 1, display_name: 'Checking', type: 'depository', current_balance: 1000, first_txn_date: '2026-07-01' }],
      deltas: [{ account_id: 1, date: '2026-10-05', total: 100 }, { account_id: 1, date: '2026-10-01', total: -400 }]
    });
    const v = h.accounts[0].values;
    const at = d => v[h.dates.indexOf(d)];
    assert.equal(v[v.length - 1], 1000);                    // today
    assert.equal(h.net[h.net.length - 1], 1000);
    const dayBefore = h.dates.find(d => d >= '2026-10-02' && d < '2026-10-05');
    if (dayBefore) assert.equal(at(dayBefore), 1100);        // before the $100 spend
    assert.equal(at(h.dates[0]), 1000 + 100 - 400);          // before everything: 700
  });

  it('shows credit balances as negative and nets against deposits', () => {
    // Card owes $300 now; charged $50 on 10-06, so owed $250 before.
    const h = buildBalanceHistory({
      range: '3m', today: TODAY,
      accounts: [
        { id: 1, display_name: 'Checking', type: 'depository', current_balance: 1000, first_txn_date: '2026-07-01' },
        { id: 2, display_name: 'Card', type: 'credit', current_balance: 300, first_txn_date: '2026-07-01' }
      ],
      deltas: [{ account_id: 2, date: '2026-10-06', total: 50 }]
    });
    const card = h.accounts.find(a => a.id === 2).values;
    assert.equal(card[card.length - 1], -300);
    assert.equal(card[0], -250);
    assert.equal(h.net[h.net.length - 1], 700);
    assert.equal(h.net[0], 750);
  });

  it('leaves pre-coverage points null and keeps net null until all accounts have data', () => {
    const h = buildBalanceHistory({
      range: '3m', today: TODAY,
      accounts: [
        { id: 1, display_name: 'Old', type: 'depository', current_balance: 10, first_txn_date: '2026-07-01' },
        { id: 2, display_name: 'New', type: 'depository', current_balance: 5, first_txn_date: '2026-09-15' }
      ],
      deltas: []
    });
    assert.equal(h.accounts[1].values[0], null);
    assert.equal(h.net[0], null);
    assert.equal(h.net[h.net.length - 1], 15);
    assert.deepEqual(h.partial_accounts.map(p => p.id), [2]);
  });

  it('leaves accounts with no transactions out of net instead of blanking it', () => {
    const h = buildBalanceHistory({
      range: '3m', today: TODAY,
      accounts: [
        { id: 1, display_name: 'Active', type: 'depository', current_balance: 10, first_txn_date: '2026-07-01' },
        { id: 2, display_name: 'Empty', type: 'depository', current_balance: 5, first_txn_date: null }
      ],
      deltas: []
    });
    assert.equal(h.net[0], 10);
    assert.deepEqual(h.partial_accounts.map(p => p.id), [2]);
  });

  it('skips investment and loan accounts', () => {
    const h = buildBalanceHistory({
      range: '3m', today: TODAY,
      accounts: [
        { id: 1, display_name: 'Brokerage', type: 'investment', current_balance: 99, first_txn_date: '2026-01-01' },
        { id: 2, display_name: 'Mortgage', type: 'loan', current_balance: 99, first_txn_date: '2026-01-01' }
      ],
      deltas: []
    });
    assert.equal(h.accounts.length, 0);
  });

  it('computes range starts and ends samples on today', () => {
    assert.equal(rangeStart('3m', TODAY), '2026-07-07');
    assert.equal(rangeStart('1y', TODAY), '2025-10-07');
    assert.equal(rangeStart('ytd', TODAY), '2026-01-01');
    assert.equal(rangeStart('6m', '2026-08-31'), '2026-02-28');
    const dates = buildSampleDates('2026-07-07', TODAY, 7);
    assert.equal(dates[0], '2026-07-07');
    assert.equal(dates[dates.length - 1], TODAY);
  });

  it('rejects unknown ranges', () => {
    assert.throws(() => buildBalanceHistory({ range: '5y', today: TODAY, accounts: [], deltas: [] }));
  });
});
