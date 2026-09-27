import { spawn, spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import { EventEmitter } from 'node:events';
import { OverdriveError, refusedRequest } from './util.mjs';
import { ClaudeWorkerBridge } from './claude-worker.mjs';
import { BROWSER_CONTROL, workerToolDecision } from './worker-policy.mjs';

const DEFAULT_REQUEST_TIMEOUT = 120_000;
const HARNESSES = new Set(['codex', 'claude']);
const PROFILES = new Set(['feature', 'qa']);
const COORDINATOR_PLUGINS = ['overdrive@overdrive-local', 'feature-theater@feature-theater-local'];
const BROWSER_PLUGINS = ['browser@openai-bundled', 'chrome@openai-bundled', 'computer-use@openai-bundled', 'unified-computer-use@openai-bundled'];
const DISABLED_STDIO = Object.freeze({ enabled: false, command: 'node', args: ['-e', ''] });
const DISABLED_URL = Object.freeze({ enabled: false, url: 'http://127.0.0.1/' });
const WORKER_SERVER_ENV = ['PATH', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'CODEX_HOME'];
// With network access in the sandbox, only 'untrusted' makes a command such as git push ask first,
// so the worker permission policy sees every command that is not read-only.
const WORKER_APPROVAL_POLICY = 'untrusted';
// Escalations a worker may need follow the worker permission policy; questions and MCP
// elicitations still reach the coordinator as pending requests.
const POLICY_APPROVALS = {
  'item/commandExecution/requestApproval': { tool: 'shell', answer: allow => ({ decision: allow ? 'accept' : 'decline' }) },
  'item/fileChange/requestApproval': { tool: 'apply_patch', answer: allow => ({ decision: allow ? 'accept' : 'decline' }) },
  'item/permissions/requestApproval': { tool: 'permissions', answer: (allow, params) => ({ permissions: allow ? params.permissions ?? {} : {}, scope: 'turn' }) },
};

// Plugin keys stay unquoted because Codex keeps quotes in a -c key segment literally.
function workerConfigOverrides(profile) {
  const feature = profile !== 'qa';
  const plugins = [...COORDINATOR_PLUGINS, ...(feature ? BROWSER_PLUGINS : [])];
  return [
    ...(feature ? ['features.browser_use=false', 'features.computer_use=false', 'features.in_app_browser=false'] : []),
    'features.skill_mcp_dependency_install=false',
    ...plugins.map(id => `plugins.${id}.enabled=false`),
  ].flatMap(value => ['-c', value]);
}

// A server configured with these variables drives a browser or the computer whatever its name, as
// Codex's node_repl does.
const BROWSER_ENV = /^(?:BROWSER_USE_|SKY_CUA_|CODEX_BROWSER_USE_)/;
const serverVariables = server => [...Object.keys(server.transport?.env ?? {}), ...(Array.isArray(server.transport?.env_vars) ? server.transport.env_vars : [])];
// Every file a patch item writes, a rename's destination included.
const patchTargets = item => (Array.isArray(item.changes) ? item.changes.flatMap(change => [change?.path, change?.kind?.move_path ?? undefined]).filter(value => value !== undefined) : []);

// Credential-free stand-ins for the MCP servers a profile denies. They are applied per thread,
// because a process-wide override does not reach servers that plugins provide.
export function deniedMcpServers(servers, profile) {
  if (!Array.isArray(servers)) throw new OverdriveError('Codex returned an unexpected MCP inventory.', 'CODEX_CONFIG_INVALID');
  const browser = server => BROWSER_CONTROL.test(server.name) || serverVariables(server).some(name => BROWSER_ENV.test(String(name)));
  const denied = server => ['overdrive', 'feature_theater'].includes(server.name) || (profile !== 'qa' && browser(server));
  return Object.fromEntries(servers
    .filter(server => server?.enabled && typeof server.name === 'string' && denied(server))
    .map(server => [server.name, server.transport?.type === 'stdio' ? DISABLED_STDIO : DISABLED_URL]));
}

function mcpInventory(executable) {
  const listed = spawnSync(executable, ['mcp', 'list', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 5_000_000,
  });
  if (listed.status !== 0 || listed.error) {
    throw new OverdriveError('Unable to inventory configured MCP servers for a worker task. Repair the Codex configuration and retry.', 'CODEX_CONFIG_INVALID');
  }
  try { return JSON.parse(listed.stdout); }
  catch { throw new OverdriveError('Codex returned an invalid MCP inventory; refusing to start a worker task without its capability profile.', 'CODEX_CONFIG_INVALID'); }
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

function launchSpec(override, profile) {
  if (override) return override;
  return { command: codexExecutable(), args: [...workerConfigOverrides(profile), 'app-server', '--stdio'] };
}

export class CodexAppServer extends EventEmitter {
  constructor({ launch, profile = 'feature', requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT } = {}) {
    super();
    this.profile = profile;
    this.launch = launchSpec(launch, profile);
    this.isolateWorker = !launch;
    this.deniedServers = {};
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.starting = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.nextId = 1;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.denials = new Map();
    this.writeScopes = new Map();
    this.patchPaths = new Map();
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return await this.starting;
    this.starting = this.#start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    if (this.isolateWorker) this.deniedServers = deniedMcpServers(mcpInventory(this.launch.command), this.profile);
    // OVERDRIVE_WORKER leaves any copy of the OVERDRIVE plugin server a worker loads without tools.
    const child = spawn(this.launch.command, this.launch.args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OVERDRIVE_WORKER: '1' },
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
    this.denials.clear();
    this.patchPaths.clear();
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
        if (this.#answerByPolicy(message)) continue;
        this.serverRequests.set(String(message.id), { id: message.id, method: message.method, params: message.params ?? {} });
        this.emit('serverRequest', { id: message.id, method: message.method, params: message.params ?? {} });
        continue;
      }
      if (message.method === 'serverRequest/resolved') {
        const key = String(message.params?.requestId);
        if (this.serverRequests.get(key)?.params.threadId === message.params?.threadId) this.serverRequests.delete(key);
      }
      if (message.method === 'item/started' && message.params?.item?.type === 'fileChange') this.patchPaths.set(message.params.item.id, patchTargets(message.params.item));
      // With streamed patch events, item/started may name only the files known so far.
      if (message.method === 'item/fileChange/patchUpdated') {
        const { itemId } = message.params ?? {};
        this.patchPaths.set(itemId, [...new Set([...(this.patchPaths.get(itemId) ?? []), ...patchTargets(message.params)])]);
      }
      if (message.method === 'item/completed') this.patchPaths.delete(message.params?.item?.id);
      if (message.method === 'turn/completed') this.#attachDenials(message.params);
      if (message.method) this.emit('notification', { method: message.method, params: message.params ?? {} });
    }
  }

  // A file-change approval request is checked against the files its earlier item/started and patch updates named; a patch Codex
  // applies without a request, such as under preapproved permissions or a cached approval, is not seen here.
  #answerByPolicy({ id, method, params = {} }) {
    const approval = POLICY_APPROVALS[method];
    if (!approval) return false;
    const input = method === 'item/fileChange/requestApproval' ? { file_paths: this.patchPaths.get(params.itemId) } : params;
    const { allow } = workerToolDecision(this.profile, approval.tool, input, this.writeScopes.get(params.threadId));
    if (!allow) this.denials.set(params.turnId, [...(this.denials.get(params.turnId) ?? []), approval.tool]);
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ id, result: approval.answer(allow, params) })}\n`);
    return true;
  }

  // Denied escalations travel with the turn's completion into its recorded handoff.
  #attachDenials(params) {
    const denials = this.denials.get(params?.turn?.id);
    if (!denials) return;
    this.denials.delete(params.turn.id);
    params.turn = { ...params.turn, denials };
  }

  // The injected worker server gives the thread its OVERDRIVE identity and replaces any server of
  // that name, including a denied stand-in. Codex clears a server's environment except for listed
  // variables, and lab_run may outlast its default tool timeout.
  #threadConfig(workerServer) {
    const overdrive = workerServer && { ...workerServer, env_vars: WORKER_SERVER_ENV, tool_timeout_sec: 3_700, default_tools_approval_mode: 'approve' };
    return {
      mcp_servers: { ...this.deniedServers, ...(overdrive ? { overdrive } : {}) },
      sandbox_workspace_write: { network_access: true },
    };
  }

  notify(method, params) {
    if (!this.child?.stdin?.writable) throw new OverdriveError('Codex app-server is not running.', 'CODEX_NOT_RUNNING');
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async #ready() {
    await this.ensureStarted().catch(error => { throw refusedRequest(error); });
  }

  async request(method, params, timeoutMs = this.requestTimeoutMs, skipEnsure = false) {
    if (!skipEnsure) await this.#ready();
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

  // Thread config needs the denied-server inventory, which is taken when the app-server starts.
  async startThread({ cwd, runtimeWorkspaceRoots, writeRoots, workspaceRoot, developerInstructions, workerServer, model = 'gpt-6-sol', effort = 'high' }) {
    await this.#ready();
    const response = await this.request('thread/start', {
      cwd,
      runtimeWorkspaceRoots,
      model,
      approvalPolicy: WORKER_APPROVAL_POLICY,
      sandbox: 'workspace-write',
      config: this.#threadConfig(workerServer),
      developerInstructions,
      personality: 'pragmatic',
      ephemeral: false,
    });
    this.writeScopes.set(response.thread.id, { writeRoots, workspaceRoot });
    return { ...response, requestedEffort: effort };
  }

  async resumeThread({ threadId, cwd, runtimeWorkspaceRoots, writeRoots, workspaceRoot, developerInstructions, workerServer, model = 'gpt-6-sol' }) {
    await this.#ready();
    this.writeScopes.set(threadId, { writeRoots, workspaceRoot });
    return await this.request('thread/resume', {
      threadId,
      cwd,
      runtimeWorkspaceRoots,
      model,
      approvalPolicy: WORKER_APPROVAL_POLICY,
      sandbox: 'workspace-write',
      config: this.#threadConfig(workerServer),
      developerInstructions,
      personality: 'pragmatic',
      excludeTurns: true,
    });
  }

  shutdown() {
    const child = this.child;
    if (!child) return;
    this.#failed(new OverdriveError('Codex app-server connection closed.', 'CODEX_CLOSED'));
    if (!child.killed) child.kill();
  }
}

// Routes each worker thread to the backend that owns it, one per harness and capability profile,
// so the two profiles never share a process. Backends start lazily, so a Claude-only workspace
// never launches a Codex app-server and vice versa.
export class WorkerBridge extends EventEmitter {
  constructor({ codex, claude } = {}) {
    super();
    this.factories = { codex: profile => new CodexAppServer({ ...codex, profile }), claude: profile => new ClaudeWorkerBridge({ ...claude, profile }) };
    this.backends = new Map();
    this.threads = new Map();
  }

  // key is 'harness' or 'harness:profile'; the profile defaults to feature.
  backend(key = 'codex') {
    const [harness, profile = 'feature'] = key.split(':');
    if (!HARNESSES.has(harness)) throw refusedRequest(new OverdriveError(`Unknown worker harness: ${harness}`, 'INVALID_STATE'));
    if (!PROFILES.has(profile)) throw refusedRequest(new OverdriveError(`Unknown worker profile: ${profile}`, 'INVALID_STATE'));
    const owner = `${harness}:${profile}`;
    let backend = this.backends.get(owner);
    if (backend) return backend;
    backend = this.factories[harness](profile);
    backend.on('notification', message => this.emit('notification', message));
    backend.on('serverRequest', message => this.emit('serverRequest', message));
    backend.on('exit', (error, threadIds) => {
      const owned = threadIds ?? [...this.threads].filter(([, loaded]) => loaded === owner).map(([threadId]) => threadId);
      for (const threadId of owned) this.threads.delete(threadId);
      this.emit('exit', error, owned);
    });
    this.backends.set(owner, backend);
    return backend;
  }

  async ensureStarted() {}

  // A session belongs to the backend that created it. Callers name its harness and profile; a
  // loaded session confirms them and a disagreement is refused instead of silently rerouted.
  owner(threadId, harness, profile = 'feature') {
    const loaded = this.threads.get(threadId);
    const named = harness && `${harness}:${profile}`;
    if (loaded && named && loaded !== named) throw refusedRequest(new OverdriveError(`Native session ${threadId} belongs to the ${loaded} worker backend, not ${named}.`, 'SESSION_OWNER_CONFLICT'));
    const owner = loaded ?? named;
    if (!owner) throw refusedRequest(new OverdriveError(`Native session ${threadId} has no recorded owning harness.`, 'SESSION_OWNER_UNKNOWN'));
    return owner;
  }

  // Makes a saved session readable in this controller without launching a turn. Only backends
  // that keep session metadata in process need this; others read their persisted sessions.
  async attachThread({ harness, profile, ...params }) {
    const owner = this.owner(params.threadId, harness, profile);
    const backend = this.backend(owner);
    if (!backend.attachThread) return;
    await backend.attachThread(params);
    this.threads.set(params.threadId, owner);
  }

  async startThread({ harness = 'codex', profile = 'feature', ...params }) {
    const owner = `${harness}:${profile}`;
    const response = await this.backend(owner).startThread(params);
    this.threads.set(response.thread.id, owner);
    return response;
  }

  async resumeThread({ harness, profile, ...params }) {
    const owner = this.owner(params.threadId, harness, profile);
    const response = await this.backend(owner).resumeThread(params);
    this.threads.set(params.threadId, owner);
    return response;
  }

  // A loaded session adopts changed session-bound settings before its next turn, exactly as a
  // resume after restart would. Backends whose settings travel with each turn need no update.
  async updateThread({ harness, profile, ...params }) {
    const backend = this.backend(this.owner(params.threadId, harness, profile));
    return backend.updateThread ? await backend.updateThread(params) : null;
  }

  async request(method, { harness, profile = 'feature', ...params } = {}) {
    return await this.backend(params.threadId ? this.owner(params.threadId, harness, profile) : `${harness ?? 'codex'}:${profile}`).request(method, params);
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

  // Request IDs are unique only within one backend, so the backend owning threadId is asked first.
  #requestBackend(requestId, threadId) {
    const owner = this.backends.get(this.threads.get(threadId));
    if (owner?.liveRequest(requestId)) return owner;
    return [...this.backends.values()].find(backend => backend.liveRequest(requestId)) ?? null;
  }

  liveRequest(requestId, threadId = undefined) {
    return this.#requestBackend(requestId, threadId)?.liveRequest(requestId) ?? null;
  }

  respondToServer(requestId, result, error = undefined, threadId = undefined) {
    const backend = this.#requestBackend(requestId, threadId);
    if (!backend) throw new OverdriveError(`Worker request is no longer live: ${requestId}`, 'REQUEST_ORPHANED');
    return backend.respondToServer(requestId, result, error);
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

// Reads only the public turn.error.message of a failed turn; a message holding a JSON error body
// yields its inner human-readable message.
export function turnFailureMessage(turn) {
  const message = turn?.status === 'failed' && typeof turn.error?.message === 'string' ? turn.error.message.trim() : '';
  let inner;
  try { inner = JSON.parse(message)?.error?.message; } catch { /* a plain-text message */ }
  return typeof inner === 'string' && inner.trim() ? inner.trim() : message;
}
