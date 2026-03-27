# Feature #22: Transaction Identity Overrides

## Problem
Plaid-synced transaction names are often good enough for machines and bad for humans. Checks show
up as `Check #1024`. Some merchants arrive with awkward abbreviations or low-quality labels.
Over time, that makes the transaction list harder to scan and weakens trust in Family Pulse as the
place where the household remembers what a charge actually was.

## Solution
Add a local identity layer on top of synced transactions:

1. **One-off display name overrides** for single transactions
2. **Optional exact-match rename rules** for future synced transactions with the same raw source text
3. **Check-aware defaults** so check renames stay one-off unless a parent deliberately opts into a rule
4. **Rule management** so parents can review, disable, or delete rename rules later

### How It Works
- Family Pulse preserves `merchant_name` and `name` exactly as synced
- The UI shows an **effective display name** that may come from:
  1. a transaction-level override
  2. a matching exact rename rule
  3. raw synced text
- Rules are optional and exact-match only in v1
- Renamed transactions still reveal their original synced text in the detail view

## Key Decisions
- **Raw provenance stays untouched**: no overwriting Plaid source fields
- **Exact matching first**: simpler and more predictable than fuzzy matching
- **Rules are optional**: one-off cleanup must remain easy
- **Checks default to one-off**: `Check ####` is usually not a reusable merchant identity
- **Separate from category rules**: naming and categorization should not become silently coupled

## New Database Objects
| Object | Purpose |
|--------|---------|
| Transaction display override fields | One-off display-name cleanup |
| `merchant_rename_rules` table | Optional exact-match future rename behavior |
| Migration 018 | Schema for identity layer |

## Files Changed
| File | Change |
|------|--------|
| `db/migrations/018-transaction-identity-overrides.sql` | New rule and override schema |
| `lib/merchant-rename-rules.js` | Exact-match rule helper |
| `lib/routes/transactions.js` | Edit endpoints and response shape updates |
| `lib/sync.js` | Apply rules during Plaid ingest |
| `lib/routes/import.js` | Apply rules during Monarch import |
| `public/transactions.html` | Edit controls in transaction detail surface |
| `public/transactions.js` | Rename UX and future-rule toggle |
| `public/style.css` | UI polish for renamed/original labels |
| `test/transaction-identity-overrides.test.js` | API and rule coverage |
| `test/e2e/transaction-identity.spec.js` | Browser coverage |

## Test Plan

### Automated now
- One-off rename set/clear behavior
- Exact-match rule creation and application on sync/import
- Check-pattern heuristic defaults future-rule toggle off
- Effective display name returned in APIs
- Search includes effective display name without losing raw-source traceability
- Parent-only rule management

### Manual checks
- Rename a `Check #1024` transaction and confirm future-rule toggle defaults off
- Rename a messy merchant and confirm future exact matches pick up the cleaned name
- Verify original synced text remains visible in detail view
- Disable a rule and confirm future transactions stop inheriting that display name
