/* forecast.js — Cash flow forecast page */
'use strict';

let forecastData = null;
let forecastChart = null;
let editingPlannedId = null;

// ── Init ──────────────────────────────────────────────────────

async function init() {
  try {
    const res = await fetch('api/cash-flow/forecast');
    if (res.status === 401) { window.location.href = 'login.html'; return; }
    forecastData = await res.json();
    render();
  } catch (err) {
    console.error('Forecast load failed:', err);
    document.getElementById('forecast-loading').classList.add('hidden');
    document.getElementById('forecast-empty').classList.remove('hidden');
  }
}

function render() {
  const loading = document.getElementById('forecast-loading');
  const empty = document.getElementById('forecast-empty');
  const content = document.getElementById('forecast-content');

  loading.classList.add('hidden');

  if (!forecastData || !forecastData.projections || forecastData.projections.length === 0) {
    empty.classList.remove('hidden');
    return;
  }

  content.classList.remove('hidden');
  renderHero();
  renderPrimer();
  renderDangerBanner();
  renderChart();
  renderMonthlyCards();
  renderPlannedExpenses();
  renderPlannedIncome();
  renderAssumptions();
}

// ── Hero ──────────────────────────────────────────────────────

function renderHero() {
  const meta = forecastData.meta || {};
  const dangerZones = forecastData.danger_zones || [];
  const excess = forecastData.excess_liquidity || {};

  // Balance
  document.getElementById('hero-balance').innerHTML = fmtMoney(meta.starting_balance || 0);

  // Outlook status
  const outlookEl = document.getElementById('hero-outlook');
  const nearDanger = dangerZones.filter(z => z.severity === 'danger' && isWithinDays(z.date, 30));
  const nearRisk = dangerZones.filter(z => z.severity === 'at_risk' && isWithinDays(z.date, 30));

  if (nearDanger.length > 0) {
    outlookEl.textContent = 'Danger';
    outlookEl.style.color = 'var(--red)';
  } else if (nearRisk.length > 0) {
    outlookEl.textContent = 'Caution';
    outlookEl.style.color = 'var(--yellow)';
  } else {
    outlookEl.textContent = 'Healthy';
    outlookEl.style.color = 'var(--green)';
  }

  // Next danger
  const dangerEl = document.getElementById('hero-danger');
  const nextDanger = dangerZones.find(z => z.severity === 'danger');
  if (nextDanger) {
    dangerEl.textContent = fmtShortDate(nextDanger.date);
    dangerEl.style.color = 'var(--red)';
  } else {
    dangerEl.textContent = 'None';
    dangerEl.style.color = 'var(--muted)';
  }

  // Excess liquidity
  const excessEl = document.getElementById('hero-excess');
  if (excess.recommendation_level && excess.recommendation_level !== 'none') {
    excessEl.classList.remove('hidden');
    const strength = excess.recommendation_level === 'strong' ? 'comfortably' : 'potentially';
    excessEl.innerHTML = `<span style="color:var(--accent)">Excess cash detected:</span> You could ${strength} move about <strong>${fmtMoney(excess.excess_amount)}</strong> without dropping below your reserve target of ${fmtMoney(excess.reserve_target)}.`;
  }
}

// ── Danger Banner ─────────────────────────────────────────────

function renderDangerBanner() {
  const banner = document.getElementById('danger-banner');
  const dangerZones = (forecastData.danger_zones || []).filter(
    z => z.severity === 'danger' && isWithinDays(z.date, 30)
  );
  if (dangerZones.length === 0) return;

  const first = dangerZones[0];
  const trigger = first.trigger_event ? ` (${first.trigger_event.name})` : '';
  document.getElementById('danger-banner-text').innerHTML =
    `Balance projected to drop to <strong>${fmtMoney(first.projected_balance)}</strong> on ${fmtShortDate(first.date)}${trigger} &mdash; ${fmtMoney(first.deficit_below_floor)} below your safety floor.`;
  banner.classList.remove('hidden');
}

