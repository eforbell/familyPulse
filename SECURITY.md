# Security Policy

## Scope and security objective

Family Pulse processes real household financial data from Plaid. It stores Plaid access tokens, institution and account metadata, balances, transactions, liabilities, budgets, anomalies, family roles, sessions, notes, and transaction attachments. Optional AI and MCP features can expose derived financial context outside the main browser application.

The objective is to keep provider credentials and financial records confidential, preserve parent/kid authorization boundaries, and make every external data flow explicit and limited.

## Data classification

### Critical credentials

- `PLAID_SECRET`, Plaid access tokens and public-token exchange results;
- `DATABASE_URL` and database backups;
- member passphrases/hashes, session tokens, `BOOTSTRAP_SECRET`, and `MCP_AUTH_TOKEN`;
- `OPENAI_API_KEY` and notification credentials.

### Sensitive financial and household data

- balances, transactions, merchant names, account masks, liabilities, budgets, anomalies, and sync errors;
- member names/roles and account-to-member mappings;
- notes, uploaded receipts/documents, AI summaries, MCP responses, logs, exports, and restore-drill data.

Never use production records in source-controlled fixtures, issues, PRs, screenshots, or support bundles.

## Secrets management

1. Keep `.env`, `.env.test`, database dumps, attachments, Plaid tokens, provider keys, and session tokens out of git.
2. `.env.example` must contain only empty placeholders or clearly local/sandbox values.
3. Restrict production environment files, attachment storage, and backups to the service account and administrators.
4. Use disk encryption for the host and encrypted media for off-host backups. Plaid access tokens stored in PostgreSQL depend on those host/database controls.
5. Rotate any credential that appears in git history, logs, issues, PRs, chat, screenshots, API responses, MCP output, or model prompts. Rotate first; purge copies/history second.

## Authentication and authorization

- Household creation is currently possible before `BOOTSTRAP_SECRET` is checked; the secret protects the later passphrase-setup step. Keep first-run instances restricted to localhost/private-network operators until a parent passphrase is set, then remove or rotate the bootstrap secret.
- Once configured, pages and non-public APIs must remain session-gated. Public health/bootstrap/login-discovery endpoints, including the minimized member list used by the login screen, must return only the data required for that purpose.
- Parent-only routes must enforce the role server-side.
- Kid sessions may access only accounts explicitly mapped through `account_members`; browser filtering is not an authorization control.
- Session cookies are HTTP-only and SameSite-protected, but the current setters do not add the `Secure` flag. Keep production access inside the Tailnet/private proxy boundary and treat production-aware secure-cookie support as an unresolved hardening requirement; HTTPS alone does not add the cookie flag.
- Review the 30-day session lifetime against the household threat model and invalidate sessions after credential or role changes.

## Plaid integration

- Use Plaid Sandbox or Development for tests. Never run automated tests with production Plaid credentials.
- Production `APP_URL` and `PLAID_OAUTH_REDIRECT_URI` must use HTTPS and match the configured Plaid application.
- Plaid access tokens must never enter logs, API responses, error messages, model prompts, MCP responses, screenshots, or notifications.
- Preserve the secrets guard and startup validation when adding routes or changing Plaid flows.
- Disconnecting an Item stops future Plaid access/billing but intentionally preserves local history; deletion and retention decisions must account for that copy.
- When access is suspected compromised, revoke/remove the affected Item in Plaid and reconnect only after containment.

## AI and MCP boundaries

OpenAI features are optional. Minimize financial context before model calls and keep API keys, Plaid tokens, session data, full account numbers, and unnecessary kid/member information out of prompts. Changes to AI context must pass secret-sanitization review and tests.

MCP tools are read-only but expose balances, transactions, budgets, anomalies, and financial snapshots. If MCP is enabled:

1. set a strong `MCP_AUTH_TOKEN`;
2. bind `MCP_HOST` to localhost or the narrowest trusted interface instead of `0.0.0.0` where possible;
3. use HTTPS or a trusted encrypted tunnel for remote transport;
4. authorize the AI/tool client and treat its transcripts as financial records.

An unset MCP token is not acceptable on a shared LAN, Tailnet, or public interface.

## Attachments, logs, and backups

- Validate attachment type and size, generate server-controlled file names, and never execute uploaded content.
- Serve attachments only after the same authentication and account/member authorization checks as the parent transaction.
- Logs and errors must redact secrets and avoid raw provider payloads or unnecessary transaction details.
- Back up PostgreSQL and `transaction-files` in the same recovery window. Encrypt off-host copies and run the documented isolated restore drill regularly.
- Test tooling must reject production and ordinary development database names before destructive setup or cleanup.

## Incident response

1. Remove unintended network/public access and preserve relevant redacted logs.
2. Revoke Plaid Items/tokens or rotate Plaid, OpenAI, MCP, notification, database, bootstrap, and session credentials as applicable.
3. Invalidate sessions and restart affected services.
4. Identify exposed transactions, attachments, backups, AI transcripts, MCP transcripts, screenshots, and exports.
5. Notify affected household members when their data or access was involved.
6. Clean source/history and document the incident only after credentials are invalidated.

## Security-sensitive review checklist

- [ ] No real secrets, tokens, attachments, dumps, or financial exports are committed.
- [ ] Parent/kid and account-member authorization is enforced server-side.
- [ ] Plaid tokens are absent from logs, responses, prompts, MCP, and notifications.
- [ ] Production URLs are HTTPS and cookies are secure.
- [ ] MCP is disabled or local/authenticated.
- [ ] Attachments are size/type checked and access controlled.
- [ ] AI context is minimized and passes the secrets guard.
- [ ] Backup and test-database safety controls still pass.

## Reporting a vulnerability

Do not open a public issue containing vulnerabilities, credentials, account details, transactions, or attachments. Report privately through a GitHub Security Advisory when available, or contact the repository owner privately. Include affected routes/files, reproduction steps, impact, and a redacted proof of concept.

There is no bug bounty program or guaranteed response SLA.
