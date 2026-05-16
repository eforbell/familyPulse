/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let currentMember = { role: 'parent' };
let accounts = [];
let categories = [];
let transactions = [];
let txTotal = 0;
let txSum = 0;
let currentPage = 0;
const PAGE_SIZE = 50;
let selectedIds = new Set();
let assignTarget = null; // { id, merchant } for single, null for bulk
let dedupRunFilter = null;
let currentDetailId = null;
let currentDetail = null;
let displayNameSuggestionController = null;
let transactionSearchSuggestionController = null;
const FILTER_DISCLOSURE_KEY = 'pulse-transactions-filter-more-open';

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadCurrentMember();
  await Promise.all([loadAccounts(), loadCategories()]);
  populateFilterDropdowns();
  applyUrlParams();
  restoreFilterDisclosure();
  renderFilterChips();
  updatePageTitle();
  setBackLink();
  await loadTransactions();

  // Filter listeners
  $('filter-account').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-category').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-from').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-to').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-search').addEventListener('input', debounce(() => { resetAndLoad(); updatePageTitle(); }, 300));
  $('filter-transfers').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-hidden').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('filter-sort').addEventListener('change', () => { resetAndLoad(); updatePageTitle(); });
  $('btn-dedup').addEventListener('click', runDedup);
  initDisplayNameSuggestionController();
  initTransactionSearchSuggestionController();
});

// ── URL params → filters ─────────────────────────────────────

function applyUrlParams() {
  const params = new URLSearchParams(location.search);
  $('filter-transfers').checked = true;

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
  if (showTransfers === '0') $('filter-transfers').checked = false;
  else if (showTransfers === '1') $('filter-transfers').checked = true;

  const showHidden = params.get('show_hidden');
  if (showHidden === '1') $('filter-hidden').checked = true;

  const sortField = params.get('sort_field');
  const sortDirection = params.get('sort_direction');
  if (sortField && sortDirection) {
    $('filter-sort').value = `${sortField}_${sortDirection}`;
  }

  const dedupRunId = params.get('dedup_run_id');
  if (dedupRunId) dedupRunFilter = dedupRunId;
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
    if (cat) parts.push(plainCategoryName(cat.name));
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

  if (dedupRunFilter) {
    parts.push(`Dedup Run #${dedupRunFilter}`);
  }

  $('page-title').textContent = parts.length > 0 ? parts.join(' · ') : 'Transactions';
  document.title = `Family Pulse | ${$('page-title').textContent}`;
}

// ── Data fetching ────────────────────────────────────────────

