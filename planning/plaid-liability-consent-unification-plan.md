# Plaid Liability Consent Unification Plan

## Status

Deferred implementation plan for resolving the current mismatch between:

- split onboarding flows for depository vs liability accounts
- OAuth institutions that expose depository, credit, and loan accounts under one bundled Item

As of March 18, 2026, the current product split solves one class of onboarding failure but creates a dead-end for some existing Items that were originally linked without liability consent.

This plan is now best read as a sub-problem of the broader Plaid connection-management
work captured in:

- [planning/plaid-connection-management-plan.md](/Volumes/DATA/workspace/homeApps/familyPulse/planning/plaid-connection-management-plan.md)

## Problem Summary

Family Pulse currently has two Plaid link flows:

- standard bank flow: `transactions` only
- credit / loan flow: `transactions` + `liabilities`

This behavior was introduced to reduce onboarding friction for institutions where requiring liabilities caused Link failures.

That split works for new intentional flows, but it breaks down for institutions like Chase where:

- checking, credit card, and mortgage accounts may belong to the same Item
- the institution uses OAuth consent
- the user may initially link only depository access
- later they want liability data for an already-linked institution

Current outcome:

- the existing Item stays effectively transactions-only
- the current "Fix" / update flow repairs login but does not upgrade the Item's consent scope to liabilities
- users cannot reliably enable liability data later for the same institution without awkward workarounds

## What the Code Does Today

### Standard link flow

`POST /api/link/create-token` requests:

- `products: ['transactions']`

Reference:

- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)

### Liability link flow

`POST /api/link/create-liability-token` requests:

- `products: ['transactions', 'liabilities']`

Reference:

- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)

### Update / re-link flow

`POST /api/link/update-token` creates Link in update mode using:

- `access_token`
- no product expansion

And in the Plaid client wrapper, update mode explicitly deletes `products`.

Reference:

- [lib/routes/link.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/routes/link.js)
- [lib/plaid-client.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/plaid-client.js)

### Sync behavior

Sync only attempts `liabilitiesGet` when an Item's current accounts payload already contains at least one `credit` or `loan` account.

Reference:

- [lib/sync.js](/Volumes/DATA/workspace/homeApps/familyPulse/lib/sync.js)

## Root Cause

The app currently treats "liability onboarding" as a separate institution-linking path, but Plaid and OAuth institutions often treat consent at the Item level.

That means:

- product selection is not really "per account" in the way the UI suggests
- once an Item is created without liability access, the current reauth path does not upgrade it
- the split flow is conceptually mismatched with the underlying institution model

## Goal

Unify Plaid onboarding so the app:

- still avoids failing normal bank linking when liability consent is not granted
- can gather liability consent when available
- can upgrade existing Items later without forcing delete-and-relink behavior

## Non-Goals

- Requiring every institution to grant liabilities
- Forcing all users through a liability-specific onboarding flow
- Reworking the liability coverage calculator itself
- Guaranteeing every mortgage or loan institution will supply liability data

## Proposed Product Strategy

### New default for fresh links

Use:

- required products: `transactions`
- optional products: `liabilities`

Why:

- preserves the safer default onboarding path
- aligns better with Plaid guidance for products that may or may not be consented during OAuth
- reduces the mismatch between "bank link" and "credit / loan link"

This changes the meaning of the default flow from:

- "link only depository accounts"

to:

- "link the institution for transactions, and request liability access when available"

### Existing legacy Items

Add an explicit "Enable liabilities" or "Upgrade permissions" path for an already-linked Item.

This path should:

- use Plaid update mode
- request the additional liability permission/consent needed for that Item
- be separate from pure reauth / login repair in the UI

## Recommended UX Changes

### Replace split onboarding with a clearer model

Preferred eventual UI:

- `+ Link Bank`
- per-item action: `Enable liabilities`
- per-item action: `Fix login`

Avoid conflating:

- broken credentials
- missing product consent

Those are different problems and should not share a single "Fix" label.

### Transitional option

If removing the split buttons immediately feels risky, keep the existing button layout temporarily but change semantics:

- default link requests optional liabilities
- liability button becomes "upgrade an existing institution for liabilities" rather than "start a separate liability institution"

