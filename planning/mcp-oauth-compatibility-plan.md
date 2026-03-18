# MCP OAuth Compatibility Plan

## Status

Deferred research and implementation plan for making the Family Pulse MCP server compatible with Claude Desktop remote connectors.

As of March 18, 2026:

- The MCP server works with Claude Code over Tailscale Serve.
- The MCP server works with direct `curl` requests against the remote HTTPS endpoint.
- Static bearer auth via `MCP_AUTH_TOKEN` works for Claude Code.
- Disabling `MCP_AUTH_TOKEN` does not make Claude Desktop connect successfully.
- Claude Desktop opens a browser and returns to the app, which strongly suggests it is attempting an OAuth-based remote connector flow.

## Verified Current State

### MCP transport

- Remote endpoint is served over Tailscale Serve on a service-specific port.
- Working endpoint shape:
  - `https://family-pulse-mcp.<tailnet-domain>:3004/mcp`
- MCP server supports Streamable HTTP and multi-session transport correctly.

### App auth pieces already available

- Family Pulse already has parent/kid authentication and session handling.
- Family Pulse already has publicly served HTTPS app infrastructure.
- Family Pulse already has Plaid OAuth callback handling for institution link flows.
- Family Pulse already has user-facing account/data authorization concepts that can inform MCP scope and consent design.

### Important limitation

- The existing Plaid OAuth support is not directly reusable as Claude Desktop OAuth support.
- Plaid integration makes Family Pulse an OAuth client to Plaid.
- Claude Desktop compatibility requires Family Pulse to act as an OAuth authorization server / protected resource for the MCP server.

## Why Claude Desktop Is Blocked

The current MCP server exposes:

- `/mcp`
- `/health`

It does not expose OAuth endpoints or metadata for a remote MCP auth flow.

Likely missing pieces:

- OAuth authorization endpoint
- OAuth token endpoint
- Protected resource metadata endpoint
- Authorization server metadata endpoint
- Client registration story (dynamic or manual)
- Bearer token validation on MCP requests using OAuth-issued tokens

## Goal

Allow Claude Desktop to connect to Family Pulse as a remote MCP server without requiring ad hoc static bearer headers, while preserving the app's read-only MCP security model.

## Non-Goals

- Replacing the existing Claude Code setup
- Reworking Plaid OAuth flows
- Shipping broad third-party API access beyond the MCP use case
- Designing a multi-tenant authorization system

## Proposed Architecture

### 1. Keep the MCP server as the protected resource

The MCP process remains responsible for:

- tool registration
- data access
- read-only response shaping
- final bearer token enforcement for MCP requests

### 2. Add OAuth endpoints on the main Family Pulse app

Prefer implementing OAuth endpoints on the existing app server rather than inside the separate MCP process.

Candidate endpoints:

- `GET /oauth/authorize`
- `POST /oauth/token`
- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-authorization-server`

Optional later:

- dynamic client registration endpoint

### 3. Reuse Family Pulse login/session state

The authorization endpoint should:

- require an authenticated parent session
- reject kid sessions
- present a consent screen for MCP access
- mint an authorization code tied to the parent and approved scopes

### 4. Issue narrow MCP tokens

OAuth access tokens should be scoped to read-only MCP access.

Initial scope model can stay very small:

- `mcp:tools`

Optional later:

- finer-grained scopes by tool family
- revocation UI
- token management UI

### 5. Validate OAuth bearer tokens in the MCP server

Replace or augment `MCP_AUTH_TOKEN` logic so the MCP server can validate:

- OAuth-issued bearer tokens
- expiration
- scope
- subject / parent identity

## Likely Data Model Additions

New tables will probably be needed for some or all of:

- OAuth clients
- authorization codes
- access tokens
- refresh tokens
- consent grants

Implementation choice:

- opaque tokens stored in Postgres are likely simpler and safer than self-signed JWTs for this app
- start with opaque tokens unless a client interoperability reason appears

## Minimum Viable Implementation

### Phase 1: Manual client configuration

Ship the smallest working Claude Desktop-compatible flow first:

- protected resource metadata
- authorization server metadata
- authorization code + PKCE flow
- manual client ID / secret configuration instead of dynamic registration
- parent-only consent
- opaque access tokens with short TTL

This avoids needing full DCR on day one.

### Phase 2: Better operations

- refresh tokens
- grant revocation
- audit logging
- token cleanup cron
- better consent UX

### Phase 3: Optional DCR

If Claude Desktop setup friction remains high, add dynamic client registration later.

## Security Constraints

- Only parent accounts may authorize MCP access.
- Tokens must never expose Plaid access tokens, OpenAI keys, or raw secrets.
- MCP remains read-only.
- OAuth grants should be explicitly revocable.
- Access tokens should be short-lived.
- Refresh tokens, if added, should be server-stored and revocable.
- Consent should clearly describe that Claude can read Family Pulse financial data through MCP tools.

## Open Questions

1. Does Claude Desktop require OAuth for all remote connectors in practice, or can some authless flows work under narrower conditions?
2. Does Claude Desktop fully support manual client ID / secret entry for this use case, or is DCR effectively required for a smooth setup?
3. Does Claude Desktop tolerate non-443 remote MCP URLs, or should the OAuth-capable deployment eventually move behind a standard HTTPS origin?
4. Should OAuth endpoints live on the main app origin, the MCP origin, or a dedicated auth subdomain?
5. Should consent be permanent until revoked, or re-confirmed periodically?

## Recommended Next Implementation Slice

When this work resumes:

1. Confirm the exact Claude Desktop remote MCP OAuth expectations with one more round of official docs review.
2. Add a small PRD for Family Pulse as an OAuth authorization server for MCP.
3. Implement metadata endpoints first.
4. Implement authorization code + PKCE using existing parent session auth.
5. Add opaque token validation to the MCP server.
6. Test with Claude Desktop before adding DCR.

## Notes From Current Debugging

- Claude Code connectivity proves the MCP transport and Tailscale Serve deployment are valid.
- Claude Desktop failing after a browser round-trip points to auth compatibility rather than network reachability.
- Existing Plaid OAuth callback plumbing is useful precedent, but not a substitute for MCP OAuth support.
