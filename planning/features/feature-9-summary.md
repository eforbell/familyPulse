# Feature 9: Planning & Goals

## Purpose

Forward-looking financial intelligence. The savings signal tells Eric at a glance whether the household can afford a vacation. Named goals track progress toward specific targets. Medical and tuition horizons provide long-range awareness without the noise of investment tracking.

## Why This Is Worth Shipping

Budget tracking (Feature 4) looks at the present. Planning looks ahead. The savings signal answering "can we splurge?" and goal tracking answering "are we on track?" complete the financial intelligence picture.

## Scope

1. Liquid savings signal: Tight / Comfortable / Splurge Ready (configurable thresholds)
2. Named planning goals with progress bars and projected achievement dates
3. Medical expense planning: annual target with quarterly tracking and 3-year average
4. College tuition horizon: Jordan 2028, Casey 2030 countdown with 529 contribution tracking

## Key Design Decisions

- **Savings signal** is a simple multiple of monthly expenses — not a complex model
- **Goal projections** are linear extrapolations with clear caveats — not financial planning
- **529 tracking** is contribution detection only — no investment performance
- **Thresholds are configurable** — Eric's comfort level drives the system

## What This Does NOT Include

- Investment portfolio tracking (Schwab, Fidelity, BTC — monitored elsewhere)
- Financial advisory recommendations
- Tax planning or optimization
- 529 account balance or performance tracking

## Definition of Done

- Savings signal computes correctly and displays on dashboard with emoji status
- At least one planning goal (Alex's trip) created with progress bar and projected date
- Medical expense card shows YTD spend, annual target, and pace indicator
- Tuition horizons display countdown and 529 contribution tracking for both kids
- All signal/projection calculations have unit tests with known data
- Thresholds configurable via admin settings
