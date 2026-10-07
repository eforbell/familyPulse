/* accounts.js — Accounts page: net position + account grid */
'use strict';

let currentMember = null;
let renameTarget = null;

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Get current member from session — redirect to login if none
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) { currentMember = await res.json(); }
    else { window.location.replace('login.html'); return; }
  } catch { window.location.replace('login.html'); return; }

  updateWhoBtn();
  initHistoryRanges();
  await Promise.all([loadAccounts(), loadCoverage(), loadHistory()]);
});

// ── Data ─────────────────────────────────────────────────────

async function loadAccounts() {
  try {
    const data = await api('api/accounts/dashboard');
    renderDashboard(data);
  } catch (err) {
    document.getElementById('net-amount').textContent = 'Error loading';
    document.getElementById('net-amount').classList.remove('loading-pulse');
    console.error('Accounts load failed:', err);
  }
}

async function loadCoverage() {
  try {
    const data = await api('api/accounts/coverage');
    renderCoverage(data);
  } catch (err) {
    console.error('Coverage load failed:', err);
  }
}

// ── Balance history ──────────────────────────────────────────

let historyRange = '3m';
let historyReq = 0;

function initHistoryRanges() {
  const tabs = $('history-ranges');
  tabs.addEventListener('click', event => {
    const btn = event.target.closest('button[data-range]');
    if (!btn || btn.dataset.range === historyRange) return;
    historyRange = btn.dataset.range;
    for (const b of tabs.querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b === btn));
    }
    loadHistory();
  });
}

async function loadHistory() {
  const token = ++historyReq;
  try {
    const data = await api(`api/accounts/history?range=${encodeURIComponent(historyRange)}`);
    if (token !== historyReq) return; // a newer range was requested
    renderHistory(data);
  } catch (err) {
    if (token !== historyReq) return;
    $('history-net').innerHTML = '<div class="history-empty">Could not load balance history.</div>';
    console.error('History load failed:', err);
  }
}

// Distinct, colour-blind-safe hues for account lines. Net is always the bold text-colour line.
const HISTORY_PALETTE = ['#2a9d8f', '#e07a1f', '#4c78c9', '#b5499a', '#8a9a1b', '#c2453d', '#7a5cc4', '#1b8ab5', '#a8742a', '#4d8f3a'];
let historyHidden = new Set(); // account ids toggled off in the legend
let historyView = readHistoryView(); // 'lines' | 'stacked'

function readHistoryView() {
  try { return localStorage.getItem('pulse-history-view') === 'stacked' ? 'stacked' : 'lines'; } catch { return 'lines'; }
}
function saveHistoryView(view) {
  try { localStorage.setItem('pulse-history-view', view); } catch { /* per-viewer convenience only */ }
}
let historyData = null;

function renderHistory(data) {
  historyData = data;
  const net = $('history-net');
  const note = $('history-note');

  if (!data.accounts.length) {
    net.innerHTML = '<div class="history-empty">No deposit or credit accounts to chart.</div>';
    note.classList.add('hidden');
    return;
  }

  const netPoints = data.net.filter(v => v !== null);
  const startIdx = data.net.findIndex(v => v !== null);
  let summary = '';
  if (netPoints.length >= 2) {
    const delta = netPoints[netPoints.length - 1] - netPoints[0];
    const cls = Math.abs(delta) < 0.005 ? 'flat' : (delta > 0 ? 'up' : 'down');
    summary = `<div class="history-net-delta ${cls}">${fmtSignedMoney(delta)} <span>net since ${esc(fmtHistDate(data.dates[startIdx]))}</span></div>`;
  }

  net.innerHTML = `
    <div class="history-net-top">
      <div class="history-net-label">Net position &amp; accounts</div>
      ${summary}
    </div>
    <div class="history-view" id="history-view" role="group" aria-label="Chart style">
      <button type="button" data-view="lines" aria-pressed="${historyView === 'lines'}">Lines</button>
      <button type="button" data-view="stacked" aria-pressed="${historyView === 'stacked'}">Stacked</button>
    </div>
    <div id="history-legend" class="history-legend"></div>
    <div id="history-chart" class="history-chart-wrap"></div>`;

  $('history-view').onclick = event => {
    const btn = event.target.closest('button[data-view]');
    if (!btn || btn.dataset.view === historyView) return;
    historyView = btn.dataset.view;
    saveHistoryView(historyView);
    for (const b of $('history-view').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b === btn));
    drawHistoryChart();
  };

  drawHistoryLegend(data);
  drawHistoryChart();

  // Keep this to one short line; the per-account reasons live in the operator guide.
  const partial = data.partial_accounts || [];
  if (partial.length) {
    const n = partial.length;
    note.innerHTML = `${n} account${n === 1 ? ' has' : 's have'} limited history. See the operator guide (Balance history) for details.`;
    note.title = partial.map(p => p.name).join(', ');
    note.classList.remove('hidden');
  } else {
    note.removeAttribute('title');
    note.classList.add('hidden');
  }
}

