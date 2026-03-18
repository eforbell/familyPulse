# Feature 15: Plaid Liability Permission Upgrade

## Purpose

Stop treating liability access as a separate institution-linking class. New links should
request liabilities opportunistically, and existing Items should be upgradeable later
without delete-and-relink workarounds.

## Why This Matters

OAuth institutions like Chase often bundle checking, credit, and mortgage accounts under
one Item. The current split between "bank link" and "credit / loan link" is therefore a
poor match for the underlying Item model. It leaves legacy transactions-only Items stuck
without a clean way to enable liabilities later.

## Scope

### Phase 1: Better default link behavior
- Default new links request `transactions` plus optional `liabilities`
- Successful basic bank onboarding remains the priority

### Phase 2: Upgrade existing Items
- Add a dedicated update-mode path for enabling liabilities on an already-linked Item
- Keep this separate from login repair

### Phase 3: Persist liability capability state
- Track item-level liability access state so the UI is not driven purely by inference

### Phase 4: UI clarity
- Add `Enable liabilities` when relevant
- Keep `Fix login` focused on reauth

## Key Design Decisions

- **Liabilities are optional by default** — they should not block ordinary bank onboarding
- **Legacy Items need an upgrade path** — delete-and-relink is not an acceptable long-term answer
- **Permission upgrade and reauth are different actions**
- **Persist item state** — capability should not depend only on sparse sync results

## Definition of Done

- Default new links request optional liabilities
- Existing Items can enable liabilities via a dedicated flow
- Settings shows the right CTA based on item state
- Non-fatal consent gaps are visible without marking the whole Item broken
