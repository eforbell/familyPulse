# Feature 3: Monarch Money Migration

## Purpose

Import 12+ months of categorized transaction history from Monarch Money so Family Pulse has meaningful data for budget baselines, trend analysis, and anomaly detection from day one — rather than starting from zero.

## Why This Is Worth Shipping

Without historical data, Features 4 (Budget) and 5 (Anomaly Detection) can't compute rolling averages or meaningful comparisons. This import bridges the gap between Monarch cancellation and Family Pulse maturity.

## Scope

1. CSV upload endpoint with preview before commit
2. Category mapping UI: Monarch categories → Family Pulse categories (fuzzy auto-suggest)
3. Transaction import with deduplication against existing Plaid data
4. Import audit trail: run history, counts, status

## Pre-Flight (CRITICAL)

- **Must inspect actual Monarch CSV export before writing the parser** — format is undocumented
- Download export from Monarch → Settings → Export Data before canceling subscription
- Understand how Monarch handles transfers in their export

## Definition of Done

- CSV uploads, parses correctly, shows preview
- Category mapping UI maps all Monarch categories to Family Pulse categories
- Transactions imported with source='monarch' flag, no duplicates with Plaid data
- Import run summary shows: imported, skipped, errors
- Historical data visible in transaction browser with Monarch badge
- Re-importing same CSV produces zero new records (idempotent)