function historyColor(index) { return HISTORY_PALETTE[index % HISTORY_PALETTE.length]; }

function drawHistoryLegend(data) {
  const legend = $('history-legend');
  const items = [`<span class="history-legend-item history-legend-net"><i class="sw sw-net"></i>Net position</span>`];
  data.accounts.forEach((a, i) => {
    const off = historyHidden.has(a.id);
    items.push(`<button type="button" class="history-legend-item${off ? ' off' : ''}" data-acct="${a.id}" aria-pressed="${!off}">
      <i class="sw${a.type === 'credit' ? ' sw-credit' : ''}" style="--c:${historyColor(i)}"></i>${esc(a.name)}${a.mask ? ` ···${esc(a.mask)}` : ''}</button>`);
  });
  legend.innerHTML = items.join('');
  legend.onclick = event => {
    const btn = event.target.closest('button[data-acct]');
    if (!btn) return;
    const id = Number(btn.dataset.acct);
    if (historyHidden.has(id)) historyHidden.delete(id); else historyHidden.add(id);
    drawHistoryLegend(historyData);
    drawHistoryChart();
  };
}

// Calendar-aware x ticks: 1st & 15th for short ranges, month starts otherwise,
// thinned so labels never collide.
function historyXTicks(startStr, endStr, range, maxTicks) {
  const t0 = Date.parse(`${startStr}T00:00:00Z`);
  const t1 = Date.parse(`${endStr}T00:00:00Z`);
  const days = range === '3m' ? [1, 15] : [1];
  const out = [];
  const d = new Date(t0);
  d.setUTCDate(1);
  while (d.getTime() <= t1) {
    for (const day of days) {
      const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day);
      if (t >= t0 && t <= t1) out.push(t);
    }
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  const stride = Math.max(1, Math.ceil(out.length / maxTicks));
  return out.filter((_, i) => i % stride === 0);
}

function fmtHistTick(t, range) {
  const d = new Date(t);
  const month = d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  if (range === '3m') return `${month} ${d.getUTCDate()}`;
  return d.getUTCMonth() === 0 ? `${month} '${String(d.getUTCFullYear()).slice(2)}` : month;
}

