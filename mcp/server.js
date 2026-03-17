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
const HOST = process.env.MCP_HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

// ── MCP Server ────────────────────────────────────────────────

function createMcpServer() {
  const mcp = new McpServer({
    name: 'familypulse',
    version: '1.0.0'
  }, {
    capabilities: { tools: {} }
  });

  // ── Tool Registration ─────────────────────────────────────────

  mcp.tool(
    'get_account_balances',
    'Get all household accounts with current balances, grouped by family member. Returns depository, credit, and investment accounts with balance policy applied.',
    { member_name: z.string().optional().describe('Filter to a specific family member name (e.g. "Eric", "Alex", "Jordan", "Casey")') },
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
    async (args) => {
      const result = await getTransactions(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_budget_status',
    'Get monthly budget vs. actual spending by category. Shows income, spending, net cash flow, and per-category status (green/yellow/red).',
    { period: z.string().optional().describe('Month in YYYY-MM format (defaults to current month)') },
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
    async (args) => {
      const result = await getAnomalies(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_coverage',
    'Get liability coverage ratio — how well depository balances cover upcoming credit card and loan obligations. Includes per-card details with due dates.',
    {},
    async () => {
      const result = await getCoverageData();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  mcp.tool(
    'get_financial_snapshot',
    'Get comprehensive household financial position: liquid balance, credit balance, investments, net position, 3-month average income/spending, savings rate, and coverage ratio.',
    {},
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
// When MCP_AUTH_TOKEN is set, all /mcp requests require a matching
// Authorization: Bearer header. Prevents kids and rogue processes
// on the Tailscale LAN from accessing parent financial data.

app.use('/mcp', (req, res, next) => {
  if (!AUTH_TOKEN) return next(); // no token configured = open access

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = authHeader.slice(7);
  if (token !== AUTH_TOKEN) {
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
    console.warn('WARNING: MCP_AUTH_TOKEN not set — MCP server is unauthenticated');
  }
  app.listen(PORT, HOST, () => {
    console.log(`Family Pulse MCP server listening on http://${HOST}:${PORT}/mcp`);
    console.log(`Health check: http://${HOST}:${PORT}/health`);
  });
}

module.exports = { app, createMcpServer };
