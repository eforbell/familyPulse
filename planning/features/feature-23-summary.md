# Feature #23: Push Notification Reminders Foundation

## Problem
Family Pulse already knows about important money events, but it is passive. The app can show a
forecast, highlight recurring bills, and report sync status, yet none of that helps if Eric or Alex
do not open the app at the right moment.

There are several event types that feel useful enough to justify a push-based reminder layer:
- a real large expense lands
- Plaid sync breaks or starts needing attention
- a category goes materially over budget for the month
- the month is ending and it is worth reviewing what happened

The challenge is not just "send pushes." It is doing it in a way that is:
- simple for a household
- secure for per-user device secrets
- quiet enough to trust
- reusable later if Family Pulse adds more event types or delivery channels

## Solution
Add a server-driven reminder system with `brrr` as the first delivery channel.

This should be split into two phases.

### Phase 1: Foundation
- Securely store a per-member `brrr` secret or webhook URL in PostgreSQL
- Expose parent-only settings to enable/disable notification delivery per member
- Let parents subscribe each member to simple event categories
- Add a test-send action so onboarding can be validated immediately
- Run reminder evaluation from a separate scheduled process, following the same
  `systemd` timer pattern already used in `familyHelp`
- Track reminder state and delivery history separately so repeated runs do not spam

### Phase 2: Event rules
Ship a small, trustworthy set of reminder rules:

1. **Large expense**
   Notify when a non-transfer, non-hidden, non-pending expense above a threshold
   (default: $1,000) is first observed.

2. **Sync issue**
   Notify when Plaid sync fails in a way that likely needs attention, with distinct
   treatment for `needs_reauth` vs. generic sync errors.

3. **Budget overrun**
   Notify when a category first crosses a configurable percentage over budget for the month.
   Initial proposal: `15%` over budget. One notification per member per category per month.

4. **Month in review**
   Send a soft reminder near month-end or early next month with a link to Reports,
   even before there is a dedicated month-close surface.

## Why `brrr`
`brrr` is the right first step for Family Pulse:
- no PWA or browser push infrastructure required
- per-device onboarding is simple
- server integration is just an HTTP POST
- the FamilyHelp codebase already has a working local pattern for secret storage,
  delivery helpers, and `systemd` timer execution

This is not the full notification endgame. It is the lowest-friction path to real household value.

## Key Decisions
- **Parents-only in v1**: parents configure parent notification channels and subscriptions
- **Write-only secrets**: save to DB, never show raw secret again after write
- **Separate runner**: notification evaluation does not depend on web traffic
- **Event categories first**: keep subscription UX simple rather than exposing many low-level toggles
- **Cooldowns are mandatory**: every event type must define dedupe and resend rules before it ships
- **High-confidence rules first**: large expense and sync issue should launch before softer or noisier events
- **Reuse FamilyHelp’s pattern**: port the good parts of channel masking, `brrr` normalization,
  and `systemd` timer execution instead of inventing a second approach

## What Still Needs Tightening
The feature is close to implementation-ready, but a few points still deserve explicit decisions:

1. **Month-in-review schedule**
   Decide whether this should fire:
   - on the last day of the month
   - on the first day of the next month
   - only after a future monthly-close report exists

2. **Audience scope for sync issues**
   Decide whether sync issues should notify all subscribed parents or one default operator first.

3. **Channel cardinality**
   The PRD currently keeps v1 to one `brrr` channel per member. That is reasonable, but should stay explicit.

4. **Budget overrun crossing semantics**
   The rule should fire on first threshold crossing for the month, not on every later increase.

## Recommended Start Order
1. Build channel storage, masking, subscriptions, and test-send
2. Add the standalone runner plus `systemd` timer wiring
3. Implement large expense alerts
4. Implement sync issue alerts
5. Implement budget overrun alerts
6. Add month-in-review

## Expected Files
| File | Change |
|------|--------|
| `db/migrations/019-notification-foundation.sql` | Notification channels, subscriptions, event state, delivery log |
| `lib/notifications.js` | `brrr` normalization and send helper |
| `lib/notification-rules.js` | Event selection, dedupe, cooldown logic |
| `scripts/send-notifications.js` | Standalone runner |
| `deploy/family-pulse-notifications.service` | `systemd` oneshot runner |
| `deploy/family-pulse-notifications.timer` | Scheduled evaluation |
| `server.js` | Route wiring for settings APIs |
| `public/settings.html` | Notification onboarding + subscriptions |
| `public/settings.js` | Save/mask/clear/test-send UI |
| `README.md` | Deployment and operational guidance |

## Test Plan

### Automated now
- Channel save/replace/clear APIs with auth and masked reads
- Secret normalization for raw secret vs full webhook URL
- Event subscription CRUD
- Dedupe/cooldown rules for repeated runner execution
- Large expense rule filters out transfers, hidden rows, and pending transactions
- Sync issue rule distinguishes reauth vs transient error paths
- Budget overrun rule fires on first monthly threshold crossing only

### Manual checks
- Save a real `brrr` secret for one parent and send a test push
- Verify a saved secret cannot be read back in plaintext
- Dry-run the notification runner and inspect candidate output
- Trigger a real large-expense event and confirm one-time delivery
- Simulate repeated sync failures and confirm cooldown behavior
- Trigger a category crossing 15% over budget and confirm one notification for that month
- Verify deep links land on the right Pulse screens on iPhone