// One SVG, one shared scale. 'lines': net + a line per account. 'stacked': accounts
// build up from zero (positives) and down (credit), so the layers sum to the net line.
function drawHistoryChart() {
  const data = historyData;
  const container = $('history-chart');
  const dates = data.dates;
  const n = dates.length;
  const W = 600, H = 280;
  const pad = { t: 10, b: 6 };
  const stacked = historyView === 'stacked';

  const tOf = d => Date.parse(`${d}T00:00:00Z`);
  const t0 = tOf(dates[0]);
  const t1 = tOf(dates[n - 1]);
  const x = i => (t1 === t0 ? 0 : ((tOf(dates[i]) - t0) / (t1 - t0)) * W);

  const accts = data.accounts
    .map((a, i) => ({ a, color: historyColor(i) }))
    .filter(r => !historyHidden.has(r.a.id));
  const netLine = { key: 'net', name: 'Net position', values: data.net, color: null, credit: false };
  const acctLines = accts.map(r => ({ key: r.a.id, name: r.a.name, values: r.a.values, color: r.color, credit: r.a.type === 'credit' }));

  // Stacked layers (null counts as 0 thickness).
  const cumPos = new Array(n).fill(0);
  const cumNeg = new Array(n).fill(0);
  const layers = [];
  if (stacked) {
    for (const r of accts) {
      const pos = { lo: [], hi: [] };
      const neg = { lo: [], hi: [] };
      for (let i = 0; i < n; i++) {
        const v = r.a.values[i] === null ? 0 : r.a.values[i];
        pos.lo.push(cumPos[i]); cumPos[i] += Math.max(v, 0); pos.hi.push(cumPos[i]);
        neg.lo.push(cumNeg[i]); cumNeg[i] += Math.min(v, 0); neg.hi.push(cumNeg[i]);
      }
      layers.push({ color: r.color, pos, neg });
    }
  }

  const all = stacked
    ? [...cumPos, ...cumNeg, ...data.net.filter(v => v !== null)]
    : [netLine, ...acctLines].flatMap(l => l.values).filter(v => v !== null);
  if (all.length < 2) {
    container.innerHTML = '<div class="history-empty">Not enough synced history to chart for this range.</div>';
    return;
  }
  let min = Math.min(...all, 0);
  let max = Math.max(...all, 0);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.05; max += span * 0.05;

  const y = v => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  // Y ticks: nice round steps, ~7-9 of them.
  const rawStep = (max - min) / 9;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= rawStep) || rawStep;
  const yTicks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) yTicks.push(Math.round(t * 100) / 100);

  // X ticks (time-positioned).
  const narrow = container.clientWidth > 0 && container.clientWidth < 460;
  const xTicks = historyXTicks(dates[0], dates[n - 1], data.range, narrow ? 4 : 8)
    .map(t => ({ pct: t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * 100, label: fmtHistTick(t, data.range) }));

  const gridY = yTicks.map(t => `<line class="${t === 0 ? 'hc-zero' : 'hc-grid'}" x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join('');
  const gridX = xTicks.map(t => `<line class="hc-grid hc-grid-x" x1="${(t.pct / 100) * W}" x2="${(t.pct / 100) * W}" y1="${pad.t}" y2="${H - pad.b}"/>`).join('');
  const yLabels = yTicks.map(t => `<span style="top:${(y(t) / H) * 100}%">${esc(fmtAxisMoney(t))}</span>`).join('');
  const xLabels = xTicks.map(t => {
    const edge = t.pct < 4 ? ' edge-l' : (t.pct > 96 ? ' edge-r' : '');
    return `<span class="${edge.trim()}" style="left:${t.pct}%">${esc(t.label)}</span>`;
  }).join('');

  const lineD = values => {
    let d = '';
    let run = [];
    const flush = () => {
      if (run.length > 1) d += run.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      run = [];
    };
    values.forEach((v, i) => { if (v === null) flush(); else run.push([x(i), y(v)]); });
    flush();
    return d;
  };

  let body = '';
  let drawable = false;
  if (stacked) {
    const poly = (color, band) => {
      let thick = false;
      for (let i = 0; i < n; i++) if (Math.abs(band.hi[i] - band.lo[i]) > 1e-9) { thick = true; break; }
      if (!thick) return '';
      const top = band.hi.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
      const bottom = band.lo.map((v, i) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join('');
      return `<path class="hc-layer" style="fill:${color}" d="${top}${bottom}Z"/>`;
    };
    body = layers.map(l => poly(l.color, l.pos) + poly(l.color, l.neg)).join('');
    drawable = body !== '';
    const nd = lineD(data.net);
    if (nd) { body += `<path class="hc-line hc-net" d="${nd}"/>`; drawable = true; }
  } else {
    const drawn = [netLine, ...acctLines].map(l => ({ l, d: lineD(l.values) })).filter(r => r.d);
    drawable = drawn.length > 0;
    body = drawn
      .map(({ l, d }) => `<path class="hc-line ${l.key === 'net' ? 'hc-net' : `hc-acct${l.credit ? ' hc-credit' : ''}`}" ${l.color ? `style="stroke:${l.color}"` : ''} d="${d}"/>`)
      .reverse().join(''); // net drawn last (on top)
  }

  // A lone point per line (e.g. history that begins today) has no segment/area to draw.
  if (!drawable) {
    container.innerHTML = '<div class="history-empty">Not enough synced history to chart for this range.</div>';
    return;
  }

  container.innerHTML = `
    <div class="hc-ylabels">${yLabels}</div>
    <div class="hc-plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Net position and account balance history" style="height:${H}px">
        ${gridY}${gridX}${body}
        <line class="hc-cursor" y1="${pad.t}" y2="${H - pad.b}" x1="0" x2="0" hidden/>
      </svg>
      <div class="hc-xlabels">${xLabels}</div>
      <div class="hc-tip" hidden></div>
    </div>`;

  const plot = container.querySelector('.hc-plot');
  const svg = plot.querySelector('svg');
  const cursor = svg.querySelector('.hc-cursor');
  const tip = plot.querySelector('.hc-tip');

  function nearest(ratio) {
    const target = ratio * W;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(x(i) - target) < Math.abs(x(best) - target)) best = i;
    return best;
  }

  function show(clientX) {
    const rect = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const i = nearest(ratio);
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i));
    cursor.removeAttribute('hidden');
    // Net first, then accounts from highest to lowest balance.
    const row = l => `<div class="hc-tip-row${l.key === 'net' ? ' hc-tip-net' : ''}"><i class="sw${l.credit ? ' sw-credit' : ''}" style="--c:${l.color || 'var(--text)'}"></i><span>${esc(l.name)}</span><b>${fmtMoney(l.values[i])}</b></div>`;
    const rows = acctLines
      .filter(l => l.values[i] !== null)
      .sort((p, q) => q.values[i] - p.values[i])
      .map(row);
    const netRow = netLine.values[i] !== null ? row(netLine) : '';
    tip.innerHTML = `<div class="hc-tip-date">${esc(fmtHistDate(dates[i]))}</div>${netRow}${rows.join('')}`;
    tip.removeAttribute('hidden');
    // Place beside the cursor, flipping/clamping so it never leaves the plot (phones are narrow).
    const plotW = plot.clientWidth;
    const px = (x(i) / W) * plotW;
    const tipW = tip.offsetWidth;
    let left = px + 10;
    if (left + tipW > plotW) left = px - 10 - tipW;
    tip.style.left = `${Math.max(0, Math.min(left, plotW - tipW))}px`;
  }
  function hide() { cursor.setAttribute('hidden', ''); tip.setAttribute('hidden', ''); }
  svg.addEventListener('pointermove', e => show(e.clientX));
  svg.addEventListener('pointerdown', e => show(e.clientX));
  svg.addEventListener('pointerleave', hide);
  // Touch has no hover-out: let the readout linger briefly, then clear it.
  let touchTimer = null;
  svg.addEventListener('pointerup', e => {
    if (e.pointerType !== 'touch') return;
    clearTimeout(touchTimer);
    touchTimer = setTimeout(hide, 2500);
  });
  svg.addEventListener('pointerdown', () => clearTimeout(touchTimer));
}

function fmtAxisMoney(n) {
  const abs = Math.abs(n);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(abs % 1000 === 0 ? 0 : 1)}k` : String(abs);
  return `${n < 0 ? '−' : ''}$${body}`;
}

