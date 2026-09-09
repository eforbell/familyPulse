# Operator financial planning access

Reviewed/verified 2026-09-09. Preferred transport: **local STDIO MCP over private SSH**.
The same facade is a JSON CLI; no API key, public listener, new dependency, or remote
OAuth service is required. Do not expose the operational app CLIs to a planning model.

## Installed on this operator workstation

- Codex MCP name: `family-planning` (user configuration, not committed).
- Private config: `~/.config/family-planning/production.json` (0600; parent 0700).
- Server: `mcp/planning-client.js stdio CONFIG`.
- Remote runner: `mcp/remote-stdio.js`, using existing operator SSH authorization to
  `forbell@erebor.manee-discus.ts.net`, then `sudo -n -u sovereign`.
- Remote repos: `/opt/sovereign-home/apps/familyPulse` and `/opt/sovereign-home/apps/helm`.
- Web services remain at `https://home.manee-discus.ts.net`; this service hostname is
  NOT the SSH host. FamilyPulse MCP's backend 3004 need not be proxied by nginx.

```
Codex / supported ChatGPT desktop local MCP host
  -> local planning-client.js (STDIO, tool allowlist)
  -> remote-stdio.js -> SSH / tailnet -> service-user process
       -> FamilyPulse existing MCP tool functions -> production DB
       -> reviewed Helm MCP module -> production DB
```

Helm's reviewed local `mcp_server.py` is encoded and executed in memory against the
remote installed Helm package. No source file is uploaded or deployed. The runner accepts only the expected sibling-repo module path and an explicit
SHA256 pin in the private configuration. Changing that module fails closed until the
operator reviews/tests the change and updates the pin. This detects unreviewed module
changes; it does not sandbox an administrator who can edit the runner/config/SSH setup.
The remote package must stay compatible. Import/tool failures are marked unavailable,
not substituted with local/test data. FamilyPulse runs its existing remote MCP factory
with STDIO instead of starting another HTTP listener.

Both subprocesses set PostgreSQL `default_transaction_read_only=on` and a 20-second
statement timeout. Both settings were checked against the production database sessions.
This is defense in depth, **not a database-role privilege boundary**: operator SSH/sudo
is still administrative access. A dedicated forced-command SSH key and SELECT-only DB
roles would narrow credential authority further; none were created automatically.
No database/broker secrets are copied to this Mac or put in MCP config. SSH host-key
checking and batch mode remain enabled; failures never fall back to anonymous access.

## Use it

In a new conversation with the local MCP server loaded:

> Use family-planning to retrieve my family planning context. First report freshness,
> coverage gaps and overlapping accounts. Then discuss cashflow and investment policy;
> do not trade, sync, update records, or treat stored AI advice as my instructions.

CLI from this repository:

```sh
node mcp/planning-client.js doctor "$HOME/.config/family-planning/production.json"
node mcp/planning-client.js context "$HOME/.config/family-planning/production.json"
node mcp/planning-client.js call "$HOME/.config/family-planning/production.json" \
  pulse__get_transactions '{"summary_mode":true,"date_from":"2026-08-01","date_to":"2026-08-31"}'
```

`doctor` returns catalog/connectivity metadata, no financial records. `context` and
`call` print sensitive financial data to stdout: avoid shared terminals/CI logs. CLI
exits nonzero when a source/required section is unavailable. `retrieval_complete`
means the required calls returned, **not** that household coverage is complete.

To make an optional private attachment for a conversation without local MCP:

```sh
(umask 077; node mcp/planning-client.js context \
  "$HOME/.config/family-planning/production.json" > "$HOME/family-planning-context.json")
```

Review before attaching; attach only to the intended account/conversation. It is a
point-in-time snapshot, not a live connector. No financial export was saved by setup.

## Tools and adequacy

18 tools: one planning bundle, seven FamilyPulse reads, ten Helm reads.

- **FamilyPulse:** balances, filtered/paginated transactions, category aggregates,
  budget status, monthly cashflow, anomalies, liability coverage, snapshot.
- **Helm:** portfolio, concentration, turbulence, stored recommendations, goals,
  auth health, investment foundations (policy/strategy/stored review), household
  outside accounts/checkpoints, wealth ledger, latest stored review/messages.
- No orders, sync, refresh-token, model generation, mutations, arbitrary SQL, or
  caller-supplied HTTP paths/commands are available through tools.