function renderPrimer() {
  const meta = forecastData.meta || {};
  const monthly = forecastData.monthly_outlook || [];
  const firstMonth = monthly[0] || {};
  const root = document.getElementById('forecast-primer');
  if (!root) return;

  const recurringCount = meta.recurring_expense_count || 0;
  const discretionary = firstMonth.expected_discretionary || 0;
  const recurring = firstMonth.expected_recurring || 0;
  const liabilities = firstMonth.expected_liability_payments || 0;
  const planned = firstMonth.planned_expenses_total || 0;
  const plannedIncome = firstMonth.planned_income_total || 0;

  root.innerHTML = `
    <div class="forecast-primer-card">
      <div class="forecast-primer-head">
        <div>
          <h2 class="section-heading" style="margin:0">How Pulse Forecasts</h2>
          <div class="forecast-primer-copy">
            Pulse starts with today's liquid cash, adds expected income and any planned one-time income, then subtracts recurring bills, liability payments, normal day-to-day spending, and planned one-time expenses.
          </div>
        </div>
      </div>
      <div class="forecast-primer-grid">
        <div class="forecast-primer-item">
          <span class="forecast-primer-label">Recurring</span>
          <strong>${fmtMoney(recurring)}</strong>
          <span class="forecast-primer-detail">${recurringCount} active recurring patterns projected on their actual due schedule</span>
        </div>
        <div class="forecast-primer-item">
          <span class="forecast-primer-label">Day-to-Day</span>
          <strong>${fmtMoney(discretionary)}</strong>
          <span class="forecast-primer-detail">Baseline discretionary spending based on prior history for this calendar month</span>
        </div>
        <div class="forecast-primer-item">
          <span class="forecast-primer-label">Liabilities</span>
          <strong>${fmtMoney(liabilities)}</strong>
          <span class="forecast-primer-detail">Minimum payments coming from Plaid liability data</span>
        </div>
        <div class="forecast-primer-item">
          <span class="forecast-primer-label">Planned Expenses</span>
          <strong>${fmtMoney(planned)}</strong>
          <span class="forecast-primer-detail">One-time expenses you added manually for this month</span>
        </div>
        ${plannedIncome > 0 ? `
        <div class="forecast-primer-item">
          <span class="forecast-primer-label" style="color:var(--green)">Planned Income</span>
          <strong style="color:var(--green)">${fmtMoney(plannedIncome)}</strong>
          <span class="forecast-primer-detail">One-time income you added manually for this month</span>
        </div>` : ''}
      </div>
      <div class="forecast-primer-note">
        "Recurring" here is not just the committed monthly summary. Pulse projects each active medium/high-confidence recurring item on its expected future dates, and the monthly card shows the total scheduled to hit inside that month.
      </div>
    </div>
  `;
}

// ── Chart ─────────────────────────────────────────────────────

