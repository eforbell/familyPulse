# Feature 14: Plaid Disconnect Lifecycle

## Purpose

Fix the institution-removal lifecycle so Family Pulse can actually disconnect a Plaid
Item remotely, stop future sync and billing, and preserve local history by default.

## Why This Matters

Today the app's remove action is local-only. That means a user can believe an institution
is gone while the Plaid Item may still exist remotely and continue incurring billing for
subscription products. It also means the app has no clear distinction between:

- disconnecting from Plaid
- fixing login issues
- permanently deleting local history

This feature fixes that lifecycle gap first before broader Plaid connection-management
changes.

## Scope

### Phase 1: Real Disconnect
- Add a dedicated disconnect action that calls Plaid `/item/remove`
- Preserve local accounts and transactions by default
- Mark the institution as disconnected / archived locally
- Stop future sync attempts for disconnected institutions

### Phase 2: Separate Purge
- Add a distinct destructive action to permanently delete local institution history
- Keep purge separate from normal disconnect semantics

### Phase 3: UI Clarity
- Settings clearly distinguishes `Disconnect`, `Fix login`, and `Purge`
- Disconnect messaging explicitly says local history is retained by default

### Phase 4: Tests
- Route test for remote disconnect behavior
- Route test for explicit purge behavior
- Sync test verifying disconnected items are excluded from future syncs

### Phase 5: Reconnect Policy
- Define how a future reconnect interacts with archived local history
- Avoid silent duplication or ambiguous merging when an institution is linked again later

## Key Design Decisions

- **Disconnect preserves history by default** — users often still want historical reporting for closed or problematic institutions
- **Purge is separate and destructive** — deleting local data should never be the silent default
- **Remote disconnect must call Plaid first** — local UI semantics should match remote billing reality
- **Disconnected items should stop syncing, not vanish from understanding**
- **Reconnect behavior must be explicit** — preserving history changes how future relinks should be handled

## Definition of Done

- Disconnect calls Plaid `/item/remove`
- Disconnected institutions are excluded from sync
- Local history remains available after disconnect
- Purge exists as a separate destructive action
- Settings copy makes the difference clear
- Reconnect semantics are explicitly documented for future implementation work
