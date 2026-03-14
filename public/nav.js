/* nav.js — Shared navigation: sidebar (desktop) + bottom bar (mobile) */
'use strict';

(function () {
  const activePage = document.body.dataset.navPage || 'dashboard';
  const navRole = document.body.dataset.navRole || 'parent';

  // ── Icon SVGs (20x20 line-art) ──────────────────────────────

  const icons = {
    home: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10L10 3l7 7"/><path d="M5 8.5V16a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V8.5"/></svg>',
    'building-columns': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 17h16M3 14h14M10 3L2 8h16L10 3z"/><path d="M5 8v6M8 8v6M12 8v6M15 8v6"/></svg>',
    'credit-card': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="16" height="12" rx="2"/><path d="M2 9h16"/><path d="M5 13h3"/></svg>',
    wallet: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="16" height="13" rx="2"/><path d="M2 7h16"/><path d="M14 11.5a.5.5 0 100-1 .5.5 0 000 1z" fill="currentColor"/></svg>',
    'chart-bar': '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17V9M7 17V5M11 17V8M15 17V3"/></svg>',
    tag: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10.5V4a2 2 0 012-2h6.5L18 9.5 10.5 17 2 10.5z"/><circle cx="6.5" cy="6.5" r="1" fill="currentColor"/></svg>',
    gear: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 1.5v2M10 16.5v2M3.5 3.5l1.4 1.4M15.1 15.1l1.4 1.4M1.5 10h2M16.5 10h2M3.5 16.5l1.4-1.4M15.1 4.9l1.4-1.4"/></svg>',
    more: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="4" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="16" r="1.5" fill="currentColor"/></svg>'
  };

  // ── Navigation items ────────────────────────────────────────

  const parentItems = [
    { id: 'dashboard',     label: 'Dashboard',    icon: 'home',             href: './' },
    { id: 'accounts',      label: 'Accounts',     icon: 'building-columns', href: 'accounts.html' },
    { id: 'transactions',  label: 'Transactions', icon: 'credit-card',      href: 'transactions.html' },
    { id: 'budget',        label: 'Budget',       icon: 'wallet',           href: 'budget.html' },
    { id: 'reports',       label: 'Reports',      icon: 'chart-bar',        href: 'reports.html' },
    { id: 'categories',    label: 'Categories',   icon: 'tag',              href: 'admin.html' },
    { id: 'settings',      label: 'Settings',     icon: 'gear',             href: 'settings.html' }
  ];

  const kidItems = [
    { id: 'kid-dashboard', label: 'My Money',     icon: 'home',             href: './' }
  ];

  const allItems = navRole === 'kid' ? kidItems : parentItems;

  // Mobile bottom bar: first 4 + More (kids only have 1 item, no More needed)
  const mobileItems = allItems.slice(0, 4);
  const moreItems = allItems.slice(4);

  // ── Build sidebar (desktop) ─────────────────────────────────

  const sidebar = document.createElement('nav');
  sidebar.className = 'app-sidebar';
  sidebar.setAttribute('aria-label', 'Main navigation');

  const logoHTML = `
    <a href="./" class="nav-logo">
      <img src="icon-32.png" alt="Pulse" width="28" height="28">
      <span>Pulse</span>
    </a>`;

  const sidebarItemsHTML = allItems.map((item, i) => {
    const active = item.id === activePage ? ' active' : '';
    const divider = i === 4 ? '<div class="nav-divider"></div>' : '';
    return `${divider}<a href="${item.href}" class="nav-item${active}" data-nav="${item.id}">
      <span class="nav-icon">${icons[item.icon]}</span>
      <span class="nav-label">${item.label}</span>
    </a>`;
  }).join('');

  sidebar.innerHTML = logoHTML + '<div class="nav-items">' + sidebarItemsHTML + '</div>';

  // ── Build bottom bar (mobile) ───────────────────────────────

  const bottomBar = document.createElement('nav');
  bottomBar.className = 'app-bottom-bar';
  bottomBar.setAttribute('aria-label', 'Mobile navigation');

  const mobileHTML = mobileItems.map(item => {
    const active = item.id === activePage ? ' active' : '';
    return `<a href="${item.href}" class="nav-item${active}" data-nav="${item.id}">
      <span class="nav-icon">${icons[item.icon]}</span>
      <span class="nav-label">${item.label}</span>
    </a>`;
  }).join('');

  // More button — active if current page is in moreItems
  const moreActive = moreItems.some(m => m.id === activePage) ? ' active' : '';
  const moreBtn = `<button class="nav-item nav-brand-mobile${moreActive}" id="more-nav-btn" aria-label="Pulse menu">
    <span class="nav-brand-mark"><img src="icon-32.png" alt="" width="18" height="18"></span>
    <span class="nav-label">Pulse</span>
  </button>`;

  bottomBar.innerHTML = mobileHTML + (moreItems.length > 0 ? moreBtn : '');

  // ── Build "More" sheet ──────────────────────────────────────

  const moreSheet = document.createElement('div');
  moreSheet.className = 'more-sheet hidden';
  if (moreItems.length > 0) {
    moreSheet.innerHTML = `
      <div class="more-sheet-backdrop"></div>
      <div class="more-sheet-panel">
        <div class="more-sheet-brand">
          <img src="icon-32.png" alt="Pulse" width="34" height="34">
          <div>
            <div class="more-sheet-brand-title">Family Pulse</div>
            <div class="more-sheet-brand-copy">Reports, categories, settings</div>
          </div>
        </div>
        ${moreItems.map(item => {
          const active = item.id === activePage ? ' active' : '';
          return `<a href="${item.href}" class="more-sheet-item${active}">
            <span class="nav-icon">${icons[item.icon]}</span>
            <span>${item.label}</span>
          </a>`;
        }).join('')}
      </div>`;
  }

  // ── Inject into DOM ─────────────────────────────────────────

  document.body.insertBefore(sidebar, document.body.firstChild);
  document.body.appendChild(bottomBar);
  document.body.appendChild(moreSheet);
  document.body.classList.add('app-has-nav');

  // ── More sheet toggle ───────────────────────────────────────

  function toggleMoreSheet() {
    moreSheet.classList.toggle('hidden');
  }

  const moreBtnEl = document.getElementById('more-nav-btn');
  if (moreBtnEl) {
    moreBtnEl.addEventListener('click', toggleMoreSheet);
    moreSheet.querySelector('.more-sheet-backdrop').addEventListener('click', toggleMoreSheet);
  }
})();
