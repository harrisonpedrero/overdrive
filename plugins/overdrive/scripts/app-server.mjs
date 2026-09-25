import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import { EventEmitter } from 'node:events';
import { OverdriveError, refusedRequest } from './util.mjs';
import { ClaudeWorkerBridge } from './claude-worker.mjs';

const DEFAULT_REQUEST_TIMEOUT = 120_000;
const HARNESSES = new Set(['codex', 'claude']);
const WORKER_CONFIG_OVERRIDES = [
  'features.plugins=false',
  'features.apps=false',
  'features.browser_use=false',
  'features.computer_use=false',
  'features.enable_mcp_apps=false',
  'features.hooks=false',
  'features.image_generation=false',
  'features.in_app_browser=false',
  'features.skill_mcp_dependency_install=false',
];

function configArgs(values) {
  return values.flatMap(value => ['-c', value]);
}

function tomlKeySegment(value) {
  return /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

export function isolatedMcpConfigArgs(servers) {
  if (!Array.isArray(servers)) throw new OverdriveError('Codex returned an unexpected MCP inventory.', 'CODEX_CONFIG_INVALID');
  return servers
    .filter(server => server?.enabled && typeof server.name === 'string')
    .flatMap(server => {
      const key = `mcp_servers.${tomlKeySegment(server.name)}`;
      const transport = server.transport?.type === 'stdio'
        ? '{enabled=false,command="node",args=["-e",""]}'
        : '{enabled=false,url="http://127.0.0.1/"}';
      return ['-c', `${key}=${transport}`];
    });
}

function disabledMcpOverrides(executable) {
  const listed = spawnSync(executable, ['mcp', 'list', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 5_000_000,
  });
  if (listed.status !== 0 || listed.error) {
    throw new OverdriveError('Unable to inventory configured MCP servers for an isolated feature task. Repair the Codex configuration and retry.', 'CODEX_CONFIG_INVALID');
  }
  let servers;
  try { servers = JSON.parse(listed.stdout); }
  catch { throw new OverdriveError('Codex returned an invalid MCP inventory; refusing to start a feature task without tool isolation.', 'CODEX_CONFIG_INVALID'); }
  return isolatedMcpConfigArgs(servers);
}

// The Codex executable a worker launch would use: CODEX_CLI_PATH, then codex.exe on the Windows
// PATH, otherwise the bare command name for the platform's own PATH lookup.
export function codexExecutable() {
  let direct = process.env.CODEX_CLI_PATH;
  if ((!direct || !fsSync.existsSync(direct)) && process.platform === 'win32') {
    const found = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true });
    direct = found.status === 0 ? found.stdout.split(/\r?\n/).find(candidate => candidate && fsSync.existsSync(candidate)) : undefined;
  }
  return direct && fsSync.existsSync(direct) ? direct : 'codex';
}

function launchSpec(override = undefined) {
  if (override) return override;
  return { command: codexExecutable(), args: [...configArgs(WORKER_CONFIG_OVERRIDES), 'app-server', '--stdio'] };
}

