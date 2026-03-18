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
- Use Plaid Link update mode with `update.account_selection_enabled = true`

### Phase 2: Local reconciliation
- Refresh local account state correctly after account-selection changes
- Preserve historical understanding when accounts stop syncing
- Default deselected accounts to `historical` rather than purging local data

### Phase 3: Institution-aware UX
- Surface fallback guidance for institutions that require account management at the bank
- Do not over-promise in-app removals when Plaid/institution behavior is asymmetric
- Treat Chase removal guidance as a first-class case, not a generic failure state

### Phase 3a: Editability Source Of Truth
- Define how the app decides an Item should show `Edit synced accounts`
- Base that decision on explicit state/rules rather than vague UI heuristics
- Start with a documented rule set:
  - item is not disconnected
  - item does not currently need reauth
  - item is not institution-blocked from in-app editing
  - item has at least one active synced account

### Phase 4: Visibility
- Settings helps users understand which institutions/accounts are active, disconnected, or historically retained

## Execution Plan

### Slice A: Launch the action safely
- Add `Edit synced accounts` route and button
- Create update-mode tokens with account-selection editing enabled
- Keep completion handling separate from reauth and liability upgrades

### Slice B: Reconcile local accounts
- Add account-level sync state so accounts can be `active` or `historical`
- Reconcile post-Link account sets by marking de-selected accounts historical instead of deleting them
- Keep existing historical transactions visible

### Slice C: Institution-aware UX
- Add explicit Chase fallback copy for removals
- Only promise in-app editing where Family Pulse has a defined basis for doing so
- Show partial limitations in Settings rather than burying them in failed flows

## Key Design Decisions

- **Account-selection editing is its own lifecycle action**
- **Institution-specific exceptions must be first-class UX, not hidden edge cases**
- **Historical local data should remain understandable even when sync membership changes**
- **Deselection preserves history by default** — changing sync membership should not purge past transactions automatically
- **The app should be honest about what Plaid can and cannot control for a given institution**
- **Editability needs a defined source of truth** — UI availability should come from explicit capability decisions, not guesswork

## Definition of Done

- Parents can launch an explicit account-selection edit flow where supported
- Local state reconciles cleanly after changes, with de-selected accounts preserved as historical by default
- Chase-like limitations are handled with clear user guidance
- Settings makes current sync membership understandable
- The app has a documented basis for when `Edit synced accounts` is shown