async function loadAccounts() {
  try {
    const data = await api('api/accounts/dashboard');
    accounts = [];
    Object.values(data.groups).forEach(g => accounts.push(...g));
    Object.values(data.historical_groups || {}).forEach(g => {
      g.forEach(account => accounts.push({ ...account, is_historical: true }));
    });
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

async function loadCurrentMember() {
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) {
      currentMember = await res.json();
    } else {
      currentMember = { role: 'parent', name: 'Local' };
    }
  } catch {
    currentMember = { role: 'parent', name: 'Local' };
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
    const merchant = tx.effective_display_name || tx.merchant_name || tx.name || '—';
    const pendingClass = tx.pending ? ' pending' : '';
    const selectedClass = selectedIds.has(tx.id) ? ' selected' : '';
    const iconLetter = esc(merchant.trim().charAt(0).toUpperCase() || '•');
    const iconClass = tx.category_name ? (isCredit ? 'in' : 'out') : 'uncat';
    const sourceBadge = tx.source && tx.source !== 'plaid' ? `<span class="status-tag info">${esc(tx.source)}</span>` : '';
    const accountStatusBadge = tx.account_sync_status === 'historical' ? '<span class="status-tag">Historical</span>' : '';
    const hiddenBadge = tx.is_hidden ? '<span class="status-tag bad">Suppressed</span>' : '';
    const suppressButton = tx.is_hidden
      ? `<button class="btn-ghost btn-xs tx-inline-action" onclick="unhideTx(event, ${tx.id})" title="Restore">Restore</button>`
      : (tx.source !== 'plaid'
          ? `<button class="btn-ghost btn-xs tx-inline-action" onclick="hideTx(event, ${tx.id})" title="Suppress duplicate">Suppress</button>`
          : '');
    const categoryLine = tx.category_name
      ? `<div class="tx-cat-line"><span class="cat-dot" style="background:${esc(tx.category_color || '#6F6A5E')}"></span><span>${esc(plainCategoryName(tx.category_name))}</span>${sourceBadge}${accountStatusBadge}${hiddenBadge}</div>`
      : `<div class="tx-cat-line uncat"><span class="cat-dot"></span><span>Uncategorized · tap to assign</span>${sourceBadge}${accountStatusBadge}${hiddenBadge}</div>`;
    const pendingTag = tx.pending ? '<span class="status-tag">Pending</span>' : '';

    return `<div class="tx-row${pendingClass}${selectedClass}" data-id="${tx.id}" onclick="onTxClick(event, ${tx.id})">
      <input type="checkbox" class="tx-check" ${selectedIds.has(tx.id) ? 'checked' : ''} onclick="onCheckbox(event, ${tx.id})">
      <div class="tx-icon ${iconClass}">${iconLetter}</div>
      <div class="tx-main">
        <div class="tx-merchant">${esc(merchant)}</div>
        <div class="tx-sub">
          <span>${formatDate(tx.date)}</span>
          <span class="sep">·</span>
          <span class="tx-account">${esc(tx.account_name)}${tx.account_mask ? ` •••${esc(tx.account_mask)}` : ''}</span>
        </div>
        ${categoryLine}
      </div>
      <div class="tx-amount-wrap">
        <div class="tx-amount ${isCredit ? 'credit' : 'debit'}">${fmtTxAmount(amt)}</div>
        ${pendingTag}
        ${suppressButton}
      </div>
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
    opt.textContent = `${a.display_name || a.name} ···${a.mask || ''}${a.is_historical ? ' (historical)' : ''}`;
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
    opt.textContent = plainCategoryName(c.name);
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

  const [sortField, sortDirection] = ($('filter-sort').value || 'date_desc').split('_');
  if (sortField) p.set('sort_field', sortField);
  if (sortDirection) p.set('sort_direction', sortDirection);

  if ($('filter-transfers').checked) p.set('show_transfers', '1');
  if ($('filter-hidden').checked) p.set('show_hidden', '1');
  if (dedupRunFilter) p.set('dedup_run_id', dedupRunFilter);

  return p.toString();
}

function resetAndLoad() {
  currentPage = 0;
  selectedIds.clear();
  updateBulkBar();
  renderFilterChips();
  loadTransactions();
}

function toggleFilterDisclosure(force) {
  const panel = $('filter-more');
  const shouldOpen = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !shouldOpen);
  sessionStorage.setItem(FILTER_DISCLOSURE_KEY, shouldOpen ? '1' : '0');
  renderFilterChips();
}

function restoreFilterDisclosure() {
  const isOpen = sessionStorage.getItem(FILTER_DISCLOSURE_KEY) === '1';
  $('filter-more').classList.toggle('hidden', !isOpen);
}

function renderFilterChips() {
  const accountId = $('filter-account').value;
  const categoryId = $('filter-category').value;
  const search = $('filter-search').value.trim();
  const from = $('filter-from').value;
  const to = $('filter-to').value;
  const sort = $('filter-sort').value || 'date_desc';
  const showTransfers = $('filter-transfers').checked;
  const showHidden = $('filter-hidden').checked;
  const isOpen = !$('filter-more').classList.contains('hidden');
  const account = accounts.find(entry => String(entry.id) === accountId);
  const category = categoryId === '0' ? { name: 'Uncategorized' } : categories.find(entry => String(entry.id) === categoryId);
  const chips = [];

  if (account) chips.push({ key: 'account', label: account.name || 'Account' });
  if (category) chips.push({ key: 'category', label: plainCategoryName(category.name) || 'Category' });
  if (search) chips.push({ key: 'search', label: `Search: ${search}` });
  if (from || to) chips.push({ key: 'date', label: `${from ? formatDate(from) : 'Start'} → ${to ? formatDate(to) : 'Now'}` });
  if (sort !== 'date_desc') {
    const sortLabels = { date_asc: 'Oldest first', amount_desc: 'Largest amount', amount_asc: 'Smallest amount' };
    chips.push({ key: 'sort', label: sortLabels[sort] || sort });
  }
  if (!showTransfers) chips.push({ key: 'transfers', label: 'Transfers hidden' });
  if (showHidden) chips.push({ key: 'hidden', label: 'Suppressed shown' });
  if (dedupRunFilter) chips.push({ key: 'dedup', label: `Dedup run #${dedupRunFilter}` });

  $('filter-chips').innerHTML = `
    <button type="button" class="filter-chip" id="filter-chip-trigger" aria-expanded="${isOpen ? 'true' : 'false'}" onclick="toggleFilterDisclosure()">
      <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M3 5h14M6 10h8M9 15h2"/></svg>
      <span>Filters</span>
    </button>
    ${chips.map(chip => `
      <button type="button" class="filter-chip active" onclick="clearFilterChip('${chip.key}')">
        <span>${esc(chip.label)}</span>
        <span class="chip-x" aria-hidden="true"></span>
      </button>
    `).join('')}
  `;
}

function clearFilterChip(key) {
  if (key === 'account') $('filter-account').value = '';
  if (key === 'category') $('filter-category').value = '';
  if (key === 'search') $('filter-search').value = '';
  if (key === 'date') {
    $('filter-from').value = '';
    $('filter-to').value = '';
  }
  if (key === 'sort') $('filter-sort').value = 'date_desc';
  if (key === 'transfers') $('filter-transfers').checked = true;
  if (key === 'hidden') $('filter-hidden').checked = false;
  if (key === 'dedup') dedupRunFilter = null;
  updatePageTitle();
  resetAndLoad();
}

function prevPage() { if (currentPage > 0) { currentPage--; loadTransactions(); } }
function nextPage() { currentPage++; loadTransactions(); }

function isOverlayOpen(id) {
  const el = $(id);
  return !!el && !el.classList.contains('hidden');
}

function syncModalOpenState() {
  const open = ['tx-detail-overlay','category-overlay','tx-note-editor-overlay','tx-attachment-editor-overlay'].some(isOverlayOpen);
  document.body.classList.toggle('modal-open', open);
}

// ── Category assignment ──────────────────────────────────────

function onTxClick(event, id) {
  if (event.target.classList.contains('tx-check')) return;
  if (event.target.closest('.tx-inline-action')) return;
  openTransactionDetail(id);
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
  syncModalOpenState();
}

function openBulkCategoryOverlay() {
  assignTarget = null;
  $('cat-overlay-title').textContent = `Assign to ${selectedIds.size} transactions`;
  $('create-rule-row').classList.add('hidden');
  renderCategoryOptions();
  $('category-overlay').classList.remove('hidden');
  syncModalOpenState();
}

function renderCategoryOptions() {
  const list = $('category-list');
  list.innerHTML = categories
    .map(c => `
      <button class="cat-option" onclick="pickCategory(${c.id})">
        <span class="cat-swatch" style="background:${c.color}"></span>
        <span>${esc(plainCategoryName(c.name))}</span>
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
    if (currentDetailId) {
      await refreshCurrentDetail();
    }
  } catch (err) {
    console.error('Category assignment failed:', err);
  }
}

function closeCategoryOverlay() {
  $('category-overlay').classList.add('hidden');
  assignTarget = null;
  syncModalOpenState();
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

// ── Dedup workflow ───────────────────────────────────────────

async function runDedup() {
  try {
    const dateFrom = $('filter-from').value || null;
    const dateTo = $('filter-to').value || null;
    const payload = {};
    if (dateFrom) payload.date_from = dateFrom;
    if (dateTo) payload.date_to = dateTo;

    const preview = await api('api/transactions/dedup/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (preview.duplicates_found === 0) {
      alert(`No import duplicates found.${preview.ambiguous_count ? ` Ambiguous matches: ${preview.ambiguous_count}` : ''}`);
      return;
    }

    const scopeLabel = dateFrom || dateTo
      ? ` for current date filters (${dateFrom || 'start'} to ${dateTo || 'end'})`
      : '';

    const shouldApply = window.confirm(
      `Found ${preview.duplicates_found} duplicates${scopeLabel}.\n` +
      `Plaid transactions will be kept; imported duplicates will be suppressed.\n` +
      `${preview.ambiguous_count} ambiguous matches will be skipped.\n\n` +
      'Apply now?'
    );
    if (!shouldApply) return;

    const result = await api('api/transactions/dedup/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    alert(
      `Done.\nSuppressed: ${result.hidden}\n` +
      `Copied categories to Plaid: ${result.category_copied}\n` +
      `Ambiguous skipped: ${result.ambiguous_count}`
    );

    await resetAndLoad();
  } catch (err) {
    alert(`Duplicate cleanup failed: ${err.message}`);
  }
}

async function hideTx(event, id) {
  event.stopPropagation();
  try {
    await api(`api/transactions/${id}/hide`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'manual_duplicate_suppress' })
    });
    await loadTransactions();
  } catch (err) {
    alert(`Suppress failed: ${err.message}`);
  }
}

async function unhideTx(event, id) {
  event.stopPropagation();
  try {
    await api(`api/transactions/${id}/unhide`, { method: 'PUT' });
    await loadTransactions();
  } catch (err) {
    alert(`Restore failed: ${err.message}`);
  }
}

// ── Transaction detail ───────────────────────────────────────

async function openTransactionDetail(id) {
  currentDetailId = id;
  currentDetail = null;
  $('tx-detail-title').textContent = 'Transaction Detail';
  $('tx-detail-meta').textContent = 'Loading…';
  $('tx-detail-display-name').textContent = '—';
  $('tx-detail-amount').textContent = '—';
  $('tx-detail-category').textContent = '—';
  $('tx-detail-raw').textContent = '—';
  $('tx-detail-feedback').className = 'tx-detail-feedback hidden';
  $('tx-attachment-list').innerHTML = '<div class="empty-state loading-pulse">Loading attachments…</div>';
  hideDisplayNameSuggestions();
  $('tx-detail-overlay').classList.remove('hidden');
  syncModalOpenState();

  try {
    const data = await api(`api/transactions/${id}`);
    currentDetail = data.transaction;
    renderTransactionDetail();
  } catch (err) {
    $('tx-detail-feedback').className = 'tx-detail-feedback error';
    $('tx-detail-feedback').textContent = err.message || 'Could not load transaction detail';
  }
}

function closeTransactionDetail() {
  currentDetailId = null;
  currentDetail = null;
  hideDisplayNameSuggestions();
  closeTransactionNoteEditor();
  closeTransactionAttachmentEditor();
  $('tx-detail-overlay').classList.add('hidden');
  syncModalOpenState();
}

async function refreshCurrentDetail() {
  if (!currentDetailId) return;
  const data = await api(`api/transactions/${currentDetailId}`);
  currentDetail = data.transaction;
  renderTransactionDetail();
}

function renderTransactionDetail() {
  if (!currentDetail) return;
  const tx = currentDetail;
  const merchant = tx.effective_display_name || tx.merchant_name || tx.name || 'Transaction Detail';
  const rawParts = [tx.merchant_name, tx.name].filter(Boolean);
  const note = tx.note || null;

  $('tx-detail-title').textContent = merchant;
  $('tx-detail-display-name').textContent = tx.effective_display_name || '—';
  $('tx-detail-meta').textContent = [
    formatDate(tx.date),
    tx.account_name ? `${tx.account_name}${tx.account_mask ? ` ···${tx.account_mask}` : ''}` : '',
    tx.source || '',
    tx.pending ? 'pending' : '',
    tx.source_removed ? 'removed upstream, kept locally' : ''
  ].filter(Boolean).join(' · ');
  $('tx-detail-amount').innerHTML = fmtTxAmount(tx.amount);
  $('tx-detail-amount').className = `tx-detail-amount-value ${parseFloat(tx.amount) < 0 ? 'credit' : 'debit'}`;
  $('tx-detail-category').textContent = plainCategoryName(tx.category_name) || 'Uncategorized';
  $('tx-detail-raw').textContent = rawParts.length ? rawParts.join(' / ') : '—';

  const canEditDisplayName = currentMember?.role === 'parent';
  $('tx-display-name-input').classList.toggle('hidden', !canEditDisplayName);
  $('tx-display-name-actions').classList.toggle('hidden', !canEditDisplayName);
  $('tx-display-name-readonly').classList.toggle('hidden', canEditDisplayName);
  $('tx-display-name-rule-row').classList.toggle('hidden', !canEditDisplayName);
  $('tx-display-name-meta').textContent = tx.display_name_override_updated_at
    ? `Updated ${formatDate(tx.display_name_override_updated_at)}${tx.display_name_override_updated_by_name ? ` by ${tx.display_name_override_updated_by_name}` : ''}`
    : '';

  if (canEditDisplayName) {
    $('tx-display-name-input').value = tx.display_name_override || '';
    $('tx-display-name-rule-check').checked = tx.rename_rule ? true : !tx.raw_display_name_is_check_like;
    $('tx-display-name-rule-hint').classList.remove('hidden');
    $('tx-display-name-rule-hint').textContent = 'Apply name change to future matches';
    $('tx-display-name-empty').classList.toggle('hidden', !!tx.display_name_override);
  } else {
    $('tx-display-name-readonly').textContent = tx.display_name_override || '';
    $('tx-display-name-empty').classList.toggle('hidden', !!tx.display_name_override);
  }
  hideDisplayNameSuggestions();

  $('tx-note-meta').textContent = note?.updated_at
    ? `Last updated ${formatDate(note.updated_at)}${note.updated_by_name ? ` by ${note.updated_by_name}` : ''}`
    : '';
  $('tx-note-readonly').textContent = note?.text || '';
  $('tx-note-readonly').classList.toggle('hidden', !note?.text);
  $('tx-note-empty').classList.toggle('hidden', !!note?.text);
  const noteEditor = $('tx-note-modal-input');
  if (noteEditor) noteEditor.value = note?.text || '';

  renderAttachmentList(tx.attachments || []);
}

async function saveTransactionDisplayName() {
  await submitTransactionDisplayName({
    displayName: $('tx-display-name-input').value,
    applyToFuture: $('tx-display-name-rule-check').checked
  });
}

async function submitTransactionDisplayName({ displayName, applyToFuture }) {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  const feedback = $('tx-detail-feedback');
  feedback.className = 'tx-detail-feedback';
  feedback.textContent = 'Saving display name…';

  try {
    const data = await api(`api/transactions/${currentDetailId}/display-name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        display_name: displayName,
        apply_to_future: applyToFuture
      })
    });
    currentDetail = data.transaction;
    await loadTransactions();
    renderTransactionDetail();
    feedback.textContent = 'Display name saved.';
  } catch (err) {
    feedback.className = 'tx-detail-feedback error';
    feedback.textContent = err.message || 'Could not save display name';
  }
}

