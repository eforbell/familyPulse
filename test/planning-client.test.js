'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createPlanningClient, validateConfig, readToken, buildServer } = require('../mcp/planning-client');
const source = { environment: 'production', url: 'https://example.invalid/mcp', token_env: 'TEST_PLANNING_TOKEN' };
const schema = { type: 'object', properties: {} };

test('configuration requires explicit production source and protected transport', () => {
  for (const value of [{}, { pulse: { ...source, environment: 'development' } },
    { pulse: { ...source, url: 'http://remote.invalid/mcp' } },
    { pulse: { ...source, url: 'https://user:password@example.invalid/mcp' } },
    { pulse: { ...source, url: 'https://example.invalid/mcp?token=secret' } },
    { pulse: { environment: 'production', url: source.url } },
    { rogue: source }, { helm: { environment: 'production', command: 'sh', args: [] } }]) {
    assert.throws(() => validateConfig(value));
  }
  assert.ok(validateConfig({ pulse: source }));
});

test('missing credentials fail closed; token files must be private', () => {
  assert.throws(() => readToken({ token_env: 'DOES_NOT_EXIST_PLANNING_TEST' }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-token-'));
  const file = path.join(dir, 'token');
  try {
    fs.writeFileSync(file, 'fixture-token\n', { mode: 0o600 });
    assert.equal(readToken({ token_file: file }), 'fixture-token');
    fs.chmodSync(file, 0o644);
    if (process.platform !== 'win32') assert.throws(() => readToken({ token_file: file }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('new upstream write tools are not listed or callable', async () => {
  let calls = 0;
  const planning = createPlanningClient({ pulse: source }, async (_source, fn) => fn({
    listTools: async () => ({ tools: ['get_financial_snapshot', 'place_order', 'sync'].map(name => ({ name, inputSchema: schema })) }),
    callTool: async () => { calls++; return { content: [] }; },
  }));
  assert.deepEqual((await planning.list()).tools.map(t => t.name), ['get_family_planning_context', 'pulse__get_financial_snapshot']);
  for (const name of ['pulse__sync', 'pulse__place_order', 'helm__portfolio', 'pulse__get_financial_snapshot__extra']) {
    assert.equal((await planning.call(name)).isError, true);
  }
  assert.equal(calls, 0);
});

test('upstream failures are partial, not zero balances, and do not leak error details', async () => {
  const planning = createPlanningClient({ pulse: source }, async () => { throw new Error('secret-password'); });
  const context = await planning.context();
  assert.equal(context.retrieval_complete, false);
  assert.equal(context.sources.pulse.status, 'unavailable');
  assert.equal(context.sources.helm.status, 'not_configured');
  assert.ok(!JSON.stringify(context).includes('secret-password'));
});

test('tool data retains provenance, sanitizes secrets, and suppresses upstream errors', async () => {
  let fail = false;
  const planning = createPlanningClient({ pulse: source }, async (_source, fn) => fn({
    callTool: async () => ({ isError: fail, content: [{ type: 'text', text: JSON.stringify({ balance: 42, access_token: 'fixture-secret', refresh_token: 'fixture-refresh', note: 'Bearer fixture-bearer' }) }] }),
  }));
  const first = await planning.call('pulse__get_financial_snapshot');
  const payload = JSON.parse(first.content[0].text);
  assert.equal(payload.source, 'pulse');
  assert.equal(payload.environment, 'production');
  assert.equal(payload.data[0].balance, 42);
  assert.equal(payload.data[0].access_token, '[REDACTED]');
  assert.equal(payload.data[0].refresh_token, '[REDACTED]');
  assert.equal(payload.data[0].note, 'Bearer [REDACTED]');
  fail = true;
  const second = await planning.call('pulse__get_financial_snapshot');
  assert.equal(second.isError, true);
  assert.ok(!JSON.stringify(second).includes('fixture-secret'));
});

test('real MCP handshake/list/call advertise read-only tools and useful instructions', async () => {
  const planning = createPlanningClient({ pulse: source }, async (_source, fn) => fn({
    listTools: async () => ({ tools: [{ name: 'get_financial_snapshot', inputSchema: schema }] }),
    callTool: async () => ({ content: [{ type: 'text', text: '{"balance":42}' }] }),
  }));
  const server = buildServer(planning);
  const client = new Client({ name: 'fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    assert.match(client.getInstructions(), /Never add FamilyPulse/);
    const listed = await client.listTools();
    assert.ok(listed.tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
    const result = await client.callTool({ name: 'pulse__get_financial_snapshot', arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0].text).data[0].balance, 42);
  } finally { await client.close(); await server.close(); }
});

test('SSH runner is noninteractive, verifies host keys, and defaults DB sessions read-only', () => {
  const { remoteCommand, sshArgs } = require('../mcp/remote-stdio');
  const config = { source: 'pulse', host: 'operator@host.example', repo: '/opt/apps/familyPulse', serviceUser: 'service' };
  const args = sshArgs(config);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.match(remoteCommand(config), /default_transaction_read_only=on/);
  assert.match(remoteCommand(config), /statement_timeout=20000/);
  assert.throws(() => sshArgs({ ...config, host: '-oProxyCommand=evil' }));
  assert.throws(() => sshArgs({ ...config, serviceUser: 'root; whoami' }));
  assert.throws(() => remoteCommand({ ...config, source: 'arbitrary' }));
});

test('HTTP bridge negotiates real MCP bearer auth and terminates its session', async () => {
  const express = require('express');
  const crypto = require('node:crypto');
  const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const app = express(); app.use(express.json());
  let transport, upstream, deleted = false;
  app.use('/mcp', (req, res, next) => req.headers.authorization === 'Bearer fixture-token' ? next() : res.sendStatus(401));
  app.post('/mcp', async (req, res) => {
    if (!transport) {
      upstream = new McpServer({ name: 'fixture', version: '1' });
      upstream.tool('get_financial_snapshot', {}, async () => ({ content: [{ type: 'text', text: '{"balance":42}' }] }));
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      await upstream.connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/mcp', (req, res) => transport.handleRequest(req, res));
  app.delete('/mcp', async (req, res) => { deleted = true; await transport.handleRequest(req, res); });
  const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  process.env.TEST_PLANNING_TOKEN = 'fixture-token';
  try {
    const planning = createPlanningClient({ pulse: { ...source, url: `http://127.0.0.1:${listener.address().port}/mcp` } });
    const result = await planning.call('pulse__get_financial_snapshot');
    assert.equal(result.isError, false);
    assert.equal(JSON.parse(result.content[0].text).data[0].balance, 42);
    assert.equal(deleted, true);
  } finally {
    delete process.env.TEST_PLANNING_TOKEN;
    if (upstream) await upstream.close();
    await new Promise(resolve => listener.close(resolve));
  }
});

test('Helm SSH runner only executes the expected module with an explicit matching SHA256', () => {
  const crypto = require('node:crypto');
  const { remoteCommand } = require('../mcp/remote-stdio');
  const file = path.resolve(__dirname, '../../helm/src/python/schwab_helm/mcp_server.py');
  const config = { source: 'helm', repo: '/opt/apps/helm', moduleFile: file };
  assert.throws(() => remoteCommand(config));
  assert.throws(() => remoteCommand({ ...config, moduleSha256: '0'.repeat(64) }));
  assert.throws(() => remoteCommand({ ...config, moduleFile: __filename, moduleSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }));
  const moduleSha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.match(remoteCommand({ ...config, moduleSha256 }), /default_transaction_read_only=on/);
});

test('operator scope prevents interpreting cash and investments as full household net worth', async () => {
  const planning = createPlanningClient({ pulse: source }, async (_source, fn) => fn({
    listTools: async () => ({ tools: [{ name: 'get_financial_snapshot', inputSchema: schema }] }),
    callTool: async () => ({ content: [{ type: 'text', text: '{"liquid_balance":42}' }] }),
  }));
  const context = await planning.context();
  assert.equal(context.operator_scope.household_net_worth_available, false);
  assert.equal(context.operator_scope.property_values_present, false);
  assert.deepEqual(context.operator_scope.excluded_assets, ['houses', 'cars', 'other property assets']);
  assert.match(context.operator_scope.family_pulse, /mortgage liabilities/);
  assert.match(context.operator_scope.guidance, /Do not propose adding property valuations to FamilyPulse/);
  const result = JSON.parse((await planning.call('pulse__get_financial_snapshot')).content[0].text);
  assert.deepEqual(result.operator_scope, context.operator_scope);
  assert.match(context.guidance.slice(0, 512), /Household net worth is unavailable/);
});
