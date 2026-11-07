'use strict';

// Passkey checks in tailnet mode (wire contract, section 8). Home Base serves its step-up helper on this hostname at
// /_sovereign/auth/stepup.js: it asks for a tap, runs the passkey check with Home Base, and sets the cookie Family
// Pulse reads. In local mode nothing asks for a check, so the helper loads only when an answer asks for one.
(function pulsePasskey() {
  const HELPER = '/_sovereign/auth/stepup.js';
  const UNAVAILABLE = 'Family Pulse couldn\'t reach Home Base for a passkey check. Try again in a minute.';
  const CANCELLED = 'This needs a check with your passkey first.';
  const NOT_ACCEPTED = 'Your passkey check didn\'t go through. Try again.';
  let helper = null;

  function loadHelper() {
    if (window.SovereignStepUp) return Promise.resolve(window.SovereignStepUp);
    if (!helper) {
      helper = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = HELPER;
        script.onload = () => (window.SovereignStepUp ? resolve(window.SovereignStepUp) : reject(new Error(UNAVAILABLE)));
        script.onerror = () => { helper = null; script.remove(); reject(new Error(UNAVAILABLE)); };
        document.head.append(script);
      });
    }
    return helper;
  }

  async function stepUpAsked(res) {
    if (res.status !== 401) return null;
    const body = await res.clone().json().catch(() => null);
    return body && body.error === 'step_up_required' ? body : null;
  }

  // fetch, and when the answer asks for a passkey check: the check, then the same request once more. The body must be
  // a string (or absent), so the retry sends exactly what was asked.
  async function passkeyFetch(url, init = {}) {
    const first = await fetch(url, init);
    const stepUp = await stepUpAsked(first);
    if (!stepUp) return first;
    if ((await (await loadHelper()).satisfy(stepUp)) === false) throw new Error(CANCELLED);
    const retry = await fetch(url, init);
    if (await stepUpAsked(retry)) throw new Error(NOT_ACCEPTED);
    return retry;
  }

  // The page Family Pulse answers with when a parent opens it without a current check: run the check, then reload.
  function checkOnOpen(main) {
    const status = document.getElementById('passkey-status');
    const retry = document.getElementById('passkey-retry');
    let stepUp;
    try { stepUp = JSON.parse(main.dataset.stepUp); } catch { stepUp = null; }
    async function run() {
      retry.hidden = true;
      status.textContent = '';
      try {
        if (!stepUp) throw new Error(NOT_ACCEPTED);
        if ((await (await loadHelper()).satisfy({ ...stepUp, message: 'Check with your passkey to open Family Pulse.' })) !== false) {
          window.location.reload();
          return;
        }
        status.textContent = CANCELLED;
      } catch (err) {
        status.textContent = err.message || NOT_ACCEPTED;
      }
      retry.hidden = false;
    }
    retry.addEventListener('click', run);
    run();
  }

  window.PulsePasskey = { fetch: passkeyFetch };
  const main = document.getElementById('passkey-check');
  if (main) checkOnOpen(main);
})();