async function clearTransactionDisplayName() {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  $('tx-display-name-input').value = '';
  $('tx-display-name-rule-check').checked = false;
  hideDisplayNameSuggestions();
  await submitTransactionDisplayName({ displayName: '', applyToFuture: false });
}

function bindDisplayNameSuggestionInput() {
  if (displayNameSuggestionController) displayNameSuggestionController.bind();
}

function initDisplayNameSuggestionController() {
  if (typeof window.createDisplayNameSuggestionController !== 'function') return;
  displayNameSuggestionController = window.createDisplayNameSuggestionController({
    getInput: () => $('tx-display-name-input'),
    getRoot: () => $('tx-display-name-suggestions'),
    shouldSuggest: () => currentMember?.role === 'parent',
    fetchSuggestions: async (query) => {
      const data = await api(`api/transactions/merchant-suggestions?q=${encodeURIComponent(query)}`);
      return data.suggestions || [];
    },
    escapeHtml: esc,
    formatDate
  });
  bindDisplayNameSuggestionInput();
}

function hideDisplayNameSuggestions() {
  if (displayNameSuggestionController) displayNameSuggestionController.hide();
}

function initTransactionSearchSuggestionController() {
  if (typeof window.createDisplayNameSuggestionController !== 'function') return;
  transactionSearchSuggestionController = window.createDisplayNameSuggestionController({
    getInput: () => $('filter-search'),
    getRoot: () => $('filter-search-suggestions'),
    shouldSuggest: () => true,
    fetchSuggestions: async (query) => {
      const data = await api(`api/transactions/merchant-suggestions?q=${encodeURIComponent(query)}`);
      return data.suggestions || [];
    },
    escapeHtml: esc,
    formatDate,
    onSelect: () => {
      resetAndLoad();
      updatePageTitle();
    }
  });
  transactionSearchSuggestionController.bind();
  $('filter-search').addEventListener('change', () => {
    if (transactionSearchSuggestionController) transactionSearchSuggestionController.hide();
    resetAndLoad();
    updatePageTitle();
  });
}

