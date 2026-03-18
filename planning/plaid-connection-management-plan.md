# Plaid Connection Management Plan

## Status

Deferred feature plan for fixing the broader Plaid connection-management model in Family Pulse.

This feature absorbs and extends the narrower liability-consent unification work. The
core issue is no longer just how liabilities are requested; it is that Family Pulse
currently lacks a complete lifecycle for a Plaid Item after the first successful link.

As of March 18, 2026:

- new links can succeed
- OAuth resume works
- sync and reauth basically work
- liability consent upgrades for existing bundled institutions are not handled well
- account selection changes are not exposed intentionally
- local item deletion does not currently call Plaid `/item/remove`

That last point is operationally important because it risks continued Plaid billing for
Items that Family Pulse has "removed" only from its local database.

## Problem Summary

The current product treats Plaid institution links as mostly one-time onboarding events.
In practice, they need active lifecycle management.

Users need to be able to:

- link an institution successfully
- repair credentials when login expires
- upgrade consent or products later
- adjust which accounts are synced when the institution allows it
- fully disconnect the institution and stop Plaid billing

Family Pulse currently handles only part of that lifecycle.

## Current Gaps

### 1. Product / consent upgrades

Existing Items linked under the transactions-only flow cannot currently be upgraded
cleanly for liabilities.

### 2. Account selection management

The app does not currently provide a user-facing way to revisit account selection.

For some institutions, update mode can add or remove selected accounts. For others,
notably Chase, account removal may have to happen in the institution's own permission UI.

### 3. True disconnect

Current item removal is local-only:

- the app deletes the `items` row and cascaded local data
- it does **not** call Plaid `/item/remove`

That means a user can think an institution is disconnected while the Plaid Item may
still exist and continue incurring subscription billing.

## Verified Code Reality

### Local delete is not a Plaid disconnect

`DELETE /api/items/:id` currently removes the local DB row only.

Reference:

- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)

### Update mode is currently reauth-only

The existing update-token flow:

- fetches the Item access token
- creates a Link token in update mode
- does not request additional product consent
- does not distinguish login repair from account-selection editing or product upgrade

References:

- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)
- [lib/plaid-client.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/plaid-client.js)

### Link flow is split by product intent

Current new-item link choices are:

- standard bank: `transactions`
- liability path: `transactions` + `liabilities`

That split is the source of the current bundled-institution mismatch.

## Goal

Make Plaid Items manageable across their full lifecycle:

1. Link
2. Reauth
3. Upgrade permissions
4. Edit account selection
5. Disconnect completely

## Non-Goals

- Rebuilding the Plaid sync engine from scratch
- Supporting arbitrary per-account product combinations beyond what Plaid allows
- Solving every institution-specific OAuth quirk in one pass
- Eliminating all local data on disconnect by default without explicit product decisions

## Feature Scope

### Phase 1: Safer new links

Unify new onboarding so the default path requests:

- required products: `transactions`
- optional products: `liabilities`

Why:

- avoids forcing liabilities for ordinary bank links
- better matches bundled OAuth institutions
- reduces the need for separate institution-level link flows

### Phase 2: Explicit item actions

Turn "Fix" into a clearer set of item-level management actions:

- `Fix login`
- `Enable liabilities`
- `Edit synced accounts`
- `Disconnect from Plaid`

Not every action will appear for every item.

### Phase 3: True disconnect

Change institution removal semantics so the primary destructive path:

- calls Plaid `/item/remove`
- preserves local synced history by default
- marks the local institution as disconnected / archived so it no longer syncs
- makes billing implications explicit in the UI

Optional fallback path:

- `Permanently delete local history`

This destructive purge path should stay separate, explicit, and uncommon.

### Phase 4: Consent + capability state

Persist item-level connection-management state so the UI is not driven by guesswork.

Candidate item-level fields:

- `liability_access_status`
- `liability_access_checked_at`
- `account_selection_editable`
- `remote_disconnect_status`
- `linked_products_mode` or equivalent provenance for how the Item was created

### Phase 5: Institution-specific handling

Document and handle known exceptions:

- Chase account removal may require doing it in Chase Security Center, not in Plaid Link
- some institutions may allow add-but-not-remove behavior
- some institutions may expose liabilities but require additional consent later

## Proposed UX Model

### Institution row actions

For each linked institution, Settings should eventually expose a small action set:

- `Fix login`
  - shown for `needs_reauth`
- `Enable liabilities`
  - shown when liability consent is missing or upgradeable
- `Edit synced accounts`
  - shown when account selection updates are plausible / supported
- `Disconnect`
  - always shown for parents

### Disconnect confirmation

The disconnect UI should state plainly:

