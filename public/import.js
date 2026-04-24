'use strict';

let uploadData = null;  // holds parsed response from /api/import/upload
let selectedFile = null;

const $ = id => document.getElementById(id);

// ── File selection ──────────────────────────────────────────

const fileInput = $('file-input');
const uploadZone = $('upload-zone');
const btnUpload = $('btn-upload');
const uploadStatus = $('upload-status');

fileInput.addEventListener('change', () => {
  selectedFile = fileInput.files[0];
  if (selectedFile) {
    uploadStatus.textContent = `Selected: ${selectedFile.name} (${(selectedFile.size / 1024).toFixed(1)} KB)`;
    uploadStatus.classList.remove('hidden');
    btnUpload.classList.remove('hidden');
  }
});

// Drag & drop
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor = 'var(--accent)'; });
uploadZone.addEventListener('dragleave', () => { uploadZone.style.borderColor = ''; });
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.style.borderColor = '';
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.csv')) {
    selectedFile = file;
    fileInput.files = e.dataTransfer.files;
    uploadStatus.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    uploadStatus.classList.remove('hidden');
    btnUpload.classList.remove('hidden');
  }
});

// ── Upload & Preview ────────────────────────────────────────

btnUpload.addEventListener('click', async () => {
  if (!selectedFile) return;
  btnUpload.disabled = true;
  btnUpload.textContent = 'Parsing…';

  const form = new FormData();
  form.append('file', selectedFile);

  try {
    const res = await fetch('api/import/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');

    uploadData = data;
    renderPreview(data);
    renderCategoryMapping(data);
    renderAccountMapping(data);

    $('step-upload').classList.add('hidden');
    $('step-mapping').classList.remove('hidden');
  } catch (err) {
    uploadStatus.textContent = `Error: ${err.message}`;
    uploadStatus.style.color = 'var(--red)';
  } finally {
    btnUpload.disabled = false;
    btnUpload.textContent = 'Upload & Preview';
  }
});

// ── Preview table ───────────────────────────────────────────

function renderPreview(data) {
  $('preview-summary').textContent = `${data.totalRows} transactions found in ${data.filename}` +
    (data.parseErrors.length > 0 ? ` (${data.parseErrors.length} parse errors)` : '');

  const tbody = $('preview-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const row of data.preview) {
    const tr = document.createElement('tr');
    const amtClass = row.amount >= 0 ? 'amt-pos' : 'amt-neg';
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${esc(row.merchant)}</td>
      <td>${esc(row.category)}</td>
      <td class="muted">${esc(row.account)}</td>
      <td class="${amtClass}">${fmt(row.amount)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Category mapping ────────────────────────────────────────

function renderCategoryMapping(data) {
  const tbody = $('category-map-table').querySelector('tbody');
  tbody.innerHTML = '';

  for (const mc of data.monarchCategories) {
    const suggestion = data.categorySuggestions.mapped[mc];
    const tr = document.createElement('tr');

    const fpOptions = data.fpCategories.map(c =>
      `<option value="${c.id}" ${suggestion && suggestion.fpId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('');

    const confidence = suggestion
      ? `<span class="badge badge-${suggestion.confidence}">${suggestion.confidence}</span>`
      : '<span class="badge badge-none">manual</span>';

    tr.innerHTML = `
      <td>${esc(mc)}</td>
      <td class="muted">→</td>
      <td><select class="cat-select" data-monarch="${esc(mc)}">
        <option value="">— Uncategorized —</option>
        ${fpOptions}
      </select></td>
      <td>${confidence}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Account mapping ─────────────────────────────────────────

function renderAccountMapping(data) {
  const tbody = $('account-map-table').querySelector('tbody');
  tbody.innerHTML = '';

  for (const ma of data.monarchAccounts) {
    const tr = document.createElement('tr');

    const fpOptions = data.fpAccounts.map(a =>
      `<option value="${a.id}">${esc(a.name)}${a.mask ? ' (' + a.mask + ')' : ''}</option>`
    ).join('');

    tr.innerHTML = `
      <td>${esc(ma)}</td>
      <td class="muted">→</td>
      <td><select class="acct-select" data-monarch="${esc(ma)}">
        <option value="auto" selected>Auto-create</option>
        <option value="skip">Skip (don't import)</option>
        ${fpOptions}
      </select></td>
    `;
    tbody.appendChild(tr);
  }
}

// ── Commit import ───────────────────────────────────────────

$('btn-import').addEventListener('click', async () => {
  const btn = $('btn-import');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  // Gather mappings
  const categoryMap = {};
  for (const sel of document.querySelectorAll('.cat-select')) {
    if (sel.value) categoryMap[sel.dataset.monarch] = sel.value;
  }

  const accountMap = {};
  for (const sel of document.querySelectorAll('.acct-select')) {
    accountMap[sel.dataset.monarch] = sel.value;
  }

  const form = new FormData();
  form.append('file', selectedFile);
  form.append('categoryMap', JSON.stringify(categoryMap));
  form.append('accountMap', JSON.stringify(accountMap));

  try {
    const res = await fetch('api/import/commit', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');

    renderResults(data);
    $('step-mapping').classList.add('hidden');
    $('step-results').classList.remove('hidden');
    loadHistory();
  } catch (err) {
    alert(`Import error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Import Transactions';
  }
});

// ── Results ─────────────────────────────────────────────────

function renderResults(data) {
  $('results-body').innerHTML = `
    <div class="results-grid">
      <div class="result-card result-total">
        <div class="result-num">${data.totalRows}</div>
        <div class="result-label">Total Rows</div>
      </div>
      <div class="result-card result-inserted">
        <div class="result-num">${data.inserted}</div>
        <div class="result-label">Imported</div>
      </div>
      <div class="result-card result-skipped">
        <div class="result-num">${data.skipped}</div>
        <div class="result-label">Skipped (duplicate)</div>
      </div>
      <div class="result-card result-errors">
        <div class="result-num">${data.errors}</div>
        <div class="result-label">Errors</div>
      </div>
    </div>
  `;
}

function resetImport() {
  uploadData = null;
  selectedFile = null;
  fileInput.value = '';
  uploadStatus.classList.add('hidden');
  uploadStatus.style.color = '';
  btnUpload.classList.add('hidden');
  $('step-results').classList.add('hidden');
  $('step-mapping').classList.add('hidden');
  $('step-upload').classList.remove('hidden');
}

// ── History ─────────────────────────────────────────────────

async function loadHistory() {
  try {
    const res = await fetch('api/import/history');
    const runs = await res.json();
    const body = $('history-body');

    if (runs.length === 0) {
      body.innerHTML = '<p class="muted">No imports yet</p>';
      return;
    }

    body.innerHTML = runs.map(r => `
      <div class="history-row">
        <div>
          <strong>${esc(r.filename || 'Unknown file')}</strong>
          <span class="muted" style="margin-left:.5rem">${new Date(r.started_at).toLocaleDateString()}</span>
        </div>
        <div class="muted" style="font-size:.85rem">
          ${r.txns_added || 0} imported, ${r.txns_skipped || 0} skipped
          <span class="badge badge-${r.status === 'complete' ? 'known' : 'none'}">${r.status}</span>
        </div>
      </div>
    `).join('');
  } catch {
    $('history-body').innerHTML = '<p class="muted">Could not load history</p>';
  }
}

// ── Helpers ─────────────────────────────────────────────────

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function fmt(n) {
  const sign = n >= 0 ? '+' : '';
  const text = sign + n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  return `<span class="fp-amount">${text}</span>`;
}

// ── Init ────────────────────────────────────────────────────

loadHistory();
