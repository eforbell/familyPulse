/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let currentMember = JSON.parse(localStorage.getItem('fp_member') || 'null');
let membersCache = [];
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
  updateWhoBtn();
  await Promise.all([loadDashboard(), loadCategories()]);
  populateFilterDropdowns();
  await loadTransactions();
  if (!currentMember) setTimeout(openMemberPicker, 400);

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
    const params = memberParam();
    const data = await api(`api/accounts/dashboard${params}`);
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
    <span><span class="label">Liquid</span> <span class="value">${fmtMoney(data.liquid_total)}</span></span>
    <span><span class="label">Credit</span> <span class="value" style="color:var(--red)">${fmtMoney(data.credit_total)}</span></span>
    <span><span class="label">Accounts</span> <span class="value">${data.account_count}</span></span>
  `;

  const grid = $('accounts-grid');
  grid.innerHTML = '';

  for (const [owner, accts] of Object.entries(data.groups)) {
    const group = document.createElement('div');
    group.className = 'owner-group';
    group.innerHTML = `<div class="owner-label">${esc(owner)}</div>`;

    for (const a of accts) {
      const bal = parseFloat(a.current_balance) || 0;
      const isCredit = a.type === 'credit';
      group.innerHTML += `
        <div class="account-card" style="cursor:pointer" onclick="location.href='transactions.html?account_id=${a.id}'">
          <div class="acct-info">
            <div class="acct-name">${esc(a.name)}</div>
            <div class="acct-detail">${esc(a.institution_name || '')} ${a.mask ? '···' + esc(a.mask) : ''} · ${esc(a.subtype || a.type)}</div>
          </div>
          <div class="acct-balance ${isCredit ? 'credit' : ''}">${fmtMoney(bal)}</div>
        </div>`;
    }

    grid.appendChild(group);
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
      <div class="tx-amount ${isCredit ? 'credit' : 'debit'}">${fmtMoney(amt)}</div>
    </div>`;
  }).join('');
}

function renderStats() {
  $('tx-stats').innerHTML = `
    <span><span class="label">Showing</span> <span class="value">${transactions.length} of ${txTotal}</span></span>
    <span><span class="label">Net</span> <span class="value">${fmtMoney(txSum)}</span></span>
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

  // Member scoping
  if (currentMember) p.set('member', currentMember.name);

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
    .filter(c => !c.is_transfer_class)
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

// ── Member picker ────────────────────────────────────────────

async function openMemberPicker() {
  try {
    membersCache = await api('api/family-members');
    const list = $('member-list');
    list.innerHTML = membersCache.map(m => `
      <button class="member-btn" onclick="selectMember(${m.id})">
        <span class="emoji">${m.avatar_emoji || '👤'}</span>
        <span>${esc(m.name)}</span>
      </button>
    `).join('');
    $('member-overlay').classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load members:', err);
  }
}

function selectMember(id) {
  currentMember = membersCache.find(m => m.id === id);
  localStorage.setItem('fp_member', JSON.stringify(currentMember));
  updateWhoBtn();
  $('member-overlay').classList.add('hidden');
  // Reload everything with new member scope
  loadDashboard();
  resetAndLoad();
}

function updateWhoBtn() {
  $('who-btn').textContent = currentMember ? (currentMember.avatar_emoji || '👤') : '👤';
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

function memberParam() {
  if (!currentMember) return '';
  return `?member=${encodeURIComponent(currentMember.name)}`;
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
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
