# Feature #21: Transaction Memory

## Problem
Family Pulse currently knows what happened, but not why it mattered. A transaction row may tell
you that $842.17 hit Lowe's, but it cannot hold the receipt, warranty invoice, reimbursement
paperwork, or the quick note that explains what the purchase was for. In practice, that means the
bank feed is visible but the household record still lives elsewhere.

If Family Pulse is going to replace Monarch as the long-term financial memory for the household,
transactions need to become durable records, not just synced events.

## Solution
Add a local memory layer to transactions:

1. **One note per transaction** for context such as warranty details, reimbursement reminders,
   or "this was the upstairs dishwasher repair"
2. **Multiple attachments per transaction** for receipts, invoices, and photos
3. **Authenticated file serving** so attachments are stored on disk but never exposed as public
   static files
4. **Retention protection** so annotated transactions are not hard-deleted if Plaid later
   removes them from the upstream feed

### Storage Model
- Files live on disk under `/data/apps/familyPulse/...`
- Metadata lives in Postgres
- Stored filenames are GUID-based to avoid collisions and keep user filenames untrusted
- One note per transaction, no note history
- Multiple attachments per transaction, no extra structure required

### V1 File Rules
- Allowed types: PDF, JPG, JPEG, PNG, HEIC
- Per-file size cap enforced on the server
- Parent-only write access
- Kids can view/download only for transactions they are already allowed to see

## Key Decisions
- **Disk, not blobs**: simpler deployment and backup story for this app family
- **Additive memory**: notes and attachments do not overwrite raw synced transaction fields
- **No revision history**: one current note is enough for v1
- **No receipt schema**: attachments are generic files, not typed objects
- **Annotated rows are durable**: if Plaid removes a transaction that has local memory, Family
  Pulse keeps it and marks it as source-removed instead of deleting it

## New Database Objects
| Object | Purpose |
|--------|---------|
| `transaction_notes` table | One note per transaction |
| `transaction_attachments` table | Metadata for receipt/invoice/image files |
| Transaction retention flags | Preserve annotated rows when upstream removes them |
| Migration 017 | Schema for memory layer |

## Files Changed
| File | Change |
|------|--------|
| `db/migrations/017-transaction-memory.sql` | New tables and retention columns |
| `lib/routes/transactions.js` | Note/detail endpoints and UI payload expansion |
| `lib/transaction-attachments.js` | Path generation, GUID naming, safe deletes |
| `lib/sync.js` | Preserve annotated rows on Plaid removal |
| `public/transactions.html` | Transaction detail surface |
| `public/transactions.js` | Note and attachment interactions |
| `public/style.css` | Detail drawer/modal styles |
| `test/transaction-memory-api.test.js` | API and auth coverage |
| `test/e2e/transaction-memory.spec.js` | Browser coverage |

## Test Plan

### Automated now
- Note create/update/clear behavior
- Attachment upload validation and metadata persistence
- Auth-gated download and delete
- GUID file naming and safe storage path generation
- Retention of annotated rows on Plaid removal
- Kid visibility scoping for note/attachment reads

### Manual checks
- Open a transaction and add a note from mobile and desktop
- Upload a PDF receipt and a phone photo
- Download attachments from the transaction detail surface
- Verify an annotated transaction survives a simulated upstream removal
- Confirm backup/restore procedure includes the attachment folder
