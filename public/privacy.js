'use strict';

(function () {
  const STORAGE_KEY = 'pulse-privacy-mode';

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  }

  let observer = null;

  function bindRevealHandlers(el) {
    if (el.dataset.privacyBound === '1') return;
    el.addEventListener('mouseenter', () => {
      if (isEnabled()) el.style.filter = 'blur(0px)';
    });
    el.addEventListener('mouseleave', () => {
      if (isEnabled()) el.style.filter = 'blur(7px)';
    });
    el.dataset.privacyBound = '1';
  }

  function syncNodes(enabled) {
    const amountSelectors = ['.fp-amount', '#net-amount', '#balance-amount', '#tx-stats .value', '.tx-amount', '.strip-meta', '.summary-value', '.summary-prior', '.history-net-delta', '.hc-ylabels span'];
    document.querySelectorAll(amountSelectors.join(', ')).forEach((el) => {
      el.classList.toggle('private-blur', enabled);
      bindRevealHandlers(el);
      el.style.filter = enabled ? 'blur(7px)' : '';
      el.style.userSelect = enabled ? 'none' : '';
    });

    document.querySelectorAll('canvas, .hc-plot svg').forEach((el) => {
      el.classList.toggle('private-blur-canvas', enabled);
      el.style.filter = enabled ? 'blur(7px)' : '';
    });
  }

  function ensureObserver() {
    if (observer || typeof MutationObserver === 'undefined') return;
    observer = new MutationObserver(() => syncNodes(isEnabled()));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function apply(enabled) {
    document.documentElement.classList.toggle('privacy-mode', enabled);
    ensureObserver();
    syncNodes(enabled);
    requestAnimationFrame(() => syncNodes(enabled));
    setTimeout(() => syncNodes(enabled), 0);
    setTimeout(() => syncNodes(enabled), 150);
    window.dispatchEvent(new CustomEvent('pulse:privacy-change', { detail: { enabled } }));
  }

  function setEnabled(enabled) {
    if (enabled) localStorage.setItem(STORAGE_KEY, 'on');
    else localStorage.removeItem(STORAGE_KEY);
    apply(enabled);
  }

  window.PulsePrivacy = {
    isEnabled,
    toggle() { setEnabled(!isEnabled()); },
    setEnabled,
  };

  apply(isEnabled());
})();