export class CodexAppServer extends EventEmitter {
  constructor({ launch, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT } = {}) {
    super();
    this.launch = launchSpec(launch);
    this.isolateWorker = !launch;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.starting = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return await this.starting;
    this.starting = this.#start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    // A lane may edit its checkout, but apps, hooks, plugins, browser control,
    // and every configured external MCP server remain coordinator-only.
    const launch = this.isolateWorker
      ? { ...this.launch, args: [...disabledMcpOverrides(this.launch.command), ...this.launch.args] }
      : this.launch;
    const child = spawn(launch.command, launch.args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child = child;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (this.child === child) this.#receive(chunk); });
    child.stderr.on('data', chunk => { this.stderrTail = (this.stderrTail + chunk).slice(-16_000); });
    child.once('error', error => { if (this.child === child) this.#failed(new OverdriveError(`Unable to launch Codex app-server: ${error.message}`, 'CODEX_LAUNCH_FAILED')); });
    child.once('exit', code => { if (this.child === child) this.#failed(new OverdriveError(`Codex app-server exited (${code}). ${this.stderrTail.trim()}`.trim(), 'CODEX_EXITED')); });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await this.request('initialize', {
      clientInfo: { name: 'overdrive', title: 'OVERDRIVE', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 30_000, true);
    this.notify('initialized', {});
  }

  #failed(error) {
    if (!this.child && !this.pending.size) return;
    this.child = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.emit('exit', error);
  }

  #receive(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.stderrTail = `${this.stderrTail}\nInvalid app-server JSON: ${line.slice(0, 1_000)}`.slice(-16_000);
        continue;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(String(message.id));
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(String(message.id));
        if (message.error) pending.reject(refusedRequest(new OverdriveError(message.error.message || JSON.stringify(message.error), 'CODEX_RPC_ERROR', message.error)));
        else pending.resolve(message.result);
        continue;
      }
      if (message.id !== undefined && message.method) {
        this.serverRequests.set(String(message.id), { id: message.id, method: message.method, params: message.params ?? {} });
        this.emit('serverRequest', { id: message.id, method: message.method, params: message.params ?? {} });
        continue;
      }
      if (message.method === 'serverRequest/resolved') {
        const key = String(message.params?.requestId);
        if (this.serverRequests.get(key)?.params.threadId === message.params?.threadId) this.serverRequests.delete(key);
      }
      if (message.method) this.emit('notification', { method: message.method, params: message.params ?? {} });
    }
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) throw new OverdriveError('Codex app-server is not running.', 'CODEX_NOT_RUNNING');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async request(method, params, timeoutMs = this.requestTimeoutMs, skipEnsure = false) {
    if (!skipEnsure) await this.ensureStarted().catch(error => { throw refusedRequest(error); });
    if (!this.child?.stdin?.writable) throw refusedRequest(new OverdriveError('Codex app-server is not running.', 'CODEX_NOT_RUNNING'));
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new OverdriveError(`Codex request timed out: ${method}`, 'CODEX_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer, method });
    });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return await response;
  }

  respondToServer(requestId, result, error = undefined) {
    const key = String(requestId);
    const request = this.serverRequests.get(key);
    if (!request) throw new OverdriveError(`App-server request is no longer live: ${key}`, 'REQUEST_ORPHANED');
    if (!this.child?.stdin?.writable) throw new OverdriveError('Codex app-server is not running.', 'CODEX_NOT_RUNNING');
    const message = error
      ? { id: request.id, error: { code: -32000, message: String(error) } }
      : { id: request.id, result };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    this.serverRequests.delete(key);
  }

  liveRequest(requestId) {
    return this.serverRequests.get(String(requestId)) ?? null;
  }

  async startThread({ cwd, runtimeWorkspaceRoots, developerInstructions, model = 'gpt-6-sol', effort = 'high' }) {
    const response = await this.request('thread/start', {
      cwd,
      runtimeWorkspaceRoots,
      model,
      approvalPolicy: 'on-request',
      permissions: ':workspace',
      config: { features: { plugins: false } },
      developerInstructions,
      personality: 'pragmatic',
      ephemeral: false,
    });
    return { ...response, requestedEffort: effort };
  }

  async resumeThread({ threadId, cwd, runtimeWorkspaceRoots, developerInstructions, model = 'gpt-6-sol' }) {
    return await this.request('thread/resume', {
      threadId,
      cwd,
      runtimeWorkspaceRoots,
      model,
      approvalPolicy: 'on-request',
      permissions: ':workspace',
      config: { features: { plugins: false } },
      developerInstructions,
      personality: 'pragmatic',
      excludeTurns: true,
    });
  }

  async startTurn({ threadId, instruction, cwd, runtimeWorkspaceRoots, effort = 'high' }) {
    return await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: instruction, text_elements: [] }],
      cwd,
      runtimeWorkspaceRoots,
      model: 'gpt-6-sol',
      effort,
      summary: 'concise',
    });
  }

  async steer({ threadId, turnId, instruction }) {
    return await this.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: instruction, text_elements: [] }],
    });
  }

  async compact(threadId) {
    return await this.request('thread/compact/start', { threadId });
  }

  async readThread(threadId) {
    return await this.request('thread/read', { threadId, includeTurns: true });
  }

  async nameThread(threadId, name) {
    return await this.request('thread/name/set', { threadId, name });
  }

  async interrupt(threadId, turnId) {
    return await this.request('turn/interrupt', { threadId, turnId });
  }

  shutdown() {
    const child = this.child;
    if (!child) return;
    this.#failed(new OverdriveError('Codex app-server connection closed.', 'CODEX_CLOSED'));
    if (!child.killed) child.kill();
  }
}

// Routes each feature thread to the harness backend that owns it. Backends start lazily,
// so a Claude-only workspace never launches a Codex app-server and vice versa.
export class WorkerBridge extends EventEmitter {
  constructor({ codex, claude } = {}) {
    super();
    this.factories = { codex: () => new CodexAppServer(codex), claude: () => new ClaudeWorkerBridge(claude) };
    this.backends = new Map();
    this.threads = new Map();
  }

