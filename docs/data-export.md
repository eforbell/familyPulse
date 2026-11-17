# Operator data export

## Available export

Parents can use **Settings → Data Export → Download transactions CSV** to download
all retained transactions. This is a one-way dump, **not a backup or import format**.
`GET /api/export?format=csv` uses the same parent authorization, including when
local passphrase authentication has not been configured. No anonymous or child export.

There are no UI/date/account filters or pagination limits. Pending, transfer,
hidden duplicate, source-removed, imported, and historical/disconnected-account
transactions remain included. Rows are ordered by transaction date and ID.

Each transaction appears **once** with its original signed amount (positive means
outflow; negative means inflow). Joined data includes:

- Account identity, display name, owner, type, mask, sync state and institution.
- Original transaction fields, original source JSON, display override,
  categorization/suggestion provenance, transfer pairing and duplicate references.
- Note text, timestamps and author/editor names.
- Canonical category allocations as a JSON array, including signed amounts,
  category names, income/transfer/spending flags and author metadata.
  `category_id` / `legacy_category_name` are legacy compatibility fields, **not**
  the authority for split transactions; use `allocations` instead.
- Recurring matches as a JSON array (only actual history links, no guessed matches).
- Paycheck event and deposit-leg details as JSON objects, including gross pay,
  deductions, member/employer and reconciliation state. Multiple deposit legs can
  share one event; do not sum repeated event-level gross pay across transactions.
- Attachment metadata as a JSON array. Attachment files and internal storage paths
  are not included.

Credentials, sessions, member passphrase hashes, application configuration, Plaid
access tokens and sync cursors are excluded. The download still contains sensitive
financial data, notes and source payloads. Privacy mode does not redact the export.
Deleted/purged rows and attachment binaries cannot be recovered from it.

## Consistency, encoding and handling

- One PostgreSQL **repeatable-read, read-only** snapshot for the whole export.
- Server-side cursor fetches 500 rows at a time, writing a private temporary file
  before offering a download. Query/write failures do not offer partial exports.
  Temporary files are removed after transfer or failure; response caching is disabled.
- UTF-8 with BOM, CRLF record separators, every field quoted, embedded quotes
  doubled. Quoted fields may contain newlines; do not parse by splitting lines.
- Dates are `YYYY-MM-DD`; top-level timestamps are UTC ISO 8601. Structured cells
  are JSON. Null values are empty fields; numeric amounts keep database precision.
- Potential spreadsheet formulas in text are prefixed with an apostrophe, including
  whitespace/control-prefixed and full-width initiators. Signed database-typed
  numeric values remain numeric text. This deliberately changes affected text for
  safer spreadsheet opening; CSV is not lossless or a restore format.
- Spreadsheet software can infer types (e.g. lose leading zeroes from masks) or
  reinterpret CSV formulas after editing/re-saving. Use explicit text-column import
  when exact string handling matters; do not enable formulas from untrusted data.
- The browser buffers the completed download as a Blob; unusually large exports
  need enough browser memory and server temporary disk space.

## XLSX feasibility research (2026-11-17)

Multi-sheet XLSX is feasible. Recommended sheets are **Transactions, Accounts,
Categories, Recurring Income, Recurring Expenses**, with **Allocations, Recurring
History, Paychecks, Paycheck Deposits, Attachments, Planned Cashflow** to preserve
one-to-many details without multiplying transaction amounts. XLSX and standalone
related-table worksheets are outside the scope of this CSV-only release.

Options researched:

1. **ExcelJS**: MIT-licensed, supports multiple sheets and a streaming XLSX writer
   with committed rows. Best fit for straightforward typed data dumps, without
   browser spreadsheet code. String values must be explicit strings, never formula
   objects. Would add a production dependency and its transitive dependency tree.
   Sources: [upstream documentation](https://github.com/exceljs/exceljs#streaming-xlsx)
   and [license](https://github.com/exceljs/exceljs/blob/master/LICENSE).
2. **SheetJS Community Edition**: also supports workbook generation, but current
   Node installation uses the vendor CDN; its official docs identify the public npm
   `xlsx` release as outdated (0.18.5 versus documented CDN 0.20.3). Do not simply
   install the npm package by name. Source:
   [official installation guidance](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).
3. **Dependency-free Open XML/ZIP**: technically possible because XLSX consists of
   workbook/worksheet XML parts and relationships inside a ZIP package. Rejected
   for now: maintaining a custom file-format/ZIP writer is disproportionate to
   this feature. Source:
   [Microsoft SpreadsheetML structure](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document).

The operator review will assess CSV only; revisit XLSX only if a need emerges.
No spreadsheet dependencies or dormant workbook queries are included. A future
XLSX change would need explicit dependency approval. If pursued, consider ExcelJS,
write text/IDs/masks as literal string cells and amounts/booleans as typed values,
and verify generated files with an independent reader. Excel limits are 1,048,576
rows per sheet and 32,767 characters per cell; never silently truncate source JSON
or rows. Reject oversized XLSX data clearly with CSV as the fallback, or split it
with an explicitly documented scheme.
Source: [Microsoft Excel limits](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits).

CSV security considerations follow [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection).
