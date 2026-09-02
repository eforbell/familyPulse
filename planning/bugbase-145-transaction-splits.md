# Bugbase #145 — Normalized Transaction Allocations

## Decision

Category allocations are the canonical categorization model. A transaction is
the immutable bank/Plaid event; one or more signed allocation rows describe how
its amount is categorized. Every application read and write uses
`transaction_allocations`.

## Invariants

- Every transaction has at least one allocation.
- Allocation amounts have cent precision and sum exactly to the transaction
  amount; a deferred database constraint enforces this at commit.
- A category appears at most once in the current editor/API payload.
- Posted transactions may be split. Pending transactions remain single until
  Plaid posts them.
- Transfer parents are not splittable, and transfer-class categories cannot be
  mixed with ordinary categories while reporting remains transaction-scoped.
- There is no household-facing split limit. The API's 24-row ceiling is only a
  malformed/abusive-payload guard.
- Merchant learning consumes single-category decisions only. A split does not
  train one category as though it represented the entire purchase.

## Signed compound entries

Signed rows deliberately support a future paycheck enrichment workflow. For a
Plaid net deposit of `-5000.00`, allocations such as gross income `-7000.00`,
withheld tax `1200.00`, and healthcare `800.00` reconcile to the source event.
This lets budget reporting show gross income and deductions while preserving
net cash flow and the original bank record.

The first split UI is intentionally simpler: it creates ordinary same-direction
purchase splits with progressive rows. A dedicated paycheck editor can later
expose mixed signs, gross-pay fields, and reconciliation guidance without
another schema migration.

## Deployment compatibility

Migration 025 retains `transactions.category_id` temporarily as a write-through
projection so an old process or older import fixture cannot create transactions
without allocations while the migration and new server are deployed. It is not
an application read model.

The projection protects allocation row existence, not split preservation: an old
writer that assigns `transactions.category_id` will intentionally collapse the
transaction to one allocation. Deployment must therefore avoid mixed-version
writes once users can create splits. Drain/stop the old application, migrate, and
start the allocation-aware release before enabling user traffic. Rolling back
after split writes requires an allocation-aware build or a data conversion; an
old build must not be put back into write service. After one stable release, a
contraction migration may remove the compatibility trigger and column once all
external/direct writers are confirmed allocation-aware.
