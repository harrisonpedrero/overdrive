#!/usr/bin/env node
import { callTool, TOOLS } from './tools.mjs';
import { shutdownAgentRuntime } from './agent-runtime.mjs';

let buffer = '';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function rpcError(id, code, message, data = undefined) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function toolResult(id, value, isError = false) {
  const text = JSON.stringify(value, null, 2);
  result(id, {
    content: [{ type: 'text', text }],
    structuredContent: value,
    isError,
  });
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'overdrive', title: 'OVERDRIVE', version: '0.1.0' },
      instructions: 'Use OVERDRIVE to run features in isolated clones and orchestrate their lane workers. Persist only safe summaries and evidence; never expose private reasoning.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const value = await callTool(params?.name, params?.arguments ?? {});
      return toolResult(id, value);
    } catch (error) {
      return toolResult(id, {
        error: error?.code || 'OVERDRIVE_ERROR',
        message: error?.message || String(error),
        ...(error?.details === undefined ? {} : { details: error.details }),
      }, true);
    }
  }
  if (id !== undefined) rpcError(id, -32601, `Method not found: ${method}`);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); }
    catch {
      rpcError(null, -32700, 'Parse error');
      continue;
    }
    void handle(message).catch(error => rpcError(message.id ?? null, -32603, error?.message || String(error)));
  }
});

process.stdin.on('end', async () => {
  await shutdownAgentRuntime();
  process.exit(0);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await shutdownAgentRuntime();
    process.exit(0);
  });
}
