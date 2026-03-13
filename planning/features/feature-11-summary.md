# Feature 11: Split Liability Onboarding From Default Bank Link

## Purpose

Reduce Plaid onboarding friction for standard checking/savings institutions by removing Liabilities from the default Link flow, while preserving a separate explicit path for linking credit and loan accounts when liability data is actually desired.

## Why This Matters

The current default Link token requests both `transactions` and `liabilities`. That works for some institutions, but it can break otherwise-valid checking-account onboarding when the institution also contains mortgage or credit products and the user does not grant liability-account access during OAuth.

Observed production symptom:
- Plaid Link error `NO_LIABILITY_ACCOUNTS`
- example case: Chase OAuth where only checking was selected, while a mortgage also existed on the institution

This feature keeps the app’s mission intact because credit-card and loan accounts still matter. It simply stops forcing every default bank onboarding flow to satisfy the Liabilities product.

## Scope

### Phase 1

1. Default Link flow requests `transactions` only
2. Existing linked Items remain unchanged
3. No UI overhaul required
4. Primary goal: checking/savings onboarding succeeds reliably

### Phase 2

1. Settings gets a second onboarding action for credit/loan accounts
2. Liability-specific Link token requests `transactions` + `liabilities`
3. Clear user-facing separation between:
   - standard bank account link
   - credit / loan account link
4. Future-proof for `account_filters` if institution-specific tuning is needed

## Key Design Decisions

- **Do not mutate existing Items** — changing future Link token products must not disturb already-linked institutions
- **Default path should optimize for successful onboarding** — transactions-first is the safer default
- **Liabilities become intentional, not ambient** — only request them when the user is linking debt-related accounts on purpose
- **Keep backend liabilities code intact** — this feature changes onboarding behavior, not existing sync capabilities

## Definition of Done

- Default “Link Account” flow no longer requests Liabilities
- New normal bank onboarding does not fail with `NO_LIABILITY_ACCOUNTS` when only checking/savings are selected
- Settings exposes a second explicit flow for credit/loan onboarding
- Existing Items linked with Liabilities continue to function unchanged
- Documentation updated to explain when to use each link path
