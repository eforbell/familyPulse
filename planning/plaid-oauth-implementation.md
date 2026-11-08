# Plaid OAuth Implementation and Requirements

This document describes what Family Pulse now requires to satisfy Plaid OAuth redirect
expectations for institutions such as Chase and Capital One, and how the current code
implements that flow.

It is intended to be the operational reference for this repository. Older planning docs
may describe an earlier design.

## Goal

Support Plaid Link for OAuth-required institutions without exposing the full app
publicly. Only the Plaid callback endpoint is public; the rest of the app remains
internal.

## Public Redirect URI

Plaid must be configured with this exact allowed redirect URI:

```text
https://plaid-callback.yourdomain.com/oauth/callback
```

This value must exactly match:

- the URI registered in the Plaid Dashboard
- the URI used in `PLAID_OAUTH_REDIRECT_URI`
- the Cloudflare Tunnel hostname/path rule

Any mismatch will break OAuth resume.

## Required Environment Variables

Family Pulse expects these values in production:

```bash
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=production
PLAID_OAUTH_REDIRECT_URI=https://plaid-callback.yourdomain.com/oauth/callback
APP_URL=http://erebor:3003
```

Notes:

- `PLAID_OAUTH_REDIRECT_URI` is injected into Plaid link token creation in
  [lib/plaid-client.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/plaid-client.js#L103).
- `APP_URL` is used only to build the post-success "Return to Settings" link shown on the
  callback page in [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js#L13).
- `APP_URL` should point to the internal URL users actually use for Family Pulse. It does
  not need to be public.

## Network and Tunnel Requirements

The app currently listens on port `3003` in
[server.js](/Volumes/DATA/workspace/homeApps/familyPulse/server.js#L10).

Cloudflare Tunnel must route:

```yaml
ingress:
  - hostname: plaid-callback.yourdomain.com
    path: /oauth/callback
    service: http://localhost:3003
  - service: http_status:404
```

Only `GET /oauth/callback` needs to be public, and it holds nothing: it redirects the
browser to Pulse's own address (`APP_URL`), where the link finishes behind sign-in. A tunnel
or nginx block for the callback host should forward that one path and nothing else. If
cloudflared's path is a pattern, anchor it: `^/oauth/callback$`.

## Current Application Flow

### 1. User starts Plaid Link from Settings

The Settings page creates a link token via `POST /api/link/create-token` in
[lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js#L284).

That endpoint:

- creates the Plaid link token
- stores a `link_sessions` row with status `pending`
- returns both `link_token` and `link_session_id`

The browser then initializes Plaid Link and holds that session ID client-side in
[public/settings.js](/Volumes/DATA/workspace/homeApps/familyPulse/public/settings.js#L81).

### 2. Plaid redirects back for OAuth institutions

For OAuth institutions, Plaid redirects the browser to:

```text
GET /oauth/callback?oauth_state_id=...
```

That address can be public, so the route answers anyone. It changes nothing and holds
nothing: it checks the query has exactly one `oauth_state_id` and redirects (303) to
`APP_URL/oauth-return.html` with the query exactly as it came. There is no
`POST /oauth/callback`.

### 3. The return page resumes Link behind sign-in

`public/oauth-return.html` (with `oauth-return.js`) is served without sign-in, because the
browser arrives from another site and so brings no sign-in cookie (it is `SameSite=Strict`).
The page changes nothing on load. It takes Plaid's query off the address bar, so a reload
has nothing to send, and posts it once to `POST /api/link/oauth-resume`. That same-origin
request does carry the cookie, and the route is parent-only. It finds the one pending link
session, refusing if there are none or several, and returns:

- the session's `link_token`
- its `link_session_id`
- `received_redirect_uri`: `PLAID_OAUTH_REDIRECT_URI` plus Plaid's query, the exact URL
  Plaid redirected to

It stores nothing: anyone can put an `oauth_state_id` in a link to the return page, and only
Plaid can tell a real one.

The page then calls `Plaid.create({ token, receivedRedirectUri })`. A browser that isn't
signed in to Pulse (for example, a bank app that reopened a different browser) is told to
sign in and start again.

### 4. The completed session is exchanged through the normal route

`onSuccess` posts `public_token` and `link_session_id` to `POST /api/link/exchange`, the same
signed-in route Settings uses, which exchanges the token and marks that session `exchanged`.

## Normal Link and Update Mode Behavior

Non-OAuth institutions still use `POST /api/link/exchange`, but the request now includes
`link_session_id` from the original token-creation response.

This is implemented in:

- [public/settings.js](/Volumes/DATA/workspace/homeApps/familyPulse/public/settings.js#L98)
- [public/settings.js](/Volumes/DATA/workspace/homeApps/familyPulse/public/settings.js#L137)
- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js#L350)

That change prevents race conditions where multiple pending Link sessions exist at once.

## Database Requirements

OAuth resume depends on the `link_sessions` table created in
[db/migrations/002-link-sessions.sql](/Volumes/DATA/workspace/homeApps/familyPulse/db/migrations/002-link-sessions.sql#L1).

Required fields:

- `link_token`
- `oauth_state_id`
- `status`
- `owner`
- `item_id_for_update`
- `expires_at`

Operational expectations:

- pending sessions expire after 4 hours
- only pending, unexpired sessions may be resumed
- OAuth binding is only allowed when there is a single unbound pending session available

## What Plaid Expects From This App

To satisfy Plaid OAuth behavior, this app must continue to do all of the following:

1. Create the original link token with `redirect_uri` set to the public callback URL.
2. Accept `GET /oauth/callback?oauth_state_id=...` on a publicly reachable HTTPS host, and
   send the browser on to `APP_URL`.
3. Resume Plaid Link with the original `link_token`.
4. Pass `receivedRedirectUri` as the full callback URL returned by Plaid.
5. Exchange the resulting `public_token` server-side.
6. Persist enough state to correlate the resumed callback with the original Link session.

If any of those fail, OAuth institutions may show blank redirects, silent failures, or
session mismatch errors.

## Operational Checklist

Before testing Chase, Capital One, or another OAuth institution:

1. Confirm `PLAID_OAUTH_REDIRECT_URI` is set to `https://plaid-callback.yourdomain.com/oauth/callback`.
2. Confirm `APP_URL` points to the internal Family Pulse URL users should return to.
3. Confirm the Cloudflare Tunnel routes only `/oauth/callback` to Pulse.
4. Confirm the Plaid Dashboard allowed redirect URIs include the exact callback URL.
5. Confirm the target institution is enabled/approved in Plaid for OAuth use.
6. Confirm the app has run migration `002-link-sessions.sql`.

## Known Limits and Assumptions

- Resuming assumes there is one link in progress. If several pending sessions exist (an
  abandoned Link stays pending for 4 hours), the resume is refused rather than guessed, and
  the member starts again from Settings.
- The callback page relies on Plaid's hosted JS SDK from `https://cdn.plaid.com/`.
- The tunnel only needs to be live during Link initiation and OAuth callback completion.
  Routine syncs do not depend on it.

## Relevant Code

- [lib/plaid-client.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/plaid-client.js)
- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)
- [public/settings.js](/Volumes/DATA/workspace/homeApps/familyPulse/public/settings.js)
- [db/migrations/002-link-sessions.sql](/Volumes/DATA/workspace/homeApps/familyPulse/db/migrations/002-link-sessions.sql)
- [test/link-api.test.js](/Volumes/DATA/workspace/homeApps/familyPulse/test/link-api.test.js)
