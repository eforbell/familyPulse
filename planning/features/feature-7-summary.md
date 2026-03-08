# Feature 7: Magic Actions — Full LLM Layer

## Purpose

Turn raw financial data into household intelligence. Weekly digests, monthly close reports, on-demand analysis ("explain our dining spend"), and what-if forecasting ("can we afford the Pacific Rim trip?"). All powered by OpenAI gpt-5-nano, cached to minimize API cost.

## Why This Is Worth Shipping

This is Eric's differentiator vs. Monarch. No commercial budget app lets you ask plain-English questions against your own financial data and get contextual, personalized answers.

## Scope

1. Weekly household digest (scheduled Sunday evening)
2. Monthly close report (1st of month, covers prior month)
3. On-demand analysis (preset questions + free-form input)
4. What-if forecasting (scenario-based cash flow projections)

## Key Design Decisions

- **Server-side only** — no client-side LLM calls, all through Express API
- **Cache by prompt hash** — identical questions with same data don't re-call API
- **Graceful degradation** — app works without LLM, just missing narrative panels
- **Prompt security** — no access tokens, account numbers, or sensitive PII
- **Input sanitization** — free-form text sanitized before inclusion in prompts
- **Disclaimers** — AI-generated analysis clearly labeled as informational

## Definition of Done

- Weekly digest auto-generates Sunday evening and displays on dashboard
- Monthly close report generates on 1st and is browsable historically
- On-demand analysis answers preset and custom questions with relevant context
- What-if forecasting projects scenarios with appropriate uncertainty caveats
- All prompts verified free of sensitive data
- Cache prevents redundant API calls
- Rate limiting enforced on on-demand queries
- App functions normally when OpenAI API is unavailable
