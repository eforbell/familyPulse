#!/usr/bin/env node
'use strict';

/**
 * demo-showcase.js — a fictional household for README screenshots and demos.
 *
 *   node scripts/demo-showcase.js seed
 *     Migrates the database in DATABASE_URL and fills it with ~15 months of
 *     invented history for "Sam & Morgan" and their kids Leo and Maya: paychecks
 *     with paystub breakdowns, bills, subscriptions (with a price increase),
 *     savings transfers, kids' allowances, and a dining-out spike this month.
 *     Then it runs the app's own recurring, anomaly and snapshot detectors.
 *
 *   node scripts/demo-showcase.js screenshots [--url http://127.0.0.1:3097/] [--out docs/images]
 *     Captures the README images from a running server that uses the demo DB.
 *     Needs Chrome or `npx playwright install chromium`.
 *
 * Every name, merchant amount, institution and account here is made up. Before
 * writing anything, the seed checks (read-only) that the database name contains
 * "demo" or "showcase" and that the database is brand new, with no tables at all,
 * so it cannot touch real data.
 *
 * Typical run (Docker Postgres from docker-compose.yml):
 *   docker compose exec -T db psql -U familypulse -d postgres -c 'CREATE DATABASE familypulse_showcase'
 *   export DATABASE_URL=postgresql://familypulse:<password>@localhost:5434/familypulse_showcase
 *   node scripts/demo-showcase.js seed
 *   PORT=3097 PLAID_CLIENT_ID=demo PLAID_SECRET=demo PLAID_ENV=sandbox node server.js &
 *   node scripts/demo-showcase.js screenshots
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { extractDatabaseName } = require('../db/test-env');

const ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error(`demo-showcase: ${message}`);
  process.exit(1);
}

function guardDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) fail('set DATABASE_URL to a dedicated demo database (it is not read from .env)');
  const name = extractDatabaseName(url) || '';
  if (!/demo|showcase/i.test(name)) fail(`refusing database "${name}": its name must contain "demo" or "showcase"`);
  // test mode makes db/migrate.js load .env.test, which could point the migration elsewhere
  if (['production', 'test'].includes(process.env.NODE_ENV)) fail(`refusing to run with NODE_ENV=${process.env.NODE_ENV}`);
  return name;
}

// Read-only check before any write: only a freshly created, empty database qualifies.
async function assertEmptyDatabase(dbName) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows: [{ tables }] } = await client.query(
      `SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'`);
    if (tables > 0) fail(`"${dbName}" already has ${tables} tables; seed only into a freshly created, empty database`);
  } finally {
    await client.end();
  }
}

// ── deterministic helpers ─────────────────────────────────────

let rngState = 20261118;
const rnd = () => { rngState = (rngState * 1664525 + 1013904223) % 4294967296; return rngState / 4294967296; };
const between = (a, b) => a + (b - a) * rnd();
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const money = (n) => Math.round(n * 100) / 100;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const daysInMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
const monthKey = (d) => iso(d).slice(0, 7);
const monthOffset = (d, n) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

// ── seed ──────────────────────────────────────────────────────

async function seed() {
  const dbName = guardDatabase();
  await assertEmptyDatabase(dbName);
  execFileSync(process.execPath, [path.join(ROOT, 'db/migrate.js')], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' }, // migrate exactly the DATABASE_URL validated above
  });

  const { pool } = require('../lib/db');
  const { householdToday } = require('../lib/reports');
  const { savePaycheck } = require('../lib/paychecks');
  const { detectRecurringCashflows } = require('../lib/recurring-detector');
  const { detectAnomalies } = require('../lib/anomaly-detector');
  const { backfillSnapshots } = require('../lib/snapshot-generator');
  const q = (sql, params) => pool.query(sql, params);

  await q(fs.readFileSync(path.join(ROOT, 'db/seed.sql'), 'utf8'));

  const todayStr = householdToday();
  const TODAY = addDays(new Date(`${todayStr}T00:00:00Z`), -1); // last posted day
  const START = monthOffset(TODAY, -15);
  const thisMonth = monthKey(TODAY);
  const priceHikeMonth = monthKey(monthOffset(TODAY, -3));

  // household
  await q('DELETE FROM family_members');
  const members = {};
  for (const [name, role, emoji, color, budget] of [
    ['Sam', 'parent', '🧔', '#3b82f6', null], ['Morgan', 'parent', '👩', '#ec4899', null],
    ['Leo', 'kid', '🧒', '#f59e0b', 60], ['Maya', 'kid', '👧', '#8b5cf6', 50]]) {
    const { rows } = await q(
      'INSERT INTO family_members (name, role, avatar_emoji, color, monthly_budget) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [name, role, emoji, color, budget]);
    members[name] = rows[0].id;
  }

  // categories and budgets
  await q(`INSERT INTO categories (name, color, icon) VALUES ('Mortgage', '#0f766e', '🏠') ON CONFLICT (name) DO NOTHING`);
  await q(`INSERT INTO categories (name, color, icon, is_transfer_class) VALUES ('Investing', '#0ea5e9', '📈', true) ON CONFLICT (name) DO NOTHING`);
  const cat = {};
  for (const r of (await q('SELECT id, name FROM categories')).rows) cat[r.name] = r.id;
  const budgets = { Mortgage: 2145, Groceries: 1150, 'Dining Out': 450, 'Gas & Auto': 220, Utilities: 420, Healthcare: 150,
    Entertainment: 120, Shopping: 350, 'Kids Activities': 300, Subscriptions: 70, 'Home & Garden': 200, Insurance: 215, Travel: 300 };
  for (const [name, amount] of Object.entries(budgets)) await q('UPDATE categories SET budget_amount=$1 WHERE id=$2', [amount, cat[name]]);

  // institutions and accounts (tokens are placeholders; nothing here talks to Plaid)
  const item = async (name, n) => (await q(
    `INSERT INTO items (access_token, item_id, institution_id, institution_name, last_sync_at)
     VALUES ($1,$2,$3,$4, now() - interval '2 hours') RETURNING id`,
    [`demo-token-${n}`, `demo-item-${n}`, `ins_demo_${n}`, name])).rows[0].id;
  const creditUnion = await item('Harborview Credit Union', 1);
  const cardIssuer = await item('Summit Card Services', 2);
  const account = async (itemId, n, name, type, subtype, mask, balance, available = balance, liability = {}) => (await q(
    `INSERT INTO accounts (plaid_account_id, item_id, name, type, subtype, mask, current_balance, available_balance,
       last_statement_balance, minimum_payment_amount, next_payment_due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [`demo-acct-${n}`, itemId, name, type, subtype, mask, balance, available,
      liability.statement ?? null, liability.minimum ?? null, liability.due ?? null])).rows[0].id;
  const A = {
    checking: await account(creditUnion, 1, 'Joint Checking', 'depository', 'checking', '4821', 8742.55),
    savings: await account(creditUnion, 2, 'Rainy Day Savings', 'depository', 'savings', '4839', 24150.00),
    visa: await account(cardIssuer, 3, 'Summit Rewards Visa', 'credit', 'credit card', '7702', 1412.58, 15000 - 1412.58,
      { statement: 1984.33, minimum: 40, due: iso(addDays(TODAY, 16)) }),
    leo: await account(creditUnion, 4, "Leo's Checking", 'depository', 'checking', '5110', 186.40),
    maya: await account(creditUnion, 5, "Maya's Checking", 'depository', 'checking', '5128', 142.75),
  };
  await q('INSERT INTO account_members (account_id, member_id) VALUES ($1,$2), ($3,$4)', [A.leo, members.Leo, A.maya, members.Maya]);

  // transactions (Plaid convention: positive = money out)
  const tx = [];
  const add = (acct, date, amount, merchant, category, extra = {}) =>
    tx.push({ id: `demo-tx-${tx.length + 1}`, account: acct, date: iso(date), amount: money(amount), merchant, category: cat[category], ...extra });

  let samPayday = addDays(START, 14 + ((5 - START.getUTCDay() + 7) % 7)); // a Friday, biweekly from here
  for (let d = START; d <= TODAY; d = addDays(d, 1)) {
    const day = d.getUTCDate(), month = d.getUTCMonth() + 1, weekday = d.getUTCDay(), last = daysInMonth(d), ym = monthKey(d);

    if (d.getTime() === samPayday.getTime()) { add(A.checking, d, -2834.62, 'Brightline Systems Payroll', 'Income', { pay: 'Sam' }); samPayday = addDays(samPayday, 14); }
    if (day === 15 || day === last) add(A.checking, d, -2108.75, 'Valley Health Partners', 'Income', { pay: 'Morgan' });
    if (month === 3 && day === 20) add(A.checking, d, -1840.00, 'IRS Treas 310 Tax Refund', 'Income');

    if (day === 1) add(A.checking, d, 2145.00, 'Lakeshore Home Loans', 'Mortgage');
    if (day === 3) add(A.checking, d, 214.60, 'State Farm', 'Insurance');
    if (day === 12) add(A.checking, d, [1, 2, 7, 8].includes(month) ? between(158, 172) : between(136, 150), 'Duke Energy', 'Utilities');
    if (day === 18) add(A.checking, d, between(58, 74), 'City of Oakridge Water', 'Utilities');
    if (day === 9) add(A.visa, d, ym >= priceHikeMonth ? 84.99 : 79.99, 'Spectrum Internet', 'Utilities');
    if (day === 22) add(A.visa, d, 90.00, 'Visible Wireless', 'Utilities');
    if (day === 7) add(A.visa, d, ym >= thisMonth ? 16.99 : 15.49, 'Netflix', 'Subscriptions');
    if (day === 14) add(A.visa, d, 19.99, 'Spotify Family', 'Subscriptions');
    if (day === 21) add(A.visa, d, 9.99, 'Disney+', 'Subscriptions');
    if (day === 2) add(A.visa, d, 2.99, 'iCloud+', 'Subscriptions');
    if (day === 5) add(A.visa, d, 85.00, 'Riverside Youth Soccer', 'Kids Activities');
    if (day === 10) add(A.visa, d, 140.00, 'Harmony Piano Studio', 'Kids Activities');

    // savings leave checking as transfers, as sync's transfer detection marks them
    if (day === 16) add(A.checking, d, 250.00, 'NC 529 College Plan', '529 Contribution', { transferType: '529_contribution' });
    if (weekday === 1 && day <= 7) add(A.checking, d, 200.00, 'Swan Bitcoin', 'Crypto/BTC', { transferType: 'crypto_savings' });
    if (day === 28) add(A.checking, d, 500.00, 'Transfer to Vanguard Brokerage', 'Investing', { transferType: 'transfer' });
    if (weekday === 6) for (const [kid, amount] of [[A.leo, 15], [A.maya, 12]]) {
      const pair = `allowance-${iso(d)}-${kid}`;
      add(A.checking, d, amount, 'Allowance transfer', 'Transfer', { pair, transferType: 'inter_account' });
      add(kid, d, -amount, 'Allowance from Joint Checking', 'Transfer', { pair, transferType: 'inter_account' });
    }

    if (weekday === 0 || weekday === 3) add(A.visa, d, between(95, 175), pick(["Trader Joe's", 'Harris Teeter', 'Publix']), 'Groceries');
    if (day % 14 === 4) add(A.visa, d, between(160, 290), 'Costco', 'Groceries');
    if (rnd() < 0.26) add(A.visa, d, between(9, 68), pick(['Chipotle', 'Blue Door Café', 'Starbucks', "Domino's", 'Panera Bread', 'Sakura Sushi']), 'Dining Out');
    if (rnd() < 0.11) add(A.visa, d, between(38, 64), pick(['Shell', 'Exxon', 'Costco Gas']), 'Gas & Auto');
    if (rnd() < 0.16) add(A.visa, d, between(12, 95), pick(['Amazon', 'Target', 'Old Navy']), 'Shopping');
    if (rnd() < 0.05) add(A.visa, d, between(18, 140), pick(['Home Depot', "Lowe's", 'Oakridge Garden Center']), 'Home & Garden');
    if (rnd() < 0.045) add(A.visa, d, between(14, 85), pick(['CVS Pharmacy', 'Oakridge Pediatrics']), 'Healthcare');
    if (rnd() < 0.05) add(A.visa, d, between(15, 62), pick(['AMC Theatres', 'Bowlero', 'Steam']), 'Entertainment');

    if (month === 12 && (day === 6 || day === 13)) add(A.visa, d, between(310, 420), pick(['Amazon', 'Target']), 'Shopping');
    if (month === 6 && day === 15) add(A.visa, d, 650.00, 'Camp Pinewood', 'Kids Activities');
    if (month === 7 && day === 2) add(A.visa, d, 1284.60, 'Delta Air Lines', 'Travel');
    if (month === 7 && day === 3) add(A.visa, d, 1652.00, 'Airbnb', 'Travel');
    if (month === 3 && day === 11) add(A.visa, d, 865.40, 'Oakridge Auto Care', 'Gas & Auto');
    if (ym === thisMonth && [6, 8, 13, 15].includes(day)) add(A.visa, d, between(82, 128), pick(['Sakura Sushi', 'Ember Steakhouse', 'Blue Door Café']), 'Dining Out');

    if (rnd() < 0.07) add(A.leo, d, between(5, 22), pick(['Roblox', 'GameStop', 'Chick-fil-A', 'Five Below']), pick(['Entertainment', 'Dining Out', 'Shopping']));
    if (rnd() < 0.06) add(A.maya, d, between(4, 19), pick(['Barnes & Noble', "Claire's", "Rita's Ice", 'Michaels']), pick(['Shopping', 'Dining Out', 'Entertainment']));
  }

  // card paid in full from checking on the 25th of the following month (a paired transfer)
  const cardSpend = {};
  for (const t of tx) if (t.account === A.visa) cardSpend[t.date.slice(0, 7)] = (cardSpend[t.date.slice(0, 7)] || 0) + t.amount;
  for (const [ym, total] of Object.entries(cardSpend)) {
    const payDate = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 25));
    if (payDate > TODAY) continue;
    add(A.checking, payDate, total, 'Summit Card Payment', 'CC Payment', { pair: `card-${ym}`, transferType: 'cc_payment' });
    add(A.visa, payDate, -total, 'Payment — Thank You', 'CC Payment', { pair: `card-${ym}`, transferType: 'cc_payment' });
  }
  tx.sort((a, b) => a.date.localeCompare(b.date));
  for (const t of tx.filter(t => t.account === A.visa && t.amount > 0).slice(-2)) t.pending = true;

  const pairs = {};
  for (const t of tx) {
    const { rows } = await q(
      `INSERT INTO transactions (plaid_transaction_id, account_id, amount, date, merchant_name, name, category_id,
         pending, is_transfer, transfer_type, categorization_source)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'rule') RETURNING id`,
      [t.id, t.account, t.amount, t.date, t.merchant, t.category, !!t.pending, !!t.transferType, t.transferType || null]);
    t.dbId = rows[0].id;
    if (t.pair) (pairs[t.pair] ||= []).push(t.dbId);
  }
  for (const [a, b] of Object.values(pairs)) {
    await q('UPDATE transactions SET transfer_pair_id=$2 WHERE id=$1', [a, b]);
    await q('UPDATE transactions SET transfer_pair_id=$2 WHERE id=$1', [b, a]);
  }

  // paystub breakdowns: the Sankey starts from gross pay when these exist
  const stubs = {
    Sam: { employer: 'Brightline Systems', gross_earnings: '4326.92', federal_tax: '545.20', social_security_tax: '268.27',
      medicare_tax: '62.74', retirement_401k: '346.15', health_insurance: '162.44', other_deductions: [{ name: 'State income tax', amount: '107.50' }] },
    Morgan: { employer: 'Valley Health Partners', gross_earnings: '3125.00', federal_tax: '312.40', social_security_tax: '193.75',
      medicare_tax: '45.31', retirement_401k: '250.00', health_insurance: '0.00', other_deductions: [{ name: 'State income tax', amount: '214.79' }] },
  };
  const client = await pool.connect();
  try {
    for (const t of tx.filter(t => t.pay)) {
      await client.query('BEGIN');
      await savePaycheck(client, { transactionId: t.dbId, createdBy: members.Sam, input: { ...stubs[t.pay], member_id: members[t.pay] } });
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await q(
    `INSERT INTO planned_expenses (name, amount, scheduled_date, notes, created_by, type) VALUES
       ('Holiday travel', 1800, $1, 'Flights to see grandparents', $4, 'expense'),
       ('Property tax', 3240, $2, null, $4, 'expense'),
       ('Year-end bonus', 4000, $3, null, $4, 'income')`,
    [iso(addDays(TODAY, 31)), iso(addDays(TODAY, 48)), iso(addDays(TODAY, 27)), members.Sam]);

  // let the app's own detectors find patterns, as a nightly run would
  const asOfDate = todayStr;
  await detectRecurringCashflows({ asOfDate, forceFullScan: true });
  for (let i = 2; i >= 0; i--) await detectAnomalies(monthKey(monthOffset(TODAY, -i)));
  await backfillSnapshots();

  // random spending can look periodic; ignore it as a household would, and
  // dismiss the first-run "new commitment" alerts except one example
  const noise = ['AMC Theatres', 'Bowlero', 'Costco Gas', 'Five Below', 'Publix', 'Sakura Sushi', 'Target',
    "Trader Joe's", 'Harris Teeter', 'Chipotle', 'Starbucks', 'Amazon', 'Shell', 'Exxon'];
  await q('DELETE FROM recurring_alert_events WHERE recurring_expense_id IN (SELECT id FROM recurring_expenses WHERE merchant_name = ANY($1))', [noise]);
  await q("UPDATE recurring_expenses SET status='ignored', ignored_reason='demo noise' WHERE merchant_name = ANY($1)", [noise]);
  await q(`UPDATE recurring_alert_events SET dismissed_at = now()
           WHERE event_type = 'recurring_new_commitment'
             AND recurring_expense_id NOT IN (SELECT id FROM recurring_expenses WHERE merchant_name = 'Harmony Piano Studio')`);

  console.log(`demo-showcase: seeded "${dbName}" with ${tx.length} transactions through ${iso(TODAY)}`);
  await pool.end();
}

// ── screenshots ───────────────────────────────────────────────

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function screenshots() {
  const { chromium } = require('@playwright/test');
  const base = option('--url', 'http://127.0.0.1:3097/').replace(/\/?$/, '/');
  const out = path.resolve(ROOT, option('--out', 'docs/images'));
  fs.mkdirSync(out, { recursive: true });

  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
    .catch(() => chromium.launch());

  async function signedIn({ width, height, scale, scheme }) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: scheme });
    await ctx.addInitScript(() => { try { localStorage.setItem('pulse.sankeyRange', 'last_month'); } catch { /* optional */ } });
    const members = await (await ctx.request.get(`${base}api/auth/members`)).json();
    const sam = (members.members || members).find(m => m.name === 'Sam');
    if (!sam) fail(`no demo member "Sam" at ${base}; is the server using the demo database?`);
    const login = await ctx.request.post(`${base}api/auth/login`, { data: { member_id: sam.id } });
    if (!login.ok()) fail(`sign-in failed (${login.status()}); the demo database must have no passphrases set`);
    return ctx;
  }
  async function open(page, file) {
    await page.goto(base + file, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500); // charts animate in
  }

  for (const scheme of ['light', 'dark']) {
    const ctx = await signedIn({ width: 1440, height: 900, scale: 1.25, scheme });
    const page = await ctx.newPage();
    await open(page, 'reports.html');
    await page.addStyleTag({ content: 'header{position:static!important}' }); // keep the sticky header out of the crop
    await page.locator('#cash-flow-section').screenshot({ path: path.join(out, `cash-flow-${scheme}.png`) });
    if (scheme === 'light') {
      for (const [file, name] of [['index.html', 'dashboard'], ['budget.html', 'budget'], ['forecast.html', 'forecast']]) {
        await open(page, file);
        await page.screenshot({ path: path.join(out, `${name}.png`) });
      }
    }
    await ctx.close();
  }

  const phone = await signedIn({ width: 390, height: 844, scale: 2, scheme: 'dark' });
  const phonePage = await phone.newPage();
  const shots = [];
  for (const file of ['index.html', 'recurring.html', 'forecast.html']) {
    await open(phonePage, file);
    shots.push((await phonePage.screenshot()).toString('base64'));
  }
  await phone.close();

  const strip = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1.38 });
  await strip.setContent(`<style>
    body{margin:0;background:transparent}
    .wrap{display:flex;gap:56px;align-items:flex-start;padding:48px 56px;width:max-content;border-radius:28px;
      background:radial-gradient(ellipse at 30% 0%,#1f3d2b 0%,#141714 60%)}
    .phone{width:340px;border-radius:44px;padding:10px;background:#0b0c0b;box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 1px #2c2f2c}
    .phone img{width:100%;display:block;border-radius:34px}
    .phone:nth-child(2){margin-top:36px}
  </style><div class="wrap">${shots.map(s => `<div class="phone"><img src="data:image/png;base64,${s}"></div>`).join('')}</div>`);
  await strip.waitForTimeout(300);
  await strip.locator('.wrap').screenshot({ path: path.join(out, 'mobile.png'), omitBackground: true });

  await browser.close();
  console.log(`demo-showcase: wrote README images to ${path.relative(ROOT, out) || '.'}`);
}

const command = process.argv[2];
if (command === 'seed') seed().catch(err => fail(err.stack || err.message));
else if (command === 'screenshots') screenshots().catch(err => fail(err.stack || err.message));
else fail('usage: node scripts/demo-showcase.js seed | screenshots [--url URL] [--out DIR]');
