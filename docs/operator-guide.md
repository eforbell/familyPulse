# Family Pulse Operator Guide

Troubleshooting notes for the person running the household's Family Pulse instance.

## Balance history (Accounts page)

The chart on `accounts.html` is **reconstructed**, not recorded. Family Pulse keeps no
daily balance snapshots, so each account's past balance is today's balance with
synced transactions walked backwards. The result is only as good as the synced data.

Deposit accounts plot positive and credit accounts plot negative. Investment and loan
accounts are not charted (their balances move with markets and interest, which
transactions don't capture).

### "N accounts have limited history"

The note under the chart appears when an account can't be charted for the whole range.
Hover it to see which accounts. Typical causes:

| Cause | What you see | What to do |
|---|---|---|
| **Account linked recently** | Line starts partway through the range | Nothing — history fills in as it ages. Net position only spans dates where every account has data. |
| **No synced transactions** | Account has no line and is left out of net | Run a sync; confirm the account is selected in Settings and the institution link is healthy. |
| **No current balance** | Account has no line and is left out of net | Typical for imported (Monarch) accounts that have no live balance. Link the real account via Plaid, or leave it out. |
| **Removed transactions** | Past balances differ from the bank | Transactions the bank later removed are ignored on purpose. Re-sync if a removal looks wrong. |

### Why a past balance can look off

- History starts at the account's earliest synced transaction. Balances before that are
  unknown, not zero.
- Pending and hidden (duplicate) transactions are ignored.
- The chart uses the ledger balance. The page's top card may use the available balance,
  so the last point can differ slightly.
- If transactions were never synced for part of the range, every balance before the gap
  is shifted by the missing amount.

## Linking institutions: Plaid behavior

Family Pulse now supports editing the synced account set for an existing Plaid Item through update mode, and preserves de-selected accounts locally as historical instead of deleting them.

A few institution behaviors are worth knowing up front:

- Many OAuth institutions appear to be effectively add-only from Plaid Link's point of view.
- In production testing, both `Chase` and `Capital One` allowed adding newly shared accounts more easily than removing a single account from an existing Item.
- Some institutions expose removal only as a full app disconnect on the bank side, not as a granular per-account de-selection flow for Family Pulse.
- Because of that, `Edit synced accounts` should be treated as a best-effort review/add flow, not a guarantee of symmetric add/remove control across all institutions.
- If an Item needs a permission reset, or if liabilities were never added to a legacy bundled Item, the practical remedy may be `Disconnect` followed by a fresh `Link Institution`.

Current app behavior:

- `Disconnect` removes the Plaid Item remotely and stops future sync/billing, but preserves local history.
- `Purge` is the explicit destructive action for deleting preserved local history after a disconnect.
- Historical accounts remain visible for past transactions and account history, but they no longer affect live balance totals.

## Reset linked financial data

If you previously linked sandbox institutions and want to start fresh before switching to production Plaid credentials, the safest path is usually to clear linked financial data from the database instead of trying to clean it up manually in the UI.

This script preserves:
- `family_members`
- `sessions`
- `app_config`
- `categories`
- `category_rules`
- `schema_migrations`

It clears:
- Plaid-linked `items`
- `accounts` via cascade
- `transactions` via cascade
- `account_members` via cascade
- `link_sessions`
- `import_runs`
- `anomalies`
- `budget_snapshots`
- `magic_actions_log`

It preserves the `monarch-import` sentinel item so historical Monarch CSV import continues to work after the reset.

Run it intentionally:

```sh
npm run db:clear-linked-data
```

Or directly:

```sh
node db/clear-linked-data.js --yes
```

## Backup restore drill

Run a monthly restore drill to prove backups are fully recoverable:
- [planning/restore-drill.md](../planning/restore-drill.md)

The runbook is written for `pg_dump -Fc` backups and `pg_restore` validation into an isolated drill database.
If transaction attachments are in use, include `/data/apps/familyPulse/transaction-files` in the same backup window as the database dump.

## Silent push verification

Push setup uses `PUSH_BASE_URL` (default: `https://api.brrr.now`). In notification
settings, **Verify saved secret (no push)** rechecks the currently saved target;
save any edited secret first. Saving a target also returns a verification result.
The check uses bearer-authenticated `GET /v1/check` with a timeout and refuses
redirects or URLs belonging to a different push service. Secrets and gateway
response bodies are not included in verification feedback.

A verified device/person secret means homePush recognizes it and has at least one
active device with an APNs key. It does **not** prove phone delivery, notification
permissions, or end-to-end receipt. Unknown secrets, inactive devices, missing
APNs keys, connectivity errors, and invalid responses remain **not verified**.
brrr and endpoints returning 404/405/501 are **unsupported**, not successful
verification; saving remains available. Results are point-in-time, not a durable
health badge—recheck after changing services or rotating/enrolling devices.
