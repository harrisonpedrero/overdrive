// Emulates a persistent Codex app-server for restart tests. Sessions survive restarts in
// FAKE_CODEX_STORE and unknown session IDs are rejected, as a real backend rejects a session
// created by another harness. Every request is appended to FAKE_CODEX_LOG.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const storeFile = process.env.FAKE_CODEX_STORE;
const logFile = process.env.FAKE_CODEX_LOG;
const load = () => { try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch { return {}; } };
const save = store => fs.writeFileSync(storeFile, JSON.stringify(store));
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const running = new Map();

function complete(threadId, turnId, status) {
  const store = load();
  const turn = store[threadId]?.turns.find(candidate => candidate.id === turnId);
  if (!turn || turn.status !== 'inProgress') return;
  clearTimeout(running.get(threadId)?.timer);
  running.delete(threadId);
  Object.assign(turn, { status, items: status === 'completed' ? [{ type: 'agentMessage', text: `Codex handoff for ${turnId}.` }] : [] });
  save(store);
  send({ method: 'turn/completed', params: { threadId, turn } });
}

function handle({ id, method, params = {} }) {
  if (method === 'initialized') return;
  if (method === 'initialize') return send({ id, result: { userAgent: 'fake-codex-store' } });
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ method, threadId: params.threadId ?? null })}\n`);
  const store = load();
  if (method === 'thread/start') {
    const threadId = `codex-${randomUUID()}`;
    store[threadId] = { turns: [] };
    save(store);
    return send({ id, result: { thread: { id: threadId } } });
  }
  const thread = store[params.threadId];
  if (!thread) return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
  const threadId = params.threadId;
  if (method === 'turn/start') {
    // FAKE_REFUSE: explicit error, no turn. FAKE_LOSE_RESPONSE: the turn runs for 4s but its
    // response and turn/started are never sent, as when a request times out.
    const text = (params.input ?? []).map(part => part.text).join('\n');
    if (/FAKE_REFUSE/.test(text)) return send({ id, error: { code: -32000, message: 'turn refused by fake backend' } });
    const turnId = `turn-${randomUUID()}`;
    thread.turns.push({ id: turnId, status: 'inProgress', items: [] });
    save(store);
    const lost = /FAKE_LOSE_RESPONSE/.test(text);
    // FAKE_LOSE_RESPONSE_DONE: the turn finishes at once, but neither its response nor any
    // notification is ever delivered.
    if (/FAKE_LOSE_RESPONSE_DONE/.test(text)) {
      Object.assign(thread.turns.at(-1), { status: 'completed', items: [{ type: 'agentMessage', text: `Codex handoff for ${turnId}.` }] });
      return save(store);
    }
    // FAKE_STARTED_THEN_LOSE: turn/started is delivered but the response never is; the turn keeps
    // running until interrupted.
    const startedThenLost = /FAKE_STARTED_THEN_LOSE/.test(text);
    if (!lost && !startedThenLost) send({ id, result: { turn: { id: turnId } } });
    if (!lost) send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    running.set(threadId, { turnId, timer: /hang/.test(text) || startedThenLost ? null : setTimeout(() => complete(threadId, turnId, 'completed'), lost ? 4_000 : 150) });
    return;
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} });
    return complete(threadId, params.turnId, 'interrupted');
  }
  if (method === 'thread/read') return send({ id, result: { thread: { id: threadId, turns: thread.turns } } });
  if (method === 'thread/compact/start') {
    send({ id, result: {} });
    const turnId = `compact-${randomUUID()}`;
    send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'thread/compacted', params: { threadId, turnId } });
    return send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
  }
  send({ id, result: { thread: { id: threadId } } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
