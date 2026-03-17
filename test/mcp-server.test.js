'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { LATEST_PROTOCOL_VERSION } = require('@modelcontextprotocol/sdk/types.js');
const { app } = require('../mcp/server');

let server;
let baseUrl;

function initializeRequest(id) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'familypulse-test-client',
        version: '1.0.0'
      }
    }
  };
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream'
};

describe('MCP HTTP transport', () => {
  before(async () => {
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', (err) => {
        if (err) return reject(err);
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
  });

  it('allows separate clients to create independent sessions', async () => {
    const firstRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(initializeRequest(1))
    });
    assert.equal(firstRes.status, 200);
    await firstRes.text();
    const firstSessionId = firstRes.headers.get('mcp-session-id');
    assert.ok(firstSessionId, 'first session should return an MCP session id');

    const secondRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(initializeRequest(2))
    });
    assert.equal(secondRes.status, 200);
    await secondRes.text();
    const secondSessionId = secondRes.headers.get('mcp-session-id');
    assert.ok(secondSessionId, 'second session should return an MCP session id');
    assert.notEqual(secondSessionId, firstSessionId);

    await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': firstSessionId }
    });
    await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': secondSessionId }
    });
  });

  it('rejects non-initialize requests that do not provide a session id', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: {}
      })
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.message, 'Bad Request: No valid session ID provided');
  });
});
