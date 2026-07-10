# Feature #24: Learned Auto-Categorization

## Problem
Categorization is the last genuinely manual chore in Family Pulse. The current pipeline knows
only two signals: hand-written `category_rules` (exact/contains string match) and a small
hard-coded Plaid taxonomy mapping. Critically, when a parent manually categorizes a transaction,
the system learns nothing — unless a rule is explicitly created, the same merchant arrives
uncategorized again next month. Meanwhile `lib/merchant-normalizer.js` already builds robust
merchant fingerprints, but only the recurring detector and seasonal baseline use them;
categorization still matches raw strings.

The household's own history is the best classifier it will ever have, and it's sitting unused.

## Solution
Teach categorization to learn from normal use, with a strict confidence split:

1. **Silent learning** — every manual categorization upserts a fingerprint→category association
   (`learned_category_rules`). No dialogs, no "create rule?" friction. Re-categorizing updates
   the association.
2. **History vote on sync** — uncategorized transactions are fingerprinted; a learned rule
   (trusted immediately at count 1 — operator categorization is direct teaching) or a
   unanimous history (≥3 prior occurrences, all one category) auto-applies with
   `categorization_source = 'learned'`.
3. **Suggestions, not guesses** — majority-but-not-unanimous history, or Plaid-taxonomy-only
   signal for novel merchants, populates a *suggestion* on the transaction instead of silently
   assigning. The transactions page renders one-tap accept/reject chips (mobile-first).
   Categorization becomes confirming, not typing.
4. **Rejection memory** — a rejected fingerprint→category pair is never re-suggested.
4a. **Contextual categories don't teach** — categories flagged `exclude_from_learning`
   (Vacation) never create learned rules, never count in history votes (either direction),
   and are never suggested. Stamping a Mobil charge as Vacation leaves the merchant's
   everyday Gas & Auto learning fully intact. Mirrors the `exclude_from_baseline` pattern
   from migration 016; flag editable in the admin category editor.
5. **Provenance everywhere** — every auto-assigned category shows why (rule / learned / plaid),
   and manually-set categories are terminal: no automatic pass ever overwrites them.

### Precedence Chain
```
explicit category_rules  >  learned associations (count-1 trusted)
Plaid taxonomy: suggestion-only, never silent auto-apply (decided 2026-07-07)
manual categorization is never overwritten by anything
```

## Key Decisions
- **Deterministic v1**: no LLM anywhere in this feature. An optional LLM fallback classifier
  (single category-id output feeding the suggestion queue — never prose, never auto-apply) is
  explicitly deferred until the deterministic hit-rate is measured.
- **Reuse fingerprints**: same `buildMerchantFingerprint` that powers recurring detection —
  proven on this household's data; no new normalization scheme.
- **Unanimity gates auto-apply**: anything ambiguous goes to the review queue. A wrong silent
  categorization costs trust; a suggestion costs one tap.
- **Learning is non-blocking**: capture failures log and swallow; categorizing never errors
  because learning hiccuped.
- **Backfill protects history**: existing categorized rows get `categorization_source = 'manual'`
  so retroactive passes can never clobber past data.
- **Learned rules are household intent**: preserved by `db/clear-linked-data.js`, same as
  categories and `category_rules`.

## New Database Objects
| Object | Purpose |
|--------|---------|
| `learned_category_rules` table | Fingerprint → category associations with occurrence stats |
| `suggestion_rejections` table | Fingerprint + category pairs never to re-suggest |
| `transactions.merchant_fingerprint` | Stored fingerprint column (indexed, backfilled) |
| `transactions.categorization_source` | manual / rule / learned / plaid provenance |
| `transactions.suggested_category_id` + `suggestion_source` | Pending suggestion state |
| `categories.exclude_from_learning` | Contextual stamp-over categories exempt from all learning — seeded true for Vacation and Travel (Travel reserved for future unreimbursed business travel, same stamp-over pattern) |
| Migration 023 | All of the above |

## Expected Files
| File | Change |
|------|--------|
| `db/migrations/023-learned-categorization.sql` | New tables, transaction columns, backfill |
| `lib/learned-categorization.js` | Learning capture, history vote, suggestion generation |
| `lib/categorization.js` | Precedence chain integration, manual guard, per-source counts |
| `lib/sync.js` | Fingerprint population on upsert |
| `lib/routes/transactions.js` | Learning hooks on category endpoints; suggestion accept/reject endpoints |
| `public/transactions.html` / `public/transactions.js` | Suggestion chips, pending count, provenance badge |
| `db/clear-linked-data.js` | Preserve learned rules and rejections |
| `test/learned-categorization.test.js` | Vote thresholds, precedence, rejection memory |
| `test/e2e/...` | Chip accept/reject flows, regression on existing categorize flows |

## Test Plan

### Automated now
- Unanimous ≥3 history auto-applies; 2 occurrences does not
- Explicit rule beats conflicting learned association
- Manual rows untouched by categorizeMany and applyRulesRetroactive
- Re-categorization updates (not duplicates) the learned rule
- Rejected pair never re-suggested; different category still may be
- Vacation-stamping a merchant neither creates a learned rule nor breaks the merchant's
  everyday-category unanimity; exempt categories never appear as suggestions
- Suggestion endpoints parent-only; learning capture non-blocking on failure
- History vote runs as bulk grouped query (no per-row lookups)

### Manual checks
- Categorize a recurring merchant once, run a sync, confirm the next occurrence auto-applies
  with a "learned" badge
- Confirm suggestion chips are comfortably tappable on the iOS web wrapper
- Reject a suggestion and verify it stays gone across syncs
- Verify sync log reports per-source categorization counts

## Definition of Done
- A month of normal use requires near-zero typing to categorize: repeat merchants auto-apply,
  ambiguous ones are one-tap confirmations
- Every auto-applied category shows inspectable provenance
- No existing categorization, rule, or retroactive behavior regresses (Playwright sweep passes)
- Sync duration remains flat relative to pre-feature baseline
