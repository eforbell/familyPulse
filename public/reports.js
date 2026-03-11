/* eslint-disable no-unused-vars */
'use strict';

let currentMember = JSON.parse(localStorage.getItem('fp_member') || 'null');
let magicDisclaimer = '';

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  if (!currentMember || currentMember.role !== 'parent') {
    $('reports-locked').classList.remove('hidden');
    $('reports-content').classList.add('hidden');
    return;
  }
  $('reports-locked').classList.add('hidden');
  $('reports-content').classList.remove('hidden');
  loadReports();
});

// ── Data ─────────────────────────────────────────────────────

async function loadReports() {
  const params = memberParam();

  // Load disclaimer
  try {
    const cfg = await api(`api/magic/config${params}`);
    const row = cfg.config.find(c => c.key === 'magic_disclaimer');
    magicDisclaimer = row ? row.value : '';
  } catch { /* ignore */ }

  // Load presets
  try {
    const data = await api(`api/magic/presets${params}`);
    $('report-presets').innerHTML = data.presets.map(q =>
      `<button class="magic-preset-btn" onclick="reportAskPreset(this)" data-q="${esc(q)}">${esc(q)}</button>`
    ).join('');
  } catch { /* ignore */ }

  // Load history
  try {
    const data = await api(`api/magic/history${params}`);
    renderHistory(data.reports);
  } catch (err) {
    $('monthly-reports-list').innerHTML = '<div class="empty-state">Error loading reports</div>';
  }
}

// ── Render ───────────────────────────────────────────────────

function renderHistory(reports) {
  const list = $('monthly-reports-list');

  const monthly = reports.filter(r => r.type === 'monthly');
  const weekly = reports.filter(r => r.type === 'weekly');

  if (monthly.length === 0 && weekly.length === 0) {
    list.innerHTML = '<div class="empty-state">No reports generated yet. Reports are created automatically at the start of each month.</div>';
    return;
  }

  const all = [...monthly, ...weekly].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  list.innerHTML = all.map(r => {
    const typeLabel = r.type === 'monthly' ? 'Monthly Close' : 'Weekly Digest';
    const date = new Date(r.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    return `
      <div class="report-card">
        <div class="report-card-header" onclick="toggleReport(this)">
          <div>
            <span class="report-type-badge ${r.type}">${typeLabel}</span>
            <span class="report-period">${formatPeriod(r.period)}</span>
          </div>
          <span class="report-date">${date}</span>
        </div>
        <div class="report-card-body hidden">
          <div class="digest-content">${renderMarkdown(r.content)}</div>
        </div>
      </div>`;
  }).join('');
}

function toggleReport(header) {
  const body = header.nextElementSibling;
  body.classList.toggle('hidden');
}

function formatPeriod(period) {
  if (!period) return '';
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ── Ask Pulse ───────────────────────────────────────────────

function reportAskPreset(btn) {
  $('report-ask-input').value = btn.dataset.q;
  submitReportAsk();
}

async function submitReportAsk() {
  const input = $('report-ask-input');
  const question = input.value.trim();
  if (!question) return;

  const result = $('report-ask-result');
  result.classList.remove('hidden');
  result.innerHTML = '<div class="loading-pulse" style="color:var(--muted)">Thinking...</div>';

  try {
    const data = await api('api/magic/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, member: currentMember?.name })
    });
    result.innerHTML = renderMarkdown(data.answer || 'No response.');
    showDisclaimer();
  } catch (err) {
    result.innerHTML = `<div style="color:var(--red)">${esc(err.message)}</div>`;
  }
}

// ── What-If ─────────────────────────────────────────────────

async function submitReportWhatIf() {
  const input = $('report-whatif-input');
  const scenario = input.value.trim();
  if (!scenario) return;

  const result = $('report-whatif-result');
  result.classList.remove('hidden');
  result.innerHTML = '<div class="loading-pulse" style="color:var(--muted)">Forecasting...</div>';

  try {
    const data = await api('api/magic/what-if', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, member: currentMember?.name })
    });
    result.innerHTML = renderMarkdown(data.forecast || 'No response.');
    showDisclaimer();
  } catch (err) {
    result.innerHTML = `<div style="color:var(--red)">${esc(err.message)}</div>`;
  }
}

function showDisclaimer() {
  if (!magicDisclaimer) return;
  const el = $('report-disclaimer');
  el.textContent = magicDisclaimer;
  el.classList.remove('hidden');
}

// ── Helpers ─────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function memberParam() {
  if (!currentMember) return '';
  return `?member=${encodeURIComponent(currentMember.name)}`;
}

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${esc(p)}</p>`)
    .join('');
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