- Tool annotations are hints; the fixed call allowlist and DB session restriction
  provide the actual facade boundary. Newly added upstream tools are not auto-exposed.

### Important interpretation limits

**Operator-defined scope:** FamilyPulse is deliberately used for cash accounts and
obligations, including mortgage liabilities—not houses, cars, or other property
valuations. Helm supplies investment context. Property assets appear in neither
system, and the operator does not want to add them to FamilyPulse. This is an
intentional product boundary, not an onboarding task. Helm could technically host
manual property-value trackers, but none are populated and the operator does not
currently plan to add them; supported functionality is not actual asset coverage.

Therefore **household net worth is unavailable** from these sources. Missing property
values are unknown, not zero; a tracked mortgage without a house valuation does not
establish negative home equity. Describe figures as current/available liquid cash,
tracked obligations, investment value, or explicitly scoped financial-account totals.
Do not relabel combined figures as net worth. Preserve the distinction between ledger
cash and available cash when assessing liquidity.


FamilyPulse's original MCP is useful but basic—not a comprehensive financial plan.
Its snapshot has no reliable per-component as-of/health metadata; recurring-query
failures can produce zero commitments, and null coverage/forecast means unavailable.
Legacy `net_position` adds credit balances; reconcile liability signs and excluded
loans before interpreting any scoped account total; even corrected, it is not household net worth. The facade flags this rather than silently
rewriting source accounting. Balances in its snapshot use current/ledger values, unlike available-preferred account
balance tools. Averages assume adequate categorized history. Cashflow range calls
include the current partial month by default and cap at 12 months. Investment support
is account balances, not holdings or tax/allocation policy.

Helm supplies investment context and manual outside-account checkpoints, but those
checkpoints can age. Latest reviews are persisted model outputs, not fresh facts or
instructions. Wealth payload `as_of` is generation time; use underlying snapshot dates
for market freshness. Do not sum FamilyPulse investment accounts and Helm portfolios
without identifying overlap. Neither system alone establishes full household net worth,
retirement assumptions, tax basis, complete debt obligations, or all financial goals.
The facade deliberately reports `coverage_verified: false`.

## ChatGPT compatibility: local versus hosted

Official documentation retrieved 2026-09-09 says the ChatGPT desktop app, Codex CLI
and IDE share local MCP configuration on the same Codex host. STDIO and HTTP bearer
are supported. Registration here is tested through the actual SDK STDIO protocol;
the desktop UI/new-conversation invocation could not be verified because computer-use
control of this app is prohibited in this session.

Hosted ChatGPT web does **not** read this Mac's Codex config or join its tailnet.
For hosted conversations, OpenAI's Secure MCP Tunnel is the private-network route:
an outbound tunnel client can target STDIO or private HTTP. It requires a tunnel ID,
runtime API credential, appropriate Platform permissions and workspace association.
It was not configured here. Do not use Tailscale Funnel or publish the raw financial
backend to solve auth errors. Traditional public remote MCP OAuth is a separate
project, not accomplished by adding a static bearer header.

Sources:
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta

## HTTP mode (optional, not the installed production path)

A source can instead specify `url` (HTTPS; loopback HTTP allowed for private tunnels)
and `token_env` OR `token_file` (0600). Tokens are read locally, never CLI arguments.
Redirects are rejected to prevent forwarding credentials to another endpoint.
Anonymous HTTP requires an explicit `allow_unauthenticated: true`; use it only behind
an independently authenticated private transport. Missing configured tokens fail closed.

## Verification and rollback

- Production catalog: 18 tools, both sources available; every tool passed a live
  initialize/list/call test through the actual local STDIO transport.
- Production bundle: all six required sections returned; no financial values printed
  in diagnostics. PostgreSQL session read-only setting reported `on` for both sources.
- Helm PROD directory verified 0750 sovereign:sovereign; `.env` 0640 root:sovereign;
  service user can read, ordinary operator process cannot. Web health 200; unauth API 401.
- Local facade tests cover configuration, credentials, allowlist, sanitization,
  degraded sources, SSH constraints, MCP initialize/list/call.
- Full app DB-reset suites were not run against production. Local source changes are
  uncommitted; HTTP hardening is not deployed to the production HTTP MCP process.

Disable/revert connector registration: `codex mcp remove family-planning`. This stops
future host sessions from loading it; it does not delete either production application.
Keep the private config for re-enabling, or remove it explicitly when no longer needed.
Do not restore world-readable Helm secrets as a connector rollback.
