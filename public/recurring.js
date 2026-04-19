/* eslint-disable no-unused-vars */
'use strict';

let currentMember = null;
let recurringRows = [];
let currentDetailId = null;

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

  loadRecurring();
});

async function loadRecurring() {
  try {
    const [summary, recurring, calendar] = await Promise.all([
      api('api/recurring/summary'),
      api('api/recurring'),
      api('api/recurring/calendar?days=30')
    ]);

    recurringRows = recurring.recurring || [];
    renderSummary(summary);
    renderCalendar(calendar.calendar || []);
    renderRecurringLists(recurringRows);
    $('recurring-summary').classList.remove('loading-pulse');
  } catch (err) {
    console.error('Recurring load failed:', err);
    $('recurring-list').innerHTML = '<div class="empty-state">Error loading recurring items</div>';
    $('recurring-stale').innerHTML = '';
    $('bill-calendar').innerHTML = '<div class="empty-state">Error loading bill calendar</div>';
  }
}

function renderSummary(data) {
  $('recurring-committed').textContent = fmtMoney(data.committed_monthly_total);
  $('recurring-income').textContent = fmtMoney(data.recurring_income_monthly_total);
  $('recurring-active').textContent = String(data.active_count || 0);
  $('commitment-strip').classList.remove('hidden');
  $('commitment-strip').innerHTML = `
    <div class="commitment-pill">
      <span class="commitment-pill-label">Price Increases</span>
      <strong>${data.price_increase_count || 0}</strong>
    </div>
    <div class="commitment-pill">
      <span class="commitment-pill-label">Stale</span>
      <strong>${data.stale_count || 0}</strong>
    </div>
  `;
}

