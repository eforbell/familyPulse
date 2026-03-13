/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let currentPeriod = getCurrentPeriod();
let summaryData = null;
let currentMember = null;

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) { currentMember = await res.json(); }
    else { window.location.replace('login.html'); return; }
  } catch { window.location.replace('login.html'); return; }
  loadBudget();
});

// ── Data ─────────────────────────────────────────────────────

async function loadBudget() {
  updateMonthLabel();
  try {
    summaryData = await api(`api/budget/summary?period=${currentPeriod}`);
    renderSummary();
    renderObligations();
    renderHotSpots();
    renderUncategorized();
    renderGrid();
    renderDigest();
    $('summary-hero').classList.remove('loading-pulse');
  } catch (err) {
    console.error('Budget load failed:', err);
    $('budget-grid').innerHTML = '<div class="empty-state">Error loading budget data</div>';
  }
}

// ── Render: Summary hero ─────────────────────────────────────

function renderSummary() {
  const d = summaryData;

  $('summary-income').textContent = fmtMoney(d.income.current);
  $('summary-income-prior').textContent = `Prior: ${fmtMoney(d.income.prior)}`;

  $('summary-spending').textContent = fmtMoney(d.spending.actual);
  $('summary-spending').style.color = d.spending.actual > d.spending.budgeted ? 'var(--red)' : 'var(--text)';
  $('summary-spending-budget').textContent = `Budget: ${fmtMoney(d.spending.budgeted)}`;

  const net = d.net_cash_flow.current;
  $('summary-net').textContent = fmtMoney(net);
  $('summary-net').style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
  $('summary-net-prior').textContent = `Prior: ${fmtMoney(d.net_cash_flow.prior)}`;
}

// ── Render: Obligations ──────────────────────────────────────

async function renderObligations() {
  const card = $('obligations-card');
  try {
    const data = await api('api/accounts/coverage');
    if (!data || data.status === 'clear') {
      card.classList.add('hidden');
      return;
    }
    const colorMap = { healthy: 'var(--green)', warning: 'var(--yellow)', danger: 'var(--red)' };
    const color = colorMap[data.status] || 'var(--muted)';
    const ratioLabel = data.ratio !== null ? `${data.ratio}x` : '--';
    card.innerHTML = `
      <div class="obligations-card-inner">
        <span>Upcoming statements: <strong>${fmtMoney(data.obligation_total)}</strong></span>
        <span style="color:${color};font-weight:600">${ratioLabel} checking coverage</span>
      </div>`;
    card.classList.remove('hidden');
  } catch {
    card.classList.add('hidden');
  }
}

// ── Render: Hot spots ────────────────────────────────────────