- this removes the institution from Family Pulse
- this disconnects the Plaid Item remotely
- this is the action intended to stop Plaid subscription billing
- linked accounts and transactions remain in Family Pulse history by default
- the institution will stop future syncs and be shown as disconnected / archived
- permanent local deletion is a separate destructive action

## Backend Workstreams

### Workstream A: Link token flexibility

Extend `plaid.createLinkToken()` to support:

- `optional_products`
- update-mode variants for:
  - reauth
  - account selection update
  - product consent upgrade

This is the foundational change all other flows depend on.

### Workstream B: Item capability tracking

Persist how each Item was linked and what management operations are still relevant.

Without this, the UI will have to infer too much from partial sync data.

### Workstream C: Liability permission upgrade

Add a dedicated route for upgrading an existing Item to liabilities consent.

Candidate route:

- `POST /api/link/upgrade-liabilities-token`

Behavior:

- create Link update token for the Item
- request additional liability consent
- preserve OAuth resume / link session tracking

### Workstream D: Account selection editing

Add a dedicated route for editing account selection on an existing Item.

Candidate route:

- `POST /api/link/edit-accounts-token`

Behavior:

- create Link update token with account selection editing enabled where applicable
- guide user through institution flow
- refresh local account set after completion

Important:

- for institutions like Chase, the UI may need a custom help message rather than a
  promise that account removal is editable in-app

### Workstream E: Plaid item removal

Add a real remote disconnect path.

Candidate route:

- `DELETE /api/items/:id/disconnect`

Behavior:

1. fetch local Item access token
2. call Plaid `/item/remove`
3. on success, preserve local history but mark the Item as disconnected / archived
4. prevent future sync attempts for that Item
5. record success/failure for auditability

Separate destructive purge route:

- `DELETE /api/items/:id/purge`

Behavior:

1. require an explicit destructive confirmation
2. delete the local item, accounts, and transactions
3. only be used when the user intentionally wants to erase local history

## Data Retention Decision

For this feature, the default decision is:

- `Disconnect` stops remote Plaid sync/billing and preserves local historical data

Separate destructive action:

- `Purge` permanently deletes the local institution history

Reasoning:

- users may disconnect because of a sync problem, closed account, or consent change while
  still wanting historical reporting
- preserving history is the safer and more user-aligned default
- full local deletion should require a distinct, clearly destructive action

Implementation implication:

- the current cascade-delete model is not sufficient for the new default disconnect
- items will need a disconnected / archived local state instead of immediate deletion

## Risks

1. Remote `/item/remove` may fail for stale or broken Items; fallback handling must be
   explicit.
2. Account-selection editing behavior varies by institution; we cannot promise symmetric
   add/remove everywhere.
3. Liability consent upgrades may still be institution-specific in OAuth update mode.
4. If we keep only one generic "Fix" entrypoint, users will continue to confuse login
   repair with consent/account-selection changes.
5. Preserving disconnected history means reconnect semantics must be designed carefully so
   historical rows are not duplicated or ambiguously merged later.

## Test Plan

### API tests

Extend:

- [test/link-api.test.js](/Volumes/DATA/workspace/homeApps/familyPulse/test/link-api.test.js)

Add coverage for:

- default link requests optional liabilities
- liability-upgrade token route
- account-edit token route
- disconnect route calls Plaid removal and preserves local history
- purge route deletes local history only as an explicit destructive action

### Sync / lifecycle tests

Extend:

- [test/sync.test.js](/Volumes/DATA/workspace/homeApps/familyPulse/test/sync.test.js)

Add coverage for:

- item capability status changes
- non-fatal liability consent required states
- post-update-mode account set refresh

### Manual institution tests

At minimum:

- Chase OAuth reauth
- Chase liability-upgrade attempt
- Chase account-selection messaging
- true disconnect behavior and billing expectation messaging

## Recommended Next Slice

The safest first implementation sequence is:

1. Add true disconnect via Plaid `/item/remove`
2. Replace current delete semantics with preserve-history disconnect as the default
3. Add a separate explicit purge action for local deletion
4. Unify new link tokens around optional liabilities
5. Add dedicated item-level actions for reauth vs liability upgrade
6. Add account-selection editing where Plaid supports it

Why this order:

- the billing leak is the highest operational risk
- disconnect semantics should be fixed before expanding connection-management surface area
- once disconnect is trustworthy, the rest of the lifecycle becomes less risky to evolve

## Relationship to Existing Plans

This broader feature supersedes the narrower liability-only planning work as the main
implementation frame.

Related document:

- [planning/plaid-liability-consent-unification-plan.md](/Volumes/DATA/workspace/homeApps/familyPulse/planning/plaid-liability-consent-unification-plan.md)
