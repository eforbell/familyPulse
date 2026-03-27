'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

process.env.FP_TRANSACTION_FILES_DIR = path.join(os.tmpdir(), `family-pulse-attachments-${process.pid}`);

const { app } = require('../server');
const {
  DEFAULT_TRANSACTION_FILES_DIR,
  getTransactionFilesRoot,
  buildStoredFilename,
  buildAttachmentPath,
  ensureTransactionFilesDir,
  safeDeleteAttachmentFile
} = require('../lib/transaction-attachments');
const { removeTransactionByPlaidId, upsertTransaction } = require('../lib/sync');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let server;
let baseUrl;
let parentSessionToken;
let kidSessionToken;
let parentAccountId;
let kidAccountId;
let parentTxId;
let kidTxId;
let retainedTxId;
let parentId;
let kidId;
let uploadedAttachmentId;

function parentReq(pathname, opts = {}) {
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${parentSessionToken}`,
      ...opts.headers
    }
  });
}

function kidReq(pathname, opts = {}) {
  return fetch(`${baseUrl}/${pathname}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fp_session=${kidSessionToken}`,
      ...opts.headers
    }
  });
}

describe('transaction memory API', () => {
  before(async () => {
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const migrationSql = await fs.readFile(
      path.join(__dirname, '..', 'db', 'migrations', '017-transaction-memory.sql'),
      'utf8'
    );
    await pool.query(migrationSql);

    const { rows: parents } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'parent' ORDER BY id LIMIT 1"
    );
    const { rows: kids } = await pool.query(
      "SELECT id FROM family_members WHERE role = 'kid' ORDER BY id LIMIT 1"
    );
    parentId = parents[0].id;
    kidId = kids[0].id;

    parentSessionToken = crypto.randomUUID();
    kidSessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO sessions (token, member_id, expires_at) VALUES ($1, $2, $3), ($4, $5, $6)',
      [parentSessionToken, parentId, expiresAt, kidSessionToken, kidId, expiresAt]
    );

    const { rows: [item] } = await pool.query(`
      INSERT INTO items (access_token, item_id, institution_id, institution_name, status)
      VALUES ('test-token-memory', 'test-item-memory', 'ins_memory', 'Memory Bank', 'good')
      ON CONFLICT (item_id) DO UPDATE SET status = 'good'
      RETURNING id
    `);

    const { rows: [parentAccount] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-memory-parent', $1, 'Memory Parent Checking', 'depository', 'checking', '1111', 2000.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [item.id]);
    parentAccountId = parentAccount.id;

    const { rows: [kidAccount] } = await pool.query(`
      INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance)
      VALUES ('acct-memory-kid', $1, 'Memory Kid Checking', 'depository', 'checking', '2222', 500.00)
      ON CONFLICT (plaid_account_id) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [item.id]);
    kidAccountId = kidAccount.id;

    await pool.query(
      'INSERT INTO account_members (account_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [kidAccountId, kidId]
    );

    const { rows: [parentTx] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-memory-parent', $1, 120.45, '2026-03-20', 'Home Depot', 'HOME DEPOT', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
      RETURNING id
    `, [parentAccountId]);
    parentTxId = parentTx.id;

    const { rows: [kidTx] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-memory-kid', $1, 14.25, '2026-03-21', 'Arcade', 'ARCADE', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
      RETURNING id
    `, [kidAccountId]);
    kidTxId = kidTx.id;

    const { rows: [retainedTx] } = await pool.query(`
      INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, pending, is_transfer, source)
      VALUES ('tx-memory-retained', $1, 88.00, '2026-03-22', 'Appliance Repair', 'APPLIANCE REPAIR', false, false, 'plaid')
      ON CONFLICT (plaid_transaction_id) DO UPDATE SET amount = EXCLUDED.amount
      RETURNING id
    `, [parentAccountId]);
    retainedTxId = retainedTx.id;
  });

  after(async () => {
    if (uploadedAttachmentId) {
      await pool.query('DELETE FROM transaction_attachments WHERE id = $1', [uploadedAttachmentId]);
    }
    await pool.query('DELETE FROM transaction_notes WHERE transaction_id IN ($1, $2, $3)', [parentTxId, kidTxId, retainedTxId]);
    await pool.query("DELETE FROM transactions WHERE plaid_transaction_id IN ('tx-memory-parent', 'tx-memory-kid', 'tx-memory-retained')");
    await pool.query("DELETE FROM account_members WHERE account_id = $1 AND member_id = $2", [kidAccountId, kidId]);
    await pool.query("DELETE FROM accounts WHERE plaid_account_id IN ('acct-memory-parent', 'acct-memory-kid')");
    await pool.query("DELETE FROM items WHERE item_id = 'test-item-memory'");
    await pool.query('DELETE FROM sessions WHERE token IN ($1, $2)', [parentSessionToken, kidSessionToken]);
    server.close();
    await fs.rm(process.env.FP_TRANSACTION_FILES_DIR, { recursive: true, force: true });
    await pool.end();
  });

  it('GET /api/transactions/:id returns note metadata when present', async () => {
    await pool.query(
      `INSERT INTO transaction_notes (transaction_id, note, created_by, updated_by)
       VALUES ($1, 'Warranty through 2029', $2, $2)
       ON CONFLICT (transaction_id) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [parentTxId, parentId]
    );

    const res = await parentReq(`api/transactions/${parentTxId}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.transaction.id, parentTxId);
    assert.equal(data.transaction.note.text, 'Warranty through 2029');
    assert.ok(data.transaction.note.updated_at);
  });

  it('kid can read own transaction detail but not parent transaction detail', async () => {
    const ownRes = await kidReq(`api/transactions/${kidTxId}`);
    assert.equal(ownRes.status, 200);

    const parentRes = await kidReq(`api/transactions/${parentTxId}`);
    assert.equal(parentRes.status, 404);
  });

  it('PUT /api/transactions/:id/note creates and replaces a note', async () => {
    const createRes = await parentReq(`api/transactions/${parentTxId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ note: 'Receipt filed in garage binder' })
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json();
    assert.equal(created.transaction.note.text, 'Receipt filed in garage binder');

    const replaceRes = await parentReq(`api/transactions/${parentTxId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ note: 'Updated note for warranty claim' })
    });
    assert.equal(replaceRes.status, 200);
    const replaced = await replaceRes.json();
    assert.equal(replaced.transaction.note.text, 'Updated note for warranty claim');
    assert.equal(replaced.transaction.note.updated_by_name, 'Eric');
  });

  it('PUT /api/transactions/:id/note clears note when blank', async () => {
    const res = await parentReq(`api/transactions/${parentTxId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ note: '   ' })
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.transaction.note, null);

    const { rows } = await pool.query('SELECT 1 FROM transaction_notes WHERE transaction_id = $1', [parentTxId]);
    assert.equal(rows.length, 0);
  });

  it('PUT /api/transactions/:id/note enforces parent-only auth and length cap', async () => {
    const kidRes = await kidReq(`api/transactions/${kidTxId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ note: 'Kid cannot write this' })
    });
    assert.equal(kidRes.status, 403);

    const longNote = 'x'.repeat(4001);
    const longRes = await parentReq(`api/transactions/${parentTxId}/note`, {
      method: 'PUT',
      body: JSON.stringify({ note: longNote })
    });
    assert.equal(longRes.status, 400);
  });

  it('DELETE /api/transactions/:id/note removes an existing note', async () => {
    await pool.query(
      `INSERT INTO transaction_notes (transaction_id, note, created_by, updated_by)
       VALUES ($1, 'Delete me', $2, $2)
       ON CONFLICT (transaction_id) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [parentTxId, parentId]
    );

    const res = await parentReq(`api/transactions/${parentTxId}/note`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.transaction.note, null);
  });

  it('removeTransactionByPlaidId retains annotated transactions and marks them source_removed', async () => {
    await pool.query(
      `INSERT INTO transaction_notes (transaction_id, note, created_by, updated_by)
       VALUES ($1, 'Keep for warranty', $2, $2)
       ON CONFLICT (transaction_id) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [retainedTxId, parentId]
    );

    const result = await removeTransactionByPlaidId('tx-memory-retained');
    assert.equal(result.retained, true);

    const { rows: [tx] } = await pool.query(
      'SELECT source_removed, source_removed_at FROM transactions WHERE id = $1',
      [retainedTxId]
    );
    assert.equal(tx.source_removed, true);
    assert.ok(tx.source_removed_at);
  });

  it('upsertTransaction restores retained rows when Plaid sends them again', async () => {
    await upsertTransaction(null, {
      transaction_id: 'tx-memory-retained',
      account_id: 'acct-memory-parent',
      amount: 88.00,
      date: '2026-03-22',
      authorized_date: '2026-03-22',
      merchant_name: 'Appliance Repair',
      name: 'APPLIANCE REPAIR',
      personal_finance_category: { primary: 'HOME_IMPROVEMENT' },
      pending: false,
      iso_currency_code: 'USD'
    });

    const { rows: [tx] } = await pool.query(
      'SELECT source_removed, source_removed_at FROM transactions WHERE plaid_transaction_id = $1',
      ['tx-memory-retained']
    );
    assert.equal(tx.source_removed, false);
    assert.equal(tx.source_removed_at, null);
  });

  it('transaction attachment helper builds safe paths and can ensure/delete files', async () => {
    assert.equal(DEFAULT_TRANSACTION_FILES_DIR, '/data/apps/familyPulse/transaction-files');
    assert.equal(getTransactionFilesRoot(), process.env.FP_TRANSACTION_FILES_DIR);

    const storedFilename = buildStoredFilename('Receipt Final.PDF');
    assert.match(storedFilename, /^[0-9a-f-]+\.pdf$/);

    const root = await ensureTransactionFilesDir();
    assert.equal(root, process.env.FP_TRANSACTION_FILES_DIR);

    const filePath = buildAttachmentPath(storedFilename);
    assert.equal(path.dirname(filePath), process.env.FP_TRANSACTION_FILES_DIR);
    await fs.writeFile(filePath, 'test');
    const deleted = await safeDeleteAttachmentFile(storedFilename);
    assert.equal(deleted, true);

    const deletedMissing = await safeDeleteAttachmentFile(storedFilename);
    assert.equal(deletedMissing, false);
  });

  it('POST /api/transactions/:id/attachments uploads valid files and lists metadata', async () => {
    const form = new FormData();
    form.append('files', new Blob(['%PDF-1.4 receipt'], { type: 'application/pdf' }), 'receipt.pdf');
    form.append('files', new Blob(['pngdata'], { type: 'image/png' }), 'photo.png');

    const res = await fetch(`${baseUrl}/api/transactions/${parentTxId}/attachments`, {
      method: 'POST',
      headers: { Cookie: `fp_session=${parentSessionToken}` },
      body: form
    });
    assert.equal(res.status, 201);
    const data = await res.json();
    assert.equal(data.attachments.length, 2);
    assert.ok(data.attachments.every(row => !Object.hasOwn(row, 'stored_filename')));
    uploadedAttachmentId = data.attachments[0].id;

    const listRes = await parentReq(`api/transactions/${parentTxId}/attachments`);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(listData.attachments.length >= 2);

    const detailRes = await parentReq(`api/transactions/${parentTxId}`);
    const detailData = await detailRes.json();
    assert.ok(detailData.transaction.attachments.length >= 2);
  });

  it('POST /api/transactions/:id/attachments rejects invalid types and mismatched extensions', async () => {
    const invalidTypeForm = new FormData();
    invalidTypeForm.append('files', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const invalidTypeRes = await fetch(`${baseUrl}/api/transactions/${parentTxId}/attachments`, {
      method: 'POST',
      headers: { Cookie: `fp_session=${parentSessionToken}` },
      body: invalidTypeForm
    });
    assert.equal(invalidTypeRes.status, 400);

    const mismatchForm = new FormData();
    mismatchForm.append('files', new Blob(['hello'], { type: 'image/png' }), 'receipt.pdf');
    const mismatchRes = await fetch(`${baseUrl}/api/transactions/${parentTxId}/attachments`, {
      method: 'POST',
      headers: { Cookie: `fp_session=${parentSessionToken}` },
      body: mismatchForm
    });
    assert.equal(mismatchRes.status, 400);
  });

  it('POST /api/transactions/:id/attachments enforces parent-only auth', async () => {
    const form = new FormData();
    form.append('files', new Blob(['kid upload'], { type: 'application/pdf' }), 'kid.pdf');

    const res = await fetch(`${baseUrl}/api/transactions/${kidTxId}/attachments`, {
      method: 'POST',
      headers: { Cookie: `fp_session=${kidSessionToken}` },
      body: form
    });
    assert.equal(res.status, 403);
  });

  it('GET /api/transaction-attachments/:id/download streams uploaded files with auth', async () => {
    assert.ok(uploadedAttachmentId);
    const res = await parentReq(`api/transaction-attachments/${uploadedAttachmentId}/download`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'), /attachment;/);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const text = await res.text();
    assert.equal(text, 'pngdata');
  });

  it('kid cannot access parent attachment downloads', async () => {
    const res = await kidReq(`api/transaction-attachments/${uploadedAttachmentId}/download`);
    assert.equal(res.status, 404);
  });

  it('DELETE /api/transaction-attachments/:id removes metadata and file', async () => {
    const { rows: [attachment] } = await pool.query(
      'SELECT stored_filename FROM transaction_attachments WHERE id = $1',
      [uploadedAttachmentId]
    );
    const filePath = buildAttachmentPath(attachment.stored_filename);

    const res = await parentReq(`api/transaction-attachments/${uploadedAttachmentId}`, {
      method: 'DELETE'
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.deleted_from_disk, true);

    const { rows } = await pool.query(
      'SELECT 1 FROM transaction_attachments WHERE id = $1',
      [uploadedAttachmentId]
    );
    assert.equal(rows.length, 0);

    await assert.rejects(async () => {
      await fs.access(filePath);
    });

    uploadedAttachmentId = null;
  });
});
