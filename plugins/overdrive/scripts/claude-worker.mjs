import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TREE_MARK, defaultContainment } from './process-tree.mjs';
import { OverdriveError, now, redactString, refusedRequest, run } from './util.mjs';

// Workers get no MCP servers, hooks, skills, plugins or browser integration; the OVERDRIVE
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
const TERMINATION_TIMEOUT_MS = 5_000;
const EXIT_DRAIN_MS = 1_000;
const STDERR_TAIL_CHARS = 8_000;
const DIAGNOSTIC_CHARS = 1_200;
const DIAGNOSTIC_STDERR_LINES = 12;
const CONTAINMENT_START_MS = 30_000;
const uncontainedNote = reason => `This worker ran without process-tree containment (${reason}), so tools it launched cannot be confirmed stopped. Checks, candidate recording, completion and the next turn wait until the coordinator verifies no process for this lane is running and records that with prior_turn_attestation.`;

function toolList(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || /[\r\n]/.test(item))) {
    throw new OverdriveError(`overdrive.json claude.${name} must be a list of tool patterns.`, 'INVALID_STATE');
  }
  return value.map(item => item.trim());
}

export function normalizeWorkerOptions(raw = {}) {
  const permissionMode = raw.permissionMode ?? DEFAULT_OPTIONS.permissionMode;
  if (!PERMISSION_MODES.has(permissionMode)) throw new OverdriveError(`overdrive.json claude.permissionMode must be one of ${[...PERMISSION_MODES].join(', ')}.`, 'INVALID_STATE');
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

// Auto-memory lives outside OVERDRIVE state and would carry notes across replaced sessions or
// reused checkouts, so it is forced off regardless of any inherited value or key casing.
export function workerEnvironment(env = process.env) {
  const inherited = Object.entries(env).filter(([key]) => !NESTED_SESSION_ENV.test(key) && key.toUpperCase() !== 'CLAUDE_CODE_DISABLE_AUTO_MEMORY');
  return { ...Object.fromEntries(inherited), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
}

// The Claude Code executable a worker launch would use: CLAUDE_CLI_PATH, then the PATH, then the
// native installer's ~/.local/bin location; null when none exists.
export function claudeExecutable() {
  const direct = process.env.CLAUDE_CLI_PATH;
  if (direct && fsSync.existsSync(direct)) return direct;
  const locator = process.platform === 'win32' ? ['where.exe', ['claude.exe', 'claude']] : ['which', ['claude']];
  const found = spawnSync(locator[0], locator[1], { encoding: 'utf8', windowsHide: true });
  const located = found.status === 0 ? found.stdout.split(/\r?\n/).map(line => line.trim()).find(candidate => candidate && fsSync.existsSync(candidate)) : undefined;
  if (located) return located;
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fsSync.existsSync(local) ? local : null;
}

function launchSpec(override) {
  if (override) return override;
  const command = claudeExecutable();
  return command ? { command, args: [] } : null;
}

function textOf(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
  return '';
}

function errorFieldText(value, depth = 0) {
  if (typeof value === 'string') return value.trim();
  if (depth > 3) return '';
  if (Array.isArray(value)) return value.slice(0, 10).map(item => errorFieldText(item, depth + 1)).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return errorFieldText(value.message ?? value.error, depth + 1);
  return '';
}

// Failure text reaches turn notifications and thread reads before the runtime sees it, so it is
// redacted here, always before it is clipped: a clip cannot expose part of a secret the
// redaction would have matched.
function boundedHead(text) {
  const safe = redactString(text);
  return safe.length > DIAGNOSTIC_CHARS ? `${safe.slice(0, DIAGNOSTIC_CHARS)} [truncated]` : safe;
}

// The last lines of captured stderr. A tail cut at the capture limit may start mid-line, so that
// partial line is dropped.
function stderrExcerpt(tail) {
  const lines = tail.split(/\r?\n/).slice(tail.length >= STDERR_TAIL_CHARS ? 1 : 0).map(line => line.trimEnd()).filter(line => line.trim());
  const safe = redactString(lines.slice(-DIAGNOSTIC_STDERR_LINES).join('\n'));
  return safe.length > DIAGNOSTIC_CHARS ? `[truncated] ${safe.slice(-DIAGNOSTIC_CHARS)}` : safe;
}

// A nonblank result string is the failure report; otherwise the reason can only be in error
// fields or on stderr. Only those are read, never transcript content.
export function failedResultDiagnostic(message, stderrTail = '') {
  if (typeof message.result === 'string' && message.result.trim()) return boundedHead(message.result.trim());
  const kind = typeof message.subtype === 'string' && /^[\w-]{1,40}$/.test(message.subtype) ? ` (${message.subtype})` : '';
  const fields = errorFieldText([message.errors, message.error]);
  if (fields) return `Claude Code reported a failed result${kind}: ${boundedHead(fields)}`;
  const stderr = stderrExcerpt(stderrTail);
  if (stderr) return `Claude Code reported a failed result${kind}; its stderr ended with:\n${stderr}`;
  return `Claude Code reported a failed result${kind} without diagnostic detail.`;
}

const exited = child => child.exitCode !== null || child.signalCode !== null;

function waitForExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(exited(child)); }, timeoutMs);
    child.once('exit', onExit);
  });
}

