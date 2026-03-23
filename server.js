require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { pool } = require('./lib/db');
const { syncAll } = require('./lib/sync');
const logger = require('./lib/logger');
const { validateStartupConfig } = require('./lib/startup-validation');
const { validateSession, authEnabled, parseCookie, cleanExpiredSessions } = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3003;
const TZ = process.env.HOUSEHOLD_TIMEZONE || 'America/New_York';

const { requireAuth, requireParent } = require('./lib/auth');

app.use(express.json());

// ── Session middleware ───────────────────────────────────────
// Attaches req.member if a valid session cookie exists.

app.use(async (req, res, next) => {
  try {
    const token = parseCookie(req.headers.cookie, 'fp_session');
    if (token) {
      const session = await validateSession(token);
      if (session) {
        req.member = { id: session.id, name: session.name, role: session.role, avatar_emoji: session.avatar_emoji };
      }
    }
  } catch (err) {
    logger.error('Session validation error', { error: err.message });
  }
  next();
});

// ── Auth-gated page serving ──────────────────────────────────
// When auth is enabled, unauthenticated HTML requests redirect to login.
// Runs BEFORE express.static so pages can't be served without auth.

const HTML_PAGES = new Set([
  '/', '/index.html', '/accounts.html', '/transactions.html',
  '/budget.html', '/recurring.html', '/forecast.html', '/reports.html', '/admin.html', '/settings.html', '/import.html',
  '/kids.html'
]);

const PARENT_ONLY_PAGES = new Set([
  '/settings.html', '/admin.html', '/import.html', '/forecast.html'
]);

function memberSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'kid';
}

function kidDashboardPath(member) {
  return `/kids/${memberSlug(member?.name)}`;
}

app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  const urlPath = req.path;
  if (!HTML_PAGES.has(urlPath)) return next();

  try {
    const isAuthOn = await authEnabled();
    if (!isAuthOn) return next();

    if (!req.member) {
      return res.redirect('login.html');
    }

    if (req.member.role === 'kid' && !PARENT_ONLY_PAGES.has(urlPath) && urlPath !== '/kids.html') {
      return res.redirect(kidDashboardPath(req.member));
    }

    if (req.member.role === 'kid' && PARENT_ONLY_PAGES.has(urlPath)) {
      return res.redirect(kidDashboardPath(req.member));
    }
  } catch (err) {
    logger.error('Auth gate error', { error: err.message });
  }
  next();
});

// ── Kid dashboard route ──────────────────────────────────────
// /kids/:name → serves kids.html (for both kids and parents)
app.get('/kids/:name', async (req, res, next) => {
  try {
    const isAuthOn = await authEnabled();
    if (isAuthOn && !req.member) {
      return res.redirect('login.html');
    }
  } catch (err) {
    logger.error('Kid route auth error', { error: err.message });
  }
  res.sendFile(path.join(__dirname, 'public', 'kids.html'));
});

// Static files — AFTER auth gate so HTML pages are protected
app.use(express.static(path.join(__dirname, 'public')));

// ── API auth enforcement ─────────────────────────────────────
// Blanket auth gate for /api/ routes. Public routes are exempted.
// Parent-only routes get an additional role check.

const API_PUBLIC = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/members'
]);

const API_PARENT_ONLY_PREFIXES = [
  '/api/sync', '/api/link', '/api/import', '/api/items',
  '/api/magic', '/api/anomalies', '/api/status'
];

const API_PARENT_ONLY_WRITES = [
  '/api/categories', '/api/rules',
  '/api/budget/snapshot', '/api/budget/backfill'
];

app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();

  // Always public
  if (API_PUBLIC.has(req.path)) return next();

  // Bootstrap passphrase endpoint handled by its own guard
  if (req.path === '/api/auth/passphrase') return next();

  try {
    const isAuthOn = await authEnabled();
    if (!isAuthOn) return next();
  } catch (err) {
    logger.error('Auth check error', { error: err.message });
    return next();
  }

  // Require valid session for all other API routes
  if (!req.member) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Parent-only: certain prefixes always, certain paths on write methods
  const isParentPrefix = API_PARENT_ONLY_PREFIXES.some(p => req.path.startsWith(p));
  const isParentWrite = API_PARENT_ONLY_WRITES.some(p => req.path.startsWith(p)) && req.method !== 'GET';

  if ((isParentPrefix || isParentWrite) && req.member.role !== 'parent') {
    return res.status(403).json({ error: 'Parent access required' });
  }

  next();
});

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

