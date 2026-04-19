require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { pool } = require('./lib/db');
const { syncAll } = require('./lib/sync');
const logger = require('./lib/logger');
const { validateStartupConfig } = require('./lib/startup-validation');
const { validateSession, authEnabled, parseCookie, cleanExpiredSessions } = require('./lib/auth');
const { issueBootstrapToken, TOKEN_TTL_MS } = require('./lib/bootstrap-token');

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

const BOOTSTRAP_REDIRECT_PAGES = new Set([...HTML_PAGES, '/login.html']);

const PARENT_AVATARS = ['👨', '👩', '🧑', '👴', '👵'];
const PARENT_COLORS  = ['#3b82f6', '#ec4899', '#8b5cf6', '#06b6d4', '#f97316'];
const KID_AVATARS    = ['👦', '👧', '🧒', '👶'];
const KID_COLORS     = ['#f59e0b', '#22c55e', '#f97316', '#a855f7'];

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

// ── Bootstrap redirect ───────────────────────────────────────
// When no household exists, redirect HTML page requests to /setup.

app.use(async (req, res, next) => {
  if (req.method !== 'GET') return next();
  const urlPath = req.path;
  if (urlPath === '/setup' || urlPath === '/setup.html') return next();
  if (!BOOTSTRAP_REDIRECT_PAGES.has(urlPath)) return next();
  try {
    const state = await bootstrapState();
    if (state.bootstrap.needs_household) return res.redirect('setup');
  } catch (err) {
    logger.error('Bootstrap redirect check failed', { error: err.message });
  }
  next();
});

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

