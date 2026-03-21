/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let items = [];
let familyMembers = [];
let ownerTarget = null; // item id being assigned
let currentMember = null;
let deleteMode = 'disconnect';
let accountSelectionTarget = null;

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Get current member from session
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) {
      currentMember = await res.json();
    } else if (res.status === 401) {
      const membersRes = await fetch('api/auth/members');
      if (membersRes.ok) {
        const members = await membersRes.json();
        if (members.some(m => m.has_passphrase)) {
          window.location.replace('login.html');
          return;
        }
      }
    }
  } catch {}

  await Promise.all([loadItems(), loadMembers(), loadDedupHistory()]);
  loadBalancePolicy();
  loadThemeControls();
  loadAIPrompts();
  loadPassphraseManager();
  loadKidBudgets();
});

// ── Data fetching ────────────────────────────────────────────

async function loadItems() {
  try {
    items = await api('api/items');
    renderItems();
  } catch (err) {
    document.getElementById('items-list').innerHTML =
      '<div class="empty-state">Error loading institutions</div>';
    console.error('Items load failed:', err);
  }
}

async function loadMembers() {
  try {
    familyMembers = await api('api/family-members');
  } catch (err) {
    console.error('Members load failed:', err);
  }
}

async function loadDedupHistory() {
  const section = document.getElementById('dedup-history-section');
  const list = document.getElementById('dedup-history-list');
  if (!section || !list) return;

  if (currentMember && currentMember.role !== 'parent') {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  try {
    const runs = await api('api/transactions/dedup/runs?limit=20');
    if (!Array.isArray(runs) || runs.length === 0) {
      list.innerHTML = '<div class="empty-state">No duplicate cleanup runs yet.</div>';
      return;
    }

    list.innerHTML = runs.map(r => `
      <div class="admin-row">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
            <strong>Run #${r.id}</strong>
            <span class="status-good">${esc(r.strategy || 'prefer_plaid')}</span>
          </div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.25rem">
            ${fmtDateTime(r.created_at)} · by ${esc(r.created_by || 'system')}
          </div>
        </div>
        <div style="text-align:right;font-size:0.8rem;color:var(--muted)">
          <div><span class="label">Suppressed</span> <strong>${r.txns_hidden}</strong></div>
          <div><span class="label">Category copied</span> <strong>${r.category_copied}</strong></div>
          <div><span class="label">Ambiguous skipped</span> <strong>${r.ambiguous_count}</strong></div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty-state">Error loading history: ${esc(err.message)}</div>`;
  }
}

function loadThemeControls() {
  const el = document.getElementById('theme-switch');
  if (!el || !window.PulseTheme) return;

  const preference = window.PulseTheme.getPreference();
  const options = [
    { id: 'system', label: 'System', icon: 'Auto' },
    { id: 'light', label: 'Light', icon: 'Sun' },
    { id: 'dark', label: 'Dark', icon: 'Night' }
  ];

  el.innerHTML = options.map(option => `
    <button
      type="button"
      class="theme-option${preference === option.id ? ' active' : ''}"
      data-theme-pref="${option.id}"
      onclick="setThemePreference('${option.id}')"
    >
      <span>${esc(option.icon)}</span>
      <span>${esc(option.label)}</span>
    </button>
  `).join('');
}

async function loadBalancePolicy() {
  const section = document.getElementById('balance-policy-section');
  if (!section) return;
  if (!currentMember || currentMember.role !== 'parent') {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  try {
    const data = await api('api/settings/balance-basis');
    const select = document.getElementById('balance-basis-select');
    select.value = data.balance_basis || 'available_preferred';
    renderBalancePolicyCopy(select.value);
  } catch (err) {
    console.error('Balance policy load failed:', err);
  }
}

function renderBalancePolicyCopy(balanceBasis) {
  const copy = document.getElementById('balance-policy-copy');
  if (!copy) return;

  copy.textContent = balanceBasis === 'current_only'
    ? 'Pulse will show depository balances using ledger/current balance everywhere. Investment accounts continue using ledger balance.'
    : 'Pulse will prefer a bank-provided available balance for depository accounts when present, then fall back to ledger/current balance. Investment accounts continue using ledger balance.';
}

async function saveBalancePolicy() {
  const select = document.getElementById('balance-basis-select');
  if (!select) return;

  try {
    await api('api/settings/balance-basis', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance_basis: select.value })
    });
    renderBalancePolicyCopy(select.value);
    select.style.borderColor = 'var(--green)';
    setTimeout(() => { select.style.borderColor = ''; }, 1500);
  } catch (err) {
    alert('Failed to save balance basis: ' + err.message);
  }
}