// 1Y spans the same month/day twice, so show the year there.
function fmtHistDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d)) return '';
  const opts = historyRange === '1y' ? { month: 'short', day: 'numeric', year: '2-digit' } : { month: 'short', day: 'numeric' };
  return d.toLocaleDateString('en-US', opts);
}

function fmtSignedMoney(n) {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : '+'}$${abs}`;
}

// ── Render ───────────────────────────────────────────────────

function renderDashboard(data) {
  const netEl = document.getElementById('net-amount');
  netEl.innerHTML = fmtMoney(data.net_position);
  netEl.classList.remove('loading-pulse');

  const liquidTotal = parseFloat(data.liquid_total) || 0;
  const creditTotal = parseFloat(data.credit_total) || 0;
  const accountCount = Number(data.account_count) || 0;
  const historicalCount = Number(data.historical_account_count) || 0;
  const coverageRatio = Math.abs(creditTotal) > 0 ? `${(liquidTotal / Math.abs(creditTotal)).toFixed(2)}×` : '—';

  document.getElementById('balance-breakdown').innerHTML = `
    <div class="item">
      <div class="k">Cash</div>
      <div class="v ok">${fmtMoney(liquidTotal)}</div>
    </div>
    <div class="item">
      <div class="k">Credit</div>
      <div class="v bad">${fmtMoney(creditTotal)}</div>
    </div>
    <div class="item">
      <div class="k">Coverage</div>
      <div class="v">${coverageRatio}</div>
    </div>
    <div class="item">
      <div class="k">Accounts</div>
      <div class="v">${accountCount}${historicalCount > 0 ? ` · +${historicalCount} hist` : ''}</div>
    </div>
  `;

  const grid = document.getElementById('accounts-grid');
  grid.innerHTML = '';
  renderAccountGroups(grid, data.groups);
  if (data.historical_groups && Object.keys(data.historical_groups).length > 0) {
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = 'Historical Accounts';
    grid.appendChild(heading);

    const note = document.createElement('div');
    note.className = 'historical-note';
    note.textContent = 'These accounts are retained for history and no longer affect live balance totals.';
    grid.appendChild(note);

    renderAccountGroups(grid, data.historical_groups, { historical: true });
  }
}

function renderAccountGroups(container, groups, opts = {}) {
  const historical = Boolean(opts.historical);
  for (const [owner, accts] of Object.entries(groups || {})) {
    const group = document.createElement('div');
    group.className = `owner-group${historical ? ' owner-group-historical' : ''}`;
    group.innerHTML = `<div class="owner-label">${esc(owner)}${historical ? ' · Historical' : ''}</div>`;

    for (const a of accts) {
      const bal = parseFloat(a.display_balance != null ? a.display_balance : a.current_balance) || 0;
      const isCredit = a.type === 'credit';
      const isLoan = a.type === 'loan';
      const liabilityLine = (isCredit || isLoan) ? buildLiabilityLine(a) : '';
      const ledgerBalance = parseFloat(a.ledger_balance);
      const showLedgerSecondary = a.type === 'depository'
        && a.display_balance_kind === 'available'
        && Number.isFinite(ledgerBalance)
        && Math.round(ledgerBalance * 100) / 100 !== Math.round(bal * 100) / 100;
      const displayName = a.display_name || a.name;
      const statusBadge = historical ? '<span class="acct-status-badge">Historical</span>' : '';
      group.innerHTML += `
        <div class="account-card${historical ? ' account-card-historical' : ''}" style="cursor:pointer" onclick="location.href='transactions.html?account_id=${a.id}'">
          <div class="acct-info">
            <div class="acct-name">
              ${esc(displayName)}
              ${statusBadge}
              <button class="acct-rename-btn" onclick="openRename(event, ${a.id}, '${esc(displayName).replace(/'/g, "\\'")}' )" title="Rename">&#9998;</button>
            </div>
            <div class="acct-detail">${esc(a.institution_name || '')} ${a.mask ? '···' + esc(a.mask) : ''} · ${esc(a.subtype || a.type)}</div>
            ${liabilityLine}
          </div>
          <div class="acct-balance-wrap">
            <div class="acct-balance ${(isCredit || isLoan) ? 'credit' : ''}">${fmtMoney(bal)}</div>
            ${buildBalanceSubline(a, bal, showLedgerSecondary, ledgerBalance, historical)}
          </div>
        </div>`;
    }

    container.appendChild(group);
  }
}

// ── Coverage ─────────────────────────────────────────────────

function renderCoverage(data) {
  const banner = document.getElementById('coverage-banner');
  if (!data || data.status === 'clear') {
    banner.classList.add('hidden');
    return;
  }

  const colorMap = { healthy: 'var(--green)', warning: 'var(--yellow)', danger: 'var(--red)' };
  const color = colorMap[data.status] || 'var(--muted)';
  const ratioLabel = data.ratio !== null ? `${data.ratio}x` : '--';

  let cardsHtml = data.cards.map(c => {
    const due = c.due_date ? formatShortDate(c.due_date) : null;
    const overdue = c.is_overdue ? '<span class="coverage-overdue">OVERDUE</span>' : '';
    const minPay = c.minimum_payment !== null ? fmtMoney(c.minimum_payment) : null;
    const statusText = c.satisfied
      ? '<span class="coverage-card-status coverage-card-status-ok">Satisfied</span>'
      : `<span class="coverage-card-amount">${fmtMoney(c.obligation)}</span>`;
    return `<div class="coverage-card-line">
      <div class="coverage-card-name">${esc(c.name)} ${c.mask ? '<span class="coverage-card-mask">···' + esc(c.mask) + '</span>' : ''}</div>
      <div class="coverage-card-details">
        ${statusText}
        ${due ? `<span class="coverage-card-due">due ${due}</span>` : ''}
        ${minPay && !c.satisfied ? `<span class="coverage-card-min">min ${minPay}</span>` : ''}
        ${overdue}
      </div>
    </div>`;
  }).join('');

  banner.innerHTML = `
    <div class="coverage-banner-inner" style="border-left: 4px solid ${color}">
      <div class="coverage-banner-header">
        <div class="coverage-banner-title">Liability Coverage</div>
        <div class="coverage-banner-ratio" style="color:${color}">${ratioLabel}</div>
      </div>
      <div class="coverage-banner-totals">
        <span>Cash (${esc(data.depository_balance_label || 'Available')}): <strong>${fmtMoney(data.depository_total)}</strong></span>
        <span>Obligations: <strong>${fmtMoney(data.obligation_total)}</strong></span>
      </div>
      ${cardsHtml ? '<div class="coverage-card-lines">' + cardsHtml + '</div>' : ''}
    </div>`;
  banner.classList.remove('hidden');
}

function buildLiabilityLine(acct) {
  if (acct.type === 'credit') return buildCreditLiabilityLine(acct);

  const chips = [];
  if (acct.last_statement_balance != null) {
    chips.push(renderLiabilityChip(`Stmt ${fmtMoney(acct.last_statement_balance)}`));
  }
  if (acct.next_payment_due_date) {
    chips.push(renderLiabilityChip(`Due ${formatShortDate(acct.next_payment_due_date)}`));
  }
  if (acct.minimum_payment_amount != null) {
    chips.push(renderLiabilityChip(`Min ${fmtMoney(acct.minimum_payment_amount)}`));
  }
  if (!chips.length) return '';
  return `<div class="acct-liability"><div class="acct-liability-chips">${chips.join('')}</div></div>`;
}

function buildCreditLiabilityLine(acct) {
  const statementBalance = parseFloat(acct.last_statement_balance);
  const minimumPayment = parseFloat(acct.minimum_payment_amount);
  const hasStatement = Number.isFinite(statementBalance);
  const hasMinimum = Number.isFinite(minimumPayment);
  const paymentDate = acct.last_payment_date ? formatShortDate(acct.last_payment_date) : '';
  const paymentAmount = parseFloat(acct.last_payment_amount);
  const hasPaymentAmount = Number.isFinite(paymentAmount);
  const noPaymentDue = hasMinimum && minimumPayment === 0;

  const chips = [];
  if (acct.is_overdue) {
    chips.push(renderLiabilityChip('Payment overdue', 'alert'));
  }
  if (noPaymentDue) {
    chips.push(renderLiabilityChip('No payment due', 'ok'));
  }
  if (hasStatement) {
    chips.push(renderLiabilityChip(`Stmt ${fmtMoney(statementBalance)}`));
  }
  if (acct.next_payment_due_date && !noPaymentDue) {
    chips.push(renderLiabilityChip(`Due ${formatShortDate(acct.next_payment_due_date)}`));
  }
  if (hasMinimum && minimumPayment > 0) {
    chips.push(renderLiabilityChip(`Min ${fmtMoney(minimumPayment)}`));
  }
  const secondary = [];
  if (hasPaymentAmount) {
    secondary.push(`Last payment ${fmtMoney(paymentAmount)}${paymentDate ? ` ${paymentDate}` : ''}`);
  }
  if (!chips.length && !secondary.length) return '';
  return `
    <div class="acct-liability${noPaymentDue ? ' acct-liability-ok' : ''}">
      ${chips.length ? `<div class="acct-liability-chips">${chips.join('')}</div>` : ''}
      ${secondary.length ? `<div class="acct-liability-secondary">${secondary.join(' · ')}</div>` : ''}
    </div>`;
}

function buildBalanceSubline(acct, displayBalance, showLedgerSecondary, ledgerBalance, historical = false) {
  if (historical) {
    return '<div class="acct-balance-sub">No longer syncing</div>';
  }
  if (acct.type === 'credit') {
    return `<div class="acct-balance-sub">Current balance</div>`;
  }
  if (acct.type === 'loan') {
    return `<div class="acct-balance-sub">Outstanding balance</div>`;
  }
  if (showLedgerSecondary) {
    return `<div class="acct-balance-sub">Ledger ${fmtMoney(ledgerBalance)}</div>`;
  }
  return '';
}

function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const str = String(dateStr);
  const d = str.length === 10 ? new Date(str + 'T00:00:00') : new Date(str);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderLiabilityChip(label, tone = 'neutral') {
  return `<span class="acct-liability-chip acct-liability-chip-${tone}">${label}</span>`;
}

// ── Account rename ───────────────────────────────────────

function openRename(event, accountId, currentName) {
  event.stopPropagation();
  event.preventDefault();
  renameTarget = { id: accountId };
  const input = $('rename-input');
  input.value = currentName || '';
  document.body.classList.add('modal-open');
  $('rename-overlay').classList.remove('hidden');
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

async function renameAccount(id, customName) {
  try {
    await api(`api/accounts/${id}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ custom_name: customName })
    });
    await loadAccounts();
    return true;
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
    return false;
  }
}

