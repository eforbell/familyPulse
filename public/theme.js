'use strict';

(function () {
  const STORAGE_KEY = 'pulse-theme';
  const themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function getPreference() {
    return localStorage.getItem(STORAGE_KEY) || 'system';
  }

  function resolveTheme(preference) {
    if (preference === 'light' || preference === 'dark') return preference;
    return themeMedia && themeMedia.matches ? 'light' : 'dark';
  }

  function themeColor(theme) {
    return theme === 'light' ? '#f6f1e8' : '#0f0f0f';
  }

  function setThemeColorMeta(theme) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColor(theme));
  }

  function applyTheme(preference) {
    const resolvedTheme = resolveTheme(preference);
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    document.documentElement.setAttribute('data-theme-preference', preference);
    setThemeColorMeta(resolvedTheme);

    window.dispatchEvent(new CustomEvent('pulse:theme-change', {
      detail: { preference, theme: resolvedTheme }
    }));
  }

  function setPreference(preference) {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
    applyTheme(getPreference());
  }

  window.PulseTheme = {
    getPreference,
    getResolvedTheme() {
      return document.documentElement.getAttribute('data-theme') || resolveTheme(getPreference());
    },
    setPreference,
    applyCurrentTheme() {
      applyTheme(getPreference());
    }
  };

  if (themeMedia && typeof themeMedia.addEventListener === 'function') {
    themeMedia.addEventListener('change', () => {
      if (getPreference() === 'system') applyTheme('system');
    });
  }

  applyTheme(getPreference());
})();
