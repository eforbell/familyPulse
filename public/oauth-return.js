'use strict';

// Where a bank's sign-in comes back to (lib/routes/link.js, "Bank sign-in return"). The page itself changes nothing
// and is served without sign-in, because the browser arrives here from another site and so brings no sign-in cookie.
// It takes Plaid's return off the address bar, so a reload has nothing to send, and asks Pulse once, with a
// same-origin request that does carry sign-in, to resume the link. Plaid Link then finishes it, and the account is
// saved through the same exchange Settings uses.
(function finishBankLink() {
  const statusEl = document.getElementById('status-msg');

  function say(text, { busy = false, back = false } = {}) {
    statusEl.textContent = '';
    const line = document.createElement('div');
    if (busy) line.className = 'loading-pulse';
    line.textContent = text;
    if (back) {
      const link = document.createElement('a');
      link.href = 'settings.html';
      link.textContent = 'Back to Settings';
      line.append(' ', link);
    }
    statusEl.append(line);
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Sign in to Family Pulse in this browser, then link the bank again from Settings');
    if (!res.ok) throw new Error(data.error || `Pulse answered ${res.status}`);
    return data;
  }

  const query = window.location.search.slice(1);
  window.history.replaceState(null, '', window.location.pathname);
  if (!new URLSearchParams(query).get('oauth_state_id')) {
    say('Nothing to finish here.', { back: true });
    return;
  }

  postJson('api/link/oauth-resume', { query })
    .then((resume) => {
      const handler = window.Plaid.create({
        token: resume.link_token,
        receivedRedirectUri: resume.received_redirect_uri,
        onSuccess: async (publicToken) => {
          say('Linking accounts…', { busy: true });
          try {
            await postJson('api/link/exchange', { public_token: publicToken, link_session_id: resume.link_session_id });
            say('Connected.', { back: true });
          } catch (err) {
            say(`Connection failed: ${err.message}.`, { back: true });
          }
        },
        onExit: (err) => {
          say(err ? `Connection interrupted: ${err.display_message || err.error_code}.` : 'Connection cancelled.', { back: true });
        }
      });
      handler.open();
    })
    .catch((err) => say(`Couldn't finish the bank link: ${err.message}.`, { back: true }));
})();
