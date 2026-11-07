'use strict';

// Passkey checks in tailnet mode (wire contract, section 8). Home Base serves its step-up helper on this hostname at
// /_sovereign/auth/stepup.js: it asks for a tap, runs the passkey check with Home Base, and sets the cookie Family
// Pulse reads. In local mode nothing asks for a check, so the helper loads only when an answer asks for one.
(function pulsePasskey() {
  const HELPER = '/_sovereign/auth/stepup.js';
  const UNAVAILABLE = 'Family Pulse couldn\'t reach Home Base for a passkey check. Try again in a minute.';
  const CANCELLED = 'This needs a check with your passkey first.';
  const NOT_ACCEPTED = 'Your passkey check didn\'t go through. Try again.';
  const STILL_REFUSED = 'Your passkey check went through, but Family Pulse couldn\'t confirm it yet. Try again in a minute.';
  const RELOADED = 'pulse-passkey-reloaded';
  let helper = null;

  function loadHelper() {
    if (window.SovereignStepUp) return Promise.resolve(window.SovereignStepUp);
    if (!helper) {
      helper = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = HELPER;
        const failed = () => { helper = null; script.remove(); reject(new Error(UNAVAILABLE)); };
        script.onload = () => (window.SovereignStepUp ? resolve(window.SovereignStepUp) : failed());
        script.onerror = failed;
        document.head.append(script);
      });
    }
    return helper;
  }

  // One check at a time: requests sent together (Settings saves its alert settings in parallel) share it, since one
  // check sets the cookie each of them reads. A request whose answer comes back after a check has ended takes the
  // outcome of the first check that ended after it was sent: the one its batch shared. So a late answer neither asks
  // again after a cancel nor saves part of what the member cancelled, even once a later save has been checked.
  let checking = null;
  const ended = [];   // every check that ended, oldest first: { at, outcome: null (through), false (cancelled), or an error }
  const settle = (outcome) => { ended.push({ at: performance.now(), outcome }); };
  function satisfyOnce(stepUp, sentAt) {
    const earlier = ended.find((check) => check.at > sentAt);
    if (earlier) return earlier.outcome instanceof Error ? Promise.reject(earlier.outcome) : Promise.resolve(earlier.outcome);
    if (!checking) {
      checking = loadHelper().then((h) => h.satisfy(stepUp)).then(
        (done) => { settle(done === false ? false : null); return done; },
        (err) => { settle(err); throw err; },
      ).finally(() => { checking = null; });
    }
    return checking;
  }

  async function stepUpAsked(res) {
    if (res.status !== 401) return null;
    const body = await res.clone().json().catch(() => null);
    return body && body.error === 'step_up_required' ? body : null;
  }

  // fetch, and when the answer asks for a passkey check: the check, then the same request once more. The body must be
  // a string (or absent), so the retry sends exactly what was asked.
  async function passkeyFetch(url, init = {}) {
    const sentAt = performance.now();
    const first = await fetch(url, init);
    const stepUp = await stepUpAsked(first);
    if (!stepUp) return first;
    if ((await satisfyOnce(stepUp, sentAt)) === false) throw new Error(CANCELLED);
    const retry = await fetch(url, init);
    if (await stepUpAsked(retry)) throw new Error(NOT_ACCEPTED);
    return retry;
  }

  // The page Family Pulse answers with when a parent opens it without a current check: run the check, then reload. If
  // this page comes back straight after a check that went through (Home Base's new key or a changed access hasn't
  // reached Family Pulse yet), it waits for a tap rather than looping through checks.
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
          try { sessionStorage.setItem(RELOADED, String(Date.now())); } catch { /* private mode: no loop guard to keep */ }
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
    let reloadedAt = 0;
    try { reloadedAt = Number(sessionStorage.getItem(RELOADED)) || 0; sessionStorage.removeItem(RELOADED); } catch { /* as above */ }
    if (Date.now() - reloadedAt < 60 * 1000) {
      status.textContent = STILL_REFUSED;
      retry.hidden = false;
      return;
    }
    run();
  }

  window.PulsePasskey = { fetch: passkeyFetch };
  const main = document.getElementById('passkey-check');
  if (main) checkOnOpen(main);
})();
