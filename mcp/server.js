'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const express = require('express');

const { getAccountBalances } = require('./tools/accounts');
const { getTransactions } = require('./tools/transactions');
const { getBudgetStatus, getCashFlowSummary } = require('./tools/budget');
const { getAnomalies } = require('./tools/anomalies');
const { getCoverageData } = require('./tools/coverage');
const { getFinancialSnapshot } = require('./tools/snapshot');

const PORT = parseInt(process.env.MCP_PORT || '3004', 10);
const HOST = process.env.MCP_HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

const MCP_SERVER_INSTRUCTIONS = [
  'FamilyPulse exposes read-only household finance planning context.',
  'Treat balances, transactions, budgets, coverage, and investment snapshots as sensitive operator data.',
  'Data can be stale relative to bank, brokerage, Plaid, or pending-card reality; state date ranges and freshness assumptions.',
  'Avoid double-counting transfers, credit-card payments, and balance snapshots as cash flow or investable assets.',
  'Do not present output as financial, tax, legal, or investment advice; use it as planning context for the operator.'
].join(' ');

const READ_ONLY_TOOL_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false
});

// ── MCP Server ────────────────────────────────────────────────

function createMcpServer() {
  const mcp = new McpServer({
    name: 'familypulse',
    version: '1.0.0'
  }, {
    capabilities: { tools: {} },
    instructions: MCP_SERVER_INSTRUCTIONS
  });

  // ── Tool Registration ─────────────────────────────────────────

  mcp.tool(
    'get_account_balances',
    'Get all household accounts with current balances, grouped by family member. Returns depository, credit, and investment accounts with balance policy applied.',
    { member_name: z.string().optional().describe('Filter to a specific family member name (e.g. "Eric", "Alex", "Jordan", "Casey")') },
    READ_ONLY_TOOL_ANNOTATIONS,
    async (args) => {
      const result = await getAccountBalances(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_transactions',
    'Query household transactions with filters. Returns individual transactions or aggregated category summary. Transfers excluded by default.',
    {
      date_from: z.string().optional().describe('Start date (YYYY-MM-DD)'),
      date_to: z.string().optional().describe('End date (YYYY-MM-DD)'),
      category: z.string().optional().describe('Category name filter (case-insensitive)'),
      account_name: z.string().optional().describe('Account name filter (case-insensitive)'),
      search: z.string().optional().describe('Search merchant/transaction name'),
      include_transfers: z.boolean().optional().default(false).describe('Include inter-account transfers'),
      limit: z.number().optional().default(50).describe('Max results (1-200)'),
      offset: z.number().optional().default(0).describe('Pagination offset'),
      summary_mode: z.boolean().optional().default(false).describe('Return aggregated totals by category instead of individual transactions')
    },
    READ_ONLY_TOOL_ANNOTATIONS,
    async (args) => {
      const result = await getTransactions(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_budget_status',
    'Get monthly budget vs. actual spending by category. Shows income, spending, net cash flow, and per-category status (green/yellow/red).',
    { period: z.string().optional().describe('Month in YYYY-MM format (defaults to current month)') },
    READ_ONLY_TOOL_ANNOTATIONS,
    async (args) => {
      const result = await getBudgetStatus(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_cash_flow_summary',
    'Get net cash flow across a range of months. Shows per-month income, spending, net cash flow plus period totals and averages.',
    {
      start_period: z.string().optional().describe('Start month (YYYY-MM, defaults to 3 months ago)'),
      end_period: z.string().optional().describe('End month (YYYY-MM, defaults to current month)')
    },
    READ_ONLY_TOOL_ANNOTATIONS,
    async (args) => {
      const result = await getCashFlowSummary(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_anomalies',
    'Get detected spending anomalies (spikes above 130% of rolling average). Shows category, current vs. average amounts, and severity.',
    {
      period: z.string().optional().describe('Month in YYYY-MM format (defaults to current month)'),
      include_acknowledged: z.boolean().optional().default(false).describe('Include previously acknowledged anomalies')
    },
    READ_ONLY_TOOL_ANNOTATIONS,
    async (args) => {
      const result = await getAnomalies(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_coverage',
    'Get liability coverage ratio — how well depository balances cover upcoming credit card and loan obligations. Includes per-card details with due dates.',
    {},
    READ_ONLY_TOOL_ANNOTATIONS,
    async () => {
      const result = await getCoverageData();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_financial_snapshot',
    'Get comprehensive household financial position: liquid balance, credit balance, investments, net position, 3-month average income/spending, savings rate, and coverage ratio.',
    {},
    READ_ONLY_TOOL_ANNOTATIONS,
    async () => {
      const result = await getFinancialSnapshot();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  return mcp;
}

// ── HTTP Transport ────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── Bearer Token Auth ─────────────────────────────────────────
// All HTTP /mcp requests require a configured matching token, even on loopback.
// A local reverse proxy is not proof that the original caller is local. A matching
// Authorization: Bearer header. Prevents kids and rogue processes
// on the Tailscale LAN from accessing parent financial data.

function normalizeAddress(value) {
  if (!value) return '';
  return String(value).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
}

function isLoopbackHost(value) {
  const host = normalizeAddress(value).toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function hasValidBearerToken(authHeader, expectedToken = AUTH_TOKEN) {
  if (!expectedToken) return false;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  const token = authHeader.slice(7);
  const tokenDigest = crypto.createHash('sha256').update(token).digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedToken).digest();
  return crypto.timingSafeEqual(tokenDigest, expectedDigest);
}

app.use('/mcp', (req, res, next) => {
  if (!AUTH_TOKEN) {
    return res.status(503).json({
      error: 'MCP_AUTH_TOKEN required for HTTP MCP access'
    });
  }

  if (!req.headers.authorization || !req.headers.authorization.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  if (!hasValidBearerToken(req.headers.authorization)) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
});

// Per-session transport map for stateful mode
const transports = new Map();

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && transports.has(sessionId)) {
    // Existing session
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId || !isInitializeRequest(req.body)) {
    return res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided'
      },
      id: null
    });
  }

  // New session — create transport and connect
  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (newSessionId) => {
      transports.set(newSessionId, transport);
    }
  });

  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };

  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: 'Missing or invalid session ID' });
  }
  const transport = transports.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !transports.has(sessionId)) {
    return res.status(400).json({ error: 'Missing or invalid session ID' });
  }
  const transport = transports.get(sessionId);
  await transport.close();
  transports.delete(sessionId);
  res.status(200).end();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'familypulse-mcp', tools: 7 });
});

// ── Start ─────────────────────────────────────────────────────

if (require.main === module) {
  if (!AUTH_TOKEN) {
    console.warn('WARNING: MCP_AUTH_TOKEN not set — HTTP MCP requests are denied until a token is configured');
  }
  app.listen(PORT, HOST, () => {
    console.log(`Family Pulse MCP server listening on http://${HOST}:${PORT}/mcp`);
    console.log(`Health check: http://${HOST}:${PORT}/health`);
  });
}

module.exports = {
  app,
  createMcpServer,
  hasValidBearerToken,
  isLoopbackHost,
  MCP_SERVER_INSTRUCTIONS,
  READ_ONLY_TOOL_ANNOTATIONS
};
