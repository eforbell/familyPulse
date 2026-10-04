/* Spending burn chart — cumulative spend this period vs a reference period.
   Shared by the dashboard and Reports. Requires Chart.js on the page.

   Usage: SpendingBurn.mount(document.getElementById('spending-burn')); */
'use strict';

(function () {
  const MODES = [
    ['week_vs_last_week', 'This week vs. last week'],
    ['month_vs_last_month', 'This month vs. last month'],
    ['month_vs_last_year', 'This month vs. last year'],
    ['month_vs_average', 'This month vs. average month'],
    ['year_vs_last_year', 'This year vs. last year']
  ];
  const DEFAULT_MODE = 'month_vs_last_month';
  const STORAGE_KEY = 'pulse.spendingBurnMode';
  const PERIOD_WORD = { week_vs_last_week: 'this week', year_vs_last_year: 'this year' };

  function readMode() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return MODES.some(([m]) => m === saved) ? saved : DEFAULT_MODE;
    } catch { return DEFAULT_MODE; }
  }

  function saveMode(mode) {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* per-viewer convenience only */ }
  }

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function money(n, digits = 0) {
    return '$' + Math.abs(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function compactMoney(n) {
    const v = Math.abs(Number(n) || 0);
    if (v >= 1000) return '$' + (v / 1000).toLocaleString('en-US', { maximumFractionDigits: v >= 10000 ? 0 : 1 }) + 'K';
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mount(root) {
    if (!root) return null;
    let chart = null;
    let data = null;
    let mode = readMode();

    root.classList.add('burn-card');
    root.innerHTML = `
      <div class="burn-head">
        <div class="burn-title">
          <span class="burn-label">Spending</span>
          <span class="burn-total" data-burn-total>—</span>
        </div>
        <select class="burn-mode" aria-label="Compare spending">
          ${MODES.map(([value, label]) => `<option value="${value}"${value === mode ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="burn-delta" data-burn-delta></div>
      <div class="burn-canvas-wrap"><canvas aria-label="Cumulative spending chart" role="img"></canvas></div>
      <div class="burn-legend" data-burn-legend></div>
    `;

    const select = root.querySelector('.burn-mode');
    const canvas = root.querySelector('canvas');
    select.addEventListener('change', () => {
      mode = select.value;
      saveMode(mode);
      load();
    });
    window.addEventListener('pulse:theme-change', () => { if (data) render(); });

    async function load() {
      const requested = mode;
      try {
        const res = await fetch(`api/reports/spending-burn?mode=${encodeURIComponent(requested)}`);
        if (res.status === 401) { window.location.replace('login.html'); return; }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const next = await res.json();
        if (requested !== mode) return; // a newer selection superseded this one
        data = next;
        render();
      } catch (err) {
        if (requested !== mode) return;
        root.querySelector('[data-burn-delta]').textContent = 'Spending comparison unavailable';
        console.error('Spending burn load failed:', err);
      }
    }

    function render() {
      const current = data.current;
      const reference = data.reference;
      const periodWord = PERIOD_WORD[data.mode] || 'this month';

      root.querySelector('[data-burn-total]').textContent = `${money(current.total, 2)} ${periodWord}`;

      const delta = data.delta_to_date;
      const deltaEl = root.querySelector('[data-burn-delta]');
      if (reference.to_date === 0 && current.total === 0) {
        deltaEl.textContent = 'No spending yet';
        deltaEl.className = 'burn-delta';
      } else if (Math.abs(delta) < 1) {
        deltaEl.textContent = `Right on pace with ${reference.label}`;
        deltaEl.className = 'burn-delta';
      } else {
        const ahead = delta > 0;
        deltaEl.innerHTML = `<strong>${money(delta)} ${ahead ? 'more' : 'less'}</strong> than ${esc(reference.label)} at this point`;
        deltaEl.className = `burn-delta ${ahead ? 'is-over' : 'is-under'}`;
      }

      const currentColor = cssVar('--bad', '#E07A54');
      const referenceColor = cssVar('--dim', '#756F62');
      const gridColor = cssVar('--border', '#3A382F') + '55';
      const tickColor = cssVar('--muted', '#A8A399');

      const lastIndex = current.series.length - 1;
      const pointRadius = current.series.map((_, i) => (i === lastIndex ? 4 : 0));

      root.querySelector('[data-burn-legend]').innerHTML = `
        <span><i style="background:${currentColor}"></i>${esc(current.label)}</span>
        <span><i style="background:${referenceColor}"></i>${esc(reference.label)}</span>`;

      const config = {
        type: 'line',
        data: {
          labels: data.labels,
          datasets: [
            {
              label: current.label,
              data: current.series,
              borderColor: currentColor,
              backgroundColor: currentColor,
              borderWidth: 2.5,
              pointRadius,
              pointHoverRadius: 4,
              pointBackgroundColor: cssVar('--surface', '#1E1D19'),
              pointBorderWidth: 2,
              tension: 0.15,
              order: 1
            },
            {
              label: reference.label,
              data: reference.series,
              borderColor: referenceColor,
              backgroundColor: referenceColor,
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              tension: 0.15,
              order: 2
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 250 },
          interaction: { mode: 'index', intersect: false },
          scales: {
            x: {
              ticks: { color: tickColor, maxTicksLimit: data.mode === 'week_vs_last_week' ? 7 : 6, maxRotation: 0, autoSkipPadding: 12 },
              grid: { display: false }
            },
            y: {
              beginAtZero: true,
              ticks: { color: tickColor, maxTicksLimit: 5, callback: v => compactMoney(v) },
              grid: { color: gridColor },
              border: { display: false }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => `${ctx.dataset.label}: ${money(ctx.parsed.y)}`
              }
            }
          }
        }
      };

      if (chart) chart.destroy();
      if (typeof Chart === 'undefined') return;
      chart = new Chart(canvas, config);
    }

    load();
    return { reload: load };
  }

  window.SpendingBurn = { mount };
})();