function setThemePreference(preference) {
  if (!window.PulseTheme) return;
  window.PulseTheme.setPreference(preference);
  loadThemeControls();
}

// ── Render ───────────────────────────────────────────────────

function renderItems() {
  const el = document.getElementById('items-list');
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-state">No linked institutions yet. Tap "+ Link Bank Account" to connect your first bank.</div>';
    return;
  }

  el.innerHTML = items.map(item => {
    const normalizedStatus = item.status === 'error' ? 'sync_error' : item.status;
    const statusBadge = normalizedStatus === 'good'
      ? '<span class="status-good">Connected</span>'
      : normalizedStatus === 'disconnected'
        ? '<span class="status-error">Disconnected</span>'
      : normalizedStatus === 'needs_reauth'
        ? `<span class="status-error">Needs reauth${item.error_code ? `: ${esc(item.error_code)}` : ''}</span>`
        : `<span class="status-error">Sync issue${item.error_code ? `: ${esc(item.error_code)}` : ''}</span>`;

    const syncText = item.last_sync_at
      ? `Last synced ${timeAgo(item.last_sync_at)}`
      : 'Never synced';
    const accountSelection = item.account_selection || { mode: 'unavailable', label: null, help: null, removal_requires_bank: false };
    const accountSummary = item.historical_account_count > 0
      ? `${item.account_count} active · ${item.historical_account_count} historical`
      : `${item.account_count} account${item.account_count !== 1 ? 's' : ''}`;

    return `
      <div class="admin-row settings-item-card" data-item-id="${item.id}">
        <div class="settings-item-main">
          <div class="settings-item-title-row">
            <strong class="settings-item-title">${esc(item.institution_name)}</strong>
            ${statusBadge}
          </div>
          <div class="settings-item-meta">
            ${accountSummary}${item.owner ? ` · ${esc(item.owner)}` : ''} · ${syncText}
          </div>
        </div>
        <div class="settings-item-actions">
          ${normalizedStatus === 'needs_reauth' ? `<button class="btn-primary" onclick="fixItem(${item.id})" title="Re-link">Fix</button>` : ''}
          ${normalizedStatus !== 'disconnected' && item.liability_access_status === 'missing' ? `<button class="btn-ghost" onclick="enableLiabilities(${item.id})" title="Enable liabilities">Enable liabilities</button>` : ''}
          ${accountSelection.mode === 'editable' ? `<button class="btn-ghost" onclick="editSyncedAccounts(${item.id})" title="${esc(accountSelection.help || 'Edit synced accounts')}">${esc(accountSelection.label || 'Edit synced accounts')}</button>` : ''}
          <button class="btn-ghost" onclick="openAccountSelectionOverlay(${item.id})" title="View synced accounts">Accounts</button>
          ${normalizedStatus === 'disconnected' ? `<button class="btn-danger" onclick="openDeleteOverlay(${item.id}, '${esc(item.institution_name)}', 'purge')" title="Delete local history">Purge</button>` : ''}
          <button class="btn-ghost" onclick="openOwnerOverlay(${item.id})" title="Assign owner">Owner</button>
          ${normalizedStatus !== 'disconnected' ? `<button class="btn-ghost" onclick="syncItem(${item.id})" title="Sync now">Sync</button>` : ''}
          ${normalizedStatus !== 'disconnected' ? `<button class="btn-danger" onclick="openDeleteOverlay(${item.id}, '${esc(item.institution_name)}', 'disconnect')" title="Disconnect">Disconnect</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ── Plaid Link ───────────────────────────────────────────────

async function startLink() {
  await startLinkFlow({
    buttonId: 'link-btn',
    label: '+ Link Institution',
    loadingLabel: 'Loading...',
    connectingLabel: 'Connecting...',
    route: 'api/link/create-token',
    failurePrefix: 'Failed to link institution'
  });
}

async function startLinkFlow(config) {
  const btn = document.getElementById(config.buttonId);
  btn.disabled = true;
  btn.textContent = config.loadingLabel;

  try {
    const data = await api(config.route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: currentMember?.name })
    });

    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async (publicToken, metadata) => {
        btn.textContent = config.connectingLabel;
        try {
          await api('api/link/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              public_token: publicToken,
              link_session_id: data.link_session_id
            })
          });
          await loadItems();
        } catch (err) {
          alert(`${config.failurePrefix}: ` + err.message);
        }
        btn.disabled = false;
        btn.textContent = config.label;
      },
      onExit: (err) => {
        if (err) console.warn('Plaid Link exit with error:', err);
        btn.disabled = false;
        btn.textContent = config.label;
      }
    });
    handler.open();
  } catch (err) {
    alert(`${config.failurePrefix}: ` + err.message);
    btn.disabled = false;
    btn.textContent = config.label;
  }
}