// Setup page alias — supports /setup path used by Homebase install flows.
app.get('/setup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// Static files — AFTER auth gate so HTML pages are protected
app.use(express.static(path.join(__dirname, 'public')));

// ── API auth enforcement ─────────────────────────────────────
// Blanket auth gate for /api/ routes. Public routes are exempted.
// Parent-only routes get an additional role check.

const API_PUBLIC = new Set([
  '/api/health',
  '/api/ready',
  '/api/bootstrap',
  '/api/bootstrap/household',
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

async function countTable(tableName) {
  const allowed = new Set([
    'family_members',
    'categories',
    'items',
    'accounts',
    'transactions',
  ]);
  if (!allowed.has(tableName)) throw new Error(`Unsupported count table: ${tableName}`);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
  return Number(rows[0]?.count || 0);
}

async function passphraseCount() {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS count FROM family_members WHERE passphrase_hash IS NOT NULL'
  );
  return Number(rows[0]?.count || 0);
}

function plaidConfigStatus(env = process.env) {
  try {
    validateStartupConfig(env);
    return {
      configured: true,
      error: null,
    };
  } catch (err) {
    return {
      configured: false,
      error: err.message,
    };
  }
}


function warnIfPlaidConfigMissing(env = process.env, log = logger) {
  const status = plaidConfigStatus(env);
  if (!status.configured) {
    log.warn('Family Pulse starting with incomplete Plaid configuration', { error: status.error });
  }
  return status;
}

const DEFAULT_CATEGORIES = [
  { name: 'Groceries',       color: '#22c55e', is_income: false, is_transfer_class: false, icon: '🛒' },
  { name: 'Dining Out',      color: '#f97316', is_income: false, is_transfer_class: false, icon: '🍽️' },
  { name: 'Gas & Auto',      color: '#64748b', is_income: false, is_transfer_class: false, icon: '⛽' },
  { name: 'Utilities',       color: '#06b6d4', is_income: false, is_transfer_class: false, icon: '💡' },
  { name: 'Healthcare',      color: '#ef4444', is_income: false, is_transfer_class: false, icon: '🏥' },
  { name: 'Entertainment',   color: '#a855f7', is_income: false, is_transfer_class: false, icon: '🎬' },
  { name: 'Shopping',        color: '#ec4899', is_income: false, is_transfer_class: false, icon: '🛍️' },
  { name: 'Kids Activities', color: '#f59e0b', is_income: false, is_transfer_class: false, icon: '⚽' },
  { name: 'Subscriptions',   color: '#6366f1', is_income: false, is_transfer_class: false, icon: '📦' },
  { name: 'Home & Garden',   color: '#84cc16', is_income: false, is_transfer_class: false, icon: '🏡' },
  { name: 'Insurance',       color: '#78716c', is_income: false, is_transfer_class: false, icon: '🛡️' },
  { name: 'Travel',          color: '#0ea5e9', is_income: false, is_transfer_class: false, icon: '✈️' },
  { name: 'Income',          color: '#10b981', is_income: true,  is_transfer_class: false, icon: '💰' },
  { name: 'Transfer',        color: '#9ca3af', is_income: false, is_transfer_class: true,  icon: '🔄' },
  { name: 'CC Payment',      color: '#9ca3af', is_income: false, is_transfer_class: true,  icon: '💳' },
  { name: '529 Contribution',color: '#3b82f6', is_income: false, is_transfer_class: true,  icon: '🎓' },
  { name: 'Crypto/BTC',      color: '#f59e0b', is_income: false, is_transfer_class: true,  icon: '₿' },
  { name: 'Uncategorized',   color: '#6b7280', is_income: false, is_transfer_class: false, icon: '❓' },
];

const DEFAULT_APP_CONFIG = [
  ['sync_interval_hours', '12'],
  ['transfer_detection_window_days', '7'],
  ['transfer_amount_tolerance', '1.00'],
  ['transfer_date_tolerance_days', '3'],
  ['accent_color', '#10b981'],
  ['anomaly_threshold_pct', '130'],
  ['anomaly_min_avg_dollars', '25'],
  ['magic_rate_limit_daily', '10'],
  ['magic_disclaimer', 'AI-generated analysis — not financial advice.'],
  ['coverage_alert_threshold', '0.70'],
  ['balance_basis', 'available_preferred'],
  ['recurring_amount_tolerance_pct', '10'],
  ['recurring_lookback_months', '18'],
  ['recurring_last_detection_at', ''],
  ['cash_flow_safety_floor', '3000'],
  ['cash_flow_horizon_days', '90'],
  ['cash_reserve_target_months', '3.0'],
  ['notifications_enabled', 'false'],
  ['notification_base_url', ''],
  ['notification_default_interruption_level', 'active'],
  ['large_expense_threshold', '1000'],
  ['budget_overrun_threshold_pct', '15'],
];

async function installStarterContent() {
  for (const cat of DEFAULT_CATEGORIES) {
    await pool.query(
      'INSERT INTO categories (name, color, is_income, is_transfer_class, icon) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING',
      [cat.name, cat.color, cat.is_income, cat.is_transfer_class, cat.icon]
    );
  }
  for (const [key, value] of DEFAULT_APP_CONFIG) {
    await pool.query(
      'INSERT INTO app_config (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value]
    );
  }
  const [cryptoRow, contribRow] = await Promise.all([
    pool.query("SELECT id FROM categories WHERE name = 'Crypto/BTC'"),
    pool.query("SELECT id FROM categories WHERE name = '529 Contribution'"),
  ]);
  if (cryptoRow.rows.length && contribRow.rows.length) {
    const cryptoId = cryptoRow.rows[0].id;
    const contribId = contribRow.rows[0].id;
    for (const [pattern, catId] of [['Coinbase', cryptoId], ['Swan', cryptoId], ['Strike', cryptoId], ['529', contribId]]) {
      await pool.query(
        "INSERT INTO category_rules (merchant_pattern, category_id, match_type, created_by) VALUES ($1,$2,'contains','setup') ON CONFLICT DO NOTHING",
        [pattern, catId]
      );
    }
  }
}

async function bootstrapState() {
  const [
    familyMembers,
    categories,
    items,
    accounts,
    transactions,
    passphrases,
  ] = await Promise.all([
    countTable('family_members'),
    countTable('categories'),
    countTable('items'),
    countTable('accounts'),
    countTable('transactions'),
    passphraseCount(),
  ]);
  const plaid = plaidConfigStatus();
  const needsHousehold = familyMembers === 0;
  const needsAuth = passphrases === 0;
  const needsStarterContent = categories === 0;

  return {
    status: needsHousehold || needsAuth || needsStarterContent || !plaid.configured
      ? 'needs_setup'
      : 'ready',
    app: 'family-pulse',
    version: '1.0.0',
    bootstrap: {
      needs_household: needsHousehold,
      needs_auth: needsAuth,
      needs_starter_content: needsStarterContent,
      needs_plaid_config: !plaid.configured,
      ready: !needsHousehold && !needsAuth && !needsStarterContent && plaid.configured,
    },
    counts: {
      family_members: familyMembers,
      categories,
      items,
      accounts,
      transactions,
      passphrases,
    },
    features: {
      auth_enabled: passphrases > 0,
      plaid_configured: plaid.configured,
    },
    plaid_config_error: plaid.configured ? null : plaid.error,
  };
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
app.use(require('./lib/routes/notifications'));

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

app.get('/api/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const plaid = plaidConfigStatus();
    res.json({
      status: 'ok',
      app: 'family-pulse',
      checks: {
        db: 'ok',
        plaid_config: plaid.configured ? 'ok' : 'missing',
      },
      plaid_config_error: plaid.configured ? null : plaid.error,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      app: 'family-pulse',
      checks: { db: 'error' },
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

app.get('/api/bootstrap', async (req, res) => {
  try {
    res.json(await bootstrapState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bootstrap/household', async (req, res) => {
  try {
    const state = await bootstrapState();
    if (!state.bootstrap.needs_household) {
      return res.status(409).json({ error: 'Household already configured' });
    }

    const { members: rawMembers, install_starter_content = true } = req.body;
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      return res.status(400).json({ error: 'At least one member is required' });
    }
    const hasParent = rawMembers.some(m => m.role === 'parent');
    if (!hasParent) {
      return res.status(400).json({ error: 'At least one parent is required' });
    }

    const createdMembers = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let parentIdx = 0;
      let kidIdx = 0;
      for (const m of rawMembers) {
        const name = String(m.name || '').trim();
        if (!name) continue;
        const role = m.role === 'parent' ? 'parent' : 'kid';
        const isParent = role === 'parent';
        const avatarPool = isParent ? PARENT_AVATARS : KID_AVATARS;
        const colorPool = isParent ? PARENT_COLORS : KID_COLORS;
        const idx = isParent ? parentIdx++ : kidIdx++;
        const avatar_emoji = avatarPool[idx % avatarPool.length];
        const color = colorPool[idx % colorPool.length];
        const { rows } = await client.query(
          'INSERT INTO family_members (name, role, avatar_emoji, color) VALUES ($1,$2,$3,$4) RETURNING id, name, role, avatar_emoji, color',
          [name, role, avatar_emoji, color]
        );
        createdMembers.push(rows[0]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (install_starter_content) await installStarterContent();

    const bootstrapToken = issueBootstrapToken();
    res.cookie('fp_bootstrap_token', bootstrapToken, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: TOKEN_TTL_MS,
      path: '/',
    });

    res.status(201).json({
      ok: true,
      created_members: createdMembers,
      bootstrap: (await bootstrapState()).bootstrap,
    });
  } catch (err) {
    logger.error('Household bootstrap failed', { error: err.message });
    res.status(500).json({ error: err.message });
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
    res.json({
      ...result,
      synced: result.items,
      transactions_added: result.txns_added,
      transactions_modified: result.txns_modified,
      transactions_removed: result.txns_removed
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Cron schedule + Start ─────────────────────────────────────

if (require.main === module) {
  warnIfPlaidConfigMissing();

  // Only register cron when running as the main process (not in tests)
  cron.schedule('0 6 * * *', () => {
    logger.info('Cron sync triggered (6 AM)');
    syncAll().catch(err => logger.error('Cron sync failed', { error: err.message }));
  }, { timezone: TZ });

  cron.schedule('0 12 * * *', () => {
    logger.info('Cron sync triggered (12 PM)');
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

module.exports = { app, pool, cfg, setCfg, bootstrapState, plaidConfigStatus, warnIfPlaidConfigMissing };
