/* eslint-disable no-unused-vars */
'use strict';

let currentMember = null;
let magicDisclaimer = '';
let trendsData = null;
let incomeSpendingChart = null;
let categoryDoughnutChart = null;
let categoryTrendsChart = null;

// ── Boot ─────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('api/auth/me');
    if (res.ok) { currentMember = await res.json(); }
    else { window.location.replace('login.html'); return; }
  } catch { window.location.replace('login.html'); return; }

  if (!currentMember || currentMember.role !== 'parent') {
    $('reports-locked').classList.remove('hidden');
    $('reports-content').classList.add('hidden');
    return;
  }
  $('reports-locked').classList.add('hidden');
  $('reports-content').classList.remove('hidden');
  bindReportInputShortcuts();
  loadReports();
});

// ── Data ─────────────────────────────────────────────────────

async function loadReports() {
  // Load disclaimer
  try {
    const cfg = await api('api/magic/config');
    const row = cfg.config.find(c => c.key === 'magic_disclaimer');
    magicDisclaimer = row ? row.value : '';
  } catch { /* ignore */ }

  // Load presets
  try {
    const data = await api('api/magic/presets');
    $('report-presets').innerHTML = data.presets.map(q =>
      `<button class="magic-preset-btn" onclick="reportAskPreset(this)" data-q="${esc(q)}">${esc(q)}</button>`
    ).join('');
  } catch { /* ignore */ }

  // Load query history
  loadQueryHistory();

  // Load charts
  loadCharts();

  // Re-render charts on theme toggle
  window.addEventListener('pulse:theme-change', () => {
    if (!trendsData) return;
    renderIncomeSpendingChart();
    renderCategoryDoughnut($('doughnut-month-select')?.value || trendsData.periods[trendsData.periods.length - 1]);
    renderCategoryTrends();
  });
}

async function loadQueryHistory() {
  try {
    const data = await api('api/magic/history');
    renderQueryHistory(data.queries || []);
  } catch (err) {
    $('query-history-list').innerHTML = '<div class="empty-state">Error loading history</div>';
  }
}

async function loadCharts() {
  try {
    trendsData = await api('api/budget/trends?months=6');
    renderIncomeSpendingChart();
    populateMonthSelector();
    renderCategoryDoughnut(trendsData.periods[trendsData.periods.length - 1]);
    renderCategoryTrends();
  } catch (err) {
    console.error('Charts load failed:', err);
  }
}

// ── Charts ───────────────────────────────────────────────────

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function categoricalPalette() {
  return [
    cssVar('--cat-01') || '#C4572A',
    cssVar('--cat-02') || '#8B6914',
    cssVar('--cat-03') || '#6BAF3D',
    cssVar('--cat-04') || '#3B6E8F',
    cssVar('--cat-05') || '#5BA4C9',
    cssVar('--cat-06') || '#6F8A55',
    cssVar('--cat-07') || '#D4A83A',
    cssVar('--cat-08') || '#C99064',
    cssVar('--cat-09') || '#6F6A5E'
  ];
}

function paletteColorForCategory(id, fallbackIndex = 0) {
  const palette = categoricalPalette();
  if (id == null || Number.isNaN(Number(id))) return palette[fallbackIndex % palette.length];
  return palette[Math.abs(Number(id)) % (palette.length - 1)];
}

