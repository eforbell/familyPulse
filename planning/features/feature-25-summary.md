# Feature #25: Recurring Stream Health Alerts

## Problem
The recurring detector (Features 19/22) already knows things the household would want to be told
about — and tells no one. `recurring_expenses` carries `prior_amount`, `price_change_pct`, and
`price_change_direction` (the recurring page even renders an "Up X%" badge), plus
`expected_next_date` and per-stream `tolerance_days`. But all of it is pull-based: someone has to
open the recurring page and notice. Meanwhile the staleness heuristic marks a stream `stale` only
at 2× its interval — a biweekly paycheck would have to be **four weeks late** before the system
reacted at all.

Three high-value moments currently pass silently:
1. A subscription raises its price
2. Expected income doesn't arrive on schedule
3. A new recurring commitment appears (the free trial that quietly converted)

## Solution
A bridge feature: no new inference (except missed-income timing), just event plumbing from
detections the system already makes into the notification pipeline that already exists
(migrations 019/020, per-member subscriptions, cooldowns, brrr transport,
`scripts/send-notifications.js`).

### Three new event types
| Event | Trigger | Dedup |
|-------|---------|-------|
| `recurring_price_creep` | Detector-recorded upward change ≥ threshold (default 5%) on an active stream | Once per stream + price_change_date |
| `recurring_missed_income` | Active income stream past `expected_next_date + tolerance_days` with no arrival | Once per missed occurrence |
| `recurring_new_commitment` | Newly detected medium/high-confidence recurring **expense** stream | Once ever per stream identity |

### Key timing insight
Missed-income evaluation uses the stream's own schedule tolerance (days), not the 2×-interval
stale heuristic (weeks). It runs in the post-sync recurring refresh, so a deposit arriving in the
same sync cancels the candidate before anything is sent. The stale/likely_cancelled lifecycle is
untouched — this is additive and faster, not a replacement.

## Key Decisions
- **Deterministic end to end** — these alerts are pure numbers (prior/new amount, percent, days
  overdue); that's exactly why they're high-signal. No LLM.
- **Ride the existing pipeline** — new event types extend the migration-020 CHECK-constraint
  pattern and the `EVENT_TYPES` registry; `send-notifications.js` is unchanged. Per-member
  opt-in, interruption levels, cooldowns, and delivery logging come for free.
- **No initial flood** — a migration high-water mark exempts all pre-existing streams from
  new-commitment alerts; only streams detected after the feature ships can notify.
- **Income-only for missed; expense-only for new** — a late paycheck is urgent, a new paycheck
  is never a surprise. Missed *bill* alerts (autopay failed) are deferred, same mechanism.
- **In-app mirror** — the recurring page gains an alerts strip plus a `recurring_alert_events`
  history table, so "did Pulse tell me about this?" is always answerable and nothing is
  notification-only.
- **Downward price changes don't push** — visible on the page, not worth a phone buzz.

## New Database Objects
| Object | Purpose |
|--------|---------|
| `recurring_alert_events` table | Generated-event history with timestamps (inspectable provenance) |
| CHECK-constraint extensions | Add 3 event types to subscriptions / event-state / delivery-log tables |
| `price_creep_threshold_pct` config | Admin-tunable threshold, default 5 |
| New-commitment high-water mark | Exempts pre-existing streams from first-run alert flood |
| Migration (number assigned at implementation, after Feature 24's 023) | All of the above |

## Expected Files
| File | Change |
|------|--------|
| `db/migrations/0XX-recurring-health-alerts.sql` | Tables, constraint extensions, high-water mark |
| `lib/recurring-alerts.js` | Pure detector-state → event-candidate rules |
| `lib/recurring-detector.js` | Post-detection hook invoking alert generation |
| `lib/notification-rules.js` | EVENT_TYPES registry + candidate evaluation for 3 new types |
| `lib/routes/recurring.js` | Alert-history endpoint (parent-scoped) |
| `public/recurring.html` / `public/recurring.js` | Alerts strip, mobile-first |
| `public/admin.html` / `public/admin.js` | Threshold config + per-member event toggles |
| `test/recurring-alerts.test.js` | Event rules, thresholds, dedup, high-water mark |
| `test/notification-rules.test.js` | Registry + candidate emission extensions |
| `test/e2e/...` | Alerts strip rendering, mobile viewport, admin toggles |

## Test Plan

### Automated now
- Price creep fires at threshold, not below; once per distinct change; excluded statuses silent
- Missed income fires at expected+tolerance+1, silent within tolerance, suppressed by same-sync
  arrival, respects override_expected_next_date, dedups per occurrence
- New commitment fires for medium/high expense streams only; pre-existing streams exempt;
  once ever
- Subscription gating, cooldown writes, and delivery logging identical to existing event types
- Existing four event types regress-tested unchanged

### Manual checks
- Dry-run `scripts/send-notifications.js --dry-run` with a seeded price change and confirm copy
  reads well on a lock screen
- Verify per-stream tolerance_days on the live table look sane as missed-income grace periods
- Confirm the alerts strip stacks cleanly on the iOS web wrapper
- Trigger a real brrr delivery for one event type end to end

## Definition of Done
- A subscription price increase, a late paycheck, and a new subscription each produce exactly one
  well-formed notification (opt-in respected) and a matching in-app alert
- No alert flood on first deploy against existing streams
- Existing notification event types and recurring-page behavior fully unchanged
- All event rules covered by fixture-driven unit tests; strip covered by Playwright including
  mobile viewport