// Resolves once the stream has closed, or after timeoutMs.
function streamClosed(stream, timeoutMs) {
  if (!stream || stream.closed || stream.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); stream.off('close', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    stream.once('close', done);
  });
}

function runKiller({ command, args, env }, timeoutMs) {
  return new Promise(resolve => {
    let killer;
    try { killer = spawn(command, args, { windowsHide: true, stdio: 'ignore', shell: false, ...(env ? { env: { ...process.env, ...env } } : {}) }); } catch { resolve(false); return; }
    const timer = setTimeout(() => { killer.kill(); resolve(false); }, timeoutMs);
    killer.once('error', () => { clearTimeout(timer); resolve(false); });
    killer.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

function settledWithin(turn, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs, false);
    void turn.settled.then(() => { clearTimeout(timer); resolve(true); });
  });
}

const defaultTreeKill = pid => (process.platform === 'win32' ? { command: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'] } : null);

// Stops an uncontained worker and resolves true only once it has actually exited. taskkill /T
// is tried first so the tools Claude launched are stopped where it can reach them, but it walks
// parent PIDs and misses a tool whose parent already exited, so no uncontained stop confirms them.
// Only this child's PID is ever targeted, and never after it has exited.
async function terminateProcess(child, treeKill, timeoutMs) {
  if (!child || exited(child)) return true;
  const tree = treeKill(child.pid);
  if (tree && await runKiller(tree, timeoutMs) && await waitForExit(child, timeoutMs)) return true;
  if (exited(child)) return true;
  try { child.kill(); } catch { /* reported through the exit wait below */ }
  if (await waitForExit(child, timeoutMs)) return true;
  if (process.platform === 'win32') return false;
  try { child.kill('SIGKILL'); } catch { /* reported through the exit wait below */ }
  return await waitForExit(child, timeoutMs);
}

export class ClaudeWorkerBridge extends EventEmitter {
  // containment is the process-tree boundary (see process-tree.mjs); null runs every worker
  // uncontained, so no worker exit or stop can confirm the tools it launched.
  constructor({ launch, treeKill = defaultTreeKill, containment = defaultContainment(), terminationTimeoutMs = TERMINATION_TIMEOUT_MS, containmentStartMs = CONTAINMENT_START_MS } = {}) {
    super();
    this.launchOverride = launch;
    this.treeKill = treeKill;
    this.containment = containment;
    this.containmentUnavailable = null;
    this.containmentStartMs = containmentStartMs;
    this.terminationTimeoutMs = terminationTimeoutMs;
    this.launch = null;
    this.threads = new Map();
  }

  async ensureStarted() {
    if (this.launch) return;
    this.launch = launchSpec(this.launchOverride);
    if (!this.launch) throw new OverdriveError('Claude Code CLI not found. Install it or set CLAUDE_CLI_PATH.', 'CLAUDE_NOT_FOUND');
  }

  #thread(threadId) {
    const meta = this.threads.get(threadId);
    if (!meta) throw refusedRequest(new OverdriveError(`Claude worker session ${threadId} is not loaded; resume it first.`, 'THREAD_UNKNOWN'));
    return meta;
  }

  #register({ threadId, cwd, runtimeWorkspaceRoots = [], developerInstructions = '', model = null, effort = 'high', harnessOptions = {}, persisted }) {
    const existing = this.threads.get(threadId);
    // An in-flight turn and any lingering process keep the same session record.
    const meta = Object.assign(existing ?? {}, {
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
      lingering: existing?.lingering ?? null,
      updatedAt: now(),
    });
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

  // Model, permission policy and instructions are bound when a turn process launches, so a
  // loaded session takes the current settings before its next turn; a running turn is unaffected.
  async updateThread(params) {
    const meta = this.#register({ ...params, persisted: this.#thread(params.threadId).persisted });
    return { thread: { id: meta.id } };
  }

  // Loads a saved session so it can be read without launching a process. Turns from earlier
  // controllers are not replayed (their transcripts include private reasoning), and none runs here.
  async attachThread(params) {
    if (!this.threads.has(params.threadId)) this.#register({ ...params, persisted: true });
    return { thread: { id: params.threadId } };
  }

  async request(method, params = {}) {
    await this.ensureStarted().catch(error => { throw refusedRequest(error); });
    switch (method) {
      case 'turn/start': return await this.#startTurn(params);
      case 'turn/steer': return this.#steer(params);
      case 'turn/interrupt': return this.#interrupt(params);
      case 'thread/read': return this.#read(params);
      case 'thread/compact/start': return this.#compact(params);
      case 'thread/name/set': this.#thread(params.threadId).name = String(params.name ?? '').slice(0, 120); return {};
      default: throw new OverdriveError(`Claude workers do not support ${method}.`, 'UNSUPPORTED');
    }
  }

  liveRequest() { return null; }

  respondToServer(requestId) {
    throw new OverdriveError(`Claude workers answer permission prompts by policy; request ${requestId} is not live.`, 'REQUEST_ORPHANED');
  }

  // Stops every worker process this bridge still holds. Callers may ignore the result; it
  // resolves with the PIDs that did not exit, which are also written to stderr.
  shutdown() {
    const affected = [];
    const stopping = [];
    const stop = (child, termination) => stopping.push(termination.then(stopped => (stopped ? null : child.pid)));
    for (const meta of this.threads.values()) {
      const previous = meta.lingering;
      if (previous) stop(previous, this.#terminate(previous, meta.lingeringTurn).then(result => result.stopped));
      if (!meta.active) continue;
      affected.push(meta.id);
      const turn = meta.active;
      try { turn.child?.stdin?.end(); } catch { /* process already gone */ }
      stop(turn.process, this.#stop(turn));
    }
    this.threads.clear();
    if (affected.length) this.emit('exit', new OverdriveError('Claude worker bridge closed.', 'CLAUDE_CLOSED'), affected);
    return Promise.all(stopping).then(pids => {
      const unstopped = pids.filter(pid => pid !== null);
      if (unstopped.length) process.stderr.write(`[overdrive] Claude worker process(es) ${unstopped.join(', ')} did not exit on shutdown.\n`);
      return { unstopped };
    });
  }

  // Once an interrupt begins, only termination decides the turn: late output and a pending
  // steer grace period can no longer complete it.
  #stop(turn) {
    turn.interrupted = true;
    clearTimeout(turn.graceTimer);
    turn.termination ??= this.#terminate(turn.process, turn).then(({ stopped, confirmed }) => {
      if (stopped && confirmed) turn.treeStoppedGuardId = turn.guardId;
      else if (stopped) turn.descendantsUnconfirmed = true;
      return stopped;
    });
    return turn.termination;
  }

  // Resolves { stopped, confirmed }. A contained worker is stopped by terminating its job, which
  // also ends the warden; if that fails the warden itself is killed, and since it holds the job's
  // only handle the kernel then ends every process in the job. Only the job can confirm the tree:
  // the stop is confirmed once, after the warden exited, the job no longer exists or holds no process.
  async #terminate(child, turn) {
    if (!turn?.tree) return { stopped: await terminateProcess(child, this.treeKill, this.terminationTimeoutMs), confirmed: false };
    if (!exited(child)) {
      await runKiller(this.containment.stop(turn.tree.job), this.terminationTimeoutMs);
      if (!(await waitForExit(child, this.terminationTimeoutMs))) {
        try { child.kill(); } catch { /* reported through the exit wait below */ }
        if (!(await waitForExit(child, this.terminationTimeoutMs))) return { stopped: false, confirmed: false };
      }
    }
    return { stopped: true, confirmed: (await turn.settled) === 'confirmed' };
  }

  // A finished turn's process tree normally ends once the CLI's stdin closes. If it is still
  // running when the next turn starts it is given that chance, then stopped; two processes never
  // share a session. This guard is in memory only and does not survive a bridge restart. Resolves
  // with the process and turn IDs when the tree could not be confirmed stopped, so tools it
  // launched may still be running; otherwise null or the guard its confirmed stop cleared.
  async #settlePrevious(threadId) {
    const meta = this.#thread(threadId);
    if (meta.active) throw new OverdriveError(`Turn ${meta.active.id} is still active for ${threadId}.`, 'TURN_ACTIVE');
    const previous = meta.lingering;
    const turn = meta.lingeringTurn;
    if (!previous) return null;
    // A tree that ends by itself is reported through its own settlement.
    if (await settledWithin(turn, this.terminationTimeoutMs)) return null;
    const { stopped, confirmed } = await this.#terminate(previous, turn);
    if (stopped) return confirmed ? { treeStoppedGuardId: turn.guardId } : { orphaned: { pid: previous.pid, turnId: turn.id } };
    throw refusedRequest(new OverdriveError(`Claude worker process ${previous.pid} from an earlier turn is still running in ${meta.cwd} and could not be stopped; stop it before starting another turn.`, 'CLAUDE_STILL_RUNNING'));
  }

  // For a lifecycle stop, a process an ended turn left running must end together with the tools
  // it launched; stopping only the process itself is reported as unconfirmed.
  async settleThread({ threadId }) {
    if (!this.threads.has(threadId)) return;
    const settled = await this.#settlePrevious(threadId);
    const meta = this.#thread(threadId);
    if (settled?.orphaned) meta.unconfirmedDescendants = settled.orphaned;
    const unconfirmed = meta.unconfirmedDescendants;
    if (unconfirmed) throw new OverdriveError(`Claude worker process ${unconfirmed.pid} from an earlier turn was stopped, but its process tree could not be ended, so tools it launched may still be running.`, 'CLAUDE_DESCENDANTS_UNCONFIRMED', { turnId: unconfirmed.turnId });
    return { treeStoppedGuardId: settled?.treeStoppedGuardId ?? null };
  }

  acknowledgeDescendants({ threadId, turnId }) {
    const meta = this.threads.get(threadId);
    if (meta?.unconfirmedDescendants?.turnId === turnId) meta.unconfirmedDescendants = null;
  }

  #track(meta, child, turn) {
    meta.lingering = child;
    meta.lingeringTurn = turn;
    void turn.settled.then(() => { if (meta.lingering === child) { meta.lingering = null; meta.lingeringTurn = null; } });
  }

  async #startTurn({ threadId, input, effort, guardId = null }) {
    // Tools an earlier process may have left running are carried by this turn until it reports.
    const settled = await this.#settlePrevious(threadId);
    const meta = this.#thread(threadId);
    if (settled?.orphaned) meta.unconfirmedDescendants = settled.orphaned;
    if (meta.active) throw new OverdriveError(`Turn ${meta.active.id} is still active for ${threadId}.`, 'TURN_ACTIVE');
    meta.lingering = null;
    const turn = { id: `turn_${randomUUID()}`, guardId, status: 'inProgress', startedAt: now(), text: [], denials: [], pendingResults: 1, interrupted: false, child: null, process: null, tree: null, uncontained: null, cliExited: false, treeState: 'running', termination: null, descendantsUnconfirmed: Boolean(meta.unconfirmedDescendants), diffTimer: null, graceTimer: null, stderrTail: '', final: null, items: [] };
    turn.settled = new Promise(resolve => { turn.resolveSettled = resolve; });
    await this.#launch(meta, turn, { command: this.launch.command, args: [...this.launch.args, ...workerLaunchArgs(meta, effort || meta.effort)] });
    meta.active = turn;
    meta.turns = [...meta.turns, turn].slice(-RETAINED_TURNS);
    meta.updatedAt = now();
    // The new turn now carries this uncertainty into its completion record.
    meta.unconfirmedDescendants = null;
    // Recorded with the durable guard, so a later controller can prove the tree ended.
    if (turn.tree && guardId) this.emit('notification', { method: 'worker/contained', params: { threadId, guardId, job: turn.tree.job } });
    this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: turn.id, status: 'inProgress' } } });
    this.#send(turn, textOf(input));
    return { turn: { id: turn.id }, treeStoppedGuardId: settled?.treeStoppedGuardId ?? null };
  }

  // Starts the CLI under the containment warden, which reports on stderr once the job holds it.
  // If the warden cannot establish containment, the CLI never started under it and this bridge
  // falls back, for this and later turns, to uncontained workers that never confirm a tree.
  async #launch(meta, turn, cli) {
    const contained = this.containment && !this.containmentUnavailable ? this.containment.launch(cli, this.containment.jobName(turn.guardId ?? turn.id)) : null;
    if (contained) {
      const { job } = contained;
      const warden = this.#spawn(meta, turn, contained, contained.token);
      const started = await new Promise(resolve => {
        const finish = result => { if (!warden.startup) return; warden.startup = null; clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { try { warden.kill(); } catch { /* reported below */ } finish({ unavailable: `the warden did not start the worker within ${Math.round(this.containmentStartMs / 1000)}s` }); }, this.containmentStartMs);
        warden.startup = finish;
      });
      if (started === 'started') {
        turn.tree = { job };
        return;
      }
      // Not a refusal: a warden still running may yet start the CLI, so its guard must stay.
      if (!(await waitForExit(warden, this.terminationTimeoutMs))) throw new OverdriveError(`The Claude worker warden ${warden.pid} did not exit after failing to start; stop it before starting another turn.`, 'CLAUDE_STILL_RUNNING');
      if (started.launchFailed) throw refusedRequest(new OverdriveError(`Unable to launch the Claude worker: ${boundedHead(started.launchFailed)}`, 'CLAUDE_LAUNCH_FAILED'));
      this.containmentUnavailable = boundedHead(started.unavailable);
      process.stderr.write(`[overdrive] Claude worker process-tree containment is unavailable: ${this.containmentUnavailable}\n`);
    }
    turn.uncontained = this.containmentUnavailable
      ?? (this.containment ? `${path.basename(cli.command)} is not a native executable` : 'no process-tree containment is available on this platform');
    const child = this.#spawn(meta, turn, cli, null);
    turn.process = child;
    turn.child = child;
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => reject(refusedRequest(error)));
    });
  }

  // token: the containment warden's report token, or null for an uncontained CLI.
  #spawn(meta, turn, { command, args, env = {} }, token) {
    const contained = token !== null;
    const reportMark = `${TREE_MARK}${token} `;
    const child = spawn(command, args, { cwd: meta.cwd, env: { ...workerEnvironment(), ...env }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    // Output belongs to the turn once this is its process; a warden that failed to start the CLI has none.
    const current = () => turn.process === child || (!turn.process && !contained);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line || !current()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.#event(meta, turn, message);
      }
    });
    let wardenText = '';
    const stderrText = text => {
      if (current()) turn.stderrTail = (turn.stderrTail + text).slice(-STDERR_TAIL_CHARS);
      else wardenText = (wardenText + text).slice(-STDERR_TAIL_CHARS);
    };
    if (!contained) child.stderr.on('data', stderrText);
    else {
      // The warden's reports are whole lines, carrying its token, on the stderr it shares with the
      // CLI and its tools; anything else there is their output.
      let partial = '';
      child.stderr.on('data', chunk => {
        const lines = (partial + chunk).split('\n');
        partial = lines.pop();
        for (const line of lines) {
          const at = line.indexOf(reportMark);
          if (at < 0) { stderrText(`${line}\n`); continue; }
          if (at > 0) stderrText(`${line.slice(0, at)}\n`);
          this.#marker(meta, turn, child, line.slice(at + reportMark.length).trim());
        }
      });
      child.stderr.once('end', () => { if (partial) stderrText(partial); });
    }
    // A dead worker surfaces through its exit; a write to its closed stdin must not crash the host.
    child.stdin.on('error', () => {});
    child.on('error', error => {
      if (child.startup) return child.startup({ unavailable: error.message });
      // Before spawn this is a launch failure; afterwards it is a failed kill, which termination reports.
      if (child.pid === undefined && current()) {
        turn.resolveSettled('unconfirmed');
        void this.#finish(meta, turn, 'failed', `Unable to launch the Claude worker: ${boundedHead(error.message)}`);
      }
    });
    child.once('exit', code => {
      const settle = () => {
        child.startup?.({ unavailable: `the warden exited (${code}) before starting the worker${wardenText.trim() ? `: ${stderrExcerpt(wardenText)}` : ''}` });
        if (turn.process !== child) return;
        if (!contained) this.#cliExited(meta, turn, child, code);
        void this.#settleTree(meta, turn, child, code);
      };
      // A warden's reports, read from stderr, can arrive after its exit.
      if (contained) void streamClosed(child.stderr, EXIT_DRAIN_MS).then(settle);
      else settle();
    });
    return child;
  }

  #marker(meta, turn, child, report) {
    const [kind, ...rest] = report.split(' ');
    const detail = rest.join(' ');
    if (kind === 'started' && child.startup) {
      turn.process = child;
      turn.child = child;
      child.startup('started');
    } else if (kind === 'launch-failed' || kind === 'unavailable') {
      child.startup?.(kind === 'launch-failed' ? { launchFailed: detail } : { unavailable: detail });
    } else if (kind === 'exit' && turn.process === child) {
      this.#cliExited(meta, turn, child, Number(detail));
    }
  }

  // The CLI itself has exited; the tools it launched may still be running.
  #cliExited(meta, turn, child, code) {
    if (turn.cliExited) return;
    turn.cliExited = true;
    // stdout can still hold the final result when the process exits; let it drain briefly.
    const settle = () => {
      if (turn.status !== 'inProgress') return;
      // An interrupted turn is decided by its termination, even while a failed result waits for
      // stderr; that result's redacted diagnostic is kept. Otherwise the failed result's own
      // finish waits for stderr.
      if (turn.interrupted) return this.#finishInterrupted(meta, turn);
      if (turn.failedResult) return;
      void this.#finish(meta, turn, 'failed', `Claude worker exited (${code}) before completing the turn. ${stderrExcerpt(turn.stderrTail)}`.trim());
    };
    if (child.stdout.readableEnded) return settle();
    const timer = setTimeout(settle, EXIT_DRAIN_MS);
    child.stdout.once('end', () => { clearTimeout(timer); settle(); });
  }

  // Runs once the turn's process has exited: the warden, which normally outlives every process in
  // its job, or an uncontained CLI, whose tools can never be confirmed stopped. The warden's own
  // reports do not decide this: the tree has ended only if its job is gone or holds no process.
  async #settleTree(meta, turn, child, code) {
    let state = 'unconfirmed';
    if (turn.tree) {
      // A warden that reported no CLI exit was itself ended, and the job with it.
      this.#cliExited(meta, turn, child, code);
      if (['absent', 'empty'].includes(await this.containment.query(turn.tree.job))) state = 'confirmed';
    }
    turn.treeState = state;
    turn.resolveSettled(state);
    this.#reportCleanExit(meta, turn);
  }

  #send(turn, text) {
    if (!turn.child?.stdin?.writable) throw new OverdriveError('The Claude worker process is not accepting input.', 'CLAUDE_NOT_RUNNING');
    turn.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`);
  }

  #steer({ threadId, expectedTurnId, input }) {
    const meta = this.#thread(threadId);
    const turn = meta.active;
    if (!turn || turn.id !== expectedTurnId || turn.interrupted || turn.failedResult) throw new OverdriveError(`Turn ${expectedTurnId} is no longer active.`, 'TURN_MISMATCH');
    turn.pendingResults += 1;
    clearTimeout(turn.graceTimer);
    this.#send(turn, textOf(input));
    return { turnId: turn.id };
  }

  // Reports success only after the worker process has exited. If it cannot be stopped the
  // turn fails visibly and the next turn start must stop that process first.
  async #interrupt({ threadId, turnId }) {
    const meta = this.#thread(threadId);
    const turn = meta.active;
    if (!turn || turn.id !== turnId) return { interrupted: false };
    const pid = turn.process.pid;
    if (await this.#stop(turn)) return { interrupted: true, ...(turn.descendantsUnconfirmed ? { descendantsUnconfirmed: true } : {}), ...(turn.treeStoppedGuardId ? { treeStoppedGuardId: turn.treeStoppedGuardId } : {}) };
    const message = `Interrupt could not stop Claude worker process ${pid}; it may still be running in ${meta.cwd}. The next turn start retries stopping it.`;
    await this.#finish(meta, turn, 'failed', message);
    throw new OverdriveError(message, 'CLAUDE_TERMINATION_FAILED');
  }

  #read({ threadId }) {
    const meta = this.#thread(threadId);
    return {
      thread: {
        id: meta.id,
        name: meta.name,
        cwd: meta.cwd,
        status: meta.active ? 'active' : meta.turns.length || !meta.persisted ? 'idle' : 'unknown',
        updatedAt: meta.updatedAt,
        // Only turns run by this bridge are held; a session loaded by resume or attach has no
        // earlier history here, which is reported rather than shown as an empty transcript.
        history: meta.turns.length || !meta.persisted ? 'controller' : 'unavailable',
        turns: meta.turns.map(turn => ({ id: turn.id, status: turn.status, items: turn.status === 'inProgress' ? turn.text.map(text => ({ type: 'agentMessage', text })) : turn.items, ...(turn.descendantsUnconfirmed ? { descendantsUnconfirmed: true } : {}) })),
      },
    };
  }

  // Claude Code compacts its own context; the OVERDRIVE checkpoint is the durable boundary,
  // so a compaction request is acknowledged without a model call.
  #compact({ threadId }) {
    const meta = this.#thread(threadId);
    if (meta.active) throw new OverdriveError(`Turn ${meta.active.id} is active; compaction must wait.`, 'TURN_ACTIVE');
    const turnId = `compact_${randomUUID()}`;
    setImmediate(() => {
      this.emit('notification', { method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });
      this.emit('notification', { method: 'thread/compacted', params: { threadId, turnId } });
      this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [] } } });
    });
    return {};
  }

  #event(meta, turn, message) {
    if (turn.status !== 'inProgress' || turn.interrupted || turn.failedResult) return;
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
      if (failed) {
        this.#finishFailedResult(meta, turn, message);
        return;
      }
      if (turn.pendingResults <= 0) {
        void this.#finish(meta, turn, 'completed');
        return;
      }
      // A steer was queued; the CLI normally starts a new response for it. If nothing
      // follows, the queued message was folded into this response and the turn is done.
      turn.graceTimer = setTimeout(() => { if (!turn.interrupted) void this.#finish(meta, turn, 'completed'); }, RESULT_GRACE_MS);
    }
  }

  // A nonblank result string is the whole failure report. Otherwise the diagnostic precedes the
  // turn's visible text. Without a reason in error fields it comes from stderr, which may still be
  // arriving, so the worker's input is closed and the turn ends once stderr closes or after a short
  // bound; steering is refused meanwhile. The turn fails and is not retried, unless an interrupt
  // begins during that wait: then, as for any interrupt, termination decides the turn.
  #finishFailedResult(meta, turn, message) {
    clearTimeout(turn.graceTimer);
    if (typeof message.result === 'string' && message.result.trim()) return void this.#finish(meta, turn, 'failed', failedResultDiagnostic(message));
    const failWith = () => void this.#finish(meta, turn, 'failed', [failedResultDiagnostic(message, turn.stderrTail), ...turn.text].join('\n'));
    if (errorFieldText([message.errors, message.error])) return failWith();
    turn.failedResult = message;
    const child = turn.child;
    const stderr = child?.stderr;
    let timer;
    const done = () => {
      clearTimeout(timer);
      stderr?.off('close', done);
      if (!turn.interrupted) return failWith();
      // If the worker exited first, its exit handler has already passed this turn by.
      if (turn.cliExited) this.#finishInterrupted(meta, turn);
    };
    if (!stderr || stderr.readableEnded || stderr.destroyed) return done();
    timer = setTimeout(done, EXIT_DRAIN_MS);
    stderr.once('close', done);
    try { turn.child.stdin.end(); } catch { /* process already gone */ }
  }

  // An interrupted turn keeps the redacted diagnostic of a failed result it was still waiting on.
  // It ends once termination has decided whether its tools are confirmed stopped.
  #finishInterrupted(meta, turn) {
    void Promise.resolve(turn.termination).then(() => this.#finish(meta, turn, 'interrupted', turn.failedResult ? redactString([failedResultDiagnostic(turn.failedResult, turn.stderrTail), ...turn.text].join('\n')) : undefined));
  }

  #scheduleDiff(meta, turn) {
    if (turn.diffTimer) return;
    turn.diffTimer = setTimeout(async () => {
      turn.diffTimer = null;
      const patch = await this.#workingPatch(meta).catch(() => null);
      if (patch && turn.status === 'inProgress') this.emit('notification', { method: 'turn/diff/updated', params: { threadId: meta.id, turnId: turn.id, diff: patch } });
    }, DIFF_DEBOUNCE_MS);
  }

  // Clears the durable guard only once the turn has ended and its whole process tree is confirmed
  // stopped; the CLI's own exit proves nothing about the tools it launched.
  #reportCleanExit(meta, turn) {
    if (turn.status === 'inProgress' || turn.treeState !== 'confirmed' || turn.descendantsUnconfirmed || !turn.guardId || turn.cleanExitReported) return;
    turn.cleanExitReported = true;
    this.emit('notification', { method: 'worker/exited', params: { threadId: meta.id, guardId: turn.guardId } });
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
    const child = turn.child;
    if (turn.process?.pid !== undefined && turn.treeState === 'running') this.#track(meta, turn.process, turn);
    try { child?.stdin?.end(); } catch { /* process already gone */ }
    const patch = await this.#workingPatch(meta).catch(() => null);
    if (patch) this.emit('notification', { method: 'turn/diff/updated', params: { threadId: meta.id, turnId: turn.id, diff: patch } });
    const items = [];
    const text = failureText ?? turn.final ?? turn.text.join('\n');
    // Failure text is bounded where it is produced; any failed-turn text is redacted here too.
    if (text) items.push({ type: 'agentMessage', text: status === 'failed' ? redactString(text) : text });
    if (turn.descendantsUnconfirmed && status === 'interrupted') items.push({ type: 'agentMessage', text: 'The worker process tree could not be ended as a whole, so only the worker process itself was terminated; tools it launched may still be running.' });
    if (turn.denials.length) items.push({ type: 'agentMessage', text: `Worker permission policy denied ${turn.denials.length} tool call(s): ${[...new Set(turn.denials)].join(', ')}. Route those needs through the coordinator.` });
    if (turn.uncontained && status === 'completed') items.push({ type: 'agentMessage', text: uncontainedNote(turn.uncontained) });
    turn.items = items;
    turn.text = [];
    turn.child = null;
    this.emit('notification', { method: 'turn/completed', params: { threadId: meta.id, turn: { id: turn.id, status, items, ...(turn.descendantsUnconfirmed ? { descendantsUnconfirmed: true } : {}) } } });
    this.#reportCleanExit(meta, turn);
  }
}
