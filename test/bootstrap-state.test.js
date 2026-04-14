'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { app, pool, bootstrapState, plaidConfigStatus } = require('../server');

const ORIGINAL_QUERY = pool.query.bind(pool);
const ORIGINAL_ENV = { ...process.env };

class FakePool {
  constructor(initial = {}) {
    this.counts = {
      family_members: 0,
      categories: 0,
      items: 0,
      accounts: 0,
      transactions: 0,
      passphrases: 0,
      ...initial.counts,
    };
  }

  async query(sql) {
    if (sql.trim() === 'SELECT 1') {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }

    const tableMatch = sql.match(/SELECT COUNT\(\*\)::int AS count FROM (family_members|categories|items|accounts|transactions)\b/);
    if (tableMatch) {
      const tableName = tableMatch[1];
      if (tableName === 'family_members' && sql.includes('passphrase_hash IS NOT NULL')) {
        return { rows: [{ count: this.counts.passphrases }], rowCount: 1 };
      }
      return { rows: [{ count: this.counts[tableName] || 0 }], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in fake pool: ${sql}`);
  }
}

function setFakePool(fake) {
  pool.query = fake.query.bind(fake);
}

function setEnv(overrides) {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  pool.query = ORIGINAL_QUERY;
  setEnv({});
});

async function withServer(fn) {
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('plaidConfigStatus', () => {
  it('reports missing Plaid env without throwing', () => {
    const status = plaidConfigStatus({});
    assert.equal(status.configured, false);
    assert.match(status.error, /PLAID_CLIENT_ID/);
  });

  it('reports valid sandbox Plaid env as configured', () => {
    const status = plaidConfigStatus({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
    });
    assert.equal(status.configured, true);
    assert.equal(status.error, null);
  });
});

describe('bootstrapState', () => {
  it('reports all setup needs for migrated but unseeded installs', async () => {
    setFakePool(new FakePool());
    setEnv({
      PLAID_CLIENT_ID: '',
      PLAID_SECRET: '',
      PLAID_ENV: '',
    });

    const state = await bootstrapState();

    assert.equal(state.bootstrap.needs_household, true);
    assert.equal(state.bootstrap.needs_auth, true);
    assert.equal(state.bootstrap.needs_starter_content, true);
    assert.equal(state.bootstrap.needs_plaid_config, true);
    assert.equal(state.bootstrap.ready, false);
  });

  it('reports initialized production-like installs as ready', async () => {
    setFakePool(new FakePool({
      counts: {
        family_members: 4,
        categories: 18,
        items: 3,
        accounts: 12,
        transactions: 500,
        passphrases: 2,
      },
    }));
    setEnv({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
    });

    const state = await bootstrapState();

    assert.equal(state.bootstrap.needs_household, false);
    assert.equal(state.bootstrap.needs_auth, false);
    assert.equal(state.bootstrap.needs_starter_content, false);
    assert.equal(state.bootstrap.needs_plaid_config, false);
    assert.equal(state.bootstrap.ready, true);
    assert.equal(state.counts.transactions, 500);
  });
});

describe('bootstrap endpoints', () => {
  it('serves /api/bootstrap publicly even when auth would be enabled', async () => {
    setFakePool(new FakePool({
      counts: {
        family_members: 1,
        categories: 1,
        passphrases: 1,
      },
    }));
    setEnv({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
    });

    await withServer(async base => {
      const res = await fetch(`${base}/api/bootstrap`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.features.auth_enabled, true);
    });
  });

  it('serves /api/ready with db and Plaid config checks', async () => {
    setFakePool(new FakePool());
    setEnv({
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'secret',
      PLAID_ENV: 'sandbox',
    });

    await withServer(async base => {
      const res = await fetch(`${base}/api/ready`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.checks.db, 'ok');
      assert.equal(body.checks.plaid_config, 'ok');
    });
  });
});
