/* kids.js — Kid dashboard: balance, budget, categories, transactions */
'use strict';

let currentMember = null;
let dashboardData = null;
let categories = [];
let catTarget = null;
let chartInstance = null;

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) {
      currentMember = await res.json();
    } else {
      window.location.replace('login.html');
      return;
    }
  } catch {
    window.location.replace('login.html');
    return;
  }

  // Only kids should see this page
  if (currentMember.role !== 'kid') {
    window.location.replace('./');
    return;
  }

  updateWhoBtn();
  await loadDashboard();
  loadReportCard();
  loadCategories();
});

// ── Data ─────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    dashboardData = await api('api/kids/dashboard');
    renderDashboard();
  } catch (err) {
    $('balance-amount').textContent = 'Error loading';
    $('balance-amount').classList.remove('loading-pulse');
    console.error('Dashboard load failed:', err);
  }
}

async function loadReportCard() {
  try {
    const data = await api('api/kids/report-card');
    if (data.report) {
      $('report-card-section').classList.remove('hidden');
      $('report-card-content').innerHTML = data.report
        .split('\n\n')
        .map(p => `<p>${esc(p)}</p>`)
        .join('');
    }
  } catch {
    // Report card is optional — silently skip
  }
}

async function loadCategories() {
  try {
    const res = await fetch('api/categories');
    if (res.ok) categories = await res.json();
  } catch {}
}

// ── Render ───────────────────────────────────────────────────

function renderDashboard() {
  const d = dashboardData;

  // Greeting
  $('greeting').textContent = `${d.member.emoji || ''} ${d.member.name}'s Money`;

  // Balance
  const balEl = $('balance-amount');
  balEl.classList.remove('loading-pulse');

  // No linked accounts — show empty state
  if (d.accounts.length === 0) {
    balEl.textContent = '--';
    $('balance-detail').innerHTML = `
      <span style="color:var(--muted)">No accounts linked yet. Ask a parent to connect your account in Settings.</span>
    `;
    $('transactions-section').innerHTML = '';
    return;
  }

  balEl.textContent = fmtMoney(d.balance_total);

  $('balance-detail').innerHTML = `
    <span><span class="label">Accounts</span> <span class="value">${d.accounts.length}</span></span>
    <span><span class="label">Spent this month</span> <span class="value">${fmtMoney(d.month_spending)}</span></span>
  `;

  // Budget
  if (d.budget) {
    $('budget-section').classList.remove('hidden');
    renderBudget(d.budget);
  }

  // Category chart
  if (d.category_breakdown.length > 0) {
    $('categories-section').classList.remove('hidden');
    renderCategoryChart(d.category_breakdown);
  }

  // Transactions
  renderTransactions(d.recent_transactions);
}

function renderBudget(budget) {
  const pct = Math.min(budget.pct_used, 100);
  let barColor = 'var(--green)';
  if (budget.pct_used >= 90) barColor = 'var(--red)';
  else if (budget.pct_used >= 70) barColor = 'var(--yellow)';

  $('budget-card').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.5rem">
      <span style="font-size:0.85rem;color:var(--muted)">
        ${fmtMoney(budget.spent)} of ${fmtMoney(budget.amount)}
      </span>
      <span style="font-size:0.85rem;font-weight:600;color:${barColor}">
        ${budget.pct_used}%
      </span>
    </div>
    <div class="kid-budget-bar">
      <div class="kid-budget-bar-fill" style="width:${pct}%;background:${barColor}"></div>
    </div>
    <div style="font-size:0.8rem;color:var(--muted);margin-top:0.35rem">
      ${budget.remaining >= 0
        ? `${fmtMoney(budget.remaining)} remaining`
        : `${fmtMoney(Math.abs(budget.remaining))} over budget`}
    </div>
  `;
}

function renderCategoryChart(breakdown) {
  const canvas = $('category-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const labels = breakdown.map(c => `${c.icon || ''} ${c.name}`);
  const data = breakdown.map(c => c.spent);
  const colors = breakdown.map(c => c.color || '#10b981');

  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 0 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(),
            font: { size: 12 },
            padding: 12
          }
        }
      }
    }
  });
}

function renderTransactions(txns) {
  const list = $('tx-list');
  if (!txns || txns.length === 0) {
    list.innerHTML = '<div class="empty-state">No recent transactions</div>';
    return;
  }

  list.innerHTML = txns.map(t => {
    const merchant = esc(t.merchant_name || t.name || 'Unknown');
    const amt = parseFloat(t.amount);
    const amtClass = amt < 0 ? 'credit' : 'debit';
    const catBadge = t.category_name
      ? `<span class="cat-badge" style="background:${t.category_color || '#6b7280'}22;border:1px solid ${t.category_color || '#6b7280'}55;color:${t.category_color || '#6b7280'}">${t.category_icon || ''} ${esc(t.category_name)}</span>`
      : '<span class="cat-badge uncat">Uncategorized</span>';

    return `
      <div class="tx-row" onclick="openCategoryOverlay(${t.id}, '${merchant.replace(/'/g, "\\'")}')">
        <div></div>
        <div class="tx-main">
          <div class="tx-merchant">${merchant}</div>
          <div class="tx-detail">
            <span>${formatDate(t.date)}</span>
            ${catBadge}
          </div>
        </div>
        <div class="tx-amount ${amtClass}">${fmtMoney(amt)}</div>
      </div>`;
  }).join('');
}

// ── Category overlay (no create-rule for kids) ──────────────

function openCategoryOverlay(txId, merchantName) {
  catTarget = { id: txId, merchant: merchantName };
  const list = $('category-list');
  list.innerHTML = categories.map(c => `
    <button class="cat-option" onclick="assignCategory(${c.id})">
      <span class="cat-swatch" style="background:${c.color || '#6b7280'}"></span>
      <span>${c.icon || ''} ${esc(c.name)}</span>
    </button>
  `).join('');
  $('category-overlay').classList.remove('hidden');
}

function closeCategoryOverlay() {
  $('category-overlay').classList.add('hidden');
  catTarget = null;
}

async function assignCategory(categoryId) {
  if (!catTarget) return;
  try {
    await api(`api/transactions/${catTarget.id}/category`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category_id: categoryId })
    });
    closeCategoryOverlay();
    await loadDashboard();
  } catch (err) {
    alert('Failed to assign category: ' + err.message);
  }
}

// ── Report card toggle ──────────────────────────────────────

function toggleReportCard() {
  const body = $('report-card-body');
  const toggle = $('report-card-toggle');
  const hidden = body.classList.toggle('hidden');
  toggle.textContent = hidden ? '+' : '\u2212';
}

// ── Auth ─────────────────────────────────────────────────────

async function doLogout() {
  try { await fetch('api/auth/logout', { method: 'POST' }); } catch {}
  window.location.replace('login.html');
}

function updateWhoBtn() {
  const btn = $('who-btn');
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
  return n < 0 ? `-$${abs}` : `$${abs}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).length === 10 ? dateStr + 'T00:00:00' : dateStr);
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

document.addEventListener('keydown', event => {
  const overlay = $('category-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeCategoryOverlay();
});
