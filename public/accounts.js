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
    <div id="history-legend" class="history-legend"></div>
    <div id="history-chart" class="history-chart-wrap"></div>`;

  drawHistoryLegend(data);
  drawHistoryChart();

  const partial = data.partial_accounts || [];
  if (partial.length) {
    note.innerHTML = 'History is limited by synced transactions: '
      + partial.map(p => `${esc(p.name)}${p.data_from ? ` (from ${esc(fmtHistDate(p.data_from))})` : ' (none)'}`).join(', ')
      + '. Net position covers only the span where every account with history has data.';
    note.classList.remove('hidden');
  } else {
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

// One SVG, one shared scale: net line + a line per visible account. Gaps (null) break a line.
function drawHistoryChart() {
  const data = historyData;
  const container = $('history-chart');
  const dates = data.dates;
  const W = 600, H = 260;
  const pad = { t: 10, b: 8 };

  const lines = [{ key: 'net', name: 'Net position', values: data.net, color: null, cls: 'hc-net' }];
  data.accounts.forEach((a, i) => {
    if (historyHidden.has(a.id)) return;
    lines.push({ key: a.id, name: a.name, values: a.values, color: historyColor(i), cls: a.type === 'credit' ? 'hc-acct hc-credit' : 'hc-acct' });
  });

  const all = lines.flatMap(l => l.values).filter(v => v !== null);
  if (all.length < 2) {
    container.innerHTML = '<div class="history-empty">Not enough synced history to chart for this range.</div>';
    return;
  }
  let min = Math.min(...all, 0);
  let max = Math.max(...all, 0);
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.05; max += span * 0.05;

  const x = i => (dates.length === 1 ? 0 : (i / (dates.length - 1)) * W);
  const y = v => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

  // Axis ticks: nice round steps, ~4-5 of them.
  const rawStep = (max - min) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= rawStep) || rawStep;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) ticks.push(Math.round(t * 100) / 100);

  const grid = ticks.map(t => `<line class="${t === 0 ? 'hc-zero' : 'hc-grid'}" x1="0" x2="${W}" y1="${y(t)}" y2="${y(t)}"/>`).join('');
  const yLabels = ticks.map(t => `<span style="top:${(y(t) / H) * 100}%">${esc(fmtAxisMoney(t))}</span>`).join('');

  const paths = lines.map(l => {
    let d = '';
    let run = [];
    const flush = () => {
      if (run.length > 1) d += run.map((p, k) => `${k ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
      run = [];
    };
    l.values.forEach((v, i) => { if (v === null) flush(); else run.push([x(i), y(v)]); });
    flush();
    return `<path class="hc-line ${l.cls}" ${l.color ? `style="stroke:${l.color}"` : ''} d="${d}"/>`;
  }).reverse().join(''); // net drawn last (on top)

  container.innerHTML = `
    <div class="hc-ylabels">${yLabels}</div>
    <div class="hc-plot">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Net position and account balance history" style="height:${H}px">
        ${grid}${paths}
        <line class="hc-cursor" y1="${pad.t}" y2="${H - pad.b}" x1="0" x2="0" hidden/>
      </svg>
      <div class="hc-axis"><span>${esc(fmtHistDate(dates[0]))}</span><span>${esc(fmtHistDate(dates[dates.length - 1]))}</span></div>
      <div class="hc-tip" hidden></div>
    </div>`;

  const plot = container.querySelector('.hc-plot');
  const svg = plot.querySelector('svg');
  const cursor = svg.querySelector('.hc-cursor');
  const tip = plot.querySelector('.hc-tip');

  function show(clientX) {
    const rect = svg.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const i = Math.round(ratio * (dates.length - 1));
    cursor.setAttribute('x1', x(i)); cursor.setAttribute('x2', x(i));
    cursor.removeAttribute('hidden');
    const rows = lines
      .filter(l => l.values[i] !== null)
      .map(l => `<div class="hc-tip-row${l.key === 'net' ? ' hc-tip-net' : ''}"><i class="sw${l.cls.includes('hc-credit') ? ' sw-credit' : ''}" style="--c:${l.color || 'var(--text)'}"></i><span>${esc(l.name)}</span><b>${fmtMoney(l.values[i])}</b></div>`)
      .join('');
    tip.innerHTML = `<div class="hc-tip-date">${esc(fmtHistDate(dates[i]))}</div>${rows}`;
    tip.removeAttribute('hidden');
    const pct = (x(i) / W) * 100;
    tip.classList.toggle('flip', pct > 55);
    tip.style.left = `${pct}%`;
  }
  function hide() { cursor.setAttribute('hidden', ''); tip.setAttribute('hidden', ''); }
  svg.addEventListener('pointermove', e => show(e.clientX));
  svg.addEventListener('pointerdown', e => show(e.clientX));
  svg.addEventListener('pointerleave', hide);
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
