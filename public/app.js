/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let currentMember = null;
let accounts = [];
let categories = [];
let transactions = [];
let txTotal = 0;
let txSum = 0;
let currentPage = 0;
const PAGE_SIZE = 50;
let selectedIds = new Set();
let assignTarget = null; // { id, merchant } for single, null for bulk

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Authenticate — redirect to login if no valid session
  try {
    const meRes = await fetch('api/auth/me');
    if (meRes.ok) {
      currentMember = await meRes.json();
    } else {
      window.location.replace('login.html');
      return;
    }
  } catch {
    window.location.replace('login.html');
    return;
  }

  updateWhoBtn();
  await Promise.all([loadDashboard(), loadCategories()]);
  populateFilterDropdowns();
  await loadTransactions();
  loadMagicPanel();
  bindMagicInputShortcuts();

  // Filter listeners
  $('filter-account').addEventListener('change', resetAndLoad);
  $('filter-category').addEventListener('change', resetAndLoad);
  $('filter-from').addEventListener('change', resetAndLoad);
  $('filter-to').addEventListener('change', resetAndLoad);
  $('filter-search').addEventListener('input', debounce(resetAndLoad, 300));
  $('filter-transfers').addEventListener('change', resetAndLoad);
});

// ── Data fetching ────────────────────────────────────────────

async function loadDashboard() {
  try {
    const data = await api('api/accounts/dashboard');
    accounts = [];
    Object.values(data.groups).forEach(g => accounts.push(...g));
    renderDashboard(data);
  } catch (err) {
    $('net-amount').textContent = 'Error loading';
    $('net-amount').classList.remove('loading-pulse');
    console.error('Dashboard load failed:', err);
  }
}

async function loadCategories() {
  try {
    categories = await api('api/categories');
  } catch (err) {
    console.error('Categories load failed:', err);
  }
}

async function loadTransactions() {
  try {
    const params = buildFilterParams();
    const data = await api(`api/transactions?${params}`);
    transactions = data.transactions;
    txTotal = data.total;
    txSum = data.sum;
    renderTransactions();
    renderStats();
    renderPagination();
  } catch (err) {
    $('tx-list').innerHTML = '<div class="empty-state">Error loading transactions</div>';
    console.error('Transactions load failed:', err);
  }
}

// ── Render: Dashboard ────────────────────────────────────────

function renderDashboard(data) {
  $('net-amount').textContent = fmtMoney(data.net_position);
  $('net-amount').classList.remove('loading-pulse');

  $('balance-breakdown').innerHTML = `
    <span><span class="label">Cash</span> <span class="value">${fmtMoney(data.liquid_total)}</span></span>
    <span><span class="label">Credit</span> <span class="value" style="color:var(--red)">${fmtMoney(data.credit_total)}</span></span>
    <span><span class="label">Accounts</span> <span class="value">${data.account_count}</span></span>
  `;
}

// ── Render: Transactions ─────────────────────────────────────

function renderTransactions() {
  const list = $('tx-list');

  if (transactions.length === 0) {
    list.innerHTML = '<div class="empty-state">No transactions found</div>';
    return;
  }

  list.innerHTML = transactions.map(tx => {
    const amt = parseFloat(tx.amount);
    const isCredit = amt < 0;
    const merchant = tx.merchant_name || tx.name || '—';
    const catBadge = tx.category_name
      ? `<span class="cat-badge" style="background:${hexToRgba(tx.category_color, 0.15)};border:1px solid ${hexToRgba(tx.category_color, 0.3)};color:${tx.category_color}">${tx.category_icon || ''} ${esc(tx.category_name)}</span>`
      : '<span class="cat-badge uncat">uncategorized</span>';
    const pendingClass = tx.pending ? ' pending' : '';
    const selectedClass = selectedIds.has(tx.id) ? ' selected' : '';

    return `<div class="tx-row${pendingClass}${selectedClass}" data-id="${tx.id}" onclick="onTxClick(event, ${tx.id})">
      <input type="checkbox" class="tx-check" ${selectedIds.has(tx.id) ? 'checked' : ''} onclick="onCheckbox(event, ${tx.id})">
      <div class="tx-main">
        <div class="tx-merchant">${esc(merchant)}</div>
        <div class="tx-detail">
          <span>${formatDate(tx.date)}</span>
          <span>${esc(tx.account_name)} ···${esc(tx.account_mask || '')}</span>
          ${catBadge}
          ${tx.pending ? '<span style="color:var(--yellow)">pending</span>' : ''}
        </div>
      </div>
      <div class="tx-amount ${isCredit ? 'credit' : 'debit'}">${fmtTxAmount(amt)}</div>
    </div>`;
  }).join('');
}

