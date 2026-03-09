/* eslint-disable no-unused-vars */
'use strict';

// ── State ────────────────────────────────────────────────────

let items = [];
let familyMembers = [];
let ownerTarget = null; // item id being assigned

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadItems(), loadMembers()]);
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

// ── Render ───────────────────────────────────────────────────

function renderItems() {
  const el = document.getElementById('items-list');
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-state">No linked institutions yet. Tap "+ Link Account" to connect your first bank.</div>';
    return;
  }

  el.innerHTML = items.map(item => {
    const statusBadge = item.status === 'good'
      ? '<span class="status-good">Connected</span>'
      : `<span class="status-error">${esc(item.error_code || 'Error')}</span>`;

    const syncText = item.last_sync_at
      ? `Last synced ${timeAgo(item.last_sync_at)}`
      : 'Never synced';

    return `
      <div class="admin-row" data-item-id="${item.id}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
            <strong>${esc(item.institution_name)}</strong>
            ${statusBadge}
          </div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:0.25rem">
            ${item.account_count} account${item.account_count !== 1 ? 's' : ''} · ${syncText}
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;flex-shrink:0">
          ${item.status !== 'good' ? `<button class="btn-primary" onclick="fixItem(${item.id})" title="Re-link">Fix</button>` : ''}
          <button class="btn-ghost" onclick="openOwnerOverlay(${item.id})" title="Assign owner">Owner</button>
          <button class="btn-ghost" onclick="syncItem(${item.id})" title="Sync now">Sync</button>
          <button class="btn-danger" onclick="openDeleteOverlay(${item.id}, '${esc(item.institution_name)}')" title="Remove">Remove</button>
        </div>
      </div>`;
  }).join('');
}

// ── Plaid Link ───────────────────────────────────────────────

async function startLink() {
  const btn = document.getElementById('link-btn');
  btn.disabled = true;
  btn.textContent = 'Loading...';

  try {
    const data = await api('api/link/create-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async (publicToken, metadata) => {
        btn.textContent = 'Connecting...';
        try {
          await api('api/link/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ public_token: publicToken })
          });
          await loadItems();
        } catch (err) {
          alert('Failed to link account: ' + err.message);
        }
        btn.disabled = false;
        btn.textContent = '+ Link Account';
      },
      onExit: (err) => {
        if (err) console.warn('Plaid Link exit with error:', err);
        btn.disabled = false;
        btn.textContent = '+ Link Account';
      }
    });
    handler.open();
  } catch (err) {
    alert('Failed to start Link: ' + err.message);
    btn.disabled = false;
    btn.textContent = '+ Link Account';
  }
}

async function fixItem(itemId) {
  try {
    const data = await api('api/link/update-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: itemId })
    });

    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async () => {
        await loadItems();
      },
      onExit: (err) => {
        if (err) console.warn('Plaid Link update exit with error:', err);
      }
    });
    handler.open();
  } catch (err) {
    alert('Failed to start re-link: ' + err.message);
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
  } catch (err) {
    alert('Failed to assign owner: ' + err.message);
  }
}

// ── Delete ───────────────────────────────────────────────────

let deleteTarget = null;

function openDeleteOverlay(itemId, name) {
  deleteTarget = itemId;
  document.getElementById('delete-msg').textContent =
    `Remove ${name}? This will delete all its accounts and transactions. This cannot be undone.`;
  document.getElementById('delete-overlay').classList.remove('hidden');
}

function closeDeleteOverlay() {
  document.getElementById('delete-overlay').classList.add('hidden');
  deleteTarget = null;
}

async function confirmDelete() {
  if (!deleteTarget) return;
  try {
    await api(`api/items/${deleteTarget}`, { method: 'DELETE' });
    closeDeleteOverlay();
    await loadItems();
  } catch (err) {
    alert('Failed to remove institution: ' + err.message);
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

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
