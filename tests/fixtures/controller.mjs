// A real OVERDRIVE controller process for restart tests: one WorkerBridge and agent
// runtime per process over the fake Codex and Claude backends, one JSON command per stdin line.
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WorkerBridge } from '../../plugins/overdrive/scripts/app-server.mjs';
import { createAgentRuntime } from '../../plugins/overdrive/scripts/agent-runtime.mjs';
import { OverdriveError } from '../../plugins/overdrive/scripts/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const node = script => ({ launch: { command: process.execPath, args: [path.join(here, script)] } });
const codex = { ...node('fake-codex-store.mjs'), requestTimeoutMs: Number(process.env.FAKE_CODEX_TIMEOUT_MS) || undefined };
// FAKE_CLAUDE_LAUNCH: a JSON argument list for Node that replaces the fake Claude CLI.
const claude = process.env.FAKE_CLAUDE_LAUNCH ? { launch: { command: process.execPath, args: JSON.parse(process.env.FAKE_CLAUDE_LAUNCH) } } : node('fake-claude-cli.mjs');
const bridge = new WorkerBridge({ codex, claude });
// FAKE_LOST_AFTER_SEND: the turn request really reaches the backend and the turn runs, but the
// response and its turn/started notification are lost, as with a transport timeout.
const request = bridge.request.bind(bridge);
const emit = bridge.emit.bind(bridge);
let losing = false;
bridge.emit = (event, message, ...rest) => (losing && event === 'notification' && message?.method === 'turn/started' ? true : emit(event, message, ...rest));
bridge.request = async (method, params) => {
  losing = method === 'turn/start' && JSON.stringify(params.input).includes('FAKE_LOST_AFTER_SEND');
  try {
    const result = await request(method, params);
    if (losing) throw new OverdriveError('Worker request timed out: turn/start', 'CODEX_TIMEOUT');
    return result;
  } finally { losing = false; }
};
const runtime = createAgentRuntime(bridge);
const operations = {
  start: runtime.startFeatureAgent,
  steer: runtime.steerFeatureAgent,
  inspect: runtime.inspectFeatureAgent,
  wait: runtime.waitFeatureAgents,
  interrupt: runtime.interruptFeatureAgent,
};
const reply = value => process.stdout.write(`${JSON.stringify(value)}\n`);

readline.createInterface({ input: process.stdin })
  .on('line', async line => {
    const { id, op, args } = JSON.parse(line);
    try { reply({ id, result: await operations[op](args) }); }
    catch (error) { reply({ id, error: { code: error.code ?? null, message: error.message } }); }
  })
  .on('close', async () => {
    await runtime.shutdownAgentRuntime();
    process.exit(0);
  });
reply({ ready: process.pid });