function formatMonthLabel(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

function currencyTooltip(context) {
  const val = context.parsed.y ?? context.parsed;
  return `${context.dataset.label}: $${Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function renderIncomeSpendingChart() {
  if (!trendsData) return;
  const canvas = $('income-spending-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const labels = trendsData.periods.map(formatMonthLabel);
  const income = trendsData.monthly.map(m => m.income);
  const spending = trendsData.monthly.map(m => m.spending);
  const netCashFlow = trendsData.monthly.map(m => m.net_cash_flow);

  if (incomeSpendingChart) incomeSpendingChart.destroy();
  incomeSpendingChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Income',
          data: income,
          backgroundColor: '#10b98188',
          borderColor: '#10b981',
          borderWidth: 1,
          borderRadius: 4,
          order: 2
        },
        {
          label: 'Spending',
          data: spending,
          backgroundColor: '#f8717188',
          borderColor: '#f87171',
          borderWidth: 1,
          borderRadius: 4,
          order: 2
        },
        {
          label: 'Net Cash Flow',
          data: netCashFlow,
          type: 'line',
          borderColor: '#60a5fa',
          backgroundColor: '#60a5fa33',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#60a5fa',
          tension: 0.3,
          fill: false,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { color: cssVar('--muted') },
          grid: { color: cssVar('--border') + '44' }
        },
        y: {
          ticks: {
            color: cssVar('--muted'),
            callback: v => '$' + Number(v).toLocaleString()
          },
          grid: { color: cssVar('--border') + '44' }
        }
      },
      plugins: {
        legend: {
          labels: { color: cssVar('--muted'), font: { size: 12 }, padding: 16 }
        },
        tooltip: {
          callbacks: { label: currencyTooltip }
        }
      }
    }
  });
}

function populateMonthSelector() {
  const select = $('doughnut-month-select');
  if (!select || !trendsData) return;

  select.innerHTML = trendsData.periods
    .slice()
    .reverse()
    .map(p => {
      const [y, m] = p.split('-').map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return `<option value="${p}">${label}</option>`;
    })
    .join('');

  select.addEventListener('change', (e) => {
    renderCategoryDoughnut(e.target.value);
  });
}

function renderCategoryDoughnut(period) {
  if (!trendsData) return;
  const container = $('doughnut-container');
  if (!container || typeof Chart === 'undefined') return;

  const monthData = trendsData.monthly.find(m => m.period === period);
  if (!monthData) return;

  // Filter to categories with spending, sort by spent desc
  const allCats = monthData.categories
    .filter(c => c.spent > 0)
    .sort((a, b) => b.spent - a.spent);

  if (allCats.length === 0) {
    if (categoryDoughnutChart) categoryDoughnutChart.destroy();
    categoryDoughnutChart = null;
    container.innerHTML = '<canvas id="category-doughnut-chart"></canvas><div class="empty-state">No spending data for this month</div>';
    return;
  }

  // Show top 8 categories, group the rest as "Other"
  const top = allCats.slice(0, 8);
  const rest = allCats.slice(8);
  const cats = [...top];
  if (rest.length > 0) {
    cats.push({
      name: 'Other',
      icon: '',
      spent: rest.reduce((s, c) => s + c.spent, 0),
      color: cssVar('--cat-09') || '#6F6A5E'
    });
  }

  // Reset container to just the canvas (clears any leftover empty-state text)
  if (categoryDoughnutChart) categoryDoughnutChart.destroy();
  categoryDoughnutChart = null;
  container.innerHTML = '<canvas id="category-doughnut-chart"></canvas>';
  const canvas = $('category-doughnut-chart');

  const labels = cats.map(c => plainCategoryName(c.name));
  const data = cats.map(c => c.spent);
  const colors = cats.map((c, idx) => c.name === 'Other' ? (cssVar('--cat-09') || '#6F6A5E') : paletteColorForCategory(c.id, idx));

  categoryDoughnutChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data, backgroundColor: colors, borderWidth: 0 }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: cssVar('--muted'),
            font: { size: 12 },
            padding: 12
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const val = ctx.parsed;
              const total = ctx.dataset.data.reduce((s, v) => s + v, 0);
              const pct = total > 0 ? Math.round((val / total) * 100) : 0;
              return `${ctx.label}: $${val.toLocaleString()} (${pct}%)`;
            }
          }
        }
      }
    }
  });
}

function renderCategoryTrends() {
  if (!trendsData) return;
  const canvas = $('category-trends-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  // Find top 5 categories by total spending across all months
  const totals = {};
  const catMeta = {};
  for (const month of trendsData.monthly) {
    for (const cat of month.categories) {
      totals[cat.id] = (totals[cat.id] || 0) + cat.spent;
      catMeta[cat.id] = { name: cat.name, color: paletteColorForCategory(cat.id), icon: cat.icon };
    }
  }

  const topIds = Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([id]) => parseInt(id));

  const labels = trendsData.periods.map(formatMonthLabel);

  const datasets = topIds.map(id => {
    const meta = catMeta[id];
    const data = trendsData.periods.map(period => {
      const month = trendsData.monthly.find(m => m.period === period);
      const cat = month ? month.categories.find(c => c.id === id) : null;
      return cat ? cat.spent : 0;
    });

    return {
      label: plainCategoryName(meta.name),
      data,
      borderColor: meta.color || '#10b981',
      backgroundColor: (meta.color || '#10b981') + '22',
      borderWidth: 2,
      pointRadius: 4,
      pointBackgroundColor: meta.color || '#10b981',
      tension: 0.3,
      fill: false
    };
  });

  if (categoryTrendsChart) categoryTrendsChart.destroy();
  categoryTrendsChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: {
          ticks: { color: cssVar('--muted') },
          grid: { color: cssVar('--border') + '44' }
        },
        y: {
          ticks: {
            color: cssVar('--muted'),
            callback: v => '$' + Number(v).toLocaleString()
          },
          grid: { color: cssVar('--border') + '44' }
        }
      },
      plugins: {
        legend: {
          labels: { color: cssVar('--muted'), font: { size: 12 }, padding: 16 }
        },
        tooltip: {
          callbacks: { label: currencyTooltip }
        }
      }
    }
  });
}

// ── Render Query History ─────────────────────────────────────

function renderQueryHistory(queries) {
  const queryList = $('query-history-list');

  if (!queries.length) {
    queryList.innerHTML = '<div class="empty-state">No Ask Pulse or What-If history yet.</div>';
  } else {
    queryList.innerHTML = queries.map(q => {
      const date = new Date(q.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
      const typeLabel = q.type === 'ask' ? 'Ask Pulse' : 'What-If';
      const badgeClass = q.type === 'ask' ? 'ask' : 'whatif';

      return `
        <div class="report-card">
          <div class="report-card-header" onclick="toggleReport(this)">
            <div>
              <span class="report-type-badge ${badgeClass}">${typeLabel}</span>
              <span class="report-period">${esc(q.prompt)}</span>
            </div>
            <span class="report-date">${date}</span>
          </div>
          <div class="report-card-body hidden">
            <div class="report-date" style="margin-bottom:0.75rem">${esc(q.prompt)}</div>
            <div class="digest-content">${renderMarkdown(q.content)}</div>
          </div>
        </div>`;
    }).join('');
  }
}

function toggleReport(header) {
  const body = header.nextElementSibling;
  body.classList.toggle('hidden');
}

// ── Ask Pulse ───────────────────────────────────────────────

function reportAskPreset(btn) {
  $('report-ask-input').value = btn.dataset.q;
  submitReportAsk();
}

function bindReportInputShortcuts() {
  bindEnterSubmit('report-ask-input', submitReportAsk);
  bindEnterSubmit('report-whatif-input', submitReportWhatIf);
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
      body: JSON.stringify({ question })
    });
    result.innerHTML = renderMarkdown(data.answer || 'No response.');
    showDisclaimer();
    loadQueryHistory();
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
      body: JSON.stringify({ scenario })
    });
    result.innerHTML = renderMarkdown(data.forecast || 'No response.');
    showDisclaimer();
    loadQueryHistory();
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

function renderMarkdown(text) {
  if (!text) return '';
  return text
    .split('\n')
    .filter(p => p.trim())
    .map(p => `<p>${esc(p)}</p>`)
    .join('');
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