function renderChart() {
  const projections = forecastData.projections || [];
  const meta = forecastData.meta || {};
  const safetyFloor = meta.safety_floor || 3000;

  const labels = projections.map(p => p.date);
  const balances = projections.map(p => p.projected_balance);
  const lows = projections.map(p => p.confidence_low);
  const highs = projections.map(p => p.confidence_high);

  // Danger zone indices
  const dangerDates = new Set((forecastData.danger_zones || [])
    .filter(z => z.severity === 'danger')
    .map(z => z.date));

  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#10b981';
  const red = style.getPropertyValue('--red').trim() || '#f87171';
  const muted = style.getPropertyValue('--muted').trim() || '#9ca3af';
  const textColor = style.getPropertyValue('--text').trim() || '#f0f0f0';
  const gridColor = style.getPropertyValue('--border').trim() || '#2a2a2a';

  const ctx = document.getElementById('forecast-chart').getContext('2d');

  if (forecastChart) forecastChart.destroy();

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Confidence High',
          data: highs,
          borderWidth: 0,
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false
        },
        {
          label: 'Projected Balance',
          data: balances,
          borderColor: accent,
          borderWidth: 2,
          backgroundColor: accent + '18',
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: accent,
          fill: false,
          tension: 0.1
        },
        {
          label: 'Confidence Low',
          data: lows,
          borderWidth: 0,
          backgroundColor: accent + '10',
          pointRadius: 0,
          fill: '-2' // fill between confidence low and confidence high
        },
        {
          label: 'Safety Floor',
          data: projections.map(() => safetyFloor),
          borderColor: red + '60',
          borderWidth: 1,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: window.innerWidth < 600 ? 1.2 : 2.5,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: style.getPropertyValue('--surface2').trim() || '#1e1e1e',
          titleColor: textColor,
          bodyColor: textColor,
          borderColor: gridColor,
          borderWidth: 1,
          callbacks: {
            title(items) { return fmtShortDate(items[0].label); },
            label(ctx) {
              if (ctx.datasetIndex === 1) return `Balance: ${fmtMoneyText(ctx.raw)}`;
              if (ctx.datasetIndex === 0) return `High: ${fmtMoneyText(ctx.raw)}`;
              if (ctx.datasetIndex === 2) return `Low: ${fmtMoneyText(ctx.raw)}`;
              if (ctx.datasetIndex === 3) return `Safety Floor: ${fmtMoneyText(ctx.raw)}`;
              return '';
            },
            afterBody(items) {
              const date = items[0].label;
              const day = projections.find(p => p.date === date);
              if (!day || !day.events.length) return '';
              const lines = day.events
                .filter(e => e.type !== 'discretionary')
                .map(e => {
                  const sign = (e.type === 'income' || e.type === 'planned_income') ? '+' : '-';
                  return `  ${sign}$${e.amount.toFixed(2)} ${e.name}`;
                });
              return lines.length ? '\nEvents:\n' + lines.join('\n') : '';
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: muted,
            maxTicksLimit: window.innerWidth < 600 ? 6 : 12,
            callback(val, i) {
              const d = labels[i];
              return d ? fmtChartDate(d) : '';
            }
          },
          grid: { color: gridColor + '40' }
        },
        y: {
          ticks: {
            color: muted,
            callback(val) { return '$' + (val / 1000).toFixed(0) + 'k'; }
          },
          grid: { color: gridColor + '40' }
        }
      }
    }
  });
}

// ── Monthly Cards ─────────────────────────────────────────────

function renderMonthlyCards() {
  const outlook = forecastData.monthly_outlook || [];
  const container = document.getElementById('monthly-cards');
  container.innerHTML = '';

  // Show up to 3 months
  const months = outlook.slice(0, 3);
  for (const m of months) {
    const isPositive = m.net_surplus_or_deficit >= 0;
    const netColor = isPositive ? 'var(--green)' : 'var(--red)';
    const netSign = isPositive ? '+' : '';

    const calMonth = parseInt(m.month.split('-')[1], 10);
    const card = document.createElement('div');
    card.className = 'monthly-card';
    card.innerHTML = `
      <div class="monthly-card-header">${fmtMonthLabel(m.month)}</div>
      <div class="monthly-card-rows">
        <div class="monthly-row"><span>Income</span><span style="color:var(--green)">${fmtMoney(m.expected_income)}</span></div>
        <div class="monthly-row"><span>Recurring</span><span>-${fmtMoney(m.expected_recurring)}</span></div>
        <div class="monthly-row monthly-row-clickable" data-drilldown-month="${calMonth}"><span>Discretionary <span class="drilldown-hint">&#9662;</span></span><span>-${fmtMoney(m.expected_discretionary)}</span></div>
        <div class="discretionary-drilldown" id="drilldown-${calMonth}" style="display:none"></div>
        <div class="monthly-row"><span>Liabilities</span><span>-${fmtMoney(m.expected_liability_payments)}</span></div>
        ${m.planned_income_total > 0 ? `<div class="monthly-row"><span style="color:var(--green)">Planned Income</span><span style="color:var(--green)">+${fmtMoney(m.planned_income_total)}</span></div>` : ''}
        ${m.planned_expenses_total > 0 ? `<div class="monthly-row"><span>Planned Expenses</span><span>-${fmtMoney(m.planned_expenses_total)}</span></div>` : ''}
        <div class="monthly-row monthly-net" style="color:${netColor}"><span>Net</span><span>${netSign}${fmtMoney(m.net_surplus_or_deficit)}</span></div>
      </div>
      <div class="monthly-card-footer">End Balance: ${fmtMoney(m.projected_end_balance)}</div>
    `;

    // Wire up drilldown click
    const discRow = card.querySelector('[data-drilldown-month]');
    discRow.addEventListener('click', () => toggleDiscretionaryDrilldown(calMonth));

    container.appendChild(card);
  }
}