function renderAttachmentList(attachments) {
  const root = $('tx-attachment-list');
  if (!attachments.length) {
    root.innerHTML = '<div class="empty-state">No attachments yet</div>';
    return;
  }

  root.innerHTML = attachments.map(att => `
    <div class="tx-attachment-row">
      <div class="tx-attachment-main">
        <div class="tx-attachment-name">${esc(att.original_filename)}</div>
        <div class="tx-detail-subtle">${formatDate(att.created_at)} · ${formatBytes(att.byte_size)}${att.uploaded_by_name ? ` · ${esc(att.uploaded_by_name)}` : ''}</div>
      </div>
      <div class="tx-attachment-actions">
        <a class="btn-ghost tx-attachment-link" href="api/transaction-attachments/${att.id}/download">Download</a>
        ${currentMember?.role === 'parent'
          ? `<button class="btn-ghost" type="button" onclick="deleteTransactionAttachment(${att.id})">Delete</button>`
          : ''}
      </div>
    </div>
  `).join('');
}

function openCurrentCategoryEditor() {
  if (!currentDetail) return;
  openCategoryOverlay(currentDetail.id, currentDetail.merchant_name || currentDetail.name);
}

function openTransactionNoteEditor() {
  if (!currentDetail || currentMember?.role !== 'parent') return;
  $('tx-note-editor-title').textContent = currentDetail.note?.text ? 'Edit note' : 'Add note';
  $('tx-note-modal-input').value = currentDetail.note?.text || '';
  $('tx-note-editor-overlay').classList.remove('hidden');
  syncModalOpenState();
}

