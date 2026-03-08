require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { pool } = require('./lib/db');
const { syncAll } = require('./lib/sync');
const logger = require('./lib/logger');

const app = express();
const PORT = process.env.PORT || 3003;
const TZ = process.env.HOUSEHOLD_TIMEZONE || 'America/New_York';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config helpers ───────────────────────────────────────────

async function cfg(key) {
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

async function setCfg(key, value) {
  await pool.query(
    'INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value]
  );
}

// ── Route modules ────────────────────────────────────────────

app.use(require('./lib/routes/accounts'));
app.use(require('./lib/routes/transactions'));
app.use(require('./lib/routes/categories'));

// ── Server-level routes ──────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT id, institution_name, status, error_code, last_sync_at
      FROM items ORDER BY institution_name
    `);
    const txCount = await pool.query('SELECT count(*)::int AS count FROM transactions');
    const acctCount = await pool.query('SELECT count(*)::int AS count FROM accounts');
    res.json({
      items: items.rows,
      transaction_count: txCount.rows[0].count,
      account_count: acctCount.rows[0].count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const result = await syncAll();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron schedule + Start ─────────────────────────────────────

if (require.main === module) {
  // Only register cron when running as the main process (not in tests)
  cron.schedule('0 6 * * *', () => {
    logger.info('Cron sync triggered (6 AM)');
    syncAll().catch(err => logger.error('Cron sync failed', { error: err.message }));
  }, { timezone: TZ });

  cron.schedule('0 20 * * *', () => {
    logger.info('Cron sync triggered (8 PM)');
    syncAll().catch(err => logger.error('Cron sync failed', { error: err.message }));
  }, { timezone: TZ });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`💚 Family Pulse running → http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app, pool, cfg, setCfg };