## Backend Implementation Plan

### Phase 1: Unify new-item token creation

Update `create-token` behavior so new Items request:

- `products: ['transactions']`
- `optional_products: ['liabilities']`

Tasks:

1. Extend `plaid.createLinkToken()` to accept `optionalProducts`
2. Pass `optional_products` into Plaid Link token creation
3. Update tests for token creation behavior

### Phase 2: Add item capability / consent visibility

Add a way to identify Items that likely do not have liability consent yet.

Possible heuristics:

- institution has credit/loan accounts but no liability fields have ever been populated
- `liabilitiesGet` returned `ADDITIONAL_CONSENT_REQUIRED`
- item was created under the old transactions-only flow

Preferred implementation:

- persist an item-level liability consent / capability status instead of inferring forever from sparse account data

Candidate item states:

- `unknown`
- `enabled`
- `not_requested`
- `consent_required`
- `not_supported`

### Phase 3: Add explicit liability-upgrade update mode

Create a dedicated endpoint for upgrading an existing Item's permissions.

Candidate route:

- `POST /api/link/upgrade-liabilities-token`

Input:

- `item_id`

Behavior:

- fetch the Item access token
- create Plaid Link update-mode token
- request liability consent expansion
- preserve link session tracking for OAuth resume

Open question:

- exact Plaid request shape for product expansion in update mode should be confirmed against current docs before implementation

### Phase 4: Separate UI actions

On Settings institution rows:

- keep `Fix` for `needs_reauth`
- add `Enable liabilities` when the Item appears upgradeable

Possible visibility rules:

- show when item status is `good` or `needs_reauth`
- show when liability consent is not yet enabled
- hide when item is already confirmed liability-enabled

### Phase 5: Sync + status handling

Improve sync bookkeeping so liability-related failures become actionable instead of silent.

Possible changes:

- capture `ADDITIONAL_CONSENT_REQUIRED` at the item level
- do not mark the whole Item as broken just because liabilities are unavailable
- surface a non-fatal capability hint in Settings

## Suggested Data Model Changes

Likely useful item-level fields:

- `liability_access_status`
- `liability_access_checked_at`
- `liability_access_note` or last non-fatal code

These could live on `items` and avoid trying to infer consent from account rows forever.

## Migration / Backward Compatibility

### Existing Items created under old transactions-only flow

Need a non-destructive upgrade path:

- do not require deleting and re-linking the Item
- do not lose owner/account associations
- do not create duplicate institutions if avoidable

### Existing Items already linked with liabilities

Must continue to work unchanged.

### Existing split buttons

Can be preserved temporarily if needed, but the backend should stop assuming a strict institutional split between depository and liabilities.

## Risks

1. Plaid update mode product-expansion details may be more restrictive than expected for some institutions.
2. Optional liabilities on new links may still expose some edge-case OAuth behavior that needs institution-specific tuning.
3. Item-level status heuristics may misclassify sparse liability institutions unless explicit status is persisted.
4. UI language must avoid implying that liabilities are always available or always required.

## Test Plan

### Link token tests

Extend:

- [test/link-api.test.js](/Volumes/DATA/workspace/homeApps/familyPulse/test/link-api.test.js)

Add coverage for:

- default link requests optional liabilities
- upgrade-liabilities token route uses update mode
- reauth route remains distinct from upgrade-permissions route

### Sync tests

Extend:

- [test/sync.test.js](/Volumes/DATA/workspace/homeApps/familyPulse/test/sync.test.js)

Add coverage for:

- non-fatal liability consent required behavior
- item-level liability capability status updates

### UI / flow tests

If front-end tests remain manual:

- verify legacy item shows `Enable liabilities`
- verify broken item shows `Fix`
- verify upgraded item no longer shows liability-upgrade action once successful

## Recommended Next Slice

Smallest useful implementation sequence:

1. Update new link tokens to use optional liabilities.
2. Add item-level liability access status.
3. Add a dedicated backend route for liability-permission upgrade.
4. Expose a separate Settings action for legacy Items.

## Decision

Do not keep the current strict split model as the long-term design.

Preferred direction:

- unified default onboarding
- liabilities requested opportunistically, not required
- explicit upgrade path for legacy Items that need additional consent
