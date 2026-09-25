import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServer, finalVisibleMessage, isolatedMcpConfigArgs } from '../plugins/overdrive/scripts/app-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('feature worker app-server disables coordinator integrations', () => {
  const client = new CodexAppServer();
  const configuration = client.launch.args.join(' ');
  for (const feature of ['plugins', 'apps', 'browser_use', 'computer_use', 'hooks']) {
    assert.match(configuration, new RegExp(`features\\.${feature}=false`));
  }
});

test('feature worker MCP overrides are disabled and credential-free', () => {
  const args = isolatedMcpConfigArgs([
    { name: 'stdio-server', enabled: true, transport: { type: 'stdio', command: 'secret-command', args: ['secret-token'] } },
    { name: 'remote.server', enabled: true, transport: { type: 'streamable_http', url: 'https://user:secret@example.test/mcp' } },
    { name: 'already-off', enabled: false, transport: { type: 'stdio' } },
  ]);
  const configuration = args.join(' ');
  assert.match(configuration, /mcp_servers\.stdio-server=.*enabled=false/);
  assert.match(configuration, /mcp_servers\."remote\.server".*enabled=false/);
  assert.doesNotMatch(configuration, /secret-command|secret-token|example\.test|already-off/);
});

test('app-server client initializes and filters final visible output', async t => {
  const client = new CodexAppServer({ launch: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-app-server.mjs')] } });
  t.after(() => client.shutdown());
  const notifications = [];
  client.on('notification', event => notifications.push(event));
  await client.ensureStarted();
  const thread = await client.startThread({ cwd: here, runtimeWorkspaceRoots: [here], developerInstructions: 'fixture' });
  assert.equal(thread.thread.id, 'thread-fixture');
  const turn = await client.startTurn({ threadId: 'thread-fixture', instruction: 'work', cwd: here, runtimeWorkspaceRoots: [here] });
  assert.equal(turn.turn.id, 'turn-fixture');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(notifications.some(event => event.method === 'item/reasoning/textDelta'));
  assert.ok(notifications.some(event => event.method === 'item/agentMessage/delta'));
  assert.equal(finalVisibleMessage({ items: [{ type: 'reasoning', summary: ['private'] }, { type: 'agentMessage', text: 'public handoff' }] }), 'public handoff');
});

test('MCP server advertises the native OVERDRIVE command surface', async t => {
  const server = spawn(process.execPath, [path.join(here, '..', 'plugins', 'overdrive', 'scripts', 'server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => server.kill());
  let buffer = '';
  const pending = new Map();
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(String(message.id))?.(message);
      pending.delete(String(message.id));
    }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5_000);
    pending.set(String(id), message => { clearTimeout(timer); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'overdrive');
  assert.equal(initialized.result.serverInfo.title, 'OVERDRIVE');
  const listed = await request(2, 'tools/list');
  const names = listed.result.tools.map(tool => tool.name);
  for (const expected of ['workspace_init', 'project_create', 'feature_create', 'feature_update', 'work_update', 'agent_start', 'agent_steer', 'candidate_promote', 'checks_update', 'checks_run', 'view', 'agent_wait']) assert.ok(names.includes(expected));
  assert.equal(new Set(names).size, names.length);
  server.stdin.end();
});