async function fixItem(itemId) {
  await startItemUpdateFlow({
    itemId,
    route: 'api/link/update-token',
    startError: 'Failed to start re-link',
    completeError: 'Failed to complete re-link'
  });
}

async function enableLiabilities(itemId) {
  await startItemUpdateFlow({
    itemId,
    route: 'api/link/create-liability-upgrade-token',
    startError: 'Failed to start liability upgrade',
    completeError: 'Failed to enable liabilities',
    completionRoute: 'api/link/complete-liability-upgrade'
  });
}

async function editSyncedAccounts(itemId) {
  await startItemUpdateFlow({
    itemId,
    route: 'api/link/create-account-selection-token',
    startError: 'Failed to start account selection update',
    completeError: 'Failed to refresh synced accounts',
    completionRoute: 'api/link/complete-account-selection'
  });
}

async function openAccountSelectionOverlay(itemId) {
  accountSelectionTarget = itemId;
  const title = document.getElementById('account-selection-title');
  const msg = document.getElementById('account-selection-msg');
  const summary = document.getElementById('account-selection-summary');
  const list = document.getElementById('account-selection-list');

  const item = items.find((candidate) => candidate.id === itemId);
  title.textContent = item ? `${item.institution_name} Accounts` : 'Institution Accounts';
  msg.textContent = 'Active accounts continue syncing. Historical accounts are preserved in Family Pulse but no longer updated from Plaid.';
  summary.textContent = 'Loading account state...';
  list.innerHTML = '<div class="empty-state loading-pulse">Loading...</div>';
  document.getElementById('account-selection-overlay').classList.remove('hidden');

  try {
    const data = await api(`api/items/${itemId}/accounts`);
    const active = data.accounts.filter((account) => account.sync_status === 'active');
    const historical = data.accounts.filter((account) => account.sync_status === 'historical');
    const help = data.item?.account_selection?.help;

    summary.textContent = `${active.length} active · ${historical.length} historical${help ? ` · ${help}` : ''}`;
    list.innerHTML = data.accounts.length === 0
      ? '<div class="empty-state">No accounts found for this institution.</div>'
      : data.accounts.map((account) => {
          const badge = account.sync_status === 'historical'
            ? '<span class="status-error">Historical</span>'
            : '<span class="status-good">Active</span>';
          const meta = [
            account.subtype || account.type,
            account.mask ? `••${esc(account.mask)}` : null,
            account.owner ? esc(account.owner) : null,
            account.sync_disabled_at ? `sync stopped ${timeAgo(account.sync_disabled_at)}` : null
          ].filter(Boolean).join(' · ');

          return `
            <div class="admin-row">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
                  <strong>${esc(account.official_name || account.name)}</strong>
                  ${badge}
                </div>
                <div style="font-size:0.8rem;color:var(--muted);margin-top:0.25rem">${meta}</div>
              </div>
            </div>
          `;
        }).join('');
  } catch (err) {
    summary.textContent = '';
    list.innerHTML = `<div class="empty-state">Failed to load account state: ${esc(err.message)}</div>`;
  }
}

function closeAccountSelectionOverlay() {
  document.getElementById('account-selection-overlay').classList.add('hidden');
  accountSelectionTarget = null;
}