function renderStats() {
  $('tx-stats').innerHTML = `
    <span><span class="label">Showing</span> <span class="value">${transactions.length} of ${txTotal}</span></span>
    <span><span class="label">Net</span> <span class="value">${fmtTxAmount(txSum)}</span></span>
  `;
}

function renderPagination() {
  const totalPages = Math.ceil(txTotal / PAGE_SIZE);
  if (totalPages <= 1) {
    $('pagination').classList.add('hidden');
    return;
  }
  $('pagination').classList.remove('hidden');
  $('page-info').textContent = `Page ${currentPage + 1} of ${totalPages}`;
  $('prev-btn').disabled = currentPage === 0;
  $('next-btn').disabled = currentPage >= totalPages - 1;
}

// ── Filters ──────────────────────────────────────────────────

function populateFilterDropdowns() {
  // Account dropdown
  const acctSelect = $('filter-account');
  const existing = acctSelect.querySelectorAll('option:not(:first-child)');
  existing.forEach(o => o.remove());
  for (const a of accounts) {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = `${a.name} ···${a.mask || ''}`;
    acctSelect.appendChild(opt);
  }

  // Category dropdown
  const catSelect = $('filter-category');
  const existingCats = catSelect.querySelectorAll('option[data-dynamic]');
  existingCats.forEach(o => o.remove());
  for (const c of categories) {
    if (c.is_transfer_class) continue;
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.icon || ''} ${c.name}`;
    opt.dataset.dynamic = '1';
    catSelect.appendChild(opt);
  }
}

function buildFilterParams() {
  const p = new URLSearchParams();
  p.set('limit', PAGE_SIZE);
  p.set('offset', currentPage * PAGE_SIZE);

  const acct = $('filter-account').value;
  if (acct) p.set('account_id', acct);

  const cat = $('filter-category').value;
  if (cat !== '') p.set('category_id', cat);

  const from = $('filter-from').value;
  if (from) p.set('date_from', from);

  const to = $('filter-to').value;
  if (to) p.set('date_to', to);

  const search = $('filter-search').value.trim();
  if (search) p.set('search', search);

  if ($('filter-transfers').checked) p.set('show_transfers', '1');

  return p.toString();
}

function resetAndLoad() {
  currentPage = 0;
  selectedIds.clear();
  updateBulkBar();
  loadTransactions();
}

function prevPage() { if (currentPage > 0) { currentPage--; loadTransactions(); } }
function nextPage() { currentPage++; loadTransactions(); }

// ── Category assignment ──────────────────────────────────────

function onTxClick(event, id) {
  if (event.target.classList.contains('tx-check')) return;
  const tx = transactions.find(t => t.id === id);
  if (!tx) return;
  openCategoryOverlay(id, tx.merchant_name || tx.name);
}

function openCategoryOverlay(txId, merchant) {
  assignTarget = { id: txId, merchant };
  $('cat-overlay-title').textContent = 'Assign Category';

  // Show create-rule option for single assignment
  if (merchant) {
    $('create-rule-row').classList.remove('hidden');
    $('rule-merchant').textContent = merchant;
    $('create-rule-check').checked = false;
  } else {
    $('create-rule-row').classList.add('hidden');
  }

  renderCategoryOptions();
  $('category-overlay').classList.remove('hidden');
}

function openBulkCategoryOverlay() {
  assignTarget = null;
  $('cat-overlay-title').textContent = `Assign to ${selectedIds.size} transactions`;
  $('create-rule-row').classList.add('hidden');
  renderCategoryOptions();
  $('category-overlay').classList.remove('hidden');
}

function renderCategoryOptions() {
  const list = $('category-list');
  list.innerHTML = categories
    .map(c => `
      <button class="cat-option" onclick="pickCategory(${c.id})">
        <span class="cat-swatch" style="background:${c.color}"></span>
        <span>${c.icon || ''} ${esc(c.name)}</span>
      </button>
    `).join('');
}

async function pickCategory(categoryId) {
  const target = assignTarget;
  closeCategoryOverlay();

  try {
    if (target) {
      // Single assignment
      const createRule = $('create-rule-check').checked;
      if (createRule) {
        await api(`api/transactions/${target.id}/create-rule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category_id: categoryId })
        });
      } else {
        await api(`api/transactions/${target.id}/category`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category_id: categoryId })
        });
      }
    } else {
      // Bulk assignment
      await api('api/transactions/bulk-categorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ids: [...selectedIds], category_id: categoryId })
      });
      selectedIds.clear();
      updateBulkBar();
    }
    await loadTransactions();
  } catch (err) {
    console.error('Category assignment failed:', err);
  }
}

function closeCategoryOverlay() {
  $('category-overlay').classList.add('hidden');
  assignTarget = null;
}

// ── Bulk selection ───────────────────────────────────────────

