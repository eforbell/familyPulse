# Feature 6: Kids View

## Purpose

Give Jordan (9th grade) and Casey (7th grade) their own financial dashboards showing only their Capital One Money account data. Balance, spending breakdown, monthly budget, and a friendly LLM-generated "Money Report Card." Parents see kids' accounts on the normal accounts screen alongside their own.

## Why This Is Worth Shipping

Financial literacy starts with visibility. The kids already use the family's other apps — giving them age-appropriate financial awareness builds good habits. This is also a feature Monarch doesn't offer.

## Scope

1. Dedicated routes: `/kids/jordan` and `/kids/casey` (Express-side; nginx maps `/pulse/` prefix)
2. **Hard data isolation**: kid sessions are denied at the API layer from accessing anything outside their `account_members`-linked accounts. Enforced server-side via `requireParent` on all parent routes.
3. Balance, recent transactions, monthly spending total
4. Category breakdown using existing household categories (no kid-specific taxonomy)
5. Parent-set monthly budget with progress bar
6. Monthly LLM "Money Report Card" — encouraging, educational narrative (gpt-5-nano)
7. Kids' accounts visible on parent accounts screen (broken out like Eric/Alex, not a separate widget)
8. Kids' balances excluded from household coverage/liquidity calculations

## Key Design Decisions

- **API-enforced data isolation** — kid login cannot access parent accounts, household finances, settings, Plaid Link, magic actions, or coverage. This is a hard security boundary, not UI hiding.
- **Existing RBAC leveraged** — `family_members.role`, `requireParent` middleware, `account_members` table, and session roles were all built during auth feature work. No new auth infrastructure needed.
- **Household categories** — kids use the same category system as parents. No parallel taxonomy. Parents manage categories and rules; kids' transactions categorize through the same pipeline.
- **Coverage exclusion** — kids' depository balances do not factor into parent liability coverage checks. Their money is theirs.
- **Encouraging tone** — LLM prompts tuned for teenagers, not financial advisors
- **No special onboarding** — Eric onboards kids' accounts through normal Plaid Link flow, then assigns via account_members

## Definition of Done

- Kid login shows ONLY that kid's account data; cannot access any parent route (403)
- Sibling isolation: Jordan cannot see Casey's data and vice versa
- Data scoping verified by tests at API level
- Balance, transactions, category chart, and budget progress all render correctly
- Money Report Card generates monthly via LLM with appropriate tone
- Parents see kids' accounts on the accounts screen alongside their own
- Coverage calculator excludes kid-owned accounts
- Kids can access their dashboards on iPhones via Tailscale