function closeTransactionNoteEditor() {
  const el = $('tx-note-editor-overlay');
  if (el) el.classList.add('hidden');
  syncModalOpenState();
}

function openTransactionAttachmentEditor() {
  if (!currentDetail || currentMember?.role !== 'parent') return;
  $('tx-attachment-editor-overlay').classList.remove('hidden');
  syncModalOpenState();
}

function closeTransactionAttachmentEditor() {
  const el = $('tx-attachment-editor-overlay');
  if (el) el.classList.add('hidden');
  syncModalOpenState();
}

async function saveTransactionNote() {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  const feedback = $('tx-detail-feedback');
  feedback.className = 'tx-detail-feedback';
  feedback.textContent = 'Saving note…';

  try {
    const data = await api(`api/transactions/${currentDetailId}/note`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: $('tx-note-modal-input').value })
    });
    currentDetail = data.transaction;
    renderTransactionDetail();
    closeTransactionNoteEditor();
    feedback.textContent = 'Note saved.';
  } catch (err) {
    feedback.className = 'tx-detail-feedback error';
    feedback.textContent = err.message || 'Could not save note';
  }
}

async function clearTransactionNote() {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  const feedback = $('tx-detail-feedback');
  feedback.className = 'tx-detail-feedback';
  feedback.textContent = 'Clearing note…';

  try {
    const data = await api(`api/transactions/${currentDetailId}/note`, { method: 'DELETE' });
    currentDetail = data.transaction;
    renderTransactionDetail();
    closeTransactionNoteEditor();
    feedback.textContent = 'Note cleared.';
  } catch (err) {
    feedback.className = 'tx-detail-feedback error';
    feedback.textContent = err.message || 'Could not clear note';
  }
}

