# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Is

Household financial visibility app for the Forbell family. Syncs bank/credit card/investment
accounts via Plaid into a local Postgres database, detects inter-account transfers, and provides
a unified view of household money flow. No UI in Feature 1 — data layer only.

Family: Eric (Dad), Alex (Mom), Jordan (Son), Casey (Daughter).

## Dev Commands

```bash
npm install            # first time
npm run dev            # node --watch (Node 18+)
npm start              # production

# Database (Docker)
docker-compose up -d   # start PostgreSQL on port 5434
node db/migrate.js     # apply migrations (idempotent)
psql $DATABASE_URL -f db/seed.sql  # seed default data

# Sync & CLI
npm run sync           # manual Plaid sync
npm run accounts       # list accounts with balances
npm run status         # last sync time + counts

# Tests
npm test               # node --test (all test/*.test.js)
npm run test:e2e       # Playwright browser tests (chromium)
npm run test:e2e:headed # browser tests with visible browser
```

Copy `.env.example` to `.env` and fill in values.

## PR Creation Note

When creating or editing GitHub PRs with `gh`, do not inline a markdown-heavy body directly in the shell command if it contains backticks, parentheses, or other shell-significant characters.

Preferred pattern:

1. write the PR body to a temporary file
2. use `gh pr create --body-file <file>` or `gh pr edit --body-file <file>`

This avoids shell mangling and accidental command substitution in PR descriptions.

## Architecture

Single-process Node.js/Express. No build step. Vanilla HTML/CSS/JS frontend (when added).

```
server.js              # Express — all routes inline, cron schedule
lib/
  db.js                # Pool wrapper, query helper, transaction support
  plaid-client.js      # Plaid API client (accounts, sync, liabilities)
  sync.js              # Sync engine — orchestrates full sync cycle
  transfer-detection.js # Detects inter-account transfers, CC payments, etc.
  logger.js            # Structured JSON logging
  secrets-guard.js     # Sanitize secrets from logs and API responses
  cli.js               # CLI entry point (sync, accounts, status)
db/
  migrations/          # Numbered SQL migrations
  migrate.js           # Migration runner
  seed.sql             # Default categories, family members, config
deploy/
  family-pulse.service # systemd unit
  deploy.sh            # Smart git-based deploy script
public/                # Static frontend (future features)
test/                  # node:test test files
```

## Key Design Decisions

### Secrets Invariant
Access tokens and API keys MUST NEVER appear in:
- Log output (logger.js sanitizes automatically)
- API responses (secrets-guard.js throws on access_token in query results)
- LLM context (sanitizeForLLM strips known patterns)
Disk encryption handles at-rest protection; no app-level encryption of tokens.

### Plaid Sync
Cron-based: 6 AM + 12 PM + 8 PM Eastern. No webhooks. Cursor-based transaction sync
(`/transactions/sync`) with upsert on `plaid_transaction_id`. Handles pending → posted
transitions and removed transactions.

### Transfer Detection
Runs after each sync. Detects:
- Inter-account transfers (matching amounts ±$1, opposite signs, within 3 days)
- Credit card payments (payee pattern + amount match)
- 529 contributions (merchant pattern)
- BTC/crypto savings (merchant pattern: Coinbase, Swan, Strike, etc.)

### Account Onboarding & Liability Coverage
Two separate Plaid Link flows exist in Settings (see Feature 11):
- **Link Bank Account** — requests `transactions` only. Use for checking/savings.
- **Link Credit / Loan Account** — requests `transactions` + `liabilities`. Use for
  credit cards, mortgages, and student loans.

This matters because the Liability Coverage system (Feature 12) depends on Plaid's
Liabilities product to get statement balances, due dates, and minimum payments. If a
mortgage or credit card is linked through the default transactions-only flow, the app
will only see the total outstanding balance — not the monthly payment amount. This
causes the coverage indicator to report the entire note balance as an obligation
instead of the monthly payment, producing wildly inaccurate coverage ratios.

**Rule of thumb**: always use the credit/loan flow for any account that carries a
recurring payment obligation.

### Nginx subpath compatible
All fetch() calls use relative paths: `fetch('api/health')` — never `fetch('/api/...')`.
The app runs at its own root on port 3003; nginx maps `/pulse/ → http://127.0.0.1:3003/`.

## Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| DATABASE_URL | Yes | — | PostgreSQL connection |
| PORT | No | 3003 | HTTP port |
| PLAID_CLIENT_ID | Yes | — | Plaid API client ID |
| PLAID_SECRET | Yes | — | Plaid API secret |
| PLAID_ENV | No | sandbox | sandbox / production |
| OPENAI_API_KEY | No | — | For future AI features |
| OPENAI_MODEL | No | gpt-4o-mini | Any chat completion model |
| OPENAI_ANOMALY_DIGEST_MODEL | No | — | Model for weekly digest (falls back to OPENAI_MODEL) |
| HOUSEHOLD_TIMEZONE | No | America/New_York | For cron schedule |

## Data Model

- `items` — Plaid Items (linked institutions)
- `accounts` — Bank/credit/investment accounts
- `transactions` — All transactions with transfer detection flags
- `categories` — Spending categories with budget amounts
- `category_rules` — Auto-categorization rules by merchant pattern
- `budgets` / `budget_periods` — Budget tracking
- `planning_goals` / `savings_signals` — Future planning features
- `family_members` — Eric, Alex, Jordan, Casey
- `app_config` — Key/value config

## Testing Strategy

Two test tiers:

- **`npm test`** — `node:test` integration tests for API logic, data shaping, auth guards.
  Fast, no browser needed. Covers `test/*.test.js`.
- **`npm run test:e2e`** — Playwright browser tests for page rendering, user interactions,
  and auth gate behavior. Runs Chromium headless against a test server on port 3099.
  Covers `test/e2e/*.spec.js`.

`npm test` is the default for CI and pre-commit. Browser tests are opt-in via `test:e2e`.

### Auth in browser tests

The global setup (`test/e2e/helpers/global-setup.js`) sets a passphrase on Eric so that
`authEnabled()` returns true. Without this, the auth gate is bypassed and redirect tests
silently pass without testing anything. The `loginAs()` helper in `test/e2e/helpers/auth.js`
injects session cookies directly — no need to go through the login UI.

### Selector conventions

Prefer existing element IDs (`#summary-hero`, `#income-spending-chart`). Avoid adding
`data-testid` attributes unless an element genuinely has no stable selector.

## Deployment (Linux / Tailscale)

```bash
npm install --omit=dev
node server.js
# or via systemd (see deploy/family-pulse.service)
```

Accent color: emerald #10b981.
