# Feature 2a: Plaid Link + OAuth Integration

## Purpose

Connect real bank accounts. Feature 1 built the sync engine, Feature 2 built the UI, but
there's no way to actually link institutions from the browser. This sub-feature adds the
Plaid Link flow with OAuth support for Chase, Capital One, Amex, and Citi.

## Why This Is a Sub-Feature (not Feature 3)

This is a missing piece of Feature 2's "see the data" milestone. Without it, the only way
to add Items is direct DB insertion. It's small, focused, and unblocks real-world testing
of everything built so far.

## Scope

1. **Link token API** — create link_tokens for Plaid Link initialization
2. **Token exchange** — receive public_token, exchange for access_token, store Item
3. **OAuth callback** — handle redirect from OAuth institutions (Chase etc.) via Cloudflare Tunnel
4. **Settings page** — manage linked institutions, assign owners, re-link broken connections
5. **Update mode** — re-authenticate Items that have gone into error state

## Architecture

```
Settings page (Tailscale-only)
  ↓ POST api/link/create-token
  ↓ Plaid Link JS SDK opens in browser
  ↓
  ├─ Non-OAuth institutions:
  │   onSuccess → POST api/link/exchange → done
  │
  └─ OAuth institutions (Chase, CapOne, etc.):
      browser redirects to bank login
      bank redirects to https://plaid-callback.yourdomain.com/oauth/callback
        ↓ Cloudflare Tunnel → erebor:3003
        ↓ Serves oauth-callback.html (re-initializes Plaid Link)
        ↓ Plaid Link completes → onSuccess → POST api/link/exchange → done
```

## New Database Table

```sql
CREATE TABLE link_sessions (
  id            SERIAL PRIMARY KEY,
  link_token    TEXT NOT NULL,
  oauth_state_id TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  owner         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
```

Stores pending link sessions so the OAuth callback can resume them. Rows are ephemeral —
cleaned up after exchange or expiry.

## New API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/link/create-token | Create link_token, store in link_sessions |
| POST | /api/link/exchange | Exchange public_token for access_token, store Item |
| GET | /oauth/callback | Serve OAuth resume page (public via Cloudflare Tunnel) |
| POST | /api/link/update-token | Create update-mode link_token for broken Items |
| DELETE | /api/items/:id | Remove linked institution + cascade |
| PUT | /api/items/:id/owner | Assign owner to Item's accounts |
| POST | /api/items/:id/sync | Manual sync trigger for single Item |

## New Files

- `db/migrations/002-link-sessions.sql` — link_sessions table
- `lib/routes/link.js` — Link token, exchange, and OAuth callback routes
- `public/settings.html` — Institution management page
- `public/settings.js` — Settings page client logic
- `public/oauth-callback.html` — Minimal page for OAuth redirect resume
- `test/link-api.test.js` — API tests for link flow

## Modified Files

- `lib/plaid-client.js` — add `createLinkToken()`, `exchangePublicToken()` wrappers
- `server.js` — mount link routes
- `.env.example` — add `PLAID_OAUTH_REDIRECT_URI`
- `public/index.html` — add settings link
- `public/style.css` — settings page styles (if needed)

## Environment Variables Added

| Variable | Required | Notes |
|---|---|---|
| PLAID_OAUTH_REDIRECT_URI | Yes (production) | `https://plaid-callback.yourdomain.com/oauth/callback` |

## Prerequisites

- Cloudflare Tunnel configured and running (see APPENDIX-A-oauth-callback.md)
- All target institutions approved in Plaid Compliance Center
- Plaid redirect URI registered in dashboard

## Definition of Done

- Eric can open settings page, click "Link Account", complete Plaid Link for a sandbox institution
- OAuth flow works end-to-end for an OAuth-required institution (test with Chase in production)
- Linked institutions appear on settings page with correct status
- Owner can be assigned to accounts at link time
- Broken Items show re-link button, update mode works
- Initial sync runs automatically after linking
- Dashboard immediately shows new accounts and transactions
- Tests pass for all link API endpoints
