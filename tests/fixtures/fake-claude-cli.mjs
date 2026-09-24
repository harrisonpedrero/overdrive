// Emulates `claude -p --input-format stream-json --output-format stream-json` for bridge tests.
// Each user message becomes one response that writes a file, emits private and visible
// blocks, and ends with a result; "hang" never answers so interruption can be exercised.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const resumed = args.includes('--resume');
const sessionId = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1] || 'fake-session';
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ args, cwd: process.cwd(), claudeEnv: Object.keys(process.env).filter(key => /^CLAUDE/.test(key)).sort() }));
}
// With FAKE_CLAUDE_STORE, sessions persist across processes and resuming an unknown session
// fails like the real CLI; each launch is appended to FAKE_CLAUDE_LOG.
if (process.env.FAKE_CLAUDE_STORE) {
  const storeFile = process.env.FAKE_CLAUDE_STORE;
  const known = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : [];
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ mode: resumed ? 'resume' : 'create', sessionId })}\n`);
  if (resumed && !known.includes(sessionId)) {
    process.stderr.write(`No conversation found with session ID: ${sessionId}\n`);
    process.exit(1);
  }
  if (!resumed) fs.writeFileSync(storeFile, JSON.stringify([...known, sessionId]));
}
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const queue = [];
let busy = false;
// A resumed session continues numbering from the files earlier processes left behind.
let count = fs.readdirSync(process.cwd()).filter(name => /^worker-\d+\.txt$/.test(name)).length;
let buffer = '';
let queued = null;

function respond(message) {
  const text = message.message.content.map(part => part.text).join('\n');
  count += 1;
  const n = count;
  send({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model' });
  if (/hang/.test(text)) return new Promise(() => {});
  send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private-do-not-persist' }, { type: 'text', text: `Working on message ${n}.` }] } });
  // Failures, each with a secret and oversized noise: a failed result whose reason is its result
  // string, only in error fields, or only on stderr (partly written after the result), and an
  // exit before any result.
  if (/fail-result/.test(text)) {
    send({ type: 'result', subtype: 'success', is_error: true, result: `API Error: connect ECONNREFUSED 127.0.0.1:9 api_key=fake-result-secret-value ${'noise '.repeat(2_000)}end-of-noise`, session_id: sessionId });
    return Promise.resolve();
  }
  if (/fail-exit/.test(text)) {
    process.stderr.write(`${'startup-noise\n'.repeat(400)}Error: connect ECONNREFUSED 127.0.0.1:9 password=fake-exit-secret-value\n`, () => process.exit(1));
    return new Promise(() => {});
  }
  if (/fail-fields/.test(text)) {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId, errors: ['API Error: Connection error. connect ECONNREFUSED 127.0.0.1:9 Authorization: Bearer fake-bearer-secret-value', `${'noise '.repeat(2_000)}end-of-noise`] });
    return Promise.resolve();
  }
  if (/fail-stderr/.test(text)) {
    process.stderr.write(`${'startup-noise\n'.repeat(700)}`);
    send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: sessionId });
    process.stderr.write('Error: connect ECONNREFUSED 127.0.0.1:9 (api_key=fake-stderr-secret-value)\n');
    return Promise.resolve();
  }
  // "hold-for-steer" keeps the response active until the next user message is queued, so a
  // steer is deterministically mid-turn; other responses finish after a fixed delay.
  const ready = /hold-for-steer/.test(text) ? nextMessage() : new Promise(resolve => setTimeout(resolve, 1_500));
  return ready.then(() => {
    const file = `worker-${n}.txt`;
    fs.writeFileSync(path.join(process.cwd(), file), `turn ${n}\n`);
    send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${n}`, name: 'Write', input: { file_path: file, content: `turn ${n}\n` } }] } });
    send({ type: 'user', session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'secret-tool-output-do-not-persist' }] } });
    send({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [{ type: 'text', text: `Handoff ${n}: wrote ${file}.` }] } });
    send({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: `Handoff ${n}: wrote ${file}.`, session_id: sessionId, permission_denials: n === 1 ? [{ tool_name: 'WebFetch', tool_input: {} }] : [] });
  });
}

function nextMessage() {
  return new Promise(resolve => { if (queue.length) resolve(); else queued = resolve; });
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) await respond(queue.shift());
  busy = false;
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (line) queue.push(JSON.parse(line));
  }
  if (queued && queue.length) { queued(); queued = null; }
  void drain();
});
process.stdin.on('end', () => process.stdout.write('', () => process.stderr.write('', () => process.exit(0))));
