/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

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
  await Promise.all([loadAccounts(), loadCategories()]);
  populateFilterDropdowns();
  applyUrlParams();
  updatePageTitle();
  setBackLink();
  await loadTransactions();

  // Filter listeners
  $('filter-account').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-category').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-from').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-to').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-search').addEventListener('input', debounce(() => { resetAndLoad(); updatePageTitle(); }, 300));
  $('filter-transfers').addEventListener('change', resetAndLoad);
});

// ── URL params → filters ─────────────────────────────────────

function applyUrlParams() {
  const params = new URLSearchParams(location.search);

  const categoryId = params.get('category_id');
  if (categoryId !== null) $('filter-category').value = categoryId;

  const period = params.get('period');
  if (period) {
    const [y, m] = period.split('-').map(Number);
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(y, m, 0); // last day of month
    const lastStr = `${y}-${String(m).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`;
    $('filter-from').value = first;
    $('filter-to').value = lastStr;
  }

  const dateFrom = params.get('date_from');
  if (dateFrom) $('filter-from').value = dateFrom;

  const dateTo = params.get('date_to');
  if (dateTo) $('filter-to').value = dateTo;

  const accountId = params.get('account_id');
  if (accountId) $('filter-account').value = accountId;

  const search = params.get('search');
  if (search) $('filter-search').value = search;

  const showTransfers = params.get('show_transfers');
  if (showTransfers === '1') $('filter-transfers').checked = true;
}

function setBackLink() {
  // no-op: back link removed in favor of nav sidebar
}

function updatePageTitle() {
  const parts = [];

  // Category name
  const catVal = $('filter-category').value;
  if (catVal === '0') {
    parts.push('Uncategorized');
  } else if (catVal) {
    const cat = categories.find(c => String(c.id) === catVal);
    if (cat) parts.push(`${cat.icon || ''} ${cat.name}`.trim());
  }

  // Search term
  const search = $('filter-search').value.trim();
  if (search) parts.push(`"${search}"`);

  // Period label from date filters
  const from = $('filter-from').value;
  const to = $('filter-to').value;
  if (from && to) {
    // Check if it's a full month range
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const lastDay = new Date(ty, tm, 0).getDate();
    if (fy === ty && fm === tm && fd === 1 && td === lastDay) {
      const d = new Date(fy, fm - 1, 1);
      parts.push(d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
    } else {
      parts.push(`${formatDate(from)} – ${formatDate(to)}`);
    }
  } else if (from) {
    parts.push(`From ${formatDate(from)}`);
  } else if (to) {
    parts.push(`Until ${formatDate(to)}`);
  }

  $('page-title').textContent = parts.length > 0 ? parts.join(' · ') : 'Transactions';
  document.title = `Pulse — ${$('page-title').textContent}`;
}

// ── Data fetching ────────────────────────────────────────────

async function loadAccounts() {
  try {
    const data = await api('api/accounts/dashboard');
    accounts = [];
    Object.values(data.groups).forEach(g => accounts.push(...g));
  } catch (err) {
    console.error('Accounts load failed:', err);
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
  const str = String(dateStr);
  const d = str.length === 10 ? new Date(str + 'T00:00:00') : new Date(str);
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
