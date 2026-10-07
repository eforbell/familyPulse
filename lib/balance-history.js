'use strict';

// Retroactive balance reconstruction.
//
// There is no balance snapshot table, so history is rebuilt by walking back
// from today's balance through synced transactions. Plaid sign convention:
// amount > 0 is money out (spending / payments), amount < 0 is money in.
//
//   depository: balance(D) = current + Σ amount(date > D)
//   credit:     owed(D)    = current − Σ amount(date > D)
//
// Series are signed for display: deposits positive, credit negative.
// Only depository and credit accounts are reconstructed — investment and loan
// balances move for reasons transactions don't capture (market value, interest).

const RANGES = {
  '3m': { label: '3 months', step: 3 },
  '6m': { label: '6 months', step: 7 },
  '1y': { label: '1 year', step: 7 },
  ytd: { label: 'Year to date', step: 7 }
};

// Own-property check: `range=toString` / `constructor` must not pass as valid.
function isValidRange(range) {
  return typeof range === 'string' && Object.hasOwn(RANGES, range);
}

const RECONSTRUCTABLE_TYPES = new Set(['depository', 'credit']);

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function toUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  return fromUtc(toUtc(dateStr) + days * 86400000);
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

function todayInTimezone(tz, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

function rangeStart(range, today) {
  if (range === '3m') return addMonths(today, -3);
  if (range === '6m') return addMonths(today, -6);
  if (range === '1y') return addMonths(today, -12);
  return `${today.slice(0, 4)}-01-01`; // ytd
}

// Sample dates from `start` forward by `step` days, always ending on `today`.
function buildSampleDates(start, today, step) {
  const dates = [];
  for (let d = start; d < today; d = addDays(d, step)) dates.push(d);
  dates.push(today);
  return dates;
}

/**
 * @param {object} opts
 * @param {Array} opts.accounts  [{id, display_name, type, current_balance, owner?, institution_name?, mask?, first_txn_date}]
 * @param {Array} opts.deltas    [{account_id, date: 'YYYY-MM-DD', total}] summed Plaid amounts per account/day
 * @param {string} opts.range    3m | 6m | 1y | ytd
 * @param {string} opts.today    YYYY-MM-DD
 */
function buildBalanceHistory({ accounts, deltas, range, today }) {
  if (!isValidRange(range)) throw new Error(`Unknown range: ${range}`);
  const cfg = RANGES[range];

  const start = rangeStart(range, today);
  const dates = buildSampleDates(start, today, cfg.step);

  const byAccount = new Map();
  for (const row of deltas) {
    if (!byAccount.has(row.account_id)) byAccount.set(row.account_id, []);
    byAccount.get(row.account_id).push({ date: row.date, total: Number(row.total) });
  }

  const series = [];
  for (const account of accounts) {
    if (!RECONSTRUCTABLE_TYPES.has(account.type)) continue;

    const sign = account.type === 'credit' ? -1 : 1;
    // A missing balance (e.g. imported accounts) is unknown, not zero: there is
    // no anchor to walk back from, so the account gets no history at all.
    const rawBalance = account.current_balance;
    const balanceKnown = rawBalance !== null && rawBalance !== undefined && rawBalance !== ''
      && Number.isFinite(Number(rawBalance));
    const current = balanceKnown ? Number(rawBalance) : 0;
    const txns = byAccount.get(account.id) || [];
    const firstTxn = balanceKnown ? (account.first_txn_date || null) : null;

    const values = dates.map(date => {
      // No transactions synced this far back: balance is unknown, not zero.
      if (!firstTxn || date < firstTxn) return null;
      let after = 0;
      for (const t of txns) if (t.date > date) after += t.total;
      const balance = account.type === 'credit' ? current - after : current + after;
      return roundMoney(sign * balance);
    });

    series.push({
      id: account.id,
      name: account.display_name,
      type: account.type,
      owner: account.owner || null,
      institution: account.institution_name || null,
      mask: account.mask || null,
      data_from: firstTxn,
      reason: !balanceKnown ? 'unknown_balance' : (!firstTxn ? 'no_transactions' : null),
      values
    });
  }

  // Net is only meaningful where every included account has data; otherwise
  // it would jump when an account's history begins. Accounts with no synced
  // transactions at all can never contribute, so they are left out of net
  // (and reported in partial_accounts) rather than blanking the whole line.
  const netSeries = series.filter(s => s.data_from);
  const netValues = dates.map((_, i) => {
    if (!netSeries.length) return null;
    let sum = 0;
    for (const s of netSeries) {
      if (s.values[i] === null) return null;
      sum += s.values[i];
    }
    return roundMoney(sum);
  });

  const partial = series.filter(s => s.values.some(v => v === null));

  return {
    range,
    label: cfg.label,
    start,
    end: today,
    step_days: cfg.step,
    dates,
    net: netValues,
    accounts: series,
    // reason: unknown_balance | no_transactions | starts_late
    partial_accounts: partial.map(s => ({ id: s.id, name: s.name, data_from: s.data_from, reason: s.reason || 'starts_late' }))
  };
}

module.exports = {
  RANGES,
  isValidRange,
  RECONSTRUCTABLE_TYPES,
  buildBalanceHistory,
  buildSampleDates,
  rangeStart,
  todayInTimezone,
  addDays,
  addMonths
};
