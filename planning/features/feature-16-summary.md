# Feature 16: Plaid Account Selection Management

## Purpose

Let parents revisit which accounts under an existing Plaid Item should keep syncing,
while handling institution-specific limits honestly.

## Why This Matters

Initial Plaid onboarding is not always the final answer. Users may want to:

- add newly relevant accounts later
- stop syncing closed or unwanted accounts
- recover from earlier botched account selections

The current app has no explicit account-selection management surface. For institutions
like Chase, that leads to confusing stuck account membership and no clear next step.

## Scope

### Phase 1: Edit synced accounts action
- Add a dedicated update-mode path for editing account selection
- Keep it separate from reauth and liability-permission upgrade

### Phase 2: Local reconciliation
- Refresh local account state correctly after account-selection changes
- Preserve historical understanding when accounts stop syncing

### Phase 3: Institution-aware UX
- Surface fallback guidance for institutions that require account management at the bank
- Do not over-promise in-app removals when Plaid/institution behavior is asymmetric

### Phase 3a: Editability Source Of Truth
- Define how the app decides an Item should show `Edit synced accounts`
- Base that decision on explicit state/rules rather than vague UI heuristics

### Phase 4: Visibility
- Settings helps users understand which institutions/accounts are active, disconnected, or historically retained

## Key Design Decisions

- **Account-selection editing is its own lifecycle action**
- **Institution-specific exceptions must be first-class UX, not hidden edge cases**
- **Historical local data should remain understandable even when sync membership changes**
- **The app should be honest about what Plaid can and cannot control for a given institution**
- **Editability needs a defined source of truth** — UI availability should come from explicit capability decisions, not guesswork

## Definition of Done

- Parents can launch an explicit account-selection edit flow where supported
- Local state reconciles cleanly after changes
- Chase-like limitations are handled with clear user guidance
- Settings makes current sync membership understandable
- The app has a documented basis for when `Edit synced accounts` is shown
