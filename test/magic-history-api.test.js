'use strict';

require('dotenv').config();
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const { app } = require('../server');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await pool.query(
    `INSERT INTO magic_actions_log (action_type, input, output, model, tokens_used)
     VALUES
     ('monthly_close_2026-03', $1, 'Monthly output', 'test', 10),
     ('on_demand_history_test', $2, 'Ask output', 'test', 20),
     ('what_if_history_test', $3, 'Forecast output', 'test', 30)`,
    [
      JSON.stringify({ period: '2026-03' }),
      JSON.stringify({ question: 'How are we doing?' }),
      JSON.stringify({ scenario: 'What if we buy a car?' })
    ]
  );
});

after(async () => {
  await pool.query(
    `DELETE FROM magic_actions_log
     WHERE action_type IN ('monthly_close_2026-03', 'on_demand_history_test', 'what_if_history_test')`
  );
  server.close();
  const { pool: dbPool } = require('../lib/db');
  await dbPool.end();
  await pool.end();
});

describe('GET /api/magic/history', () => {
  it('returns reports plus ask and what-if history', async () => {
    const res = await fetch(`${baseUrl}/api/magic/history`);
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.ok(Array.isArray(data.reports));
    assert.ok(Array.isArray(data.queries));
    assert.ok(data.reports.some(r => r.type === 'monthly' && r.content === 'Monthly output'));
    assert.ok(data.queries.some(q => q.type === 'ask' && q.prompt === 'How are we doing?'));
    assert.ok(data.queries.some(q => q.type === 'what_if' && q.prompt === 'What if we buy a car?'));
  });
});
