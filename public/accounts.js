/* accounts.js — Accounts page: net position + account grid */
'use strict';

let currentMember = JSON.parse(localStorage.getItem('fp_member') || 'null');
let membersCache = [];

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  updateWhoBtn();
  await loadAccounts();
  if (!currentMember) setTimeout(openMemberPicker, 400);
});

// ── Data ─────────────────────────────────────────────────────

async function loadAccounts() {
  try {
    const params = currentMember ? `?member=${encodeURIComponent(currentMember.name)}` : '';
    const data = await api(`api/accounts/dashboard${params}`);
    renderDashboard(data);
  } catch (err) {
    document.getElementById('net-amount').textContent = 'Error loading';
    document.getElementById('net-amount').classList.remove('loading-pulse');
    console.error('Accounts load failed:', err);
  }
}

// ── Render ───────────────────────────────────────────────────

function renderDashboard(data) {
  const netEl = document.getElementById('net-amount');
  netEl.textContent = fmtMoney(data.net_position);
  netEl.classList.remove('loading-pulse');

  document.getElementById('balance-breakdown').innerHTML = `
    <span><span class="label">Liquid</span> <span class="value">${fmtMoney(data.liquid_total)}</span></span>
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

// ── Member picker ────────────────────────────────────────────

async function openMemberPicker() {
  try {
    membersCache = await api('api/family-members');
    const list = document.getElementById('member-list');
    list.innerHTML = membersCache.map(m => `
      <button class="member-btn" onclick="selectMember(${m.id})">
        <span class="emoji">${m.avatar_emoji || '👤'}</span>
        <span>${esc(m.name)}</span>
      </button>
    `).join('');
    document.getElementById('member-overlay').classList.remove('hidden');
  } catch (err) {
    console.error('Failed to load members:', err);
  }
}

function selectMember(id) {
  currentMember = membersCache.find(m => m.id === id);
  localStorage.setItem('fp_member', JSON.stringify(currentMember));
  updateWhoBtn();
  document.getElementById('member-overlay').classList.add('hidden');
  loadAccounts();
}

function updateWhoBtn() {
  document.getElementById('who-btn').textContent = currentMember ? (currentMember.avatar_emoji || '👤') : '👤';
}

// ── Helpers ──────────────────────────────────────────────────

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
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
