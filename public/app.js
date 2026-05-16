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
let currentDetailId = null;
let currentDetail = null;
let displayNameSuggestionController = null;

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
  await Promise.all([loadDashboard(), loadCategories(), loadCoverageIndicator(), loadRecurringIndicator(), loadForecastIndicator()]);
  await loadTransactions();
  loadMagicPanel();
  bindMagicInputShortcuts();
  initDisplayNameSuggestionController();
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

async function loadCoverageIndicator() {
  try {
    const data = await api('api/accounts/coverage');
    const el = $('coverage-indicator');
    if (!data || data.status === 'clear') {
      el.classList.add('hidden');
      return;
    }
    const colorMap = { healthy: 'var(--green)', warning: 'var(--yellow)', danger: 'var(--red)' };
    const color = colorMap[data.status] || 'var(--muted)';
    const ratioLabel = data.ratio !== null ? `${data.ratio}x` : '--';
    el.innerHTML = `
      <div class="strip-label">Liability coverage <strong style="color:${color}">${ratioLabel}</strong></div>
      <div class="strip-meta">${fmtMoney(data.obligation_total)} due</div>
    `;
    el.onclick = () => { window.location.href = 'accounts.html'; };
    el.classList.remove('hidden');
  } catch (err) {
    console.error('Coverage indicator failed:', err);
  }
}


async function loadRecurringIndicator() {
  try {
    const data = await api('api/recurring/summary');
    const el = $('recurring-indicator');
    if (!el) return;
    if (!data || (!data.committed_monthly_total && !data.active_count)) {
      el.classList.add('hidden');
      return;
    }
    el.innerHTML = `
      <div class="strip-label">Recurring plan <strong>${fmtMoney(data.committed_monthly_total)}</strong> committed</div>
      <div class="strip-meta">${data.active_count} active · ${fmtMoney(data.recurring_income_monthly_total)} inbound</div>
    `;
    el.onclick = () => { window.location.href = 'recurring.html'; };
    el.classList.remove('hidden');
  } catch (err) {
    console.error('Recurring indicator failed:', err);
  }
}