app.use(require('./lib/routes/auth'));
app.use(require('./lib/routes/accounts'));
app.use(require('./lib/routes/transactions'));
app.use(require('./lib/routes/categories'));
app.use(require('./lib/routes/link'));
app.use(require('./lib/routes/import'));
app.use(require('./lib/routes/budget'));
app.use(require('./lib/routes/recurring'));
app.use(require('./lib/routes/anomalies'));
app.use(require('./lib/routes/magic-actions'));
app.use(require('./lib/routes/kids'));
app.use(require('./lib/routes/cash-flow'));

// Expose cfg/setCfg on app so route modules can access them
app.set('cfg', cfg);
app.set('setCfg', setCfg);

// ── Server-level routes ──────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.get('/api/status', requireParent, async (req, res) => {
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
  validateStartupConfig();

  // Only register cron when running as the main process (not in tests)
  cron.schedule('0 6 * * *', () => {
    logger.info('Cron sync triggered (6 AM)');
    syncAll().catch(err => logger.error('Cron sync failed', { error: err.message }));
  }, { timezone: TZ });

  cron.schedule('0 20 * * *', () => {
    logger.info('Cron sync triggered (8 PM)');
    syncAll().catch(err => logger.error('Cron sync failed', { error: err.message }));
  }, { timezone: TZ });

  // 1st of month at 6 AM — snapshot prior month's budget
  cron.schedule('0 6 1 * *', () => {
    const { generateSnapshot } = require('./lib/snapshot-generator');
    const now = new Date();
    const prior = now.getMonth() === 0
      ? `${now.getFullYear() - 1}-12`
      : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
    logger.info('Monthly budget snapshot', { period: prior });
    generateSnapshot(prior).catch(err => logger.error('Budget snapshot failed', { error: err.message }));
  }, { timezone: TZ });

  // Sunday 6 PM — weekly spending digest
  cron.schedule('0 18 * * 0', () => {
    const { generateWeeklyDigest, currentWeeklyDigestPeriod } = require('./lib/magic-actions/weekly-digest');
    logger.info('Weekly digest cron triggered');
    generateWeeklyDigest(currentWeeklyDigestPeriod(), cfg).catch(err => logger.error('Weekly digest failed', { error: err.message }));
  }, { timezone: TZ });

  // 1st of month at 7 AM — monthly close report (after the 6 AM snapshot)
  cron.schedule('0 7 1 * *', () => {
    const { generateMonthlyClose } = require('./lib/magic-actions/monthly-close');
    logger.info('Monthly close cron triggered');
    generateMonthlyClose(null, cfg).catch(err => logger.error('Monthly close failed', { error: err.message }));
  }, { timezone: TZ });

  // 2nd of month at 7 AM — kid money report cards
  cron.schedule('0 7 2 * *', async () => {
    const { generateKidReportCard } = require('./lib/magic-actions/kid-report-card');
    try {
      const { rows: kids } = await pool.query(
        "SELECT id FROM family_members WHERE role = 'kid'"
      );
      for (const kid of kids) {
        const now = new Date();
        const prior = now.getMonth() === 0
          ? `${now.getFullYear() - 1}-12`
          : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
        logger.info('Generating kid report card', { memberId: kid.id, period: prior });
        await generateKidReportCard(kid.id, prior, cfg).catch(err =>
          logger.error('Kid report card failed', { memberId: kid.id, error: err.message })
        );
      }
    } catch (err) {
      logger.error('Kid report card cron failed', { error: err.message });
    }
  }, { timezone: TZ });

  // Daily at midnight — clean expired sessions
  cron.schedule('0 0 * * *', () => {
    cleanExpiredSessions()
      .then(n => { if (n > 0) logger.info('Cleaned expired sessions', { count: n }); })
      .catch(err => logger.error('Session cleanup failed', { error: err.message }));
  }, { timezone: TZ });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`💚 Family Pulse running → http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app, pool, cfg, setCfg };
