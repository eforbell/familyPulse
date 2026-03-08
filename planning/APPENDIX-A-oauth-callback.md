# Appendix A: OAuth Callback Infrastructure (Chase & Major Bank Connectivity)

**Status:** Requires setup before Phase 1 production testing  
**Blocking:** Chase account connections (primary checking for Eric and Alex)  
**Date identified:** March 8, 2026

---

## The Problem

Major financial institutions — notably Chase, Wells Fargo, and Bank of America — require
OAuth-based Plaid Link flows. Plaid's OAuth flow requires a publicly resolvable HTTPS
redirect URI to complete the account linking handshake. Family Pulse runs exclusively on
`erebor` behind a Tailscale tailnet with no publicly forwarded ports, so there is no
valid public callback URL by default.

Chase is a primary checking institution for both Eric and Alex. This is not an optional
institution — it must be resolved before production account linking can proceed.

---

## The Solution: Cloudflare Tunnel

Expose **only** the OAuth callback endpoint publicly via a Cloudflare Tunnel using the
existing `forbell.com` domain. This approach:

- Requires no open ports on erebor
- Requires no static public IP
- Requires no running EC2 instance
- Is free on Cloudflare's free tier
- Keeps all other Family Pulse traffic Tailscale-only

The tunnel is an **outbound** connection from erebor to Cloudflare's edge — no inbound
firewall rules required.

### Registered Redirect URI

```
https://plaid-callback.forbell.com/oauth/callback
```

This URI must be registered in two places:
1. Plaid Dashboard → OAuth → Allowed redirect URIs
2. Chase OAuth application registration (via Plaid's institution OAuth setup flow)

---

## Traffic Flow

```
Chase / Plaid OAuth callback
          ↓
https://plaid-callback.forbell.com/oauth/callback   ← public, Cloudflare TLS
          ↓
Cloudflare Tunnel (cloudflared daemon running on erebor)
          ↓
http://localhost:3004/oauth/callback                ← Family Pulse Express handler
          ↓
Plaid token exchange → access_token stored in PostgreSQL
```

All other application traffic (dashboard, API, sync) remains Tailscale-only and is
unaffected by this configuration.

---

## Important: Tunnel Is Only Needed for Account Linking

The Cloudflare Tunnel is only in the request path during the **initial Plaid Link OAuth
flow** — the one-time account connection ceremony per institution. Once an `access_token`
is stored in the database, all subsequent Plaid API calls (sync, balances, liabilities)
are outbound server-to-server calls from erebor and do not touch the tunnel at all.

The tunnel can be left running as a persistent daemon with negligible resource cost, or
brought up only when linking new accounts.

---

## Setup Instructions

### 1. Point forbell.com to Cloudflare (if not already)
Update nameservers at your registrar to Cloudflare's NS records. Free plan is sufficient.

### 2. Install cloudflared on erebor

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
  -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

### 3. Authenticate and create tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create familypulse
```

Note the tunnel UUID output — needed for config.

### 4. Create tunnel config

```yaml
# /home/ubuntu/.cloudflared/config.yml
tunnel: <TUNNEL_UUID>
credentials-file: /home/ubuntu/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: plaid-callback.forbell.com
    path: /oauth/callback
    service: http://localhost:3004
  - service: http_status:404   # reject all other requests
```

The `path` filter ensures only `/oauth/callback` is routed through — all other requests
to `plaid-callback.forbell.com` return 404. This is intentional.

### 5. Create DNS record in Cloudflare

```bash
cloudflared tunnel route dns familypulse plaid-callback.forbell.com
```

This creates a `CNAME` pointing `plaid-callback.forbell.com` to the Cloudflare Tunnel
edge automatically.

### 6. Run as a system service on erebor

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

### 7. Register redirect URI in Plaid Dashboard

Navigate to: Plaid Dashboard → Team Settings → API → Allowed redirect URIs

Add: `https://plaid-callback.forbell.com/oauth/callback`

### 8. Complete Chase OAuth registration in Plaid

Navigate to: Plaid Dashboard → Compliance Center → OAuth Registration

Complete app name, logo, and required fields. Specify the redirect URI above.
Chase review typically takes 2–4 weeks — **initiate this early**, in parallel with
Phase 1 development.

---

## Express Handler Notes for Claude Code

The OAuth callback handler in Family Pulse must:

1. Receive the callback with `?oauth_state_id=` query parameter from Plaid
2. Reconstruct the Plaid Link session and complete token exchange
3. Store the resulting `access_token` and `item_id` in the `items` table
4. Redirect the user back to the dashboard

```javascript
// src/routes/oauth.js
router.get('/oauth/callback', async (req, res) => {
  const { oauth_state_id } = req.query;
  // Retrieve pending link session by oauth_state_id
  // Complete Plaid public_token exchange
  // Store access_token in items table
  // Redirect to dashboard
  res.redirect('http://erebor:3004/dashboard?linked=true');
});
```

The final redirect goes back to the Tailscale-internal dashboard URL — the public
tunnel is only used for the inbound callback leg.

---

## Environment Variables to Add

```bash
# .env additions for OAuth support
PLAID_OAUTH_REDIRECT_URI=https://plaid-callback.forbell.com/oauth/callback
APP_URL=http://erebor.tail<tailnet-id>.ts.net:3004   # or tailnet hostname
```

---

## Affected Institutions

| Institution | OAuth Required | Status |
|-------------|---------------|--------|
| Chase | Yes | Pending OAuth registration |
| Capital One | Yes (likely) | Verify in Plaid dashboard |
| Other Eric credit cards | TBD | Verify per institution |
| Alex credit cards | TBD | Verify per institution |

Verify each institution's OAuth requirement via:  
Plaid Dashboard → Compliance Center → Access OAuth Institutions → View Institutions

---

## Alternative Approaches Considered

| Approach | Verdict |
|----------|---------|
| Cloudflare Tunnel | ✅ Selected — free, no open ports, purpose-built for this |
| AWS Lambda OAuth relay | Workable but adds cost and complexity vs. Cloudflare |
| EC2 with public IP | Expensive, unnecessary for a callback-only endpoint |
| Teller.io for Chase accounts | Valid fallback if Chase OAuth registration is rejected; Teller and Plaid can coexist writing to the same transactions table |

---

*This appendix should be resolved before beginning Phase 2 production testing.  
Cloudflare Tunnel setup can be completed in under an hour.*
