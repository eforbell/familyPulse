'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { csvCell, textValue, writeCsv, withExportSnapshot, readDataset } = require('../lib/data-export');

test('CSV quotes delimiters, newlines, quotes, Unicode, JSON, dates, nulls, and signed amounts', () => {
  assert.equal(csvCell('a,"b"\n☃'), '"a,""b""\n☃"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(false), '"false"');
  assert.equal(csvCell('-123.45', { dataTypeID: 1700 }), '"-123.45"');
  assert.equal(csvCell('0012'), '"0012"');
  assert.equal(textValue({ note: 'a\nb' }), '{"note":"a\\nb"}');
  assert.equal(textValue(new Date('2026-03-01T01:02:03Z')), '2026-03-01T01:02:03.000Z');
});

test('CSV neutralizes spreadsheet formula initiators in text, not typed numbers', () => {
  for (const text of ['=1+1', '+cmd', '-cmd', '@SUM(A1)', '\t=1', '\r=1', '\n=1', '  =1', '＝1', '＋1', '－1', '＠x']) {
    assert.equal(csvCell(text), `"'${text}"`, JSON.stringify(text));
  }
  assert.equal(csvCell('normal = words'), '"normal = words"');
});

test('snapshot is read-only, consistent, committed and released; failures roll back', async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const client = { query: async sql => calls.push(sql), release: () => calls.push('release') };
    const pool = { connect: async () => client };
    const run = withExportSnapshot(pool, async c => { assert.equal(c, client); if (fail) throw new Error('query failed'); return 42; });
    if (fail) await assert.rejects(run, /query failed/);
    else assert.equal(await run, 42);
    assert.deepEqual(calls, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL TIME ZONE 'UTC'", fail ? 'ROLLBACK' : 'COMMIT', 'release']);
  }
});

test('CSV emits a BOM and headers even for an empty dataset', async () => {
  const calls = [];
  const client = { query: async query => {
    calls.push(typeof query === 'string' ? query : query.text);
    return { fields: [{ name: 'id', dataTypeID: 23 }, { name: 'date', dataTypeID: 1082 }], rows: [] };
  } };
  let text = '';
  await writeCsv(client, new Writable({ write(chunk, _encoding, callback) { text += chunk; callback(); } }));
  assert.equal(text, '\uFEFF"id","date"\r\n');
  assert.equal(calls.at(-1), 'CLOSE export_rows');
});

test('cursor fetches beyond the UI page size and closes on early return', async () => {
  let fetches = 0;
  const calls = [];
  const client = { query: async query => {
    const sql = typeof query === 'string' ? query : query.text;
    calls.push(sql);
    return { fields: [], rows: sql.startsWith('FETCH') && ++fetches <= 2 ? Array(500).fill({ id: 1 }) : [] };
  } };
  let count = 0;
  for await (const batch of readDataset(client, { sql: 'SELECT 1' })) count += batch.rows.length;
  assert.equal(count, 1000);
  assert.equal(fetches, 3);
  assert.equal(calls.at(-1), 'CLOSE export_rows');
  for await (const _batch of readDataset(client, { sql: 'SELECT 1' })) break;
  assert.equal(calls.at(-1), 'CLOSE export_rows');
});

test('CSV propagates write failures, so the route cannot offer an incomplete file', async () => {
  const client = { query: async () => ({ fields: [{ name: 'id', dataTypeID: 23 }], rows: [] }) };
  await assert.rejects(writeCsv(client, new Writable({ write(_chunk, _encoding, callback) {
    callback(new Error('disk full'));
  } })), /disk full/);
});
