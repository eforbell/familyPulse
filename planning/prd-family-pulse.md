# PRD: Family Pulse — Household Cash Flow & Budget Intelligence App

**Version:** 0.1 MVP  
**Author:** Eric (with Claude)  
**Date:** March 8, 2026  
**Status:** Draft — Ready for Claude Code Iteration  
**Replaces:** Monarch Money subscription ($99/yr)

---

## Introduction

Family Pulse is a private, self-hosted household financial intelligence application built for one family's real needs. It replaces a commercial budgeting app (Monarch Money) with a purpose-built tool that does less but does it better — focused entirely on cash flow, spending awareness, and family financial health rather than investment portfolio management.

The app runs exclusively on `erebor`, a secured home server accessible only via Tailscale tailnet. Financial data is sourced via Plaid (already onboarded; Transactions + Liabilities products). An LLM layer provides Magic Actions — plain-English narratives, anomaly explanations, and what-if forecasting — turning raw data into actionable household intelligence.

Family Pulse serves two distinct audiences under one roof: adults managing household finances with full visibility, and teenagers learning to manage their own money with an age-appropriate view of their own accounts.

This PRD defines the MVP scope. It is intended to be consumed directly by Claude Code to begin building the application bones iteratively.

---

## The Problem with Monarch Money

Eric uses approximately 5% of Monarch's feature set. The app is investment-centric, cluttered, and does not provide the specific cash flow intelligence this household needs. Critical gaps:

- No family/parental sub-views for kids' financial education
- No way to connect an LLM for conversational analysis and forecasting
- Screen-scraping required for any AI-assisted analysis
- Investment tracking creates noise — Eric monitors Schwab/Fidelity directly; BTC is tracked via a dedicated MCP tool on `numenor`
- Cannot intelligently distinguish transfers (inter-account, 529, BTC savings) from expenses

---

## Goals

