# Family Pulse — Planning

Feature-driven development tracking for Family Pulse, the household cash flow & budget intelligence app.

## Structure

- `current-feature.json` — Active feature context and shipping history
- `progress.txt` — Chronological development log
- `features/` — Per-feature PRD (JSON) and summary (MD) pairs
- `prd-family-pulse.md` — Master PRD (vision document)

## Feature Pipeline

| # | Feature | Phase | Status |
|---|---------|-------|--------|
| 1 | Foundation (Data Layer + Plaid Sync) | Phase 1 | pending |
| 2 | Transaction Browser (Web UI) | Phase 2 | pending |
| 3 | Monarch Money Migration | Phase 3 | pending |
| 4 | Budget Framework | Phase 4 | pending |
| 5 | Hot Spots & Anomaly Detection | Phase 5 | pending |
| 6 | Kids View | Phase 6 | pending |
| 7 | Magic Actions (LLM Layer) | Phase 7 | pending |
| 8 | MCP Server | Phase 8 | pending |
| 9 | Planning & Goals | Phase 9 | pending |

## Secrets Invariant (Project-Wide, Hardcoded)

**Secrets never leave the server.** This is non-negotiable across all features:

- **Access tokens** (Plaid), **API keys** (OpenAI), and **.env values** are never:
  - Logged (structured logging filters them out)
  - Returned in API responses
  - Sent to the browser
  - Included in LLM prompts (OpenAI, MCP tool responses)
- **Sensitive DB columns** (`items.access_token`) are excluded from all SELECT queries except the sync engine's internal Plaid calls
- **LLM prompts** receive only derived/aggregated data: category names, amounts, date ranges, first names
- **MCP tool responses** return user-facing data only: account names, balances, transactions, categories
- Enforced by `lib/secrets-guard.js` module and `test/secrets-guard.test.js` test suite (established in Feature 1)
- Token storage relies on erebor's full-disk encryption (manual unlock on reboot) — no application-level encryption needed
- Plaid access tokens are permanent (no TTL, no refresh) — `token_last_used_at` tracked for audit

## Testing Philosophy

Family Pulse handles sensitive financial data via Plaid APIs. Every feature includes:
- Unit tests for data transforms and business logic
- Integration tests for database operations and API flows
- Validation tests at system boundaries (Plaid responses, CSV imports, LLM outputs)
- Secrets leak tests for any feature that constructs LLM prompts, API responses, or log output
- Test coverage tracked per feature in PRD `testStrategy` fields