async function uploadTransactionAttachments() {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  const input = $('tx-attachment-input');
  if (!input.files || input.files.length === 0) return;

  const feedback = $('tx-detail-feedback');
  feedback.className = 'tx-detail-feedback';
  feedback.textContent = 'Uploading attachments…';

  const form = new FormData();
  for (const file of input.files) {
    form.append('files', file);
  }

  try {
    await apiForm(`api/transactions/${currentDetailId}/attachments`, {
      method: 'POST',
      body: form
    });
    input.value = '';
    await refreshCurrentDetail();
    closeTransactionAttachmentEditor();
    feedback.textContent = 'Attachments uploaded.';
  } catch (err) {
    feedback.className = 'tx-detail-feedback error';
    feedback.textContent = err.message || 'Could not upload attachments';
  }
}

async function deleteTransactionAttachment(id) {
  if (currentMember?.role !== 'parent') return;
  const feedback = $('tx-detail-feedback');
  feedback.className = 'tx-detail-feedback';
  feedback.textContent = 'Deleting attachment…';

  try {
    await api(`api/transaction-attachments/${id}`, { method: 'DELETE' });
    await refreshCurrentDetail();
    feedback.textContent = 'Attachment deleted.';
  } catch (err) {
    feedback.className = 'tx-detail-feedback error';
    feedback.textContent = err.message || 'Could not delete attachment';
  }
}