  backend(harness = 'codex') {
    if (!HARNESSES.has(harness)) throw refusedRequest(new OverdriveError(`Unknown worker harness: ${harness}`, 'INVALID_STATE'));
    let backend = this.backends.get(harness);
    if (backend) return backend;
    backend = this.factories[harness]();
    backend.on('notification', message => this.emit('notification', message));
    backend.on('serverRequest', message => this.emit('serverRequest', message));
    backend.on('exit', (error, threadIds) => {
      const owned = threadIds ?? [...this.threads].filter(([, owner]) => owner === harness).map(([threadId]) => threadId);
      for (const threadId of owned) this.threads.delete(threadId);
      this.emit('exit', error, owned);
    });
    this.backends.set(harness, backend);
    return backend;
  }

  async ensureStarted() {}

  // A session belongs to the harness that created it. Callers name that owner; a loaded
  // session confirms it and a disagreement is refused instead of silently rerouted.
  owner(threadId, harness) {
    const loaded = this.threads.get(threadId);
    if (loaded && harness && loaded !== harness) throw refusedRequest(new OverdriveError(`Native session ${threadId} belongs to the ${loaded} harness, not ${harness}.`, 'SESSION_OWNER_CONFLICT'));
    const owner = loaded ?? harness;
    if (!owner) throw refusedRequest(new OverdriveError(`Native session ${threadId} has no recorded owning harness.`, 'SESSION_OWNER_UNKNOWN'));
    return owner;
  }

  // Makes a saved session readable in this controller without launching a turn. Only backends
  // that keep session metadata in process need this; others read their persisted sessions.
  async attachThread({ harness, ...params }) {
    const owner = this.owner(params.threadId, harness);
    const backend = this.backend(owner);
    if (!backend.attachThread) return;
    await backend.attachThread(params);
    this.threads.set(params.threadId, owner);
  }

  async startThread({ harness = 'codex', ...params }) {
    const response = await this.backend(harness).startThread(params);
    this.threads.set(response.thread.id, harness);
    return response;
  }

  async resumeThread({ harness, ...params }) {
    const owner = this.owner(params.threadId, harness);
    const response = await this.backend(owner).resumeThread(params);
    this.threads.set(params.threadId, owner);
    return response;
  }

  // A loaded session adopts changed session-bound settings before its next turn, exactly as a
  // resume after restart would. Backends whose settings travel with each turn need no update.
  async updateThread({ harness, ...params }) {
    const backend = this.backend(this.owner(params.threadId, harness));
    return backend.updateThread ? await backend.updateThread(params) : null;
  }

  async request(method, { harness, ...params } = {}) {
    return await this.backend(params.threadId ? this.owner(params.threadId, harness) : harness).request(method, params);
  }

  // Waits for, or stops, a worker process that a loaded session's ended turn left running (such
  // as one an interrupt could not stop), throwing if it cannot. Sessions not loaded here, and
  // backends that keep no process of their own, have nothing to settle.
  async settleThread({ threadId }) {
    const owner = this.threads.get(threadId);
    return await this.backends.get(owner)?.settleThread?.({ threadId });
  }

  acknowledgeDescendants({ threadId, turnId }) {
    const owner = this.threads.get(threadId);
    this.backends.get(owner)?.acknowledgeDescendants?.({ threadId, turnId });
  }

  liveRequest(requestId) {
    for (const backend of this.backends.values()) {
      const request = backend.liveRequest(requestId);
      if (request) return request;
    }
    return null;
  }

  respondToServer(requestId, result, error = undefined) {
    for (const backend of this.backends.values()) {
      if (backend.liveRequest(requestId)) return backend.respondToServer(requestId, result, error);
    }
    throw new OverdriveError(`Worker request is no longer live: ${requestId}`, 'REQUEST_ORPHANED');
  }

  // Resolves once every backend has shut down, reporting processes a backend could not stop.
  async shutdown() {
    const results = await Promise.all([...this.backends.values()].map(backend => backend.shutdown()));
    return { unstopped: results.flatMap(result => result?.unstopped ?? []) };
  }
}

export function finalVisibleMessage(turn) {
  if (!turn?.items || !Array.isArray(turn.items)) return '';
  return turn.items.filter(item => item?.type === 'agentMessage' && typeof item.text === 'string').map(item => item.text).join('\n').trim();
}
