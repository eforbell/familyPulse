/* Cash flow Sankey — income sources → Income → spending categories / Saved.
   Desktop-only: it needs horizontal room to stay legible, so it only fetches
   and renders while the desktop media query matches.
   Requires d3 and d3-sankey on the page.

   Usage: CashFlowSankey.mount(document.getElementById('cash-flow-sankey')); */
'use strict';

(function () {
  const RANGES = [
    ['this_month', 'This month'],
    ['last_month', 'Last month'],
    ['last_3_months', 'Last 3 months'],
    ['year_to_date', 'Year to date'],
    ['last_12_months', 'Last 12 months'],
    ['last_year', 'Last year']
  ];
  const DEFAULT_RANGE = 'last_month';
  const STORAGE_KEY = 'pulse.sankeyRange';
  const DESKTOP_QUERY = '(min-width: 1100px)';
  const NODE_WIDTH = 12;
  const ROW_HEIGHT = 44;
  const LABEL_GAP = 8;

  function readRange() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return RANGES.some(([r]) => r === saved) ? saved : DEFAULT_RANGE;
    } catch { return DEFAULT_RANGE; }
  }

  function saveRange(range) {
    try { localStorage.setItem(STORAGE_KEY, range); } catch { /* per-viewer convenience only */ }
  }

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function money(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function pct(n, total) {
    if (!total) return '0%';
    const p = (n / total) * 100;
    return `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`;
  }

  function plainName(name) {
    return String(name || '')
      .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}‍️\s]+/gu, '')
      .trim();
  }

  function leadingEmoji(name) {
    const m = String(name || '').match(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}‍️]+/u);
    return m ? m[0] : '';
  }

  function displayName(node) {
    const icon = node.icon || leadingEmoji(node.name);
    const name = plainName(node.name) || node.name;
    return icon && icon !== '…' ? `${icon} ${name}` : name;
  }

  function palette() {
    return ['--cat-01', '--cat-02', '--cat-03', '--cat-04', '--cat-05', '--cat-06', '--cat-07', '--cat-08']
      .map((v, i) => cssVar(v, ['#C4572A', '#8B6914', '#6BAF3D', '#3B6E8F', '#5BA4C9', '#6F8A55', '#D4A83A', '#C99064'][i]));
  }

  function colorFor(node, index, colors) {
    switch (node.kind) {
      case 'hub': return cssVar('--accent', '#7EC44E');
      case 'saved': return cssVar('--ok', '#7EC44E');
      case 'shortfall': return cssVar('--bad', '#E07A54');
      case 'other': return cssVar('--cat-09', '#6F6A5E');
      default: return colors[index % colors.length];
    }
  }

  function mount(root) {
    if (!root) return null;
    const mq = window.matchMedia(DESKTOP_QUERY);
    let range = readRange();
    let data = null;
    let loadedRange = null;
    let resizeTimer = null;

    root.innerHTML = `
      <div class="sankey-head">
        <div class="sankey-summary" data-sankey-summary></div>
        <select class="chart-month-select sankey-range" aria-label="Cash flow period">
          ${RANGES.map(([value, label]) => `<option value="${value}"${value === range ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
      </div>
      <div class="sankey-canvas" data-sankey-canvas></div>
      <div class="sankey-tooltip hidden" data-sankey-tooltip role="tooltip"></div>
      <p class="sankey-footnote">Paychecks with a paystub breakdown show gross pay in, and taxes &amp; payroll deductions out. Transfers between your own accounts are excluded.</p>
    `;

    const canvas = root.querySelector('[data-sankey-canvas]');
    const tooltip = root.querySelector('[data-sankey-tooltip]');
    const select = root.querySelector('.sankey-range');

    select.addEventListener('change', () => {
      range = select.value;
      saveRange(range);
      load();
    });

    mq.addEventListener('change', () => { if (mq.matches) ensureLoaded(); });
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (mq.matches && data) render(); }, 150);
    });
    window.addEventListener('pulse:theme-change', () => { if (mq.matches && data) render(); });

    function ensureLoaded() {
      if (loadedRange === range && data) render();
      else load();
    }

    async function load() {
      const requested = range;
      canvas.innerHTML = '<div class="empty-state loading-pulse">Loading cash flow…</div>';
      try {
        const res = await fetch(`api/reports/cash-flow-sankey?range=${encodeURIComponent(requested)}`);
        if (res.status === 401) { window.location.replace('login.html'); return; }
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
        const next = await res.json();
        if (requested !== range) return;
        data = next;
        loadedRange = requested;
        render();
      } catch (err) {
        if (requested !== range) return;
        canvas.innerHTML = '<div class="empty-state">Cash flow unavailable</div>';
        console.error('Sankey load failed:', err);
      }
    }

    function renderSummary() {
      const { income, spent, net } = data.totals;
      const rate = income > 0 ? Math.round((net / income) * 100) : null;
      root.querySelector('[data-sankey-summary]').innerHTML = `
        <div><span class="k">Income</span><span class="v">${money(income)}</span></div>
        <div><span class="k">Outflows</span><span class="v">${money(spent)}</span></div>
        <div><span class="k">${net >= 0 ? 'Saved' : 'Shortfall'}</span><span class="v ${net >= 0 ? 'ok' : 'bad'}">${money(Math.abs(net))}</span></div>
        ${rate !== null ? `<div><span class="k">Savings rate</span><span class="v ${rate >= 0 ? 'ok' : 'bad'}">${rate}%</span></div>` : ''}
      `;
    }

    function render() {
      if (!data) return;
      renderSummary();
      canvas.innerHTML = '';
      if (!data.links.length) {
        canvas.innerHTML = '<div class="empty-state">No income or spending in this period</div>';
        return;
      }
      if (typeof d3 === 'undefined' || typeof d3.sankey !== 'function') {
        canvas.innerHTML = '<div class="empty-state">Chart library failed to load</div>';
        return;
      }

      const width = canvas.clientWidth || 1000;
      const leafCount = data.nodes.filter(n => !['source', 'shortfall', 'hub', 'group'].includes(n.kind)).length;
      const sourceCount = data.nodes.filter(n => n.kind === 'source' || n.kind === 'shortfall').length;
      const height = Math.max(460, Math.max(leafCount, sourceCount) * ROW_HEIGHT);
      const margin = { top: 8, right: 4, bottom: 8, left: 4 };

      const total = data.totals.income + Math.max(0, -data.totals.net);
      const colors = palette();
      const nodes = data.nodes.map((n, i) => ({ ...n, color: colorFor(n, i, colors) }));
      const links = data.links.map(l => ({ ...l }));

      const layout = d3.sankey()
        .nodeId(d => d.id)
        .nodeWidth(NODE_WIDTH)
        .nodePadding(28) // ≥ two label lines, so small adjacent nodes never collide
        .nodeAlign(d3.sankeyJustify)
        .nodeSort(null)
        .extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]]);
      const graph = layout({ nodes, links });

      const svg = d3.select(canvas).append('svg')
        .attr('viewBox', `0 0 ${width} ${height}`)
        .attr('width', width)
        .attr('height', height)
        .attr('class', 'sankey-svg');

      const defs = svg.append('defs');
      graph.links.forEach((link, i) => {
        const gid = `sankey-grad-${i}`;
        link.gradientId = gid;
        const grad = defs.append('linearGradient')
          .attr('id', gid)
          .attr('gradientUnits', 'userSpaceOnUse')
          .attr('x1', link.source.x1)
          .attr('x2', link.target.x0);
        grad.append('stop').attr('offset', '0%').attr('stop-color', link.source.color);
        grad.append('stop').attr('offset', '100%').attr('stop-color', link.target.color);
      });

      const linkSel = svg.append('g')
        .attr('class', 'sankey-links')
        .attr('fill', 'none')
        .selectAll('path')
        .data(graph.links)
        .join('path')
        .attr('d', d3.sankeyLinkHorizontal())
        .attr('stroke', d => `url(#${d.gradientId})`)
        .attr('stroke-width', d => Math.max(1, d.width))
        .attr('class', 'sankey-link')
        .on('mousemove', (event, d) => showTooltip(event, `${displayName(d.source)} → ${displayName(d.target)}`, d.value, total))
        .on('mouseleave', hideTooltip);

      const nodeSel = svg.append('g')
        .attr('class', 'sankey-nodes')
        .selectAll('g')
        .data(graph.nodes)
        .join('g')
        .attr('class', d => `sankey-node kind-${d.kind}${isCategoryNode(d) ? ' is-link' : ''}`)
        .on('mouseenter', (event, d) => highlight(d))
        .on('mouseleave', () => { highlight(null); hideTooltip(); })
        .on('mousemove', (event, d) => showTooltip(event, displayName(d), d.value, total, d.kind === 'other' ? data.other_categories : null))
        .on('click', (event, d) => openTransactions(d));

      nodeSel.append('rect')
        .attr('x', d => d.x0)
        .attr('y', d => d.y0)
        .attr('height', d => Math.max(1, d.y1 - d.y0))
        .attr('width', d => d.x1 - d.x0)
        .attr('rx', 2)
        .attr('fill', d => d.color);

      // Labels: the first column reads to the right of its bars; every other
      // column reads to the left, over the incoming flows, so the rightmost
      // labels never run off the edge.
      const label = nodeSel.append('text')
        .attr('class', 'sankey-label')
        .attr('x', d => (d.depth === 0 ? d.x1 + LABEL_GAP : d.x0 - LABEL_GAP))
        .attr('y', d => (d.y0 + d.y1) / 2)
        .attr('text-anchor', d => (d.depth === 0 ? 'start' : 'end'));

      label.append('tspan')
        .attr('class', 'sankey-label-name')
        .attr('x', function () { return this.parentNode.getAttribute('x'); })
        .attr('dy', '-0.25em')
        .text(d => displayName(d));
      label.append('tspan')
        .attr('class', 'sankey-label-value')
        .attr('x', function () { return this.parentNode.getAttribute('x'); })
        .attr('dy', '1.2em')
        .text(d => `${money(d.value)} (${pct(d.value, total)})`);

      function highlight(node) {
        if (!node) {
          linkSel.classed('is-dim', false).classed('is-hot', false);
          return;
        }
        const related = new Set();
        // Walk upstream and downstream so hovering a leaf lights its full path.
        const up = [node];
        while (up.length) { const n = up.pop(); for (const l of n.targetLinks) { related.add(l); up.push(l.source); } }
        const down = [node];
        while (down.length) { const n = down.pop(); for (const l of n.sourceLinks) { related.add(l); down.push(l.target); } }
        linkSel.classed('is-dim', l => !related.has(l)).classed('is-hot', l => related.has(l));
      }
    }

    function showTooltip(event, title, value, total, extra) {
      const rows = extra && extra.length
        ? `<div class="sankey-tip-list">${extra.slice(0, 12).map(o => `<div><span>${escapeHtml(displayName(o))}</span><span>${money(o.amount)}</span></div>`).join('')}${extra.length > 12 ? `<div><span>+${extra.length - 12} more</span><span></span></div>` : ''}</div>`
        : '';
      tooltip.innerHTML = `<div class="sankey-tip-title">${escapeHtml(title)}</div><div class="sankey-tip-value">${money(value)} · ${pct(value, total)}</div>${rows}`;
      tooltip.classList.remove('hidden');
      const box = root.getBoundingClientRect();
      const tipW = tooltip.offsetWidth;
      let x = event.clientX - box.left + 14;
      if (x + tipW > box.width) x = event.clientX - box.left - tipW - 14;
      tooltip.style.left = `${Math.max(0, x)}px`;
      tooltip.style.top = `${event.clientY - box.top + 14}px`;
    }

    function hideTooltip() {
      tooltip.classList.add('hidden');
    }

    function isCategoryNode(node) {
      return node.category_id != null || node.id === 'out:uncat' || node.id === 'src:uncat';
    }

    function openTransactions(node) {
      if (!isCategoryNode(node) || !data) return;
      const p = new URLSearchParams({
        category_id: node.category_id ?? 0, // 0 = uncategorized on the Transactions page
        date_from: data.start,
        date_to: data.end
      });
      window.location.href = `transactions.html?${p}`;
    }

    if (mq.matches) load();
    return { reload: load };
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  window.CashFlowSankey = { mount };
})();