// ── Helpers ──────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function setQuickDateRange(range) {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-indexed
  const pad = n => String(n).padStart(2, '0');
  let from, to;
  if (range === 'this-month') {
    from = `${y}-${pad(m + 1)}-01`;
    to = `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`;
  } else if (range === 'last-month') {
    const lm = m === 0 ? 12 : m;
    const ly = m === 0 ? y - 1 : y;
    from = `${ly}-${pad(lm)}-01`;
    to = `${ly}-${pad(lm)}-${pad(new Date(ly, lm, 0).getDate())}`;
  } else if (range === 'this-quarter') {
    const qStart = Math.floor(m / 3) * 3; // 0-indexed start month
    const qEnd = qStart + 2;
    from = `${y}-${pad(qStart + 1)}-01`;
    to = `${y}-${pad(qEnd + 1)}-${pad(new Date(y, qEnd + 1, 0).getDate())}`;
  } else if (range === 'this-year') {
    from = `${y}-01-01`;
    to = `${y}-12-31`;
  }
  $('filter-from').value = from;
  $('filter-to').value = to;
  resetAndLoad();
  updatePageTitle();
}

function plainCategoryName(name) {
  return String(name || '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\u200D\uFE0F\s]+/gu, '')
    .trim();
}

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

// Transaction-specific: Plaid negative = credit (money in) → show as +$
function fmtTxAmount(amount) {
  const n = parseFloat(amount) || 0;
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span class="fp-amount">${n < 0 ? `+$${abs}` : `$${abs}`}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const str = String(dateStr);
  const d = str.length === 10 ? new Date(str + 'T00:00:00') : new Date(str);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
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

async function apiForm(url, opts) {
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

document.addEventListener('click', event => {
  const overlay = $('tx-detail-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (event.target === overlay) closeTransactionDetail();
});

document.addEventListener('keydown', event => {
  const overlay = $('tx-detail-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (event.key === 'Escape') closeTransactionDetail();
});