function renderCalendar(items) {
  const root = $('bill-calendar');
  if (!items.length) {
    root.innerHTML = '<div class="empty-state">No upcoming recurring charges in the next 30 days</div>';
    return;
  }

  let runningTotal = 0;
  root.innerHTML = items.map(item => {
    runningTotal += Number(item.expected_amount) || 0;
    return `
      <div class="calendar-row">
        <div class="calendar-date">${formatDate(item.expected_date)}</div>
        <div class="calendar-main">
          <div class="calendar-merchant">${esc(item.merchant_name)}</div>
          <div class="calendar-meta">${esc(item.frequency)} · ${esc(item.account_name || 'Account')}</div>
        </div>
        <div class="calendar-side">
          <div class="calendar-amount">${fmtMoney(item.expected_amount)}</div>
          <div class="calendar-running">Running ${fmtMoney(runningTotal)}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderRecurringLists(rows) {
  const active = rows.filter(row => row.status === 'active');
  const income = active
    .filter(row => row.cashflow_type === 'income')
    .sort((a, b) => (b.latest_amount || 0) - (a.latest_amount || 0));
  const expenses = active
    .filter(row => row.cashflow_type !== 'income')
    .sort((a, b) => (b.latest_amount || 0) - (a.latest_amount || 0));
  const stale = rows
    .filter(row => row.status !== 'active' && row.status !== 'ignored')
    .sort((a, b) => String(b.last_seen_date).localeCompare(String(a.last_seen_date)));

  $('recurring-income-list').innerHTML = income.length
    ? income.map(renderRecurringCard).join('')
    : '<div class="empty-state">No recurring income detected yet</div>';

  $('recurring-list').innerHTML = expenses.length
    ? expenses.map(renderRecurringCard).join('')
    : '<div class="empty-state">No active recurring expenses detected yet</div>';

  $('recurring-stale').innerHTML = stale.length
    ? stale.map(renderRecurringCard).join('')
    : '<div class="empty-state">No paused recurring items</div>';
}

function renderRecurringCard(row) {
  const detailAction = currentMember?.role === 'parent'
    ? `<button class="btn-ghost recurring-card-action" type="button" onclick="openRecurringDetail(${row.id})">View Details</button>`
    : '';
  const change = row.price_change_direction === 'up' && row.price_change_pct != null
    ? `<span class="recurring-badge recurring-badge-alert">Up ${Math.round(row.price_change_pct)}%</span>`
    : '';
  const type = row.cashflow_type === 'income'
    ? '<span class="recurring-badge recurring-badge-income">Income</span>'
    : '<span class="recurring-badge">Expense</span>';
  const status = row.status !== 'active'
    ? `<span class="recurring-badge recurring-badge-muted">${esc(row.status)}</span>`
    : `<span class="recurring-badge recurring-badge-confidence">${esc(row.confidence)}</span>`;

  return `
    <div class="recurring-card">
      <div class="recurring-card-main">
        <div class="recurring-card-top">
          <div>
            <div class="recurring-merchant">${esc(row.merchant_name)}</div>
            <div class="recurring-meta">${esc(row.frequency)} · next ${formatDate(row.expected_next_date)} · last ${formatDate(row.last_seen_date)}</div>
          </div>
          <div class="recurring-amount ${row.cashflow_type === 'income' ? 'credit' : ''}">${fmtMoney(row.latest_amount)}</div>
        </div>
        <div class="recurring-card-bottom">
          <div class="recurring-badges">
            ${type}
            ${status}
            ${change}
          </div>
          <div class="recurring-account">${esc(row.account_name || 'Account')}</div>
        </div>
        ${detailAction}
      </div>
    </div>
  `;
}

async function openRecurringDetail(recurringId) {
  if (currentMember?.role !== 'parent') return;
  const row = recurringRows.find(item => item.id === recurringId);
  if (!row) return;

  currentDetailId = recurringId;
  $('recurring-detail-title').textContent = row.merchant_name || 'Recurring Detail';
  $('recurring-detail-meta').textContent = [
    row.cashflow_type === 'income' ? 'Income' : 'Expense',
    row.frequency,
    `Next ${formatDate(row.expected_next_date)}`,
    `Last ${formatDate(row.last_seen_date)}`,
    row.account_name || 'Account'
  ].filter(Boolean).join(' · ');
  $('recurring-detail-feedback').className = 'recurring-detail-feedback hidden';
  renderStatusButtons(row);
  $('recurring-detail-history').innerHTML = '<div class="empty-state loading-pulse">Loading history…</div>';
  $('recurring-detail-overlay').classList.remove('hidden');

  try {
    const data = await api(`api/recurring/${recurringId}/history`);
    renderRecurringHistory(data.history || [], row);
  } catch (err) {
    console.error('Recurring detail load failed:', err);
    $('recurring-detail-history').innerHTML = '<div class="empty-state">Error loading amount history</div>';
  }
}

function closeRecurringDetail() {
  currentDetailId = null;
  $('recurring-detail-overlay').classList.add('hidden');
}

function renderStatusButtons(row) {
  const root = $('recurring-detail-status-group');
  if (currentMember?.role !== 'parent') {
    root.classList.add('hidden');
    root.innerHTML = '';
    return;
  }

  const statuses = ['active', 'paused', 'ignored'];
  root.classList.remove('hidden');
  root.innerHTML = statuses.map(status => `
    <button
      type="button"
      class="btn-ghost recurring-status-btn${row.status === status ? ' is-active' : ''}"
      data-status="${status}"
      onclick="updateRecurringStatus(${row.id}, '${status}')"
      ${row.status === status ? 'disabled' : ''}
    >${status[0].toUpperCase()}${status.slice(1)}</button>
  `).join('');
}

function renderRecurringHistory(history, row) {
  const root = $('recurring-detail-history');
  if (!history.length) {
    root.innerHTML = '<div class="empty-state">No amount history recorded yet</div>';
    return;
  }

  root.innerHTML = history.map(entry => `
    <div class="detail-txn-row">
      <div class="detail-txn-info">
        <span class="detail-txn-merchant">${esc(row.merchant_name || 'Recurring Item')}</span>
        <span class="detail-txn-date">${formatDate(entry.transaction_date)} · ${esc(row.frequency || 'schedule')}</span>
      </div>
      <span class="detail-txn-amount">${fmtMoney(entry.amount)}</span>
    </div>
  `).join('');
}

async function updateRecurringStatus(recurringId, status) {
  if (currentMember?.role !== 'parent') return;
  const feedback = $('recurring-detail-feedback');
  feedback.className = 'recurring-detail-feedback';
  feedback.textContent = 'Saving status…';

  try {
    const res = await api(`api/recurring/${recurringId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    feedback.textContent = `Status updated to ${status}.`;

    recurringRows = recurringRows.map(row => row.id === recurringId ? res.recurring : row);
    renderRecurringLists(recurringRows);
    await refreshRecurringSummary();

    const updatedRow = recurringRows.find(row => row.id === recurringId);
    if (updatedRow && currentDetailId === recurringId) {
      renderStatusButtons(updatedRow);
      $('recurring-detail-meta').textContent = [
        updatedRow.cashflow_type === 'income' ? 'Income' : 'Expense',
        updatedRow.frequency,
        `Next ${formatDate(updatedRow.expected_next_date)}`,
        `Last ${formatDate(updatedRow.last_seen_date)}`,
        updatedRow.account_name || 'Account'
      ].filter(Boolean).join(' · ');
    }
  } catch (err) {
    console.error('Recurring status update failed:', err);
    feedback.className = 'recurring-detail-feedback error';
    feedback.textContent = err.message || 'Could not update status';
  }
}

async function refreshRecurringSummary() {
  try {
    const [summary, calendar] = await Promise.all([
      api('api/recurring/summary'),
      api('api/recurring/calendar?days=30')
    ]);
    renderSummary(summary);
    renderCalendar(calendar.calendar || []);
  } catch (err) {
    console.error('Recurring summary refresh failed:', err);
  }
}

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
  if (!dateStr) return 'TBD';
  const str = String(dateStr);
  const d = str.length === 10 ? new Date(str + 'T00:00:00') : new Date(str);
  if (isNaN(d)) return 'TBD';
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

document.addEventListener('click', event => {
  const overlay = $('recurring-detail-overlay');
  if (!overlay || overlay.classList.contains('hidden')) return;
  if (event.target === overlay) closeRecurringDetail();
});
