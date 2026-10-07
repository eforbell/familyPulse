'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');
const { todayInTimezone, addDays } = require('../lib/balance-history');

const PARENT = 'BalHistParent';
const KID = 'BalHistKid';
const ITEM_KEY = 'test-item-balance-history-api';

let server, baseUrl, parentToken, kidToken, itemId;
let checkingId, cardId, kidId, investId, histId;

const get = (path, token) => fetch(`${baseUrl}/${path}`, { headers: { Cookie: `fp_session=${token}` } });

describe('GET /api/accounts/history', () => {
  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const today = todayInTimezone(process.env.HOUSEHOLD_TIMEZONE || 'America/New_York');

    const member = async (name, role) => (await pool.query(
      `INSERT INTO family_members (name, role, avatar_emoji) VALUES ($1, $2, 'x')
       ON CONFLICT (name) DO UPDATE SET role = $2 RETURNING id`, [name, role])).rows[0].id;
    const parentId = await member(PARENT, 'parent');
    const kidMemberId = await member(KID, 'kid');

    parentToken = crypto.randomUUID();
    kidToken = crypto.randomUUID();
    const exp = new Date(Date.now() + 7 * 864e5);
    await pool.query('INSERT INTO sessions (token, member_id, expires_at) VALUES ($1,$2,$3),($4,$5,$3)',
      [parentToken, parentId, exp, kidToken, kidMemberId]);

    itemId = (await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-bh', $1, 'ins_bh', 'History Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good' RETURNING id`, [ITEM_KEY])).rows[0].id;

    const acct = async (pid, name, type, bal, extra = {}) => (await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, current_balance, owner, sync_status)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7)
      ON CONFLICT (plaid_account_id) DO UPDATE SET current_balance = $5, sync_status = $7 RETURNING id`,
      [pid, itemId, name, type, bal, PARENT, extra.status || 'active'])).rows[0].id;
    checkingId = await acct('bh-checking', 'BH Checking', 'depository', 1000);
    cardId = await acct('bh-card', 'BH Card', 'credit', 300);
    kidId = await acct('bh-kid', 'BH Kid', 'depository', 50);
    investId = await acct('bh-invest', 'BH Invest', 'investment', 9999);
    histId = await acct('bh-hist', 'BH Historical', 'depository', 777, { status: 'historical' });
    await pool.query('INSERT INTO account_members (account_id, member_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [kidId, kidMemberId]);

    const tx = (acctId, key, daysAgo, amount, extra = {}) => pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, name, pending, is_hidden)
      VALUES ($1,$2,$3,$4,'bh',$5,$6) ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = $3, date = $4, pending = $5, is_hidden = $6`,
      [key, acctId, amount, addDays(today, -daysAgo), !!extra.pending, !!extra.hidden]);
    await tx(checkingId, 'bh-t1', 100, -2000);            // paycheck in, oldest
    await tx(checkingId, 'bh-t2', 2, 100);                 // spend $100 two days ago
    await tx(checkingId, 'bh-t3', 1, 999, { pending: true });  // pending ignored
    await tx(checkingId, 'bh-t4', 1, 888, { hidden: true });   // hidden duplicate ignored
    await tx(cardId, 'bh-t5', 100, 10);
    await tx(cardId, 'bh-t6', 2, 50);                      // charged $50 two days ago
    await tx(kidId, 'bh-t7', 100, -50);
  });

  after(async () => {
    await pool.query('DELETE FROM sessions WHERE token = ANY($1)', [[parentToken, kidToken]]);
    await pool.query('DELETE FROM items WHERE item_id = $1', [ITEM_KEY]);
    await pool.query('DELETE FROM family_members WHERE name = ANY($1)', [[PARENT, KID]]);
    await pool.end();
    server.close();
  });

  it('rejects unknown ranges', async () => {
    assert.equal((await get('api/accounts/history?range=9y', parentToken)).status, 400);
  });

  it('reconstructs deposit and credit series and ignores pending/hidden/investment/historical', async () => {
    const res = await get('api/accounts/history?range=3m', parentToken);
    assert.equal(res.status, 200);
    const h = await res.json();

    const mine = h.accounts.filter(a => a.name.startsWith('BH '));
    assert.deepEqual(mine.map(a => a.name).sort(), ['BH Card', 'BH Checking', 'BH Kid']);

    const last = a => a.values[a.values.length - 1];
    const checking = mine.find(a => a.name === 'BH Checking');
    const card = mine.find(a => a.name === 'BH Card');
    assert.equal(last(checking), 1000);
    assert.equal(last(card), -300);
    assert.equal(h.dates[h.dates.length - 1], h.end);

    // Before the spend/charge two days ago (first sample is ~90 days back, after t1 at 100d? no: t1 is older)
    assert.equal(checking.values[0], 1000 + 100);            // 1100 before the $100 spend
    assert.equal(card.values[0], -250);                       // owed 250 before the $50 charge
  });

  it('scopes kids to their own accounts', async () => {
    const h = await (await get('api/accounts/history?range=3m', kidToken)).json();
    assert.deepEqual(h.accounts.map(a => a.name), ['BH Kid']);
  });
});
