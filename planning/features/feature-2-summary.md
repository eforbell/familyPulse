# Feature 2: Transaction Browser — Web UI

## Purpose

The first visual interface for Family Pulse. Lets Eric and Alex browse all accounts, see balances, scroll through transactions, assign categories, and manage categorization rules. The "see the data" milestone that makes Feature 1's plumbing tangible.

## Why This Is Worth Shipping

Without a UI, the data is only queryable via SQL. This feature gives the household immediate visibility into their financial data and starts the category assignment workflow that feeds budget tracking in Feature 4.

## Scope

1. Account list dashboard with liquid balance, credit balance, and net position
2. Paginated, filterable transaction browser with transfer toggle
3. Category assignment (single and bulk) with rule creation
4. Category CRUD admin (name, color, budget amount, flags)
5. Auto-categorization rule engine with retroactive application

## What This Does NOT Include

- Budget tracking or spending analysis (Feature 4)
- Charts or visualizations (Feature 4+)
- Kids-specific views (Feature 6)
- Any LLM/AI features (Feature 7)

## Key Design Decisions

- **Server-rendered HTML + vanilla JS** — matches familyDinner/familyHelp pattern, no build step
- **Tailwind CSS via CDN** — consistent styling, responsive out of the box
- **Transfer toggle** — transfers hidden by default, but easily revealed for audit
- **Rule engine** — substring matching for MVP, regex in future enhancement

## Definition of Done

- Account dashboard shows all accounts with correct balances and net position
- Transaction list loads with pagination, all filters work (account, date, category, search, transfer toggle)
- Categories can be created, edited, deleted with color and budget fields
- Transactions can be categorized individually and in bulk
- Auto-categorization rules apply on sync and retroactively on demand
- Mobile-friendly layout works on iPhone via Tailscale
- API endpoint tests pass for all CRUD operations
