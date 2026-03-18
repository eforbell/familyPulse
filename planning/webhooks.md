## Family Pulse Plaid Ingestion Spec

### Webhook-first architecture with cron safety net

1. Webhook Endpoint

Route

- POST /webhooks/plaid

Requirements

- Accept raw JSON body (preserve original bytes for verification)
- Capture headers exactly as received
- Verify authenticity before processing
- Enqueue work and return quickly (200 after enqueue, not after full sync)
- Log:
- request_id
- webhook_type
- webhook_code
- item_id
- internal job_id


2. Webhook Authenticity Verification (Required)

Treat all incoming webhook payloads as untrusted until verified.

Verification Flow

    1. Extract verification material from headers/body (per Plaid docs for your verification method)
    2. Verify signature/token against Plaid expectations (issuer/audience/key material)
    3. If invalid, reject with 401 or 403
    4. Only enqueue sync jobs after successful verification

Security Rules

- Use tight clock-skew tolerance (if token-based)
- Fail closed (if verification service fails, do not treat as valid)
- Never trust item_id blindly, resolve and validate internally


3. Webhook Handler Responsibility

Webhook handler should be lightweight.

Handler must only:

- verify
- normalize event
- enqueue sync job
- return response

Example queue payload
`
{
"source": "plaid_webhook",
"item_id": "xxx",
"webhook_type": "TRANSACTIONS",
"webhook_code": "SYNC_UPDATES_AVAILABLE",
"tenant_id": "resolved-internally",
"received_at": "2026-03-10T00:00:00.000Z",
"delivery_id": "provider-or-derived-id"
}
`


4. Sync Worker (Idempotent)

For TRANSACTIONS / SYNC_UPDATES_AVAILABLE:

    1. Load item access token securely
    2. Run Plaid transaction sync using cursor
    3. Loop until has_more = false
    4. Upsert added, patch modified, remove/tombstone removed
    5. Persist new cursor atomically with transaction commit
    6. Emit internal completion metric/event

Idempotency Requirements

- Dedupe job key (e.g. item_id + webhook_code + delivery window/hash)
- Upsert by stable Plaid transaction ID
- Cursor updates are monotonic and transactional

5. Multi-Tenant Safety

- Resolve item_id -> tenant_id in backend DB
- Enforce tenant boundaries in all queries and writes
- Redact access tokens and PII in logs
- Encrypt access tokens at rest (KMS/secret manager preferred)

6. Cron Reconciliation (Safety Net)

Run cron 2x/day with jitter.

Cron behavior

- Iterate active Plaid items
- Enqueue source=cron_reconcile sync jobs
- Skip recently synced items (e.g. last 2–4h), unless forced
- Alert on repeated failures or stale cursor age

Purpose

- Catch missed webhooks
- Recover from transient outages
- Heal queue/worker drift

7. Reliability and Observability

Metrics

- webhook verify pass/fail
- enqueue latency
- sync duration
- transaction counts (added/modified/removed)
- cursor staleness/lag
- per-item failure rate

Alerts

- spike in verification failures
- dead-letter queue non-empty
- no successful syncs for N hours
- stale items beyond threshold

Retry Policy

- exponential backoff with cap
- DLQ after max attempts
- replay tooling for DLQ events


8. Node/Express Pseudocode

```
app.post('/webhooks/plaid', rawBodyMiddleware, async (req, res) => {
try {
const verified = await verifyPlaidWebhook({
headers: req.headers,
rawBody: req.bodyRaw
});

if (!verified.ok) return res.status(401).end();

const event = parseWebhook(req.bodyJson);
const tenantId = await resolveTenantByItemId(event.item_id);

if (!tenantId) return res.status(202).end(); // safe ignore unknown item

await queue.enqueue('plaid-sync', {
source: 'plaid_webhook',
tenant_id: tenantId,
item_id: event.item_id,
webhook_type: event.webhook_type,
webhook_code: event.webhook_code,
received_at: new Date().toISOString()
});

return res.status(200).end();
} catch (err) {
log.error({ err }, 'plaid webhook handler failed');
return res.status(500).end(); // allow provider retry
}
});
```

9. Launch Gate (Recommended)

Before launch, confirm all are true:

- [ ] Redirect URI exact match in Plaid dashboard


- [ ] Webhook authenticity verification enabled and tested
- [ ] Queue + worker idempotency in place
- [ ] Cron reconcile job enabled (2x/day)
- [ ] Alerts wired for failures/staleness
- [ ] Access token encryption and log redaction validated

If you want, I can also format this as a ready-to-assign implementation ticket (Scope, Acceptance Criteria, and Test Plan).