- Provide a real-time cash flow picture across all household checking, savings, and credit accounts
- Track budget vs. actual spending by category with clear hot-spot alerts for unexpected burns
- Intelligently neutralize transfers (inter-account, 529, BTC) so they don't inflate expense totals
- Enable parental oversight of kids' spending with an age-appropriate kids-facing view
- Migrate historical data and categories from Monarch Money CSV export
- Expose financial data via MCP server so Claude can reason against real numbers for forecasting and decisions
- Support planning for: medical expenses, college tuition horizon (Jordan '28, Casey '30), R&R readiness (Alex's Pacific Rim trip)
- Signal clearly when liquid savings are sufficient to authorize discretionary splurges
- Build iteratively, ship working software at every phase, never break what works

---

## Household Context

| Member | Role | Accounts |
|--------|------|----------|
| Eric | Head of household / App owner | 2 checking, ~3 credit cards |
| Alex | Co-head of household | 1 checking, ~2 credit cards |
| Jordan | 9th grade (HS Freshman, ~2028 tuition horizon) | Capital One Money account |
| Casey | 7th grade (~2030 tuition horizon) | Capital One Money account |

**Account inventory (Plaid Items):**
- 3 checking accounts (2 Eric, 1 Alex) — primary cash flow
- 2 liquid savings / rainy day accounts
- ~3 Eric credit cards
- ~2 Alex credit cards
- 2 Capital One Money accounts (Jordan, Casey) — kids

**Out of scope accounts (NOT connected to Family Pulse):**
- Schwab brokerage (monitored directly)
- Fidelity (monitored directly)
- 529 accounts (contribution tracking via transaction categorization only)
- Bitcoin (tracked via dedicated MCP tool on `numenor`)

---

## Tech Stack

### Backend
- **Runtime:** Node.js (LTS) — consistent with existing erebor apps (homePlan, familyHelp, familyDinner - ask about these to inspect)
- **Framework:** Express.js
- **Database:** PostgreSQL (erebor's existing instance, dedicated `familypulse` database)
- **Plaid Integration:** `plaid` Node.js SDK (Transactions + Liabilities products, already onboarded)
- **Scheduler:** `node-cron` for daily sync jobs and webhook fallback
- **ORM/Query:** `pg` (node-postgres) with raw SQL — keep it simple and auditable
- **DEVELOPMENT** Help establish a focused docker-compose postgres instance to ease development

### Frontend
- **Framework:** Simple server-rendered HTML + vanilla JS, or lightweight React — consistent with Family Dinner / HelpDesk pattern
- **Styling:** Tailwind CSS (CDN)
- **Charts:** Chart.js (CDN)
- **Auth:** Tailscale device auth (no app-level login required — tailnet = trusted network)

### AI / Magic Actions
- **Provider:** OpenAI API (gpt-5-nano)
- **Pattern:** Server-side API calls only; results cached to DB to minimize API spend
- **Triggers:** Scheduled weekly digest, on-demand analysis endpoints, anomaly events

### MCP Server
- **Protocol:** Model Context Protocol (MCP)
- **Exposure:** Local stdio or HTTP — tailnet only
- **Purpose:** Enable Claude Desktop / Claude CLI to query live financial data for conversational forecasting and decision support more interactively via chat

### Infrastructure
- **Host:** `erebor` (Ubuntu, home server) - exposed as tagged app 'home' host on the family's tailnet. Nginx with mountpoints for /plan/, /dinner/, /help/.  All Node apps ABSOLUTELY cannot rely on absolute paths as they will be mounted on a share apps nginx proxy.
- **Network:** Tailscale tailnet — zero public ports forwarded
- **Port:** Internal only (e.g., `localhost:3004`, served via tailnet over SSL 443 on home apps tailnet server)
- **Process management:** PM2 (consistent with other erebor apps)
- **Environment:** `.env` file for Plaid keys, Anthropic API key, DB credentials

---

## Data Model (Core Schema)

```sql
-- Financial institutions and linked Items
accounts            -- Plaid account metadata (id, name, type, subtype, institution, mask)
items               -- Plaid Items (access_token, item_id, institution_id, status)

-- Transaction data
transactions        -- All transactions (plaid_id, account_id, amount, date, merchant, 
                   --   category_id, transfer_type, is_transfer, pending, raw_json)
categories          -- User-defined categories (name, color, budget_amount, is_income,
                   --   is_transfer_class, icon)
category_rules      -- Auto-categorization rules (merchant pattern → category)

-- Budget framework
budgets             -- Monthly budget targets per category
budget_periods      -- Rolling monthly snapshots (actual vs budget)

-- Planning
planning_goals      -- Named goals: medical fund, R&R, tuition (target, current, deadline)
savings_signals     -- Computed liquidity snapshots (liquid_total, signal_status, computed_at)

-- Magic Actions
magic_actions_log   -- LLM-generated narratives (type, prompt_hash, result, generated_at)
anomalies           -- Detected spending anomalies (category, amount, delta_pct, period, acknowledged)

-- Monarch import
import_runs         -- CSV import history (filename, imported_at, record_count, status)
```

---

## Transfer Intelligence (Critical Design Decision)

Transfers must be detected and neutralized. They are **not expenses**. Miscategorizing them inflates spending figures and destroys budget accuracy.

**Transfer types to handle:**

| Transfer Type | Example | Treatment |
|---------------|---------|-----------|
| Inter-account | Checking → Savings | Detected by paired debit/credit within 3 days; both flagged `is_transfer=true`; excluded from budget |
| Credit card payment | Checking → Chase card | Detected by payee pattern + amount matching; `transfer_type='cc_payment'`; excluded |
| 529 contribution | Checking → 529 | Merchant/payee pattern match; `transfer_type='529_contribution'`; shown in Planning view only |
| Bitcoin savings | Checking → BTC exchange | Merchant pattern (Coinbase, Swan, etc.); `transfer_type='btc_savings'`; shown in Planning view only |
| Payroll direct deposit | Employer → Checking | Income category; not a transfer |

**Detection strategy:**
- FR-T1: On sync, run transfer detection pass before categorization
- FR-T2: Match paired transactions: same amount ± $1, opposite sign, same/linked accounts, within 3 days
- FR-T3: Apply payee pattern rules for 529 and BTC (configured in admin)
- FR-T4: All `is_transfer=true` transactions excluded from budget/spend calculations by default
- FR-T5: Transfers visible in dedicated Transfers view for audit purposes

---

## Monarch Money Migration

Eric has an active Monarch subscription with established categories and transaction history. Migration is a first-class feature.

**FR-M1:** Accept Monarch CSV export (transactions format) via admin upload  
**FR-M2:** Parse and map Monarch categories to Family Pulse categories (fuzzy match + manual review UI)  
**FR-M3:** Import historical transactions with original dates, amounts, and mapped categories  
**FR-M4:** Detect and skip transactions already present (dedup by date + amount + merchant)  
**FR-M5:** Seed `categories` table from Monarch category list before transaction import  
**FR-M6:** Import run summary: record count, category map, duplicates skipped, manual review queue  
**FR-M7:** Monarch-imported transactions flagged `source='monarch'` for audit trail  

---

## Build Phases (Iterative MVP)

### Phase 1 — Foundation (Start Here)
*Goal: Data flowing, stored, queryable. No UI yet.*

- [ ] Initialize Node/Express project on erebor (`/data/apps/familypulse`) with systemd service definition and a deploy/deploy.sh that does worktree checkout (e.g. git --work-tree="$APP_DIR" checkout "$REF" -- .) and restarts systemd
- [ ] Create PostgreSQL database `family-pulse`, run schema initialization
- [ ] Implement Plaid sync daemon: `/transactions/sync` webhook handler + polling fallback
- [ ] Implement Plaid Liabilities sync for credit accounts
- [ ] Store all accounts and transactions in DB
- [ ] Transfer detection pass runs post-sync
- [ ] Basic admin CLI to trigger sync, view account list, tail logs
- [ ] PM2 process config, env setup, Tailscale accessible

**Exit criteria:** `SELECT COUNT(*) FROM transactions` returns real family transaction data.

---

### Phase 2 — Transaction Browser
*Goal: See the data. Minimal but functional.*

- [ ] Simple web UI served by Express (accessible on tailnet)
- [ ] Account list view: balance, type, institution
- [ ] Top-level view of liquid net cash balance combinging cash accounts and revolving credit accounts
- [ ] Transaction list: date, merchant, amount, account, category badge
- [ ] Filter by: account, date range, category, transfer (toggle show/hide)
- [ ] Basic category assignment UI (click transaction → assign category)
- [ ] Category CRUD admin (name, color, budget amount, transfer class flag)
- [ ] Auto-categorization rule engine (merchant string → category)

**Exit criteria:** Eric can browse all transactions, assign categories, and hide transfers.

---

### Phase 3 — Monarch Import
*Goal: Seed history and categories from existing data.*

- [ ] CSV upload endpoint + parser
- [ ] Category mapping UI (Monarch name → Family Pulse category, with auto-suggest)
- [ ] Transaction import with dedup
- [ ] Import summary report
- [ ] Historical data visible in transaction browser

**Exit criteria:** 12+ months of Monarch history imported, categories seeded, no duplicate transactions.

---

### Phase 4 — Budget Framework
*Goal: Budget vs. actual. The core value prop.*

- [ ] Monthly budget targets per category (editable)
- [ ] Current month dashboard: category cards showing budget / spent / remaining
- [ ] Color coding: green (< 70% used), yellow (70–99%), red (over budget)
- [ ] Income tracking: total monthly income detected from direct deposits
- [ ] Net cash flow: income minus non-transfer spending
- [ ] Rolling 3-month average spend per category (baseline for anomaly detection)

**Exit criteria:** Dashboard shows current month budget vs. actual for all spending categories.

---

### Phase 5 — Hot Spots & Anomaly Detection
*Goal: Surface unexpected cash burns automatically.*

- [ ] Anomaly detection: flag categories where current month spend > 130% of 3-month rolling average
- [ ] Hot spots panel on dashboard (top 3–5 anomalies with delta amount and percentage)
- [ ] Anomaly detail: drill into transactions driving the spike
- [ ] Acknowledge/dismiss anomaly (with optional note)
- [ ] Weekly anomaly digest: background job generates summary, stores to `magic_actions_log`
- [ ] LLM narrative for weekly digest: "This week, dining spend was 60% above your 90-day average..."

**Exit criteria:** Dashboard surfaces spending anomalies without Eric having to hunt for them.

---

### Phase 6 — Kids View
*Goal: Age-appropriate financial visibility for Jordan and Casey.*

- [ ] Separate kids dashboard route (e.g., `/kids/jordan`, `/kids/casey`)
- [ ] Shows only their Capital One Money account data
- [ ] Balance, recent transactions, monthly spending total
- [ ] Simple category breakdown (food, entertainment, personal care, etc.)
- [ ] Running monthly budget vs. actual (budget set by parent admin)
- [ ] LLM Magic Action: "Money Report Card" — monthly plain-English spending summary
  - Example: "You spent $47 this month. $22 went to food and drinks, $18 to entertainment. Your biggest single purchase was..."
- [ ] Parental view: both kids' accounts visible in parent dashboard side-by-side

**Exit criteria:** Jordan and Casey each have a working dashboard they can access on their iPhones via tailnet.

---

### Phase 7 — Magic Actions (Full LLM Layer)
*Goal: Turn data into intelligence. Eric's differentiator vs. Monarch.*

All Magic Actions are server-side Claude API calls. Results cached to `magic_actions_log` by prompt hash.

- [ ] **Weekly Household Digest** (scheduled Sunday evening)
  - Cash flow summary for the week
  - Top spending categories vs. budget
  - Anomalies called out in plain English
  - One actionable recommendation

- [ ] **Monthly Close Report** (1st of month, covers prior month)
  - Budget vs. actual by category
  - Notable wins and overruns
  - Comparison to prior month and rolling average
  - Net cash flow vs. income

- [ ] **On-Demand Analysis** (UI button → instant)
  - "Explain this month's dining spend"
  - "What's our biggest discretionary category this quarter?"
  - "Are we on track for our savings goal?"

- [ ] **What-If Forecasting** (text input)
  - "If we take Alex's Pacific Rim trip for $6,000 in October, what does our cash flow look like?"
  - "If Jordan starts at [university] in fall 2028 at $X/semester, when do we need to start redirecting cash flow?"

**Exit criteria:** Weekly digest arrives in the family dashboard automatically; on-demand analysis answers real questions from real data.

---

### Phase 8 — MCP Server
*Goal: Give Claude Code / Claude CLI direct query access to Family Pulse data.*

- [ ] Implement MCP server (`/opt/apps/familypulse-mcp`) as stdio or local HTTP server
- [ ] Expose tools:
  - `get_account_balances` — current balances for all accounts
  - `get_transactions` — query transactions by date range, category, account
  - `get_budget_status` — current month budget vs. actual by category
  - `get_cash_flow_summary` — net cash flow for any period
  - `get_anomalies` — current unacknowledged anomalies
  - `get_savings_signal` — current liquid savings total and signal status
  - `get_planning_goals` — status of all planning goals
- [ ] Register MCP server in Claude Code config on ThinkPad T14s
- [ ] Validate: Claude Code can answer "what did we spend on dining last month?" from real data

**Exit criteria:** Claude has structured, queryable access to live Family Pulse data without screen scraping.

---

### Phase 9 — Planning & Goals
*Goal: Forward-looking financial intelligence.*

- [ ] **Liquid Savings Signal**
  - Compute: total across all savings accounts + checking buffer above rolling monthly spend
  - Status: 🔴 Tight / 🟡 Comfortable / 🟢 Ready to Splurge
  - Displayed prominently on dashboard
  - Threshold configuration (e.g., "Splurge ready when liquid savings > 3 months expenses")

- [ ] **R&R / Travel Goal**
  - Named goal: "Alex's Pacific Rim Trip" with configurable target ($X)
  - Links to a savings account or tracks dedicated cash allocation
  - Progress bar + projected achievement date based on current savings rate

- [ ] **Medical Expense Planning**
  - Annual medical budget category with quarterly tracking
  - Rolling 3-year average for medical spend (seeded from Monarch history)
  - Alert when YTD medical spend approaches annual average

- [ ] **College Tuition Horizon**
  - Jordan: flag September 2028 as planning milestone
  - Casey: flag September 2030 as planning milestone  
  - Planning view shows months remaining and current 529 contribution tracking
  - No actual investment tracking — contribution detection only (via transfer categorization)

**Exit criteria:** Dashboard has a Planning section that answers: "Can we afford a vacation?" and "Are we on track for the kids' tuition?"

---

## Non-Goals (Explicitly Out of Scope)

- **Investment portfolio tracking** — Schwab and Fidelity monitored directly; no holdings, positions, or performance tracking in Family Pulse
- **Bitcoin portfolio value** — tracked via dedicated MCP tool on `numenor`; Family Pulse only sees BTC purchase transactions (categorized as savings transfer)
- **Tax preparation features** — separate workflow
- **Bill pay or payment initiation** — read-only data aggregation only
- **Public access or multi-household** — single private household, Tailscale-gated
- **Mobile native app** — progressive web app via tailnet on iPhones is sufficient
- **Bank-level security theater** — compliant with Plaid requirements per generated documentation package; not over-engineered

---

## Security Model

Family Pulse inherits the household security posture documented in the Plaid compliance package (March 2026):

- All traffic via Tailscale WireGuard — no public ports
- Plaid access tokens: server-side only, stored in PostgreSQL, never transmitted to browser
- No application-level authentication required (Tailscale device enrollment = authentication)
- Admin functions (sync trigger, category management, Monarch import) accessible to any tailnet device — acceptable for single-household use
- Kids routes accessible to all tailnet devices (parental oversight model, not privacy model)

---

## Functional Requirements Index

| ID | Requirement |
|----|-------------|
| FR-T1–T5 | Transfer detection and neutralization |
| FR-M1–M7 | Monarch Money migration |
| FR-P1 | Plaid webhook handler for `SYNC_UPDATES_AVAILABLE` |
| FR-P2 | Plaid polling fallback (daily cron if webhook missed) |
| FR-P3 | Liabilities sync for credit accounts (balance, minimum payment) |
| FR-B1 | Monthly budget targets configurable per category |
| FR-B2 | Budget dashboard: spent / remaining / percentage per category |
| FR-B3 | Rolling 3-month average as budget baseline |
| FR-A1 | Anomaly flag: current month > 130% of 3-month rolling average |
| FR-A2 | Hot spots panel: top anomalies surfaced on dashboard |
| FR-A3 | Anomaly acknowledge/dismiss with note |
| FR-K1 | Kids dashboard: scoped to individual Capital One account |
| FR-K2 | Kids monthly spending breakdown by category |
| FR-K3 | LLM Money Report Card: monthly plain-English narrative per kid |
| FR-L1 | Liquid savings signal: 🔴/🟡/🟢 status with configurable threshold |
| FR-L2 | Planning goals: named goals with target, current, projected date |
| FR-L3 | Medical budget: annual target with quarterly tracking |
| FR-L4 | Tuition horizons: Jordan 2028, Casey 2030 countdown + 529 tracking |
| FR-MCP1–7 | MCP server tools (see Phase 8) |

---

## Success Criteria

The MVP is successful when:

1. Eric cancels Monarch Money subscription (no longer needed)
2. Alex can check her accounts and see household cash flow without asking Eric
3. Jordan and Casey each use their dashboard at least weekly without being prompted
4. Eric receives a weekly digest that catches one spending anomaly he would have otherwise missed
5. Claude (via MCP) can answer "can we afford Alex's Pacific Rim trip this fall?" using real data
6. The app requires < 30 minutes/month of Eric's maintenance time

---

## Open Questions

1. **Alex's account connection:** Alex will need to complete Plaid Link OAuth on her devices for her accounts. Confirm her Capital One and credit card institutions are supported and OAuth-ready (not credential-based).

2. **Kids account ownership:** Jordan and Casey's Capital One Money accounts — are these joint with Eric or solely in kids' names? Affects who completes the Plaid Link flow.

3. **Monarch export format:** Confirm available export fields (transaction date, merchant, amount, category, account name) before Phase 3 build. Download and inspect before writing parser.

4. **Category taxonomy:** Use Monarch's category list as seed, or start fresh with a simplified set? Recommend: import Monarch categories, then prune/merge during Phase 3 review.

5. **Magic Actions trigger:** Weekly digest on Sunday evening works for the household cadence, but should anomaly alerts be real-time push (requires notification infrastructure) or next-dashboard-visit? Recommend: next visit for MVP, real-time in a later phase.

6. **Kids budget amounts:** Who sets Jordan and Casey's monthly budgets — Eric alone, or should kids have visibility into the budget-setting process? Recommend: parent-set, kid-visible.

7. **Savings threshold for "splurge ready":** What liquid savings total makes Eric feel comfortable authorizing a vacation? Recommend: configure as multiple of rolling monthly non-discretionary spend (e.g., 4× = comfortable, 6× = splurge ready).

---

## Appendix: Environment Setup Checklist for Claude Code

```bash
# erebor: initialize project
mkdir -p /opt/apps/familypulse
cd /opt/apps/familypulse
npm init -y
npm install express plaid pg node-cron dotenv

# Environment variables needed (.env)
PLAID_CLIENT_ID=
PLAID_SECRET=          # Production secret from Plaid dashboard
PLAID_ENV=production
DATABASE_URL=postgresql://familypulse:password@localhost:5432/familypulse
ANTHROPIC_API_KEY=
PORT=3004

# PostgreSQL
createdb familypulse
createuser familypulse

# PM2
pm2 start src/index.js --name familypulse
pm2 save
```

**Plaid Items to connect (via Link flow):**
- Eric checking #1
- Eric checking #2
- Alex checking
- Savings account #1 (rainy day)
- Savings account #2 (liquid)
- Eric credit card #1
- Eric credit card #2
- Eric credit card #3
- Alex credit card #1
- Alex credit card #2
- Jordan Capital One Money
- Casey Capital One Money

**Monarch export:** Download from Monarch → Settings → Export Data before canceling subscription.

---

*Family Pulse is built for one household. It doesn't need to scale to a million users. It needs to tell Alex when she can book her Pacific Rim trip.*
