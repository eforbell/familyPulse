'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { app } = require('../server');
const { pool, withTransaction } = require('../lib/db');
const { withExportSnapshot } = require('../lib/data-export');

// Test-only reader handles quoted multiline fields rather than splitting lines.
function parseCsv(text) {
  const records = [];
  let record = [], value = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\r')) {
      record.push(value); value = '';
      if (char === '\r') { records.push(record); record = []; i++; }
    } else value += char;
  }
  const [headers, ...rows] = records;
  return { headers, rows: rows.map(row => Object.fromEntries(headers.map((name, i) => [name, row[i]]))) };
}

describe('operator data export', () => {
  let server, baseUrl, itemId, accountId, parentId, transactionId, incomeId;
  const parentToken = crypto.randomUUID(), kidToken = crypto.randomUUID();
  const prefix = `export-${crypto.randomUUID()}`;
  const recurringIds = [];
  let categoryIds;
  const request = (suffix = '', token = parentToken) => fetch(`${baseUrl}/api/export${suffix}`, {
    headers: token ? { Cookie: `fp_session=${token}` } : {}
  });

  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const { rows: members } = await pool.query("SELECT id, role FROM family_members WHERE role IN ('parent', 'kid') ORDER BY id");
    parentId = members.find(m => m.role === 'parent').id;
    const kidId = members.find(m => m.role === 'kid').id;
    await pool.query("INSERT INTO sessions (token, member_id, expires_at) VALUES ($1,$2,now()+interval '1 hour'),($3,$4,now()+interval '1 hour')", [parentToken, parentId, kidToken, kidId]);
    ({ rows: [{ id: itemId }] } = await pool.query("INSERT INTO items (access_token,item_id,institution_name,status) VALUES ('secret-not-for-export',$1,'Export Bank','disconnected') RETURNING id", [prefix]));
    ({ rows: [{ id: accountId }] } = await pool.query(`INSERT INTO accounts
      (plaid_account_id,item_id,name,custom_name,type,mask,owner,sync_status) VALUES ($1,$2,'Raw account','Export Checking','depository','0012','Export Owner','historical') RETURNING id`, [prefix, itemId]));
    const { rows: categories } = await pool.query("INSERT INTO categories (name) VALUES ($1),($2) RETURNING id", [prefix + ' Food', prefix + ' Home']);
    categoryIds = categories.map(row => row.id);
    const { rows: txns } = await pool.query(`INSERT INTO transactions
      (plaid_transaction_id,account_id,amount,date,authorized_date,name,merchant_name,pending,is_hidden,source_removed,source,raw_json)
      SELECT $1 || '-' || n, $2, 42.50, '2026-03-01'::date, '2026-02-28'::date,
      'Original text', '=HYPERLINK("bad")', n=2, n=3, n=4, 'test', '{"original":"☃"}'::jsonb
      FROM generate_series(1,505) n RETURNING id`, [prefix, accountId]);
    transactionId = txns[0].id;
    await pool.query('UPDATE transactions SET is_transfer=true WHERE id=$1', [txns[4].id]);
    await pool.query('UPDATE transactions SET amount=-100 WHERE id=$1', [txns[5].id]);
    incomeId = txns[5].id;
    await pool.query('INSERT INTO transaction_notes (transaction_id,note,created_by,updated_by) VALUES ($1,$2,$3,$3)', [transactionId, '☃ note, "quoted"\nsecond line', parentId]);
    await pool.query(`INSERT INTO transaction_attachments (transaction_id,original_filename,stored_filename,mime_type,byte_size,uploaded_by)
      VALUES ($1,'Receipt ☃.pdf',$2,'application/pdf',123,$3)`, [transactionId, prefix + '-secret-storage-path', parentId]);
    await withTransaction(async client => {
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id=$1', [transactionId]);
      await client.query(`INSERT INTO transaction_allocations (transaction_id,category_id,amount,position,created_by)
        VALUES ($1,$2,20,1,$4),($1,$3,22.50,2,$4)`, [transactionId, ...categoryIds, parentId]);
      const { rows: [paycheck] } = await client.query(`INSERT INTO paycheck_events
        (member_id,employer,pay_date,gross_earnings,federal_tax,total_net_amount,created_by)
        VALUES ($1,'Export Employer','2026-03-01',120,20,100,$1) RETURNING id`, [parentId]);
      await client.query(`INSERT INTO paycheck_deposits (paycheck_event_id,transaction_id,gross_attribution,deductions_applied,source_net_amount,position)
        VALUES ($1,$2,120,true,100,1)`, [paycheck.id, incomeId]);
    });
    for (const type of ['income', 'expense']) {
      const { rows: [recurring] } = await pool.query(`INSERT INTO recurring_expenses
        (merchant_key,merchant_name,cashflow_type,frequency,status,latest_account_id,latest_amount,first_seen_date,last_seen_date)
        VALUES ($1,$1,$2,'monthly','ignored',$3,42.50,'2026-02-01','2026-03-01') RETURNING id`, [prefix + type, type, accountId]);
      recurringIds.push(recurring.id);
      await pool.query(`INSERT INTO recurring_expense_history (recurring_expense_id,transaction_id,amount,transaction_date)
        VALUES ($1,$2,42.50,'2026-03-01')`, [recurring.id, transactionId]);
    }
  });

  after(async () => {
    await pool.query('DELETE FROM recurring_expenses WHERE id=ANY($1::int[])', [recurringIds]);
    if (itemId) await pool.query('DELETE FROM items WHERE id=$1', [itemId]);
    if (categoryIds) await pool.query('DELETE FROM categories WHERE id=ANY($1::int[])', [categoryIds]);
    await pool.query('DELETE FROM sessions WHERE token=ANY($1::text[])', [[parentToken, kidToken]]);
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });

  it('denies anonymous and child access, including route case variants', async () => {
    assert.equal((await request('', null)).status, 401);
    assert.equal((await request('', kidToken)).status, 403);
    const response = await fetch(`${baseUrl}/API/EXPORT?format=csv`, { headers: { Cookie: `fp_session=${kidToken}` } });
    assert.equal(response.status, 403);
  });

  it('rejects unsupported and ambiguous formats without creating a download', async () => {
    for (const suffix of ['?format=pdf', '?format=csv&format=xlsx', '?format[x]=csv']) {
      const response = await request(suffix);
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /json/);
    }
  });

  it('exports every retained transaction once with canonical allocations and enriched metadata', async () => {
    const response = await request('?format=csv');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), /attachment;.*familypulse-transactions-.*\.csv/);
    const text = await response.text();
    const { headers, rows } = parseCsv(text);
    const { rows: [count] } = await pool.query('SELECT count(*)::int AS total FROM transactions');
    assert.equal(rows.length, count.total);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
    const fixtureRows = rows.filter(row => row.account_id === String(accountId));
    assert.equal(fixtureRows.length, 505);
    assert.ok(fixtureRows.some(row => row.pending === 'true'));
    assert.ok(fixtureRows.some(row => row.is_hidden === 'true'));
    assert.ok(fixtureRows.some(row => row.source_removed === 'true'));
    assert.ok(fixtureRows.some(row => row.is_transfer === 'true'));
    const row = fixtureRows.find(row => row.id === String(transactionId));
    assert.equal(row.amount, '42.50');
    assert.equal(row.date, '2026-03-01');
    assert.equal(row.authorized_date, '2026-02-28');
    assert.equal(row.account_mask, '0012');
    assert.equal(row.account_display_name, 'Export Checking');
    assert.equal(row.institution_name, 'Export Bank');
    assert.equal(row.institution_status, 'disconnected');
    assert.equal(row.note, '☃ note, "quoted"\nsecond line');
    assert.equal(row.merchant_name, '\'=HYPERLINK("bad")');
    assert.equal(JSON.parse(row.raw_json).original, '☃');
    assert.equal(JSON.parse(row.allocations).length, 2);
    assert.ok(JSON.parse(row.allocations).every(a => a.category_name.startsWith(prefix)));
    assert.equal(JSON.parse(row.recurring_matches).length, 2);
    assert.deepEqual(JSON.parse(row.recurring_matches).map(match => match.cashflow_type).sort(), ['expense', 'income']);
    assert.ok(JSON.parse(row.recurring_matches).every(match => match.status === 'ignored'));
    assert.equal(JSON.parse(row.attachments)[0].original_filename, 'Receipt ☃.pdf');
    assert.ok(!('stored_filename' in JSON.parse(row.attachments)[0]));
    const income = fixtureRows.find(row => row.id === String(incomeId));
    assert.equal(income.amount, '-100.00');
    assert.equal(JSON.parse(income.paycheck).employer, 'Export Employer');
    assert.equal(JSON.parse(income.paycheck_deposit).source_net_amount, 100);
    assert.ok(!headers.includes('access_token'));
    for (const secret of ['secret-not-for-export', prefix + '-secret-storage-path', parentToken, kidToken]) {
      assert.ok(!text.includes(secret));
    }
  });

  it('keeps one consistent snapshot while transaction data changes concurrently', async () => {
    try {
      await withExportSnapshot(pool, async client => {
        const { rows: [before] } = await client.query('SELECT name FROM transactions WHERE id=$1', [transactionId]);
        await pool.query("UPDATE transactions SET name='Concurrent edit' WHERE id=$1", [transactionId]);
        const { rows: [after] } = await client.query('SELECT name FROM transactions WHERE id=$1', [transactionId]);
        assert.equal(after.name, before.name);
      });
      const { rows: [current] } = await pool.query('SELECT name FROM transactions WHERE id=$1', [transactionId]);
      assert.equal(current.name, 'Concurrent edit');
    } finally {
      await pool.query("UPDATE transactions SET name='Original text' WHERE id=$1", [transactionId]);
    }
  });
});
