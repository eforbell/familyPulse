# Plaid Sandbox OAuth Test Runbook

This runbook captures the minimum sandbox OAuth validation Family Pulse should complete
before moving Plaid Link usage toward production institutions.

Primary Plaid references:

- OAuth guide: https://plaid.com/docs/link/oauth/
- Sandbox overview: https://plaid.com/docs/sandbox/
- Sandbox institutions: https://plaid.com/docs/sandbox/institutions/
- Sandbox test credentials: https://plaid.com/docs/sandbox/test-credentials/
- Link API reference: https://plaid.com/docs/api/link/

## Goal

Prove that Family Pulse can complete a full Plaid OAuth redirect cycle in sandbox:

1. create a link token with `redirect_uri`
2. launch Plaid Link
3. receive the public redirect at `/oauth/callback?oauth_state_id=...`
4. resume Link with `receivedRedirectUri`
5. exchange the returned `public_token`
6. persist the Item and accounts

This is not about transaction freshness. It is specifically about showing Plaid that the
app can correctly handle OAuth-required institutions.

## Environment

Run the app with:

```bash
PLAID_ENV=sandbox
PLAID_OAUTH_REDIRECT_URI=https://plaid-callback.forbell.com/oauth/callback
APP_URL=http://erebor:3003
PORT=3003
```

Notes:

- `PLAID_OAUTH_REDIRECT_URI` must exactly match the Plaid allowlist entry.
- `APP_URL` is only used for the "Return to Settings" link after success.
- Keep the Cloudflare Tunnel running so `plaid-callback.forbell.com` reaches the app.

## Recommended Sandbox Institution

Use Plaid's OAuth-capable sandbox institution first:

- `Platypus OAuth Bank`
- Institution ID: `ins_127287`

Reason:

- Plaid documents this as the standard sandbox institution for exercising OAuth flows.
- It is a better first test than Chase. Plaid notes that some major institutions in
  sandbox may depend on production access and completed OAuth registration.

## Expected Sandbox Behavior

Plaid's sandbox OAuth flow is not meant to perfectly mimic each real bank's branded
experience. For sandbox OAuth institutions, Plaid may show a sample OAuth flow instead of
the real institution's production UI.

For a basic successful sandbox OAuth run:

- you can usually proceed through the sample OAuth flow without relying on complex
  credentials
- many sandbox OAuth steps accept arbitrary or blank credentials
- the important validation is the redirect/resume/exchange path, not bank-specific login
  realism

## Pre-Flight Checklist

Before testing:

1. Confirm Family Pulse is running locally on port `3003`.
2. Confirm the Cloudflare Tunnel routes `https://plaid-callback.forbell.com/oauth/callback`
   to `http://localhost:3003`.
3. Confirm Plaid Dashboard allowlists:
   `https://plaid-callback.forbell.com/oauth/callback`
4. Confirm `.env` contains sandbox credentials and the redirect URI above.
5. Confirm the `link_sessions` migration has already been applied.

## Test Procedure

### 1. Start the app

Launch Family Pulse normally and open the Settings page.

### 2. Start Link

Click `+ Link Account`.

Expected app behavior:

- `POST /api/link/create-token` succeeds
- a `link_sessions` row is stored with status `pending`
- the response includes `link_token` and `link_session_id`

### 3. Choose the sandbox OAuth institution

In Plaid Link, select:

- `Platypus OAuth Bank`

### 4. Complete the sandbox OAuth flow

Proceed through the OAuth steps presented by Plaid.

Expected browser behavior:

- the browser is redirected to:
  `https://plaid-callback.forbell.com/oauth/callback?oauth_state_id=...`

### 5. Confirm callback resume

Expected app behavior at callback:

- `GET /oauth/callback` accepts `oauth_state_id`
- the app finds or binds the matching pending link session
- the callback page reinitializes Plaid Link using the original `link_token`
- the callback page passes `receivedRedirectUri: window.location.href`

### 6. Confirm final exchange

After Plaid Link resumes and completes:

- the callback page posts `public_token` and `oauth_state_id` to `POST /oauth/callback`
- Family Pulse exchanges the `public_token`
- the target `link_sessions` row is marked `exchanged`
- an Item is inserted or updated
- accounts are inserted or updated

### 7. Confirm data landed

Verify in the UI or database:

- the institution appears in Settings
- one or more accounts exist for the new Item
- the Item status is `good`

## Success Criteria

The sandbox OAuth test passes when all of the following are true:

- Link opens successfully in sandbox
- the OAuth institution redirects back to the public callback URL
- the callback page resumes Plaid Link without creating a brand-new link token
- `public_token` exchange succeeds
- the Item and accounts are stored in PostgreSQL

## Failure Modes to Watch For

- Redirect URI mismatch between app config and Plaid allowlist
- Cloudflare Tunnel path mismatch
- callback receives `oauth_state_id` but no pending session can be resumed
- callback page tries to call a non-public API route instead of posting back to
  `/oauth/callback`
- sandbox test accidentally uses a non-OAuth institution and never exercises the redirect
  path

## Recommended Evidence to Save

If Plaid asks for confirmation during production enablement, keep:

- screenshot of the successful callback page
- screenshot of the linked sandbox institution in Settings
- timestamped log lines showing callback receipt and token exchange
- a note that the sandbox institution used was `Platypus OAuth Bank (ins_127287)`

## Family Pulse Code Paths

Relevant implementation files:

- [lib/plaid-client.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/plaid-client.js)
- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)
- [public/settings.js](/Volumes/DATA/workspace/homeApps/familyPulse/public/settings.js)
- [planning/plaid-oauth-implementation.md](/Volumes/DATA/workspace/homeApps/familyPulse/planning/plaid-oauth-implementation.md)
