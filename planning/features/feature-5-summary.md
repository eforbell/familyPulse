# Feature 5: Hot Spots & Anomaly Detection

## Purpose

Automatically catch unexpected spending spikes so Eric doesn't have to hunt for them. If dining is 60% above the 90-day average, the dashboard says so — with a plain-English narrative explaining what's happening.

## Why This Is Worth Shipping

This is the "intelligence" in "financial intelligence." Budget tracking tells you where you stand; anomaly detection tells you what changed and why you should care. This is the feature Monarch doesn't have.

## Scope

1. Anomaly detection engine: current month vs. 3-month rolling average, 130% threshold
2. Hot spots panel on dashboard (top 3-5 anomalies)
3. Drill-down into transactions driving each spike
4. Acknowledge/dismiss workflow with notes
5. Weekly LLM-generated narrative digest (Sunday evening, OpenAI gpt-5-nano)

## Key Design Decisions

- **130% threshold** — flags categories spending 30%+ above their rolling average
- **Small-dollar exclusion** — categories averaging <$25/mo are noise, not signal
- **LLM narratives cached** in magic_actions_log — no redundant API calls
- **Prompt security** — LLM prompts never include account numbers, tokens, or PII

## Definition of Done

- Anomaly detection runs daily post-sync, correctly flags 130%+ spikes
- Hot spots panel visible on dashboard when anomalies exist, hidden when clean
- Drill-down shows driving transactions, acknowledge dismisses from panel
- Weekly digest generates plain-English narrative via OpenAI, cached in DB
- No sensitive data in LLM prompts (verified by test)
- Detection logic has comprehensive unit tests with fixture data
