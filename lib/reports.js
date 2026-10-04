'use strict';

const { pool } = require('./db');

// ── Dates ────────────────────────────────────────────────────
// Report windows are calendar windows in the household's timezone, not the
// server's. All arithmetic below is on plain YYYY-MM-DD strings via UTC dates
// so DST never shifts a day boundary.

const DAY_MS = 86400000;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function householdToday(now = new Date()) {
  const tz = process.env.HOUSEHOLD_TIMEZONE || 'America/New_York';
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fmtDay(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fmtDay(new Date(parseDay(s).getTime() + n * DAY_MS));
}

function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

function monthStart(s, offsetMonths = 0) {
  const d = parseDay(s);
  return fmtDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1)));
}

function yearStart(s, offsetYears = 0) {
  return `${parseDay(s).getUTCFullYear() + offsetYears}-01-01`;
}

function monthName(s, opts = { month: 'long' }) {
  return parseDay(s).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ── Spending burn ────────────────────────────────────────────

const BURN_MODES = {
  week_vs_last_week: 'This week vs. last week',
  month_vs_last_month: 'This month vs. last month',
  month_vs_last_year: 'This month vs. last year',
  month_vs_average: 'This month vs. average month',
  year_vs_last_year: 'This year vs. last year'
};

const AVERAGE_MONTHS = 3;

/**
 * Describe the current and reference windows for a burn mode. Each window is
 * [start, end) and is indexed by day offset from its start, so "day 5" of this
 * month lines up with "day 5" of every reference month.
 */
function burnWindows(mode, today) {
  switch (mode) {
    case 'week_vs_last_week': {
      const start = addDays(today, -parseDay(today).getUTCDay());
      return {
        current: { label: 'This week', start, end: addDays(start, 7) },
        references: [{ start: addDays(start, -7), end: start }],
        referenceLabel: 'Last week',
        length: 7
      };
    }
    case 'month_vs_last_month':
    case 'month_vs_last_year':
    case 'month_vs_average': {
      const start = monthStart(today);
      const end = monthStart(today, 1);
      let references;
      let referenceLabel;
      if (mode === 'month_vs_last_month') {
        references = [{ start: monthStart(today, -1), end: start }];
        referenceLabel = monthName(references[0].start);
      } else if (mode === 'month_vs_last_year') {
        references = [{ start: monthStart(today, -12), end: monthStart(today, -11) }];
        referenceLabel = monthName(references[0].start, { month: 'long', year: 'numeric' });
      } else {
        references = [];
        for (let i = AVERAGE_MONTHS; i >= 1; i--) {
          references.push({ start: monthStart(today, -i), end: monthStart(today, -i + 1) });
        }
        referenceLabel = `${AVERAGE_MONTHS}-month average`;
      }
      const length = Math.max(daysBetween(start, end), ...references.map(r => daysBetween(r.start, r.end)));
      return { current: { label: 'This month', start, end }, references, referenceLabel, length };
    }
    case 'year_vs_last_year': {
      const start = yearStart(today);
      const refStart = yearStart(today, -1);
      // Years line up by calendar date, not ordinal day, so a leap day on
      // either side never shifts every later comparison by one day.
      return {
        current: { label: 'This year', start, end: yearStart(today, 1) },
        references: [{ start: refStart, end: start, calendarAligned: true }],
        referenceLabel: String(parseDay(refStart).getUTCFullYear()),
        length: daysBetween(start, yearStart(today, 1))
      };
    }
    default:
      return null;
  }
}

function burnLabels(mode, windows) {
  const labels = [];
  for (let i = 0; i < windows.length; i++) {
    if (mode === 'week_vs_last_week') labels.push(WEEKDAY_SHORT[i]);
    else if (mode === 'year_vs_last_year') {
      const d = parseDay(addDays(windows.current.start, i));
      labels.push(`${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`);
    } else labels.push(`Day ${i + 1}`);
  }
  return labels;
}

/**
 * Cumulative spend for each day index of the current window. Each index maps
 * to a target date in `window`; the value is total spend from window.start
 * through that date.
 *
 * - Day-aligned windows (weeks, months) map index i to start + i, and days
 *   past the window's own end carry the final total forward (a 30-day month
 *   is "done" on day 31).
 * - Calendar-aligned windows (years) map index i to the same month/day as the
 *   current window's day i. A Feb 29 with no counterpart uses Feb 28, and a
 *   reference Feb 29 lands on Mar 1 — the first comparable date after it.
 */
function cumulativeSeries(daily, window, currentStart, length, throughIndex = length - 1) {
  const windowDays = daysBetween(window.start, window.end);
  const cumulative = [];
  let running = 0;
  for (let i = 0; i < windowDays; i++) {
    running += daily.get(addDays(window.start, i)) || 0;
    cumulative.push(running);
  }

  const targetIndex = (i) => {
    if (!window.calendarAligned) return Math.min(i, windowDays - 1);
    const monthDay = addDays(currentStart, i).slice(4);
    let target = window.start.slice(0, 4) + monthDay;
    if (fmtDay(parseDay(target)) !== target) target = window.start.slice(0, 4) + '-02-28';
    return daysBetween(window.start, target);
  };

  const series = [];
  for (let i = 0; i <= throughIndex && i < length; i++) {
    series.push(round2(cumulative[targetIndex(i)] || 0));
  }
  return series;
}

/**
 * Spending "burn" — cumulative posted outflow so far this period against a
 * reference period, aligned by day. Uses the same posted bank-event basis as
 * the budget summary and Income vs Spending chart so the totals agree.
 */
async function getSpendingBurn(mode = 'month_vs_last_month', { today = householdToday() } = {}) {
  const windows = burnWindows(mode, today);
  if (!windows) return null;

  const rangeStart = [windows.current.start, ...windows.references.map(r => r.start)].sort()[0];
  const { rows } = await pool.query(`
    SELECT to_char(t.date, 'YYYY-MM-DD') AS day, SUM(t.amount)::numeric AS spent
    FROM transactions t
    WHERE t.amount > 0
      AND t.is_transfer = false
      AND t.is_hidden = false
      AND t.pending = false
      AND t.date >= $1::date AND t.date <= $2::date
    GROUP BY t.date
  `, [rangeStart, today]);

  const daily = new Map(rows.map(r => [r.day, parseFloat(r.spent)]));
  const todayIndex = Math.min(daysBetween(windows.current.start, today), windows.length - 1);

  const currentStart = windows.current.start;
  const currentSeries = cumulativeSeries(daily, windows.current, currentStart, windows.length, todayIndex);
  const refSeriesList = windows.references.map(r => cumulativeSeries(daily, r, currentStart, windows.length));
  const referenceSeries = Array.from({ length: windows.length }, (_, i) =>
    round2(refSeriesList.reduce((s, series) => s + series[i], 0) / refSeriesList.length));

  const currentTotal = currentSeries[currentSeries.length - 1] || 0;
  const referenceToDate = referenceSeries[todayIndex] || 0;
  const referenceTotal = referenceSeries[referenceSeries.length - 1] || 0;

  return {
    mode,
    mode_label: BURN_MODES[mode],
    today,
    today_index: todayIndex,
    labels: burnLabels(mode, windows),
    current: {
      label: windows.current.label,
      start: windows.current.start,
      end: addDays(windows.current.end, -1),
      series: currentSeries,
      total: currentTotal
    },
    reference: {
      label: windows.referenceLabel,
      periods: windows.references.map(r => ({ start: r.start, end: addDays(r.end, -1) })),
      series: referenceSeries,
      to_date: referenceToDate,
      total: referenceTotal
    },
    delta_to_date: round2(currentTotal - referenceToDate)
  };
}

// ── Cash flow Sankey ─────────────────────────────────────────

const SANKEY_RANGES = {
  this_month: 'This month',
  last_month: 'Last month',
  last_3_months: 'Last 3 months',
  year_to_date: 'Year to date',
  last_12_months: 'Last 12 months',
  last_year: 'Last year'
};

function sankeyWindow(range, today) {
  const end = addDays(today, 1);
  switch (range) {
    case 'this_month': return { start: monthStart(today), end };
    case 'last_month': return { start: monthStart(today, -1), end: monthStart(today) };
    case 'last_3_months': return { start: monthStart(today, -3), end: monthStart(today) };
    case 'year_to_date': return { start: yearStart(today), end };
    case 'last_12_months': return { start: monthStart(today, -12), end: monthStart(today) };
    case 'last_year': return { start: yearStart(today, -1), end: yearStart(today) };
    default: return null;
  }
}

const DEDUCTIONS_GROUP = { id: 'group:deductions', name: 'Taxes & payroll deductions', icon: '🏛️' };
const SAVINGS_GROUP = { id: 'group:savings', name: 'Savings & transfers', icon: '🏦' };
const OTHER_LEAF = 'leaf:other';

/**
 * Turn per-category net allocation totals into a Sankey graph:
 *
 *   income sources → Income → [group →] spending leaves
 *                           → Saved
 *
 * Category allocations are signed and sum to each transaction's amount, so a
 * category with a negative net is money in and a positive net is money out.
 * Classifying by sign (rather than by is_income) keeps the graph balanced even
 * when refunds outweigh spending in a category. A paycheck with a paystub
 * breakdown therefore shows gross pay in and taxes/deductions out, while the
 * Saved/Shortfall node still equals the bank-basis net cash flow.
 */
function buildSankeyGraph(categoryRows, { maxLeaves = 18 } = {}) {
  const sources = [];
  const outflows = [];

  for (const r of categoryRows) {
    const net = round2(parseFloat(r.net));
    if (!net) continue;
    const base = {
      category_id: r.id ?? null,
      name: r.name || 'Uncategorized',
      icon: r.icon || '',
      color: r.color || null
    };
    if (net < 0) sources.push({ ...base, amount: -net });
    else {
      let group = null;
      if (r.is_transfer_class) group = SAVINGS_GROUP;
      else if (r.system_key && r.system_key.startsWith('paycheck.')) group = DEDUCTIONS_GROUP;
      outflows.push({ ...base, amount: net, group });
    }
  }

  sources.sort((a, b) => b.amount - a.amount);
  outflows.sort((a, b) => b.amount - a.amount);

  const income = round2(sources.reduce((s, x) => s + x.amount, 0));
  const spent = round2(outflows.reduce((s, x) => s + x.amount, 0));
  const net = round2(income - spent);

  const nodes = [];
  const links = [];
  const addNode = (node) => { nodes.push(node); return node.id; };

  for (const src of sources) {
    const id = addNode({ id: `src:${src.category_id ?? 'uncat'}`, kind: 'source', name: src.name, icon: src.icon, category_id: src.category_id, value: src.amount });
    links.push({ source: id, target: 'hub', value: src.amount });
  }
  if (net < 0) {
    addNode({ id: 'src:shortfall', kind: 'shortfall', name: 'Spent beyond income', icon: '⚠️', category_id: null, value: -net });
    links.push({ source: 'src:shortfall', target: 'hub', value: -net });
  }

  addNode({ id: 'hub', kind: 'hub', name: net < 0 ? 'Cash flow' : 'Total income', icon: '', category_id: null, value: round2(Math.max(income, spent)) });

  if (net > 0) {
    addNode({ id: 'saved', kind: 'saved', name: 'Saved', icon: '💚', category_id: null, value: net });
    links.push({ source: 'hub', target: 'saved', value: net });
  }

  // Keep the most significant leaves; fold the long tail into one node so
  // labels stay legible. Grouped outflows always render individually because
  // their parent node already gives them context.
  const ungrouped = outflows.filter(o => !o.group);
  const shown = new Set(ungrouped.slice(0, maxLeaves));
  const tail = ungrouped.filter(o => !shown.has(o));

  const groupTotals = new Map();
  for (const out of outflows) {
    if (!out.group) continue;
    groupTotals.set(out.group.id, round2((groupTotals.get(out.group.id) || 0) + out.amount));
  }
  for (const group of [DEDUCTIONS_GROUP, SAVINGS_GROUP]) {
    const total = groupTotals.get(group.id);
    if (!total) continue;
    addNode({ id: group.id, kind: 'group', name: group.name, icon: group.icon, category_id: null, value: total });
    links.push({ source: 'hub', target: group.id, value: total });
  }

  // Leaves are emitted ungrouped-first, then each group's children together,
  // matching the group nodes' order so the layout keeps their ribbons uncrossed.
  const leafOrder = [
    ...ungrouped.filter(o => shown.has(o)),
    ...outflows.filter(o => o.group === DEDUCTIONS_GROUP),
    ...outflows.filter(o => o.group === SAVINGS_GROUP)
  ];
  for (const out of leafOrder) {
    const id = addNode({ id: `out:${out.category_id ?? 'uncat'}`, kind: 'category', name: out.name, icon: out.icon, category_id: out.category_id, value: out.amount });
    links.push({ source: out.group ? out.group.id : 'hub', target: id, value: out.amount });
  }

  if (tail.length) {
    const total = round2(tail.reduce((s, o) => s + o.amount, 0));
    addNode({ id: OTHER_LEAF, kind: 'other', name: `${tail.length} smaller categories`, icon: '…', category_id: null, value: total });
    links.push({ source: 'hub', target: OTHER_LEAF, value: total });
  }

  return {
    totals: { income, spent, net },
    nodes,
    links,
    other_categories: tail.map(o => ({ name: o.name, icon: o.icon, amount: o.amount }))
  };
}

async function getCashFlowSankey(range = 'this_month', { today = householdToday(), maxLeaves } = {}) {
  const window = sankeyWindow(range, today);
  if (!window) return null;

  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.icon, c.color, c.system_key,
           COALESCE(c.is_transfer_class, false) AS is_transfer_class,
           SUM(ta.amount)::numeric AS net
    FROM transaction_allocations ta
    JOIN transactions t ON t.id = ta.transaction_id
    LEFT JOIN categories c ON c.id = ta.category_id
    WHERE t.is_transfer = false
      AND t.is_hidden = false
      AND t.pending = false
      AND t.date >= $1::date AND t.date < $2::date
    GROUP BY c.id
  `, [window.start, window.end]);

  return {
    range,
    range_label: SANKEY_RANGES[range],
    start: window.start,
    end: addDays(window.end, -1),
    ...buildSankeyGraph(rows, { maxLeaves })
  };
}

module.exports = {
  addDays,
  BURN_MODES,
  SANKEY_RANGES,
  householdToday,
  burnWindows,
  getSpendingBurn,
  buildSankeyGraph,
  getCashFlowSankey
};
