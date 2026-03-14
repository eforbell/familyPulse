# Feature 13: Balance Policy

## Purpose

Introduce an explicit balance policy so Pulse can distinguish between spendable cash and ledger balance. For depository accounts, Pulse should prefer Plaid `available_balance` when the household wants real-world spendable cash, while preserving `current_balance` as the ledger/book value.

## Why This Matters

Plaid transfer timing is often asymmetric: the source account may still mark an internal transfer as pending while the destination account has already posted it. When Pulse treats `current_balance` as the only truth, top-line cash can feel wrong even though the institution already knows the spendable amount. Monarch solves this with a toggle. Pulse should too.

## Scope

### Phase 1: Policy Module
- Add a shared balance policy helper (`lib/balance-policy.js`)
- Modes:
  - `available_preferred` = `available_balance ?? current_balance` for depository accounts
  - `current_only` = always `current_balance`
- Helper supports both account-level display balance and aggregate depository totals

### Phase 2: Household Setting
- Add `balance_basis` to `app_config`
- Default to `available_preferred` when unset
- Settings page exposes a household-level toggle with clear explanatory copy

### Phase 3: Apply To Cash Views
- **Dashboard**: liquid total / cash summary uses configured balance basis
- **Accounts page**: depository cards use policy-driven balance; ledger balance may appear as secondary detail
- **Kids dashboard**: total balance uses the same household policy
- Labels should clarify when the displayed value is `Available` instead of `Ledger`

### Phase 4: Coverage Alignment
- Coverage calculator uses configured balance basis for depository total
- Kid-linked account exclusion remains intact
- Coverage status should reflect spendable cash under `available_preferred`

### Phase 5: Tests
- `test/balance-policy.test.js` for helper logic and mixed balance cases
- Coverage integration tests for policy-sensitive totals
- Settings persistence test for `balance_basis`

## Key Design Decisions

- **Available balance is the default** for depository cash views because it best reflects spendable funds
- **Ledger balance is preserved** as `current_balance`, not discarded
- **No manual pending-transaction math** when Plaid already provides `available_balance`
- **One centralized policy helper** avoids route/UI drift
- **Global household setting first** — simpler and more coherent than per-user preference

## Definition of Done

- A household setting controls balance basis: `available_preferred` or `current_only`
- Dashboard, accounts, kids, and coverage all use the same policy
- Depository totals match available balance when configured and present
- Fallback to current balance works when available balance is null
- UI labels make the chosen basis understandable
- Tests cover mixed available/current inputs and aggregate behavior