// ── Planned Expenses ──────────────────────────────────────────

let plannedItemsCache = null;

async function loadPlannedItems() {
  const res = await fetch('api/cash-flow/planned-expenses');
  const data = await res.json();
  plannedItemsCache = data.planned_expenses || [];
}

async function renderPlannedExpenses() {
  try {
    if (!plannedItemsCache) await loadPlannedItems();
    const expenses = plannedItemsCache.filter(pe => pe.type !== 'income');
    const list = document.getElementById('planned-list');
    const emptyMsg = document.getElementById('planned-empty');

    if (expenses.length === 0) {
      list.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }

    emptyMsg.classList.add('hidden');
    list.innerHTML = expenses.map(pe => `
      <div class="planned-item" data-id="${pe.id}">
        <div class="planned-item-info">
          <div class="planned-item-name">${escHtml(pe.name)}</div>
          <div class="planned-item-meta" style="color:var(--red)">&minus;${fmtMoney(pe.amount)} &middot; ${fmtShortDate(pe.scheduled_date)}</div>
          ${pe.notes ? `<div class="planned-item-notes">${escHtml(pe.notes)}</div>` : ''}
        </div>
        <div class="planned-item-actions">
          <button class="btn-ghost btn-sm" onclick="editPlanned(${pe.id}, '${escAttr(pe.name)}', ${pe.amount}, '${pe.scheduled_date.slice(0,10)}', '${escAttr(pe.notes || '')}', 'expense')">Edit</button>
          <button class="btn-ghost btn-sm" style="color:var(--red)" onclick="deletePlanned(${pe.id}, 'expense')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load planned expenses:', err);
  }
}

async function renderPlannedIncome() {
  try {
    if (!plannedItemsCache) await loadPlannedItems();
    const incomes = plannedItemsCache.filter(pi => pi.type === 'income');
    const list = document.getElementById('planned-income-list');
    const emptyMsg = document.getElementById('planned-income-empty');

    if (incomes.length === 0) {
      list.innerHTML = '';
      emptyMsg.classList.remove('hidden');
      return;
    }

    emptyMsg.classList.add('hidden');
    list.innerHTML = incomes.map(pi => `
      <div class="planned-item planned-item-income" data-id="${pi.id}">
        <div class="planned-item-info">
          <div class="planned-item-name">${escHtml(pi.name)}</div>
          <div class="planned-item-meta" style="color:var(--green)">+${fmtMoney(pi.amount)} &middot; ${fmtShortDate(pi.scheduled_date)}</div>
          ${pi.notes ? `<div class="planned-item-notes">${escHtml(pi.notes)}</div>` : ''}
        </div>
        <div class="planned-item-actions">
          <button class="btn-ghost btn-sm" onclick="editPlanned(${pi.id}, '${escAttr(pi.name)}', ${pi.amount}, '${pi.scheduled_date.slice(0,10)}', '${escAttr(pi.notes || '')}', 'income')">Edit</button>
          <button class="btn-ghost btn-sm" style="color:var(--red)" onclick="deletePlanned(${pi.id}, 'income')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Failed to load planned income:', err);
  }
}

function openPlannedModal(itemType, id, name, amount, date, notes) {
  // itemType is 'expense' or 'income' — when called from Add buttons, id is undefined
  const resolvedType = itemType || 'expense';
  editingPlannedId = id || null;
  const isIncome = resolvedType === 'income';
  document.getElementById('planned-type').value = resolvedType;
  document.getElementById('planned-modal-title').textContent =
    id
      ? (isIncome ? 'Edit Planned Income' : 'Edit Planned Expense')
      : (isIncome ? 'Add Planned Income' : 'Add Planned Expense');
  document.getElementById('planned-name').placeholder = isIncome ? 'e.g. Annual bonus' : 'e.g. New tires';
  document.getElementById('planned-name').value = name || '';
  document.getElementById('planned-amount').value = amount || '';
  document.getElementById('planned-date').value = date || '';
  document.getElementById('planned-notes').value = notes || '';
  document.getElementById('planned-error').classList.add('hidden');
  document.body.classList.add('modal-open');
  document.getElementById('planned-overlay').classList.remove('hidden');
}

function closePlannedModal() {
  document.getElementById('planned-overlay').classList.add('hidden');
  document.body.classList.remove('modal-open');
  editingPlannedId = null;
}

function editPlanned(id, name, amount, date, notes, itemType) {
  openPlannedModal(itemType || 'expense', id, name, amount, date, notes);
}

async function deletePlanned(id, itemType) {
  const label = itemType === 'income' ? 'planned income' : 'planned expense';
  if (!confirm(`Delete this ${label}?`)) return;
  try {
    await fetch(`api/cash-flow/planned-expenses/${id}`, { method: 'DELETE' });
    plannedItemsCache = null;
    await refreshForecast();
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

document.getElementById('planned-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('planned-name').value.trim();
  const amount = parseFloat(document.getElementById('planned-amount').value);
  const scheduled_date = document.getElementById('planned-date').value;
  const notes = document.getElementById('planned-notes').value.trim() || null;
  const type = document.getElementById('planned-type').value || 'expense';
  const errorEl = document.getElementById('planned-error');

  if (!name || !amount || amount <= 0 || !scheduled_date) {
    errorEl.textContent = 'All fields are required and amount must be positive.';
    errorEl.classList.remove('hidden');
    return;
  }

  try {
    const url = editingPlannedId
      ? `api/cash-flow/planned-expenses/${editingPlannedId}`
      : 'api/cash-flow/planned-expenses';
    const method = editingPlannedId ? 'PATCH' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, amount, scheduled_date, notes, type })
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Save failed';
      errorEl.classList.remove('hidden');
      return;
    }
    closePlannedModal();
    plannedItemsCache = null;
    await refreshForecast();
  } catch (err) {
    errorEl.textContent = 'Network error';
    errorEl.classList.remove('hidden');
  }
});

