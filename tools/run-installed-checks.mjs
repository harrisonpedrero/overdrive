import { spawn } from 'node:child_process';
import path from 'node:path';
import { checkOutcome } from '../plugins/feature-theater/scripts/check-outcome.mjs';

const [pluginRoot, workspacePath, feature, ...checkKeys] = process.argv.slice(2);
if (!pluginRoot || !workspacePath || !feature || !checkKeys.length || checkKeys.some(key => !key.trim()) || new Set(checkKeys).size !== checkKeys.length) {
  throw new Error('Usage: node run-installed-checks.mjs <installed-plugin-root> <workspace-path> <feature> <check-key> [check-key ...]');
}

const server = spawn(process.execPath, [path.join(path.resolve(pluginRoot), 'scripts', 'server.mjs')], {
  cwd: path.resolve(pluginRoot), windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
});
const pending = new Map();
let buffer = '', sequence = 0, submitted = false;
function fail(error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
server.on('error', fail);
server.on('exit', code => fail(new Error(`Installed controller exited before responding (exit ${code}).`)));
server.stdin.on('error', fail);
server.stdout.setEncoding('utf8');
server.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (error) { fail(error); return; }
    const request = pending.get(message.id);
    if (!request) continue;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selective-check-client', version: '1' } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await request('tools/list');
  if (!listed.tools.find(tool => tool.name === 'theater_checks_run')?.inputSchema?.properties?.check_keys) {
    throw new Error('This installed controller does not advertise check_keys. No checks were executed.');
  }
  process.stderr.write(`${JSON.stringify({ event: 'checks.requested', controllerPid: server.pid, feature, selectedCheckKeys: checkKeys })}\n`);
  submitted = true;
  const result = await request('tools/call', { name: 'theater_checks_run', arguments: {
    workspace_path: path.resolve(workspacePath), feature, check_keys: checkKeys,
  } });
  const output = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
  if (!result.isError && Array.isArray(output.receipts) && Array.isArray(output.selectedCheckKeys)) {
    output.completion ??= checkOutcome(output.selectedCheckKeys, output.receipts);
    process.stderr.write(`${JSON.stringify({ event: 'checks.finished', controllerPid: server.pid, feature, revision: output.verification?.revision, ...output.completion })}\n`);
  } else {
    process.stderr.write(`${JSON.stringify({ event: 'checks.unconfirmed', controllerPid: server.pid, feature, message: 'No complete execution handoff. Reconcile the owned process and durable receipts before retrying.' })}\n`);
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (result.isError || !output.receipts?.length || output.receipts.some(receipt => !receipt.passed)) process.exitCode = 1;
} catch (error) {
  if (submitted) process.stderr.write(`${JSON.stringify({ event: 'checks.unconfirmed', controllerPid: server.pid, feature, message: 'Connection ended without a complete handoff. Reconcile the owned process and durable receipts before retrying.' })}\n`);
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
} finally {
  // Closing stdin ends the server, so retain it until the complete tool response arrives.
  server.stdin.end();
}
