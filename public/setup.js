'use strict';

async function boot() {
  try {
    const res = await fetch('api/bootstrap', { cache: 'no-store' });
    const data = await res.json();
    if (data?.bootstrap?.needs_household === false) {
      window.location.replace('login.html');
    }
  } catch {}
}

function parseNames(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function submitSetup() {
  const btn = document.getElementById('setup-btn');
  const errorEl = document.getElementById('setup-error');
  errorEl.textContent = '';

  const parent1 = document.getElementById('setup-parent-1').value.trim();
  const parent2 = document.getElementById('setup-parent-2').value.trim();
  const kidsRaw = document.getElementById('setup-kids').value;
  const installStarter = document.getElementById('setup-starter').checked;

  if (!parent1) {
    errorEl.textContent = 'Primary parent name is required.';
    document.getElementById('setup-parent-1').focus();
    return;
  }

  const members = [{ name: parent1, role: 'parent' }];
  if (parent2) members.push({ name: parent2, role: 'parent' });
  for (const name of parseNames(kidsRaw)) {
    members.push({ name, role: 'kid' });
  }

  btn.disabled = true;
  btn.textContent = 'Setting up…';

  try {
    const res = await fetch('api/bootstrap/household', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members, install_starter_content: installStarter }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Setup failed');
    window.location.replace('login.html');
  } catch (err) {
    errorEl.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Create Household';
  }
}

document.getElementById('setup-btn').addEventListener('click', submitSetup);
document.getElementById('setup-parent-1').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitSetup();
});

boot();
