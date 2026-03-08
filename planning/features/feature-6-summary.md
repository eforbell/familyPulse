# Feature 6: Kids View

## Purpose

Give Jordan (9th grade) and Casey (7th grade) their own financial dashboards showing only their Capital One Money account data. Balance, spending breakdown, monthly budget, and a friendly LLM-generated "Money Report Card." Parental side-by-side overview on the household dashboard.

## Why This Is Worth Shipping

Financial literacy starts with visibility. The kids already use the family's other apps — giving them age-appropriate financial awareness builds good habits. This is also a feature Monarch doesn't offer.

## Scope

1. Dedicated routes: `/pulse/kids/jordan` and `/pulse/kids/casey`
2. Data scoping: each kid sees ONLY their own account (critical security requirement)
3. Balance, recent transactions, monthly spending total
4. Simple category breakdown (Food, Entertainment, Shopping, Personal Care, Other)
5. Parent-set monthly budget with progress bar
6. Monthly LLM "Money Report Card" — encouraging, educational narrative
7. Parental overview: both kids' accounts side-by-side on household dashboard

## Key Design Decisions

- **Hard data scoping** — API queries enforce account filtering, not just UI hiding
- **Simplified categories** — kids get 5 intuitive buckets, not the full household taxonomy
- **Encouraging tone** — LLM prompts tuned for teenagers, not financial advisors
- **No access control beyond Tailscale** — household trust model, not privacy model

## Definition of Done

- Jordan's dashboard shows only Jordan's account data; Casey's shows only hers
- Data scoping verified by tests: no cross-account data leakage
- Balance, transactions, category chart, and budget progress all render correctly
- Money Report Card generates monthly via LLM with appropriate tone
- Parental overview shows both kids' accounts on household dashboard
- Kids can access their dashboards on iPhones via Tailscale
