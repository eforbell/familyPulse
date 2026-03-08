# Feature 8: MCP Server

## Purpose

Give Claude Desktop and Claude CLI direct, structured access to Family Pulse financial data. No more screen scraping — Claude can query account balances, transactions, budget status, and anomalies through typed MCP tools and compose answers to complex financial questions.

## Why This Is Worth Shipping

The MCP server is what makes Family Pulse a platform, not just an app. Claude answering "can we afford Alex's Pacific Rim trip this fall?" using real data — that's the end state.

## Scope

1. MCP server scaffold with stdio transport
2. `get_account_balances` — all accounts with balances by member
3. `get_savings_signal` — liquid position and readiness status
4. `get_transactions` — filtered query with pagination and summary mode
5. `get_budget_status` — current month budget vs. actual
6. `get_cash_flow_summary` — net cash flow for any period
7. `get_anomalies` — unacknowledged spending spikes
8. `get_planning_goals` — goal status with projections

## Key Design Decisions

- **Read-only** — MCP tools query data, never write
- **Separate DB user** — SELECT-only grants for defense in depth
- **No sensitive data in responses** — account names yes, access tokens/raw IDs never
- **Composable tools** — simple, focused tools that Claude combines for complex queries

## Definition of Done

- MCP server starts and connects to PostgreSQL
- All 7 tools return correctly typed responses
- Claude Code on ThinkPad T14s can answer "what did we spend on dining last month?" from real data
- No Plaid tokens or sensitive identifiers in any tool response
- Unit tests for all tool handlers pass
