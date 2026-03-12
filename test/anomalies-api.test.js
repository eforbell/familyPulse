'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');

let server;
let baseUrl;
let groceriesId;

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const { rows: [category] } = await pool.query(
    `SELECT id FROM categories WHERE name = 'Groceries'`
  );
  groceriesId = category.id;

  await pool.query(
    `INSERT INTO anomalies
      (category_id, anomaly_type, period, current_amount, avg_3mo, avg_12mo, pct_of_3mo, pct_of_12mo, severity, acknowledged)
     VALUES
      ($1, 'spending_spike_3mo', '2026-03', 400, 100, 150, 400, 266.7, 'warning', false),
      ($1, 'spending_spike_12mo', '2026-03', 400, 100, 120, 400, 333.3, 'warning', false)
     ON CONFLICT (category_id, period, anomaly_type) DO UPDATE SET
      current_amount = EXCLUDED.current_amount,
      avg_3mo = EXCLUDED.avg_3mo,
      avg_12mo = EXCLUDED.avg_12mo,
      pct_of_3mo = EXCLUDED.pct_of_3mo,
      pct_of_12mo = EXCLUDED.pct_of_12mo,
      acknowledged = false`,
    [groceriesId]
  );
});

after(async () => {
  await pool.query(
    `DELETE FROM anomalies WHERE category_id = $1 AND period = '2026-03'`,
    [groceriesId]
  );
  server.close();
  const { pool: dbPool } = require('../lib/db');
  await dbPool.end();
  await pool.end();
});

describe('GET /api/anomalies', () => {
  it('returns at most one hotspot per category for a period', async () => {
    const res = await fetch(`${baseUrl}/api/anomalies?period=2026-03`);
    assert.equal(res.status, 200);
    const data = await res.json();

    const groceries = data.anomalies.filter(a => a.category_id === groceriesId);
    assert.equal(groceries.length, 1);
    assert.equal(groceries[0].anomaly_type, 'spending_spike_3mo');
  });
});
