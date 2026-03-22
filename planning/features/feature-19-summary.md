# Feature #19: Recurring Expense Intelligence

## Problem
Family Pulse treats every transaction as an isolated event. But 60–70% of household outflow
is structurally recurring: subscriptions, insurance premiums, mortgage auto-pay, phone plans,
streaming services, gym memberships. This pattern signal is sitting in the transaction data
undetected. Monarch Money had recurring detection but implemented it as an annoying interactive
prompt ("Is this recurring?"). Family Pulse should do it better — silently, in the background,
always watching.

Without recurring detection:
- Budget analysis conflates fixed obligations with discretionary spending
- Price creep on subscriptions goes unnoticed ($15.49 → $22.99 Netflix)
- Annual renewals blindside the budget (insurance, property tax, memberships)
- There's no bill calendar showing what's coming in the next 30 days
- The cash flow forecast (Feature 20) has no foundation of known future charges

## Solution
A background detection engine that runs after every Plaid sync, analyzing transaction history
to identify, classify, and track recurring charges. No interactive prompts — the system
watches silently and surfaces findings.

### Core Components

1. **Recurring Detection Engine** (`lib/recurring-detector.js`)
   - Groups transactions by normalized merchant fingerprint
   - Analyzes date intervals and amount clustering to detect frequency
   - Classifies: weekly, biweekly, monthly, quarterly, semi-annual, annual
   - Requires 3+ occurrences for monthly or more frequent; 2+ for quarterly and longer
   - Assigns confidence scores (high: consistent interval + amount; medium: interval match
     but amount varies; low: sparse data or irregular)
   - Runs post-sync as a background pass (like transfer detection)

2. **Price Change Tracking**
   - Stores amount history per recurring item
   - Flags when latest charge differs from prior by >$1 or >5%
   - Surfaces price increases prominently (not decreases — those are good news)

3. **Bill Calendar**
   - Forward-looking 30-day view of expected charges
   - Based on detected frequency + last occurrence date
   - Shows: merchant, expected amount, expected date, account, confidence

4. **Committed vs Discretionary Split**
   - Budget page gains a new metric: how much monthly spending is locked in
     (recurring) vs. truly discretionary
   - Dashboard summary line: "$3,400 committed · $1,700 discretionary runway"

5. **Subscription Audit Surface**
   - Recurring items page with full list, sortable by amount, frequency, last seen
   - "Stale" flag for items not seen in 2+ expected cycles (cancelled or forgotten?)
   - Annual renewal radar: items due in the next 60 days

### What This Does NOT Include
- Automatic cancellation or payment initiation (read-only)
- Notification/push alerts (that's a separate feature)
- Manual "mark as recurring" UI (detection is automatic; manual override is stretch)

## Key Decisions
- **Background-first**: detection runs silently after sync, no user interaction required
- **Merchant normalization**: strip trailing transaction IDs, dates, reference numbers to
  group "NETFLIX.COM/1234" and "NETFLIX.COM/5678" as the same merchant
- **Conservative thresholds**: 3+ occurrences before calling something monthly-recurring
  to avoid false positives from one-off repeat purchases
- **Amount clustering**: allow ±10% variance for "same amount" to handle tax/tip
  fluctuations on recurring charges (configurable)
- **Idempotent**: re-running detection updates existing records, never duplicates
- **Feeds Feature 20**: recurring expense data is the foundation for cash flow forecasting

## New Database Objects
| Object | Purpose |
|--------|---------|
| `recurring_expenses` table | Detected recurring patterns with frequency, amounts, confidence |
| `recurring_expense_history` table | Amount history per recurring item for price tracking |
| Migration 014 | Schema for both tables |

## Files Changed
| File | Change |
|------|--------|
| `db/migrations/014-recurring-expenses.sql` | New tables |
| `lib/recurring-detector.js` | Detection engine |
| `lib/merchant-normalizer.js` | Merchant name normalization |
| `lib/routes/recurring.js` | API endpoints |
| `server.js` | Post-sync hook, cron registration |
| `public/recurring.html` | Recurring expenses page |
| `public/recurring.js` | Frontend logic + bill calendar |
| `public/style.css` | Recurring page styles |
| `public/nav.js` | Add nav entry |
| `public/budget.html` | Committed vs discretionary split |
| `public/budget.js` | Pull recurring summary into budget view |
| `public/index.html` | Dashboard committed/discretionary line |
| `lib/budget-calculator.js` | Integrate recurring data into budget summary |
| `lib/magic-actions/context-assembler.js` | Add recurring context for LLM prompts |
| `db/seed.sql` | Default config values |

## Test Plan

### Automated now
- Merchant normalization: strips trailing IDs, lowercases, handles edge cases
- Frequency detection: monthly, quarterly, annual patterns from fixture data
- Amount clustering: groups within tolerance, splits beyond tolerance
- Price change detection: flags increases above threshold
- Bill calendar projection: correct next-expected dates for each frequency
- Confidence scoring: high/medium/low classification rules
- API endpoint response shapes and auth guards
- Idempotency: re-running detection doesn't create duplicates
- Stale detection: items missing 2+ expected cycles flagged correctly

### Manual checks
- Load recurring.html and verify detected items match known subscriptions
- Verify bill calendar shows reasonable next-30-day projections
- Check budget page committed vs discretionary split
- Confirm price change badges appear for changed amounts
- Mobile layout for recurring page and bill calendar
