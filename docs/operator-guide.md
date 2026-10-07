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
