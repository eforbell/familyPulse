'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { LATEST_PROTOCOL_VERSION } = require('@modelcontextprotocol/sdk/types.js');

const SERVER_MODULE = '../mcp/server';
const ORIGINAL_ENV = {
  MCP_HOST: process.env.MCP_HOST,
  MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN
};

let server;
let baseUrl;
let activeSessionId;

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream'
};

function initializeRequest(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'familypulse-security-test-client',
        version: '1.0.0'
      }
    }
  };
}

function loadServer({ host = '', token = '' } = {}) {
  process.env.MCP_HOST = host;
  process.env.MCP_AUTH_TOKEN = token;
  delete require.cache[require.resolve(SERVER_MODULE)];
  return require(SERVER_MODULE);
}

async function listen(app, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server = app.listen(0, host, (err) => {
      if (err) return reject(err);
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function closeServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
  baseUrl = undefined;
  activeSessionId = undefined;
}

async function postMcp(body, headers = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(body)
  });
}

async function readJsonRpc(res) {
  const text = await res.text();
  if (text.trimStart().startsWith('event:')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

afterEach(async () => {
  if (activeSessionId && baseUrl) {
    await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': activeSessionId, Authorization: 'Bearer correct-token' }
    }).catch(() => {});
  }
  await closeServer();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  delete require.cache[require.resolve(SERVER_MODULE)];
});

describe('MCP HTTP auth hardening', () => {
  it('defaults to loopback binding when MCP_HOST is unset', () => {
    const { isLoopbackHost } = loadServer({ host: '', token: '' });
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('0.0.0.0'), false);
  });

  it('fails closed without a token even behind a loopback reverse proxy', async () => {
    const { app } = loadServer({ host: '0.0.0.0', token: '' });
    await listen(app);
    const response = await postMcp(initializeRequest(1));
    assert.equal(response.status, 503);
  });

  it('requires and validates bearer tokens with shared-host MCP access', async () => {
    const { app, hasValidBearerToken } = loadServer({ host: '0.0.0.0', token: 'correct-token' });
    await listen(app);

    assert.equal(hasValidBearerToken('Bearer correct-token', 'correct-token'), true);
    assert.equal(hasValidBearerToken('Bearer wrong-token', 'correct-token'), false);
    assert.equal(hasValidBearerToken('Basic correct-token', 'correct-token'), false);

    const missing = await postMcp(initializeRequest(2));
    assert.equal(missing.status, 401);

    const bad = await postMcp(initializeRequest(3), { Authorization: 'Bearer wrong-token' });
    assert.equal(bad.status, 403);

    const good = await postMcp(initializeRequest(4), { Authorization: 'Bearer correct-token' });
    assert.equal(good.status, 200);
    await good.text();
    activeSessionId = good.headers.get('mcp-session-id');
    assert.ok(activeSessionId);
  });

  it('exposes all tools as read-only, non-destructive, and instructs clients on finance-scope hazards', async () => {
    const { app, MCP_SERVER_INSTRUCTIONS } = loadServer({ host: '', token: 'correct-token' });
    await listen(app);

    const initRes = await postMcp(initializeRequest(5), { Authorization: 'Bearer correct-token' });
    assert.equal(initRes.status, 200);
    const initData = await readJsonRpc(initRes);
    activeSessionId = initRes.headers.get('mcp-session-id');
    assert.ok(activeSessionId);
    assert.equal(initData.result.instructions, MCP_SERVER_INSTRUCTIONS);
    assert.match(initData.result.instructions, /stale/i);
    assert.match(initData.result.instructions, /double-counting/i);

    const listRes = await postMcp({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/list',
      params: {}
    }, { 'mcp-session-id': activeSessionId, Authorization: 'Bearer correct-token' });

    assert.equal(listRes.status, 200);
    const listData = await readJsonRpc(listRes);
    assert.equal(listData.result.tools.length, 7);
    for (const tool of listData.result.tools) {
      assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} should be read-only`);
      assert.equal(tool.annotations.destructiveHint, false, `${tool.name} should be non-destructive`);
    }
  });
});
