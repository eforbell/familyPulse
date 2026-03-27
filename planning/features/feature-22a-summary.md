# Feature #22a: Merchant Rename Suggestions

## Problem
Feature 22 made transaction renaming powerful, but the parent still has to remember and type the
"right" merchant name every time. That creates small friction on every cleanup action and leaves
room for drift like `Crate & Barrel`, `Crate and Barrel`, and `Crate+Barrel` all being used by the
same household over time.

## Solution
Add lightweight merchant-name suggestions directly inside the existing display-name editor:

1. **Inline suggestions** while a parent types in the display-name field
2. **Suggestions sourced from existing effective merchant names** already used in Family Pulse
3. **Prefix-only matching** for a predictable v1 behavior
4. **Assistive selection only** so picking a suggestion fills the input but does not auto-save or
   auto-create a future rename rule

### How It Works
- Parent types at least a short prefix in the display-name editor
- Family Pulse queries distinct effective merchant names from transaction history
- Results are ranked by practical household usefulness: prefix match, frequency, recency
- Parent can click or keyboard-select a suggestion to fill the input
- Save behavior stays unchanged and explicit

## Key Decisions
- **No fuzzy matching yet**: keep results predictable and implementation small
- **No schema changes**: suggestions can come from existing transaction history
- **Existing detail surfaces only**: dashboard and transactions page reuse the current rename UI
- **Suggestions are advisory**: they help consistency but never change data by themselves

## Expected Files
| File | Change |
|------|--------|
| `lib/routes/transactions.js` | Add ranked merchant suggestion endpoint |
| `public/transactions.js` | Autocomplete behavior on the transactions page |
| `public/app.js` | Autocomplete behavior on the dashboard detail overlay |
| `public/style.css` | Suggestion dropdown styling |
| `test/transaction-identity-overrides.test.js` or new suggestion test | API query and ranking coverage |
| `test/e2e/...` | Browser coverage for suggestion selection and dismissal |

## Test Plan

### Automated now
- Parent-only suggestion endpoint returns a small ranked result set
- Prefix filtering is case-insensitive and deduplicated
- Suggestion selection fills the input but does not auto-save
- Dropdown opens and dismisses correctly in the detail overlay

### Manual checks
- Type `Cr` in a rename field and confirm common historical names appear
- Select a suggestion and verify the rule checkbox state remains unchanged
- Confirm Save Name is still required to persist the rename
- Verify the overlay still behaves correctly on mobile and desktop
