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
  await Promise.all([loadAccounts(), loadCoverage()]);
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