// ── Assumptions ───────────────────────────────────────────────

function renderAssumptions() {
  const meta = forecastData.meta || {};
  const body = document.getElementById('assumptions-body');

  const lines = [
    `<strong>Horizon:</strong> ${meta.horizon_days || 90} days`,
    `<strong>Starting balance:</strong> ${fmtMoney(meta.starting_balance || 0)}`,
    `<strong>Safety floor:</strong> ${fmtMoney(meta.safety_floor || 3000)}`,
    `<strong>Recurring income sources:</strong> ${meta.recurring_income_count || 0}`,
    `<strong>Recurring expenses:</strong> ${meta.recurring_expense_count || 0}`,
    `<strong>Liability payments:</strong> ${meta.liability_count || 0}`,
    `<strong>Planned expenses:</strong> ${meta.planned_count || 0}`,
    `<strong>Planned income:</strong> ${meta.planned_income_count || 0}`,
    `<strong>Last computed:</strong> ${meta.computed_at ? fmtShortDate(meta.computed_at.slice(0, 10)) : 'N/A'}`,
    meta.cached ? '<em style="color:var(--muted)">Serving cached forecast</em>' : '<em style="color:var(--accent)">Freshly computed</em>'
  ];

  body.innerHTML = `<ul class="assumptions-list">${lines.map(l => `<li>${l}</li>`).join('')}</ul>`;
}