function closeRenameOverlay() {
  renameTarget = null;
  $('rename-overlay').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function resetRename() {
  if (!renameTarget) return;
  renameAccount(renameTarget.id, '').then(ok => {
    if (ok) closeRenameOverlay();
  });
}

function submitRename() {
  if (!renameTarget) return;
  renameAccount(renameTarget.id, $('rename-input').value).then(ok => {
    if (ok) closeRenameOverlay();
  });
}

// ── Auth actions ─────────────────────────────────────────────

async function doLogout() {
  try { await fetch('api/auth/logout', { method: 'POST' }); } catch {}
  window.location.replace('login.html');
}

function updateWhoBtn() {
  const btn = document.getElementById('who-btn');
  if (!btn) return;
  btn.textContent = currentMember ? (currentMember.avatar_emoji || '\u{1F464}') : '\u{1F464}';
  btn.onclick = currentMember ? doLogout : null;
  btn.title = currentMember ? 'Sign out' : '';
}

// ── Helpers ──────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtMoney(amount) {
  const n = parseFloat(amount) || 0;
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span class="fp-amount">${n < 0 ? `-$${abs}` : `$${abs}`}</span>`;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.replace('login.html');
    throw new Error('Session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

document.addEventListener('keydown', event => {
  const overlay = $('rename-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeRenameOverlay();
  if (event.key === 'Enter' && event.target === $('rename-input')) submitRename();
});
