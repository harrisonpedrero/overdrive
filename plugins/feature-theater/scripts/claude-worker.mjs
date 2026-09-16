import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TheaterError, now, run } from './util.mjs';

// Workers get no MCP servers, hooks, skills, plugins or browser integration; the Theater
// coordinator therefore cannot be called recursively from a lane.
export const ISOLATION_ARGS = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-chrome'];
const NESTED_SESSION_ENV = /^(?:CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(?:CHILD_SESSION|SESSION_ID|HOST_SESSION_ID|MESSAGING_SOCKET|MESSAGING_TOKEN|ENTRYPOINT|SESSION_ATTENDED))$/;
const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']);
const EFFORTS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'max' };
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']);
const DEFAULT_OPTIONS = Object.freeze({
  permissionMode: 'acceptEdits',
  allowedTools: ['Bash', 'PowerShell'],
  disallowedTools: ['Bash(git push:*)', 'Bash(gh pr:*)', 'WebFetch', 'WebSearch'],
});
const RETAINED_TURNS = 4;
const DIFF_DEBOUNCE_MS = 4_000;
const RESULT_GRACE_MS = 15_000;

function toolList(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || /[\r\n]/.test(item))) {
    throw new TheaterError(`theater.json claude.${name} must be a list of tool patterns.`, 'INVALID_STATE');
  }
  return value.map(item => item.trim());
}

export function normalizeWorkerOptions(raw = {}) {
  const permissionMode = raw.permissionMode ?? DEFAULT_OPTIONS.permissionMode;
  if (!PERMISSION_MODES.has(permissionMode)) throw new TheaterError(`theater.json claude.permissionMode must be one of ${[...PERMISSION_MODES].join(', ')}.`, 'INVALID_STATE');
  return {
    permissionMode,
    allowedTools: toolList(raw.allowedTools, 'allowedTools') ?? DEFAULT_OPTIONS.allowedTools,
    disallowedTools: toolList(raw.disallowedTools, 'disallowedTools') ?? DEFAULT_OPTIONS.disallowedTools,
  };
}

export function workerLaunchArgs(meta, effort) {
  const options = meta.options;
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', meta.persisted ? '--resume' : '--session-id', meta.id];
  if (meta.model) args.push('--model', meta.model);
  if (effort && EFFORTS[effort]) args.push('--effort', EFFORTS[effort]);
  args.push('--permission-mode', options.permissionMode);
  if (options.permissionMode === 'bypassPermissions') args.push('--allow-dangerously-skip-permissions');
  if (options.allowedTools.length) args.push('--allowedTools', ...options.allowedTools);
  if (options.disallowedTools.length) args.push('--disallowedTools', ...options.disallowedTools);
  args.push(...ISOLATION_ARGS);
  for (const dir of meta.addDirs) args.push('--add-dir', dir);
  if (meta.developerInstructions) args.push('--append-system-prompt', meta.developerInstructions);
  if (meta.name && !meta.persisted) args.push('--name', meta.name);
  return args;
}

export function workerEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !NESTED_SESSION_ENV.test(key)));
}

function launchSpec(override) {
  if (override) return override;
  const direct = process.env.CLAUDE_CLI_PATH;
  if (direct && fsSync.existsSync(direct)) return { command: direct, args: [] };
  const locator = process.platform === 'win32' ? ['where.exe', ['claude.exe', 'claude']] : ['which', ['claude']];
  const found = spawnSync(locator[0], locator[1], { encoding: 'utf8', windowsHide: true });
  const located = found.status === 0 ? found.stdout.split(/\r?\n/).map(line => line.trim()).find(candidate => candidate && fsSync.existsSync(candidate)) : undefined;
  if (located) return { command: located, args: [] };
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fsSync.existsSync(local)) return { command: local, args: [] };
  return null;
}

function textOf(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  return '';
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('error', () => child.kill());
    return;
  }
  child.kill('SIGTERM');
}

export class ClaudeWorkerBridge extends EventEmitter {
  constructor({ launch } = {}) {
    super();
    this.launchOverride = launch;
    this.launch = null;
    this.threads = new Map();
  }

  async ensureStarted() {
    if (this.launch) return;
    this.launch = launchSpec(this.launchOverride);
    if (!this.launch) throw new TheaterError('Claude Code CLI not found. Install it or set CLAUDE_CLI_PATH.', 'CLAUDE_NOT_FOUND');
  }