function onCheckbox(event, id) {
  event.stopPropagation();
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  // Update row highlight
  const row = event.target.closest('.tx-row');
  if (row) row.classList.toggle('selected', selectedIds.has(id));
  updateBulkBar();
}

function updateBulkBar() {
  const bar = $('bulk-bar');
  if (selectedIds.size > 0) {
    bar.classList.remove('hidden');
    $('bulk-count').textContent = `${selectedIds.size} selected`;
  } else {
    bar.classList.add('hidden');
  }
}

function bulkAssignCategory() {
  if (selectedIds.size === 0) return;
  openBulkCategoryOverlay();
}

function clearSelection() {
  selectedIds.clear();
  updateBulkBar();
  renderTransactions();
}

// ── Auth actions ─────────────────────────────────────────────

async function doLogout() {
  try {
    await fetch('api/auth/logout', { method: 'POST' });
  } catch {}
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

// Transaction-specific: Plaid negative = credit (money in) → show as +$
function fmtTxAmount(amount) {
  const n = parseFloat(amount) || 0;
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `+$${abs}` : `$${abs}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  // Plaid dates are YYYY-MM-DD but node-postgres may return full ISO timestamps
  const str = String(dateStr);
  const d = str.length === 10
    ? new Date(str + 'T00:00:00')
    : new Date(str);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function hexToRgba(hex, alpha) {
  if (!hex) return `rgba(107,114,128,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function bindEnterSubmit(id, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    handler();
  });
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

// ── Magic Panel (Pulse Intelligence) ────────────────────────

let magicDisclaimer = '';

async function loadMagicPanel() {
  // Only show for parents
  if (!currentMember || currentMember.role !== 'parent') {
    $('magic-section').classList.add('hidden');
    return;
  }
  $('magic-section').classList.remove('hidden');

  // Load disclaimer
  try {
    const cfg = await api('api/magic/config');
    const disclaimerRow = cfg.config.find(c => c.key === 'magic_disclaimer');
    magicDisclaimer = disclaimerRow ? disclaimerRow.value : '';
  } catch { /* ignore */ }

  // Load presets
  try {
    const data = await api('api/magic/presets');
    $('magic-presets').innerHTML = data.presets.map(q =>
      `<button class="magic-preset-btn" onclick="askPreset(this)" data-q="${esc(q)}">${esc(q)}</button>`
    ).join('');
  } catch { /* ignore */ }

  // Load digest
  try {
    const data = await api('api/magic/digest');
    if (data.digest) {
      $('magic-digest').classList.remove('hidden');
      $('magic-digest-content').innerHTML = renderMarkdown(data.digest);
    }
  } catch { /* ignore */ }

  // Load monthly report
  try {
    const data = await api('api/magic/monthly');
    if (data.report) {
      $('magic-monthly').classList.remove('hidden');
      $('magic-monthly-content').innerHTML = renderMarkdown(data.report);
    }
  } catch { /* ignore */ }
}

function toggleMagicCard(id) {
  const body = $(id + '-body');
  const toggle = $(id + '-toggle');
  const hidden = body.classList.toggle('hidden');
  toggle.textContent = hidden ? '+' : '\u2212';
}

function askPreset(btn) {
  $('ask-input').value = btn.dataset.q;
  submitAsk();
}

function bindMagicInputShortcuts() {
  bindEnterSubmit('ask-input', submitAsk);
  bindEnterSubmit('whatif-input', submitWhatIf);
}

async function submitAsk() {
  const input = $('ask-input');
  const question = input.value.trim();
  if (!question) return;

  const result = $('ask-result');
  result.classList.remove('hidden');
  result.innerHTML = '<div class="loading-pulse" style="color:var(--muted)">Thinking...</div>';

  try {
    const data = await api('api/magic/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    result.innerHTML = renderMarkdown(data.answer || 'No response.');
    showDisclaimer();
  } catch (err) {
    result.innerHTML = `<div style="color:var(--red)">${esc(err.message)}</div>`;
  }
}

async function submitWhatIf() {
  const input = $('whatif-input');
  const scenario = input.value.trim();
  if (!scenario) return;

  const result = $('whatif-result');
  result.classList.remove('hidden');
  result.innerHTML = '<div class="loading-pulse" style="color:var(--muted)">Forecasting...</div>';

  try {
    const data = await api('api/magic/what-if', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    });
    result.innerHTML = renderMarkdown(data.forecast || 'No response.');
    showDisclaimer();
  } catch (err) {
    result.innerHTML = `<div style="color:var(--red)">${esc(err.message)}</div>`;
  }
}

function showDisclaimer() {
  if (!magicDisclaimer) return;
  const el = $('magic-disclaimer');
  el.textContent = magicDisclaimer;
  el.classList.remove('hidden');
}

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${esc(p)}</p>`)
    .join('');
}