async function renderHotSpots() {
  const panel = $('hotspots-panel');
  const list = $('hotspots-list');
  try {
    const data = await api(`api/anomalies?period=${currentPeriod}`);
    if (!data.anomalies || data.anomalies.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    list.innerHTML = data.anomalies.map(a => {
      const avg = a.anomaly_type === 'spending_spike_3mo' ? a.avg_3mo : a.avg_12mo;
      const pct = a.anomaly_type === 'spending_spike_3mo' ? a.pct_of_3mo : a.pct_of_12mo;
      const window = a.anomaly_type === 'spending_spike_3mo' ? '3-mo avg' : '12-mo avg';
      return `
        <div class="hotspot-card">
          <a class="hotspot-link" href="transactions.html?category_id=${a.category_id}&period=${currentPeriod}">
            <div class="hotspot-header">
              <span class="hotspot-name">${a.icon || ''} ${esc(a.category_name)}</span>
              <span class="hotspot-pct">${Math.round(parseFloat(pct))}%</span>
            </div>
            <div class="hotspot-detail">
              ${fmtMoney(a.current_amount)} spent vs ${fmtMoney(avg)} ${window}
            </div>
          </a>
          <button class="btn-ghost hotspot-dismiss" onclick="dismissAnomaly(event, ${a.id})">Dismiss</button>
        </div>`;
    }).join('');
  } catch (err) {
    console.error('Hot spots load failed:', err);
    panel.classList.add('hidden');
  }
}

async function dismissAnomaly(event, id) {
  event.stopPropagation();
  try {
    await api(`api/anomalies/${id}/acknowledge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    renderHotSpots();
  } catch (err) {
    console.error('Dismiss failed:', err);
  }
}

// ── Render: Weekly digest ───────────────────────────────────

async function renderDigest() {
  const panel = $('digest-panel');
  const content = $('digest-content');
  try {
    const data = await api(`api/magic/digest?period=${currentPeriod}`);
    if (!data.digest) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    // Render paragraphs
    content.innerHTML = data.digest
      .split('\n')
      .filter(p => p.trim())
      .map(p => `<p>${esc(p)}</p>`)
      .join('');
  } catch {
    panel.classList.add('hidden');
  }
}

// ── Render: Uncategorized ────────────────────────────────────

function renderUncategorized() {
  const u = summaryData.uncategorized;
  if (u.count === 0) {
    $('uncat-card').classList.add('hidden');
    return;
  }
  $('uncat-card').classList.remove('hidden');
  $('uncat-amount').textContent = fmtMoney(u.spent);
  $('uncat-detail').textContent = `${u.count} transaction${u.count !== 1 ? 's' : ''} need categorization`;
}

// ── Render: Category grid ────────────────────────────────────

function renderGrid() {
  const grid = $('budget-grid');

  if (summaryData.categories.length === 0) {
    grid.innerHTML = '<div class="empty-state">No budget categories configured</div>';
    return;
  }

  grid.innerHTML = summaryData.categories.map(c => {
    const pct = Math.min(c.pct_used, 100);
    const barColor = c.status === 'red' ? 'var(--red)' : c.status === 'yellow' ? 'var(--yellow)' : 'var(--green)';
    const borderClass = c.status === 'red' ? ' budget-card-over' : '';
    const budgetLabel = c.budgeted > 0 ? fmtMoney(c.budgeted) : 'no target';
    const remainLabel = c.budgeted > 0
      ? (c.remaining >= 0 ? `${fmtMoney(c.remaining)} left` : `${fmtMoney(Math.abs(c.remaining))} over`)
      : '';
    const avgLabel = c.avg_3mo > 0 ? `Typical ${fmtMoney(c.avg_3mo)}/mo` : '';

    return `
      <div class="budget-card${borderClass}" onclick="openDetail(${c.id})">
        <div class="budget-card-header">
          <span class="budget-card-name">${c.icon || ''} ${esc(c.name)}</span>
          <span class="budget-card-spent">${fmtMoney(c.spent)}</span>
        </div>
        ${c.budgeted > 0 ? `
        <div class="budget-bar">
          <div class="budget-bar-fill" style="width:${pct}%;background:${barColor}"></div>
        </div>` : ''}
        <div class="budget-card-meta">
          <span>${budgetLabel}</span>
          <span style="color:${c.status === 'red' ? 'var(--red)' : 'var(--muted)'}">${remainLabel}</span>
        </div>
        ${avgLabel ? `<div class="budget-card-avg">${avgLabel}</div>` : ''}
      </div>`;
  }).join('');
}

// ── Category detail overlay ──────────────────────────────────

async function openDetail(categoryId) {
  try {
    const detail = await api(`api/budget/category/${categoryId}?period=${currentPeriod}`);
    $('detail-title').textContent = `${detail.icon || ''} ${detail.name}`;

    const budgeted = parseFloat(detail.budget_amount) || 0;
    $('detail-meta').textContent = budgeted > 0
      ? `Budget: ${fmtMoney(budgeted)} — ${detail.transactions.length} transactions`
      : `${detail.transactions.length} transactions`;

    if (detail.transactions.length === 0) {
      $('detail-txns').innerHTML = '<div class="empty-state">No transactions this month</div>';
    } else {
      $('detail-txns').innerHTML = detail.transactions.map(t => {
        const merchant = t.merchant_name || t.name || '—';
        return `
          <div class="detail-txn-row">
            <div class="detail-txn-info">
              <span class="detail-txn-merchant">${esc(merchant)}</span>
              <span class="detail-txn-date">${formatDate(t.date)} · ${esc(t.account_name)} ···${esc(t.account_mask || '')}</span>
            </div>
            <span class="detail-txn-amount">${fmtMoney(t.amount)}</span>
          </div>`;
      }).join('');
    }

    $('detail-view-all').href = `transactions.html?category_id=${categoryId}&period=${currentPeriod}`;
    $('detail-overlay').classList.remove('hidden');
  } catch (err) {
    console.error('Detail load failed:', err);
  }
}

function closeDetail() {
  $('detail-overlay').classList.add('hidden');
}

function viewUncategorized() {
  location.href = `transactions.html?category_id=0&period=${currentPeriod}`;
}

function viewCategory(categoryId) {
  location.href = `transactions.html?category_id=${categoryId}&period=${currentPeriod}`;
}

// ── Month navigation ─────────────────────────────────────────

function prevMonth() {
  currentPeriod = shiftMonth(currentPeriod, -1);
  loadBudget();
}

function nextMonth() {
  currentPeriod = shiftMonth(currentPeriod, 1);
  loadBudget();
}

function shiftMonth(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function updateMonthLabel() {
  const [y, m] = currentPeriod.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  $('month-label').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Disable next if current or future month
  const now = getCurrentPeriod();
  $('next-month-btn').disabled = currentPeriod >= now;
}

function getCurrentPeriod() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const str = String(dateStr);
  const d = str.length === 10 ? new Date(str + 'T00:00:00') : new Date(str);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
