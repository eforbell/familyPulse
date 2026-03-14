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
  netEl.textContent = fmtMoney(data.net_position);
  netEl.classList.remove('loading-pulse');

  document.getElementById('balance-breakdown').innerHTML = `
    <span><span class="label">Cash</span> <span class="value">${fmtMoney(data.liquid_total)}</span></span>
    <span><span class="label">Depository basis</span> <span class="value">${esc(data.depository_balance_label || 'Available')}</span></span>
    <span><span class="label">Credit</span> <span class="value" style="color:var(--red)">${fmtMoney(data.credit_total)}</span></span>
    <span><span class="label">Accounts</span> <span class="value">${data.account_count}</span></span>
  `;

  const grid = document.getElementById('accounts-grid');
  grid.innerHTML = '';

  for (const [owner, accts] of Object.entries(data.groups)) {
    const group = document.createElement('div');
    group.className = 'owner-group';
    group.innerHTML = `<div class="owner-label">${esc(owner)}</div>`;

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
      group.innerHTML += `
        <div class="account-card" style="cursor:pointer" onclick="location.href='transactions.html?account_id=${a.id}'">
          <div class="acct-info">
            <div class="acct-name">
              ${esc(displayName)}
              <button class="acct-rename-btn" onclick="openRename(event, ${a.id}, '${esc(displayName).replace(/'/g, "\\'")}' )" title="Rename">&#9998;</button>
            </div>
            <div class="acct-detail">${esc(a.institution_name || '')} ${a.mask ? '···' + esc(a.mask) : ''} · ${esc(a.subtype || a.type)}</div>
            ${liabilityLine}
          </div>
          <div class="acct-balance-wrap">
            <div class="acct-balance ${(isCredit || isLoan) ? 'credit' : ''}">${fmtMoney(bal)}</div>
            ${showLedgerSecondary ? `<div class="acct-balance-sub">Ledger ${fmtMoney(ledgerBalance)}</div>` : ''}
          </div>
        </div>`;
    }

    grid.appendChild(group);
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
    return `<div class="coverage-card-line">
      <div class="coverage-card-name">${esc(c.name)} ${c.mask ? '<span class="coverage-card-mask">···' + esc(c.mask) + '</span>' : ''}</div>
      <div class="coverage-card-details">
        <span class="coverage-card-amount">${fmtMoney(c.obligation)}</span>
        ${due ? `<span class="coverage-card-due">due ${due}</span>` : ''}
        ${minPay ? `<span class="coverage-card-min">min ${minPay}</span>` : ''}
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
  const parts = [];
  if (acct.last_statement_balance != null) {
    parts.push(`Stmt ${fmtMoney(acct.last_statement_balance)}`);
  }
  if (acct.next_payment_due_date) {
    parts.push(`due ${formatShortDate(acct.next_payment_due_date)}`);
  }
  if (acct.minimum_payment_amount != null) {
    parts.push(`min ${fmtMoney(acct.minimum_payment_amount)}`);
  }
  if (parts.length === 0) return '';
  return `<div class="acct-liability">${parts.join(' · ')}</div>`;
}

function formatShortDate(dateStr) {
  if (!dateStr) return '';
  const str = String(dateStr);
  const d = str.length === 10 ? new Date(str + 'T00:00:00') : new Date(str);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Account rename ───────────────────────────────────────

function openRename(event, accountId, currentName) {
  event.stopPropagation();
  event.preventDefault();
  renameTarget = { id: accountId };
  const input = $('rename-input');
  input.value = currentName || '';
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
  return n < 0 ? `-$${abs}` : `$${abs}`;
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
