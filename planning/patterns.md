# Family Pulse — Reusable Patterns Reference

Survives context resets. Captures conventions and patterns established during development.

## Sibling App Conventions (familyDinner, familyHelp, familyPlan)

### Server Architecture
- **Single `server.js`** — all routes inline, no separate route files
- **lib/ modules** for business logic (sync, transfer detection, etc.)
- **Relative fetch paths** everywhere: `fetch('api/health')` NOT `fetch('/api/health')` — required for nginx subpath `/pulse/` compatibility
- Export `{ app, pool }` from server.js for test access
- `if (require.main === module)` guard for startup
- Bind `0.0.0.0` for Tailscale accessibility

### Database
- `pg` (node-postgres) with raw SQL — no ORM
- `family_members` + `app_config` tables in every app
- Snake_case table/column names
- `SERIAL PRIMARY KEY`, `TIMESTAMPTZ DEFAULT now()` for timestamps
- `ON CONFLICT` for upserts
- Index naming: `idx_[table]_[column]`
- Seed data uses `ON CONFLICT DO NOTHING` for idempotency

### Frontend (established in Feature 2)
- Vanilla HTML/CSS/JS — no build step, no framework
- Hand-written CSS with custom properties (matching sibling apps, NO Tailwind)
- CSS tokens: --bg, --surface, --surface2, --border, --accent (#10b981), --text, --muted, --dim, --radius: 14px
- Chart.js via CDN (for future features)
- Dark theme always-on, emerald accent (#10b981)
- System font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif
- Mobile-first: 100dvh, env(safe-area-inset-bottom)
- `.hidden { display: none !important }` for show/hide
- `esc()` XSS helper for any innerHTML
- `api()` fetch wrapper with error handling
- Member picker overlay, identity in localStorage (`fp_member`)
- `public/` directory served statically
- All asset refs relative (no leading `/`)
- Separate route files in `lib/routes/` (departure from sibling inline pattern)

### Testing
- `node:test` + `node:assert/strict` — zero test dependencies
- Run with `npm test` → `node --test`
- Test files in `test/` directory, named `*.test.js`
- Export functions from lib/ modules for unit testing

### Deploy
- systemd service: `deploy/family-pulse.service`
- Deploy script: `deploy/deploy.sh` — git worktree checkout pattern
- Production path: `/data/apps/familyPulse`
- PM2 available but systemd is primary

### Environment
- `.env` for secrets (git-ignored)
- `.env.example` committed as template
- `DATABASE_URL` format: `postgresql://user:pass@localhost:port/dbname`
- `HOUSEHOLD_TIMEZONE=America/New_York` for cron and date display

## Family Pulse Specific Decisions

### Resolved Pre-Flight Items
- **Port:** 3003 (nginx proxies `/pulse/` → `localhost:3003`)
- **Token encryption:** None at app level — erebor has full-disk encryption, manual unlock on reboot
- **Plaid tokens:** Permanent (no TTL, no refresh). `token_last_used_at` for audit.
- **Sync strategy:** Cron-based (6 AM + 8 PM Eastern via node-cron). No webhooks. Manual trigger via CLI and API.
- **Webhook:** Not needed — removed from scope entirely. Tailscale stays closed.

### Secrets Invariant (Hardcoded, Non-Negotiable)
- Access tokens, API keys, .env values NEVER appear in:
  - Log output
  - API responses
  - LLM prompts (OpenAI)
  - MCP tool responses
  - Browser/client-side code
- Enforced by `lib/secrets-guard.js` + `test/secrets-guard.test.js`
- `items.access_token` column excluded from all SELECT queries except internal Plaid sync calls

### Transfer Detection Rules
- Inter-account: same |amount| ±$1, opposite signs, within 3 days, different accounts
- CC payments: payee pattern match + amount match
- 529 contributions: merchant pattern match (configurable)
- BTC savings: merchant pattern match (Coinbase, Swan, Strike, etc.)
- All flagged `is_transfer=true`, excluded from budget/spend by default

### Docker Dev Environment
- `docker-compose.yml` — postgres:16-alpine, port 5434:5432
- User/pass/db: `familypulse`
- Dev DATABASE_URL: `postgresql://familypulse:familypulse@localhost:5434/familypulse`

### Accent Color
- Emerald: `#10b981` (Tailwind emerald-500)
