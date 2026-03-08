#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { pool } = require('./db');

const commands = {
  async sync() {
    const { syncAll } = require('./sync');
    console.log('Starting sync...\n');
    const result = await syncAll();
    console.log('\nSync Results:');
    console.log(`  Items synced:    ${result.items}`);
    console.log(`  Accounts:        ${result.accounts_updated}`);
    console.log(`  Txns added:      ${result.txns_added}`);
    console.log(`  Txns modified:   ${result.txns_modified}`);
    console.log(`  Txns removed:    ${result.txns_removed}`);
    console.log(`  Transfers found: ${result.transfers_detected || 0}`);
    if (result.errors.length > 0) {
      console.log(`  Errors:          ${result.errors.length}`);
      for (const e of result.errors) {
        console.log(`    - Item ${e.item_id}: ${e.error} (${e.code})`);
      }
    }
  },

  async accounts() {
    const { rows } = await pool.query(`
      SELECT a.name, a.type, a.subtype, a.mask,
             a.current_balance, a.available_balance, a.owner,
             i.institution_name
      FROM accounts a
      JOIN items i ON a.item_id = i.id
      ORDER BY i.institution_name, a.name
    `);

    if (rows.length === 0) {
      console.log('No accounts found. Run "npm run sync" first.');
      return;
    }

    console.log('');
    console.log('Institution          Account              Type       Mask   Balance      Available');
    console.log('─'.repeat(95));
    for (const r of rows) {
      const inst = (r.institution_name || '').padEnd(20).slice(0, 20);
      const name = (r.name || '').padEnd(20).slice(0, 20);
      const type = (r.type || '').padEnd(10).slice(0, 10);
      const mask = (r.mask || '').padStart(4);
      const bal = r.current_balance != null ? `$${Number(r.current_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—';
      const avail = r.available_balance != null ? `$${Number(r.available_balance).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—';
      console.log(`${inst} ${name} ${type} ${mask}   ${bal.padStart(12)} ${avail.padStart(12)}`);
    }
    console.log('');
  },

  async status() {
    const { rows: items } = await pool.query(
      'SELECT institution_name, status, error_code, last_sync_at FROM items ORDER BY institution_name'
    );
    const { rows: [txCount] } = await pool.query('SELECT count(*)::int AS count FROM transactions');
    const { rows: [acctCount] } = await pool.query('SELECT count(*)::int AS count FROM accounts');
    const { rows: lastRuns } = await pool.query(
      'SELECT status, started_at, finished_at, txns_added, txns_modified, txns_removed FROM import_runs ORDER BY id DESC LIMIT 3'
    );

    console.log('\n  Family Pulse Status');
    console.log('  ─'.repeat(20));
    console.log(`  Accounts:     ${acctCount.count}`);
    console.log(`  Transactions: ${txCount.count}`);
    console.log('');

    if (items.length > 0) {
      console.log('  Linked Items:');
      for (const item of items) {
        const status = item.status === 'good' ? '✓' : `✗ ${item.error_code}`;
        const lastSync = item.last_sync_at ? new Date(item.last_sync_at).toLocaleString() : 'never';
        console.log(`    ${item.institution_name || 'Unknown'}: ${status} (last sync: ${lastSync})`);
      }
    } else {
      console.log('  No linked items. Add a Plaid Item to get started.');
    }

    if (lastRuns.length > 0) {
      console.log('\n  Recent Syncs:');
      for (const run of lastRuns) {
        const time = new Date(run.started_at).toLocaleString();
        console.log(`    ${time} — ${run.status} (+${run.txns_added}/-${run.txns_removed}/~${run.txns_modified})`);
      }
    }

    console.log('');
  }
};

async function main() {
  const cmd = process.argv[2];

  if (!cmd || !commands[cmd]) {
    console.log('Usage: node lib/cli.js <command>');
    console.log('Commands: sync, accounts, status');
    process.exit(cmd ? 1 : 0);
  }

  try {
    await commands[cmd]();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
