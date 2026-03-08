# Feature 1: Foundation — Data Layer + Plaid Sync

## Purpose

Stand up the entire backend data pipeline: project scaffold, PostgreSQL schema, Plaid integration for transactions and liabilities, and the transfer detection engine. No UI — this is pure data plumbing. When this feature ships, `SELECT COUNT(*) FROM transactions` returns real family financial data.

## Why This Is Worth Shipping First

Everything downstream depends on clean, categorized, transfer-aware transaction data. Getting the data layer right — especially transfer detection and idempotent sync — prevents compounding errors in budget calculations, anomaly detection, and LLM analysis later.

## Scope

1. Node/Express project scaffold with docker-compose dev environment
2. PostgreSQL schema (all core tables) with numbered migration system
3. Plaid sync engine: accounts, transactions (cursor-based), liabilities
4. Cron-based sync (morning + evening, no webhooks)
5. Transfer detection engine (inter-account, CC payments, 529, BTC)
6. Admin CLI for manual sync, account listing, status checks
7. Structured logging with sensitive data filtering
8. Test suite: unit tests for business logic, integration tests for Plaid sandbox

## Key Design Decisions

- **Cron-based sync** (no webhooks) — morning (6 AM) + evening (8 PM) pulls via node-cron. No public endpoint needed, Tailscale stays closed. Twice-daily freshness is more than sufficient for household budget tracking.
- **Raw SQL migrations** (no ORM) — auditable, matches sibling app pattern
- **Cursor-based /transactions/sync** — Plaid's recommended approach for incremental updates
- **Transfer detection as post-sync pass** — runs before any categorization or budget logic
- **Docker-compose for dev** — isolated from production Plaid credentials and data
- **Jest test framework** — unit + integration, run against Docker PostgreSQL

## Pre-Flight Questions (Resolve Before Starting)

1. Confirm nginx `/pulse/` mountpoint availability on erebor
2. Confirm Plaid sandbox credentials separate from production

## Definition of Done

- Server starts, health check responds
- All schema tables created via migration system
- Plaid sync pulls real accounts and transactions into PostgreSQL
- Credit card liabilities synced (balance, minimum payment, due dates)
- Transfer detection correctly flags inter-account transfers, CC payments, 529, and BTC
- Admin CLI: `npm run sync`, `npm run accounts`, `npm run status` all functional
- Test suite passes with >80% coverage on transfer detection and sync logic
- No access tokens or sensitive data in logs, API responses, or LLM prompts