// ── Refresh ───────────────────────────────────────────────────

async function refreshForecast() {
  try {
    document.getElementById('refresh-btn').disabled = true;
    document.getElementById('refresh-btn').textContent = 'Refreshing...';
    plannedItemsCache = null;
    const res = await fetch('api/cash-flow/forecast/refresh', { method: 'POST' });
    forecastData = await res.json();
    render();
  } catch (err) {
    console.error('Refresh failed:', err);
  } finally {
    document.getElementById('refresh-btn').disabled = false;
    document.getElementById('refresh-btn').textContent = 'Refresh';
  }
}

// ── Helpers ───────────────────────────────────────────────────

function fmtMoney(val) {
  const n = Number(val) || 0;
  const text = '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span class="fp-amount">${text}</span>`;
}

function fmtMoneyText(val) {
  const n = Number(val) || 0;
  return '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtShortDate(dateStr) {
  const [y, m, d] = (dateStr || '').split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

function fmtChartDate(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

function fmtMonthLabel(ym) {
  const [y, m] = ym.split('-');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

function isWithinDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const now = new Date();
  const diff = (d - now) / 86400000;
  return diff >= 0 && diff <= days;
}

function escHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function escAttr(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ── Discretionary Drilldown ──────────────────────────────────

async function toggleDiscretionaryDrilldown(calMonth) {
  const panel = document.getElementById(`drilldown-${calMonth}`);
  if (!panel) return;

  // Toggle visibility
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    return;
  }

  // Show loading state
  panel.style.display = 'block';
  panel.innerHTML = '<div class="drilldown-loading">Loading breakdown...</div>';

  try {
    const res = await fetch(`api/cash-flow/discretionary-breakdown?month=${calMonth}`);
    if (!res.ok) throw new Error('Failed to load breakdown');
    const data = await res.json();

    if (!data.merchants.length) {
      panel.innerHTML = '<div class="drilldown-empty">No discretionary data available.</div>';
      return;
    }

    const topMerchants = data.merchants.slice(0, 15);
    const remaining = data.merchants.slice(15);
    const remainingTotal = remaining.reduce((s, m) => s + m.monthly_avg, 0);

    let html = '';
    if (data.proration) {
      const p = data.proration;
      html += `<div class="drilldown-fallback">${p.days_remaining} of ${p.days_in_month} days remaining &middot; ${fmtMoney(p.daily_rate)}/day &middot; Prorated: ${fmtMoney(p.prorated_amount)} of ${fmtMoney(data.discretionary_monthly_avg)} monthly baseline</div>`;
    }
    if (data.fallback) {
      html += `<div class="drilldown-fallback">No history for this calendar month yet. Showing overall average across all ${data.months_sampled} months of data.</div>`;
    }
    html += `<div class="drilldown-header">
      <span>Top merchants</span>
      <span>Monthly avg (${data.months_sampled} mo)</span>
    </div>`;

    for (const m of topMerchants) {
      html += `<div class="drilldown-row">
        <span class="drilldown-merchant" title="${escAttr(m.category)}">${escHtml(m.merchant)}</span>
        <span class="drilldown-amount">${fmtMoney(m.monthly_avg)}</span>
      </div>`;
    }

    if (remaining.length) {
      html += `<div class="drilldown-row drilldown-other">
        <span>${remaining.length} other merchants</span>
        <span class="drilldown-amount">${fmtMoney(remainingTotal)}</span>
      </div>`;
    }

    html += `<div class="drilldown-footer">
      Recurring excluded: ${fmtMoney(data.recurring_total_excluded / data.months_sampled)}/mo
    </div>`;

    panel.innerHTML = html;
  } catch (err) {
    panel.innerHTML = `<div class="drilldown-empty">Could not load breakdown.</div>`;
  }
}

// ── Boot ──────────────────────────────────────────────────────

init();