  #thread(threadId) {
    const meta = this.threads.get(threadId);
    if (!meta) throw new TheaterError(`Claude worker session ${threadId} is not loaded; resume it first.`, 'THREAD_UNKNOWN');
    return meta;
  }

  #register({ threadId, cwd, runtimeWorkspaceRoots = [], developerInstructions = '', model = null, effort = 'high', harnessOptions = {}, persisted }) {
    const existing = this.threads.get(threadId);
    const meta = {
      id: threadId,
      cwd,
      addDirs: runtimeWorkspaceRoots.filter(root => root && path.resolve(root) !== path.resolve(cwd)),
      developerInstructions,
      model: model || null,
      effort,
      options: normalizeWorkerOptions(harnessOptions),
      name: existing?.name ?? null,
      persisted: existing?.persisted || persisted,
      turns: existing?.turns ?? [],
      active: existing?.active ?? null,
      updatedAt: now(),
    };
    this.threads.set(threadId, meta);
    return meta;
  }

  async startThread(params) {
    await this.ensureStarted();
    const meta = this.#register({ ...params, threadId: randomUUID(), persisted: false });
    return { thread: { id: meta.id }, requestedEffort: params.effort };
  }

  async resumeThread(params) {
    await this.ensureStarted();
    const meta = this.#register({ ...params, persisted: true });
    return { thread: { id: meta.id } };
  }

  async request(method, params = {}) {
    await this.ensureStarted();
    switch (method) {
      case 'turn/start': return await this.#startTurn(params);
      case 'turn/steer': return this.#steer(params);
      case 'turn/interrupt': return this.#interrupt(params);
      case 'thread/read': return this.#read(params);
      case 'thread/compact/start': return this.#compact(params);
      case 'thread/name/set': this.#thread(params.threadId).name = String(params.name ?? '').slice(0, 120); return {};
      default: throw new TheaterError(`Claude workers do not support ${method}.`, 'UNSUPPORTED');
    }
  }

  liveRequest() { return null; }

  respondToServer(requestId) {
    throw new TheaterError(`Claude workers answer permission prompts by policy; request ${requestId} is not live.`, 'REQUEST_ORPHANED');
  }

  shutdown() {
    const affected = [];
    for (const meta of this.threads.values()) {
      if (!meta.active) continue;
      affected.push(meta.id);
      meta.active.interrupted = true;
      killTree(meta.active.child);
    }
    this.threads.clear();
    if (affected.length) this.emit('exit', new TheaterError('Claude worker bridge closed.', 'CLAUDE_CLOSED'), affected);
  }

  async #startTurn({ threadId, input, effort }) {
    const meta = this.#thread(threadId);
    if (meta.active) throw new TheaterError(`Turn ${meta.active.id} is still active for ${threadId}.`, 'TURN_ACTIVE');
    const turn = { id: `turn_${randomUUID()}`, status: 'inProgress', startedAt: now(), text: [], denials: [], pendingResults: 1, interrupted: false, child: null, diffTimer: null, graceTimer: null, stderrTail: '', final: null, items: [] };
    const args = [...this.launch.args, ...workerLaunchArgs(meta, effort || meta.effort)];
    const child = spawn(this.launch.command, args, { cwd: meta.cwd, env: workerEnvironment(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    turn.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.#event(meta, turn, message);
      }
    });
    child.stderr.on('data', chunk => { turn.stderrTail = (turn.stderrTail + chunk).slice(-8_000); });
    child.once('error', error => { void this.#finish(meta, turn, 'failed', `Unable to launch the Claude worker: ${error.message}`); });
    child.once('exit', code => {
      if (turn.status !== 'inProgress') return;
      void this.#finish(meta, turn, turn.interrupted ? 'interrupted' : 'failed', turn.interrupted ? undefined : `Claude worker exited (${code}) before completing the turn. ${turn.stderrTail.trim()}`.trim());
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    meta.active = turn;
    meta.turns = [...meta.turns, turn].slice(-RETAINED_TURNS);
    meta.updatedAt = now();
    this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: turn.id, status: 'inProgress' } } });
    this.#send(turn, textOf(input));
    return { turn: { id: turn.id } };
  }

  #send(turn, text) {
    if (!turn.child?.stdin?.writable) throw new TheaterError('The Claude worker process is not accepting input.', 'CLAUDE_NOT_RUNNING');
    turn.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
  }

  #steer({ threadId, expectedTurnId, input }) {
    const meta = this.#thread(threadId);
    const turn = meta.active;
    if (!turn || turn.id !== expectedTurnId) throw new TheaterError(`Turn ${expectedTurnId} is no longer active.`, 'TURN_MISMATCH');
    turn.pendingResults += 1;
    clearTimeout(turn.graceTimer);
    this.#send(turn, textOf(input));
    return { turnId: turn.id };
  }

  #interrupt({ threadId, turnId }) {
    const meta = this.#thread(threadId);
    const turn = meta.active;
    if (!turn || turn.id !== turnId) return { interrupted: false };
    turn.interrupted = true;
    killTree(turn.child);
    return { interrupted: true };
  }

  #read({ threadId }) {
    const meta = this.#thread(threadId);
    return {
      thread: {
        id: meta.id,
        name: meta.name,
        cwd: meta.cwd,
        status: meta.active ? 'active' : 'idle',
        updatedAt: meta.updatedAt,
        turns: meta.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.status === 'inProgress' ? turn.text.map(text => ({ type: 'agentMessage', text })) : turn.items })),
      },
    };
  }

  // Claude Code compacts its own context; the Theater checkpoint is the durable boundary,
  // so a compaction request is acknowledged without a model call.
  #compact({ threadId }) {
    const meta = this.#thread(threadId);
    if (meta.active) throw new TheaterError(`Turn ${meta.active.id} is active; compaction must wait.`, 'TURN_ACTIVE');
    const turnId = `compact_${randomUUID()}`;
    setImmediate(() => {
      this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      this.emit('notification', { method: 'thread/compacted', params: { threadId, turnId } });
      this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
    });
    return {};
  }

  #event(meta, turn, message) {
    if (turn.status !== 'inProgress') return;
    if (message.type === 'system' && message.subtype === 'init') {
      meta.persisted = true;
      clearTimeout(turn.graceTimer);
      return;
    }
    if (message.type === 'assistant') {
      clearTimeout(turn.graceTimer);
      for (const block of message.message?.content ?? []) {
        // Thinking blocks are private reasoning and are never forwarded or stored.
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          turn.text.push(block.text);
          this.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: meta.id, turnId: turn.id, delta: `${block.text}\n` } });
        } else if (block?.type === 'tool_use' && EDITING_TOOLS.has(block.name)) {
          this.#scheduleDiff(meta, turn);
        }
      }
      return;
    }
    if (message.type === 'result') {
      turn.pendingResults -= 1;
      for (const denial of Array.isArray(message.permission_denials) ? message.permission_denials : []) {
        if (typeof denial?.tool_name === 'string') turn.denials.push(denial.tool_name);
      }
      turn.final = typeof message.result === 'string' ? message.result : null;
      const failed = message.is_error === true || (message.subtype && message.subtype !== 'success');
      if (turn.pendingResults <= 0 || failed) {
        void this.#finish(meta, turn, failed ? 'failed' : 'completed');
        return;
      }
      // A steer was queued; the CLI normally starts a new response for it. If nothing
      // follows, the queued message was folded into this response and the turn is done.
      turn.graceTimer = setTimeout(() => { void this.#finish(meta, turn, 'completed'); }, RESULT_GRACE_MS);
    }
  }

  #scheduleDiff(meta, turn) {
    if (turn.diffTimer) return;
    turn.diffTimer = setTimeout(async () => {
      turn.diffTimer = null;
      const patch = await this.#workingPatch(meta).catch(() => null);
      if (patch && turn.status === 'inProgress') this.emit('notification', { method: 'turn/diff/updated', params: { threadId: meta.id, turnId: turn.id, diff: patch } });
    }, DIFF_DEBOUNCE_MS);
  }

  async #workingPatch(meta) {
    const options = { cwd: meta.cwd, allowFailure: true, timeoutMs: 60_000, maxOutput: 2_000_000 };
    const tracked = await run(['git', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--'], options);
    if (tracked.exitCode !== 0) return null;
    const untracked = await run(['git', 'ls-files', '--others', '--exclude-standard'], options);
    let patch = tracked.stdout;
    for (const file of untracked.stdout.split(/\r?\n/).filter(Boolean).slice(0, 50)) {
      const piece = await run(['git', 'diff', '--no-index', '--no-color', '--', '/dev/null', file], { ...options, maxOutput: 200_000 });
      if (piece.stdout) patch += `\n${piece.stdout}`;
    }
    return patch.trim() ? patch : null;
  }

  async #finish(meta, turn, status, failureText) {
    if (turn.status !== 'inProgress') return;
    turn.status = status;
    turn.completedAt = now();
    clearTimeout(turn.diffTimer);
    clearTimeout(turn.graceTimer);
    turn.diffTimer = null;
    if (meta.active === turn) meta.active = null;
    meta.updatedAt = now();
    try { turn.child?.stdin?.end(); } catch { /* process already gone */ }
    const patch = await this.#workingPatch(meta).catch(() => null);
    if (patch) this.emit('notification', { method: 'turn/diff/updated', params: { threadId: meta.id, turnId: turn.id, diff: patch } });
    const items = [];
    const text = failureText ?? turn.final ?? turn.text.join('\n');
    if (text) items.push({ type: 'agentMessage', text });
    if (turn.denials.length) items.push({ type: 'agentMessage', text: `Worker permission policy denied ${turn.denials.length} tool call(s): ${[...new Set(turn.denials)].join(', ')}. Route those needs through the coordinator.` });
    turn.items = items;
    turn.text = [];
    turn.child = null;
    this.emit('notification', { method: 'turn/completed', params: { threadId: meta.id, turn: { id: turn.id, status, items } } });
  }
}
