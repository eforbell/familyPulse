# Feature 10: Household Authentication

## Purpose

Add simple passphrase-based authentication with persistent sessions so family members have enforced identities. Parents see everything; kids see only their linked accounts. Replaces the trust-based localStorage member picker with real server-side auth.

## Why This Is Worth Shipping

Plaid expects responsible access control around financial data. More importantly, the Kids View (Feature 6) can't ship safely without server-enforced data scoping — UI hiding is security by obscurity. This feature makes identity real and unlocks role-based access for everything downstream.

## Scope

1. Passphrase hashing (Node crypto.scryptSync) — no external dependencies
2. Session management: crypto.randomUUID tokens in DB, 30-day HttpOnly cookies
3. Auth middleware on all API routes (except health + login)
4. Login page: pick your name, enter your passphrase
5. Role enforcement: parent = full access, kid = scoped to linked accounts
6. Account-to-member linking (account_members table, parent configures in settings)
7. Admin passphrase management: Eric sets all passphrases, distributes via 1Password

## Key Design Decisions

- **No self-service password flow** — Eric sets passphrases and pushes them via 1Password. Household app, not a SaaS product
- **Two roles only** — parent and kid. No guest, no read-only, no RBAC matrix
- **30-day sessions** — login once, stay logged in. No constant re-auth friction
- **Server-side scoping** — kid data filtering happens at the query level, not UI hiding
- **No Secure cookie flag** — app runs over Tailscale (private network), not public internet
- **HttpOnly + SameSite=Strict** — cookies not accessible to JS, no CSRF risk

## Definition of Done

- All API routes require valid session (except health, login, static assets)
- Login page renders, authenticates, sets session cookie, redirects to dashboard
- Parents can set passphrases for any family member via settings
- Members without passphrases cannot log in
- Kid role sees only their linked accounts' data across all pages
- Kid role cannot access settings, admin, link, or import pages
- Passphrase hashes never appear in API responses or logs
- Auth logic has comprehensive unit tests (hash, session, middleware, role scoping)
- localStorage member picker removed — identity comes from authenticated session
