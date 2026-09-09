#!/usr/bin/env node
'use strict';
// SSH is the local MCP process; no TCP listener, database password, or bearer token
// crosses the SSH boundary. The service user reads its existing remote configuration.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function remoteCommand({ source, repo, moduleFile, moduleSha256 }) {
  if (!['pulse', 'helm'].includes(source) || !path.posix.isAbsolute(repo)) throw new Error('Invalid source/repository');
  let command;
  if (source === 'pulse') {
    const code = 'console.log=console.error;const {createMcpServer}=require("./mcp/server");'
      + 'const {StdioServerTransport}=require("@modelcontextprotocol/sdk/server/stdio.js");'
      + 'createMcpServer().connect(new StdioServerTransport()).catch(()=>process.exit(1));';
    command = `/usr/bin/node -e ${quote(code)}`;
  } else {
    const approvedPath = path.resolve(__dirname, '../../helm/src/python/schwab_helm/mcp_server.py');
    if (!moduleFile || fs.realpathSync(moduleFile) !== approvedPath
        || !/^[a-f0-9]{64}$/.test(moduleSha256 || '')) throw new Error('Helm requires its pinned reviewed module');
    const moduleBytes = fs.readFileSync(moduleFile);
    if (crypto.createHash('sha256').update(moduleBytes).digest('hex') !== moduleSha256) {
      throw new Error('Helm MCP module changed: review/test and explicitly update the pin before reconnecting');
    }
    const encoded = moduleBytes.toString('base64');
    const code = 'import base64;exec(compile(base64.b64decode("' + encoded
      + '"),"<planning-mcp>","exec"),{"__name__":"__main__","__package__":"schwab_helm"})';
    command = `${quote(repo + '/.venv/bin/python')} -c ${quote(code)}`;
  }
  return `cd ${quote(repo)} && export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=20000' && exec ${command}`;
}
function sshArgs(config) {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(config.host) || config.host.startsWith('-')) throw new Error('Invalid SSH host');
  if (!/^[a-z_][a-z0-9_-]*$/.test(config.serviceUser)) throw new Error('Invalid service user');
  const command = remoteCommand(config);
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', config.host,
    `sudo -n -u ${quote(config.serviceUser)} /bin/sh -c ${quote(command)}`];
}
function main(argv) {
  const [source, host, repo, serviceUser, moduleFile, moduleSha256] = argv;
  const child = spawn('/usr/bin/ssh', sshArgs({ source, host, repo, serviceUser, moduleFile, moduleSha256 }), { stdio: ['inherit', 'inherit', 'ignore'] });
  child.on('error', () => { process.stderr.write('Private MCP SSH startup failed.\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
}
if (require.main === module) {
  try { main(process.argv.slice(2)); } catch {
    process.stderr.write('Usage: remote-stdio.js <pulse|helm> USER@HOST /REMOTE/REPO SERVICE_USER [LOCAL_HELM_MCP_MODULE SHA256]\n');
    process.exitCode = 2;
  }
}
module.exports = { remoteCommand, sshArgs };