async function startItemUpdateFlow(config) {
  try {
    const data = await api(config.route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: config.itemId })
    });

    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async (publicToken) => {
        try {
          if (publicToken) {
            await api('api/link/exchange', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                public_token: publicToken,
                link_session_id: data.link_session_id
              })
            });
          } else if (config.completionRoute) {
            await api(config.completionRoute, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                link_session_id: data.link_session_id
              })
            });
          }
          await loadItems();
        } catch (err) {
          alert(`${config.completeError}: ` + err.message);
        }
      },
      onExit: (err) => {
        if (err) console.warn('Plaid Link update exit with error:', err);
      }
    });
    handler.open();
  } catch (err) {
    alert(`${config.startError}: ` + err.message);
  }
}

// ── Owner assignment ─────────────────────────────────────────

function openOwnerOverlay(itemId) {
  ownerTarget = itemId;
  const grid = document.getElementById('owner-member-list');
  grid.innerHTML = familyMembers.map(m => `
    <button class="member-btn" onclick="assignOwner('${esc(m.name)}')">
      <span class="member-emoji">${m.emoji || '👤'}</span>
      <span>${esc(m.name)}</span>
    </button>
  `).join('');
  document.getElementById('owner-overlay').classList.remove('hidden');
}

function closeOwnerOverlay() {
  document.getElementById('owner-overlay').classList.add('hidden');
  ownerTarget = null;
}

async function assignOwner(name) {
  if (!ownerTarget) return;
  try {
    await api(`api/items/${ownerTarget}/owner`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: name })
    });
    closeOwnerOverlay();
    await loadItems();
  } catch (err) {
    alert('Failed to assign owner: ' + err.message);
  }
}

// ── Delete ───────────────────────────────────────────────────

let deleteTarget = null;

function openDeleteOverlay(itemId, name, mode) {
  deleteTarget = itemId;
  deleteMode = mode || 'disconnect';
  const title = document.getElementById('delete-title');
  const msg = document.getElementById('delete-msg');
  const confirmBtn = document.getElementById('delete-confirm-btn');

  if (deleteMode === 'purge') {
    title.textContent = 'Purge Local History';
    msg.textContent = `Permanently delete ${name} and all its local accounts and transactions? This cannot be undone.`;
    confirmBtn.textContent = 'Purge';
  } else {
    title.textContent = 'Disconnect Institution';
    msg.textContent = `Disconnect ${name} from Plaid? Future syncs will stop and local history will be preserved.`;
    confirmBtn.textContent = 'Disconnect';
  }
  document.getElementById('delete-overlay').classList.remove('hidden');
}

function closeDeleteOverlay() {
  document.getElementById('delete-overlay').classList.add('hidden');
  deleteTarget = null;
  deleteMode = 'disconnect';
}

async function confirmDelete() {
  if (!deleteTarget) return;
  try {
    const path = deleteMode === 'purge'
      ? `api/items/${deleteTarget}/purge`
      : `api/items/${deleteTarget}`;
    await api(path, { method: 'DELETE' });
    closeDeleteOverlay();
    await loadItems();
  } catch (err) {
    alert(`Failed to ${deleteMode === 'purge' ? 'purge local history' : 'disconnect institution'}: ` + err.message);
  }
}

// ── Sync ─────────────────────────────────────────────────────

async function syncItem(itemId) {
  const el = document.getElementById('sync-result');
  el.textContent = 'Syncing...';
  try {
    const data = await api(`api/items/${itemId}/sync`, { method: 'POST' });
    el.textContent = `Synced: ${data.synced || 0} item(s), ${data.transactions_added || 0} new transactions`;
    await loadItems();
  } catch (err) {
    el.textContent = 'Sync failed: ' + err.message;
  }
}

async function triggerFullSync() {
  const el = document.getElementById('sync-result');
  el.textContent = 'Syncing all...';
  try {
    const data = await api('api/sync', { method: 'POST' });
    el.textContent = `Synced: ${data.synced || 0} item(s), ${data.transactions_added || 0} new transactions`;
    await loadItems();
  } catch (err) {
    el.textContent = 'Sync failed: ' + err.message;
  }
}