async function loadForecastIndicator() {
  try {
    const el = $('forecast-indicator');
    if (!el) return;
    const data = await api('api/cash-flow/forecast');
    if (!data || !data.projections || data.projections.length === 0) {
      el.innerHTML = `
        <div class="strip-label">Forecast available after first sync</div>
        <div class="strip-meta">&#8250;</div>
      `;
      el.onclick = () => { window.location.href = 'forecast.html'; };
      el.classList.remove('hidden');
      return;
    }
    const zones = data.danger_zones || [];
    const excess = data.excess_liquidity || {};
    const outlook = data.monthly_outlook || [];
    const nearDanger = zones.filter(z => z.severity === 'danger' && withinDays(z.date, 30));

    let statusText, statusColor, rightText;

    if (nearDanger.length > 0) {
      statusColor = 'var(--red)';
      statusText = `Danger on ${fmtShortDate(nearDanger[0].date)}`;
      rightText = `${fmtMoney(nearDanger[0].deficit_below_floor)} below floor`;
    } else if (excess.recommendation_level && excess.recommendation_level !== 'none') {
      statusColor = 'var(--accent)';
      statusText = `Excess cash: ${fmtMoney(excess.excess_amount)}`;
      rightText = 'available to move';
    } else if (outlook.length > 0) {
      const nextMonth = outlook[0];
      const isPositive = nextMonth.net_surplus_or_deficit >= 0;
      statusColor = isPositive ? 'var(--green)' : 'var(--yellow)';
      const sign = isPositive ? '+' : '';
      statusText = `Next month: ${sign}${fmtMoney(nextMonth.net_surplus_or_deficit)}`;
      rightText = `end bal ${fmtMoney(nextMonth.projected_end_balance)}`;
    } else {
      statusColor = 'var(--green)';
      statusText = '90-day outlook: Healthy';
      rightText = '';
    }

    el.innerHTML = `
      <div class="strip-label">Forecast <strong style="color:${statusColor}">${statusText}</strong></div>
      <div class="strip-meta">${rightText ? `${rightText} &#8250;` : '&#8250;'}</div>
    `;
    el.onclick = () => { window.location.href = 'forecast.html'; };
    el.classList.remove('hidden');
  } catch (err) {
    console.error('Forecast indicator failed:', err);
  }
}


function withinDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const diff = (d - new Date()) / 86400000;
  return diff >= 0 && diff <= days;
}

function fmtShortDate(dateStr) {
  const [, m, d] = (dateStr || '').split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
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
    const params = buildRecentTransactionParams();
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
  const liquidTotal = parseFloat(data.liquid_total) || 0;
  const creditTotal = parseFloat(data.credit_total) || 0;
  const accountCount = Number(data.account_count) || 0;
  const historicalCount = Number(data.historical_account_count) || 0;
  const coverageRatio = Math.abs(creditTotal) > 0 ? `${(liquidTotal / Math.abs(creditTotal)).toFixed(2)}×` : '—';

  $('net-amount').innerHTML = fmtMoney(data.net_position);
  $('net-amount').classList.remove('loading-pulse');
  $('balance-breakdown').innerHTML = `
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
    const categoryLine = tx.category_name
      ? `<div class="tx-cat-line"><span class="cat-dot" style="background:${esc(tx.category_color || '#6F6A5E')}"></span><span>${esc(plainCategoryName(tx.category_name))}</span></div>`
      : '<div class="tx-cat-line uncat"><span class="cat-dot"></span><span>Uncategorized · tap to assign</span></div>';
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

// ── Recent transactions query ────────────────────────────────

function buildRecentTransactionParams() {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const p = new URLSearchParams();
  p.set('limit', PAGE_SIZE);
  p.set('offset', currentPage * PAGE_SIZE);
  p.set('date_from', fmt(weekAgo));
  p.set('date_to', fmt(now));
  p.set('show_transfers', '1');
  return p.toString();
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
  openTransactionDetail(id);
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
    $('tx-display-name-rule-hint').textContent = tx.rename_rule
      ? `Future exact matches already rename to "${tx.rename_rule.display_name}".`
      : tx.raw_display_name_is_check_like
        ? 'Check-style text defaults to one-off rename only.'
        : 'Enable this to bind the cleaned-up name to this exact synced source text.';
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
  feedback.className = 'recurring-detail-feedback';
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
    feedback.className = 'recurring-detail-feedback error';
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
  feedback.className = 'recurring-detail-feedback';
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
    feedback.className = 'recurring-detail-feedback error';
    feedback.textContent = err.message || 'Could not save note';
  }
}

async function clearTransactionNote() {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  const feedback = $('tx-detail-feedback');
  feedback.className = 'recurring-detail-feedback';
  feedback.textContent = 'Clearing note…';

  try {
    const data = await api(`api/transactions/${currentDetailId}/note`, { method: 'DELETE' });
    currentDetail = data.transaction;
    renderTransactionDetail();
    closeTransactionNoteEditor();
    feedback.textContent = 'Note cleared.';
  } catch (err) {
    feedback.className = 'recurring-detail-feedback error';
    feedback.textContent = err.message || 'Could not clear note';
  }
}

async function uploadTransactionAttachments() {
  if (!currentDetailId || currentMember?.role !== 'parent') return;
  const input = $('tx-attachment-input');
  if (!input.files || input.files.length === 0) return;

  const feedback = $('tx-detail-feedback');
  feedback.className = 'recurring-detail-feedback';
  feedback.textContent = 'Uploading attachments…';

  const form = new FormData();
  for (const file of input.files) form.append('files', file);

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
    feedback.className = 'recurring-detail-feedback error';
    feedback.textContent = err.message || 'Could not upload attachments';
  }
}

async function deleteTransactionAttachment(id) {
  if (currentMember?.role !== 'parent') return;
  const feedback = $('tx-detail-feedback');
  feedback.className = 'recurring-detail-feedback';
  feedback.textContent = 'Deleting attachment…';

  try {
    await api(`api/transaction-attachments/${id}`, { method: 'DELETE' });
    await refreshCurrentDetail();
    feedback.textContent = 'Attachment deleted.';
  } catch (err) {
    feedback.className = 'recurring-detail-feedback error';
    feedback.textContent = err.message || 'Could not delete attachment';
  }
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
  // Plaid dates are YYYY-MM-DD but node-postgres may return full ISO timestamps
  const str = String(dateStr);
  const d = str.length === 10
    ? new Date(str + 'T00:00:00')
    : new Date(str);
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
