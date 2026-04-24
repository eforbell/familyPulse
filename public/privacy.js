'use strict';

(function () {
  const STORAGE_KEY = 'pulse-privacy-mode';

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  }

  function apply(enabled) {
    document.documentElement.classList.toggle('privacy-mode', enabled);
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