// ── Passphrase management (parents only) ────────────────────

async function loadPassphraseManager() {
  const section = document.getElementById('passphrase-section');
  if (!section) return;

  // Show if: no auth enabled yet (so Eric can set first passphrase), or current user is parent
  const isBootstrap = currentMember == null;
  if (!isBootstrap && currentMember.role !== 'parent') {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  try {
    const members = await api('api/auth/members');
    const container = document.getElementById('passphrase-list');

    // In bootstrap mode, show bootstrap secret input
    const bootstrapHtml = isBootstrap ? `
      <div class="admin-row" style="background:var(--surface-hover);margin-bottom:0.5rem">
        <div style="flex:1;min-width:0">
          <strong>Bootstrap Secret</strong>
          <div style="font-size:0.8rem;color:var(--muted)">Required for initial setup (from BOOTSTRAP_SECRET env var)</div>
        </div>
        <div style="flex-shrink:0">
          <input type="password" id="bootstrap-secret-input" placeholder="Bootstrap secret" class="login-input" style="width:180px;padding:0.4rem 0.5rem;font-size:0.8rem">
        </div>
      </div>
    ` : '';

    container.innerHTML = bootstrapHtml + members.map(m => `
      <div class="admin-row" data-member-id="${m.id}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem">
            <span>${m.avatar_emoji || '\u{1F464}'}</span>
            <strong>${esc(m.name)}</strong>
            <span class="role-badge">${esc(m.role)}</span>
            ${m.has_passphrase ? '<span class="status-good">Set</span>' : '<span class="status-error">Not set</span>'}
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;align-items:center;flex-shrink:0">
          <input type="password" id="pass-${m.id}" placeholder="New passphrase" class="login-input" style="width:150px;padding:0.4rem 0.5rem;font-size:0.8rem">
          <button class="btn-primary" onclick="setPassphrase(${m.id})" style="padding:0.4rem 0.75rem;font-size:0.8rem">Set</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Passphrase manager load failed:', err);
  }
}

async function setPassphrase(memberId) {
  const input = document.getElementById('pass-' + memberId);
  const passphrase = input.value.trim();
  if (!passphrase) { alert('Enter a passphrase'); return; }
  if (passphrase.length < 4) { alert('Passphrase must be at least 4 characters'); return; }

  const body = { member_id: memberId, passphrase };
  const headers = { 'Content-Type': 'application/json' };

  // In bootstrap mode, include the bootstrap secret
  const bootstrapInput = document.getElementById('bootstrap-secret-input');
  if (bootstrapInput) {
    const secret = bootstrapInput.value.trim();
    if (!secret) { alert('Enter the bootstrap secret'); return; }
    headers['X-Bootstrap-Secret'] = secret;
  }

  try {
    await api('api/auth/passphrase', {
      method: 'PUT',
      headers,
      body: JSON.stringify(body)
    });
    input.value = '';
    input.style.borderColor = 'var(--green)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
    await loadPassphraseManager();
  } catch (err) {
    alert('Failed to set passphrase: ' + err.message);
  }
}

// ── Helpers ──────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function fmtDateTime(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Unknown time';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
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

// ── Kid Budgets ─────────────────────────────────────────────

async function loadKidBudgets() {
  const section = document.getElementById('kid-budgets-section');
  if (!section) return;
  if (!currentMember || currentMember.role !== 'parent') {
    section.classList.add('hidden');
    return;
  }

  const kids = familyMembers.filter(m => m.role === 'kid');
  if (kids.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  const list = document.getElementById('kid-budgets-list');
  list.innerHTML = kids.map(m => `
    <div class="admin-row" data-member-id="${m.id}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:0.5rem">
          <span>${m.avatar_emoji || '\u{1F464}'}</span>
          <strong>${esc(m.name)}</strong>
        </div>
      </div>
      <div style="display:flex;gap:0.4rem;align-items:center;flex-shrink:0">
        <span style="font-size:0.85rem;color:var(--muted)">$</span>
        <input type="number" id="kid-budget-${m.id}" placeholder="No budget"
               value="${m.monthly_budget != null ? m.monthly_budget : ''}"
               min="0" step="1" class="login-input"
               style="width:100px;padding:0.4rem 0.5rem;font-size:0.85rem">
        <button class="btn-primary" onclick="saveKidBudget(${m.id})" style="padding:0.4rem 0.75rem;font-size:0.8rem">Save</button>
      </div>
    </div>
  `).join('');
}

async function saveKidBudget(memberId) {
  const input = document.getElementById('kid-budget-' + memberId);
  const value = input.value.trim();
  const amount = value === '' ? null : parseFloat(value);

  try {
    await api('api/kids/budget', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_id: memberId, amount })
    });
    input.style.borderColor = 'var(--green)';
    setTimeout(() => { input.style.borderColor = ''; }, 1500);
  } catch (err) {
    alert('Failed to save budget: ' + err.message);
  }
}

// ── AI Prompts ──────────────────────────────────────────────

const PROMPT_LABELS = {
  magic_prompt_weekly_digest: 'Weekly Digest Prompt',
  magic_prompt_monthly_close: 'Monthly Close Prompt',
  magic_prompt_on_demand: 'On-Demand Analysis Prompt',
  magic_prompt_what_if: 'What-If Forecasting Prompt',
  magic_rate_limit_daily: 'Daily Query Limit',
  magic_disclaimer: 'AI Disclaimer Text'
};

const DEFAULT_PROMPTS = {};

async function loadAIPrompts() {
  if (!currentMember || currentMember.role !== 'parent') {
    document.getElementById('ai-prompts-section').classList.add('hidden');
    return;
  }

  try {
    const data = await api('api/magic/config');
    document.getElementById('ai-prompts-section').classList.remove('hidden');

    // Usage stats
    document.getElementById('usage-stats').innerHTML = `
      <span><span class="label">Queries today</span> <span class="value">${data.usage.queries_today} / ${data.usage.daily_limit}</span></span>
      <span><span class="label">Tokens this month</span> <span class="value">${data.usage.tokens_this_month.toLocaleString()}</span></span>
    `;

    // Build editors
    const container = document.getElementById('prompt-editors');
    container.innerHTML = data.config
      .filter(c => PROMPT_LABELS[c.key])
      .map(c => {
        DEFAULT_PROMPTS[c.key] = c.value;
        const isTextarea = c.key.startsWith('magic_prompt_');
        const inputEl = isTextarea
          ? `<textarea class="prompt-textarea" id="prompt-${c.key}">${esc(c.value)}</textarea>`
          : `<input type="text" class="magic-input" id="prompt-${c.key}" value="${esc(c.value)}" style="width:100%">`;

        return `
          <div class="prompt-group">
            <div class="prompt-header" onclick="togglePrompt('${c.key}')">
              <span class="prompt-label">${PROMPT_LABELS[c.key]}</span>
              <span class="prompt-toggle" id="toggle-${c.key}">+</span>
            </div>
            <div class="prompt-body hidden" id="body-${c.key}">
              ${inputEl}
              <div class="prompt-actions">
                <button class="btn-primary" onclick="savePrompt('${c.key}')">Save</button>
                <button class="btn-ghost" onclick="resetPrompt('${c.key}')">Reset to Default</button>
              </div>
            </div>
          </div>`;
      }).join('');
  } catch (err) {
    console.error('AI prompts load failed:', err);
  }
}

function togglePrompt(key) {
  const body = document.getElementById('body-' + key);
  const toggle = document.getElementById('toggle-' + key);
  const hidden = body.classList.toggle('hidden');
  toggle.textContent = hidden ? '+' : '\u2212';
}

async function savePrompt(key) {
  const el = document.getElementById('prompt-' + key);
  const value = el.value;

  try {
    await api(`api/magic/config/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    DEFAULT_PROMPTS[key] = value;
    el.style.borderColor = 'var(--green)';
    setTimeout(() => { el.style.borderColor = ''; }, 1500);
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function resetPrompt(key) {
  // Re-seed the default by reading seed.sql defaults
  // For simplicity, we reload from the server after resetting
  // For now, reload the current default from our stored copy.
  const el = document.getElementById('prompt-' + key);
  if (DEFAULT_PROMPTS[key] !== undefined) {
    el.value = DEFAULT_PROMPTS[key];
  }
}
