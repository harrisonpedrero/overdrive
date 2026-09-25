import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export class OverdriveError extends Error {
  constructor(message, code = 'OVERDRIVE_ERROR', details = undefined) {
    super(message);
    this.name = 'OverdriveError';
    this.code = code;
    this.details = details;
  }
}

// Marks a worker request error that proves the requested work never began: the request failed
// before reaching its backend or the backend explicitly refused it. Timeouts and lost
// connections stay unmarked because the backend may already be doing the work.
export function refusedRequest(error) {
  error.refused = true;
  return error;
}

export const STATE_DIR = '.overdrive';
export const CONFIG_FILE = 'overdrive.json';

export const now = () => new Date().toISOString();
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function requiredText(value, name, { max = 200_000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new OverdriveError(`${name} is required.`, 'INVALID_INPUT');
  if (value.length > max) throw new OverdriveError(`${name} is too long.`, 'INVALID_INPUT');
  if (value.includes('\0')) throw new OverdriveError(`${name} contains a null byte.`, 'INVALID_INPUT');
  return value.trim();
}

export function optionalText(value, name, options) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, name, options);
}

const RESERVED_NAMES = new Set([
  'archive', 'aux', 'cache', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'con', 'coordinator', 'features', 'integration', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9', 'nul',
  'paused', 'prn', 'runtime', 'overdrive', 'tmp',
]);

export function safeSlug(value, name = 'feature') {
  const slug = requiredText(value, name, { max: 63 }).toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug) || slug.includes('--') || RESERVED_NAMES.has(slug)) {
    throw new OverdriveError(`${name} must start with a letter and use lowercase letters, digits, or single hyphens.`, 'INVALID_SLUG');
  }
  return slug;
}

export function contained(root, ...parts) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new OverdriveError('A managed path would escape the workspace.', 'PATH_ESCAPE');
  }
  return target;
}

const LEGACY_STATE_DIR = '.theater';
const LEGACY_CONFIG_FILE = 'theater.json';
const LEGACY_TEXT = [[/\.theater\//g, `${STATE_DIR}/`], [/\btheater\.json\b/g, CONFIG_FILE], [/feature-theater skill/g, 'overdrive skill'], [/# Feature Theater coordinator/g, '# OVERDRIVE coordinator']];

async function pathExists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return await fs.rename(from, to); } catch (error) {
      // Another opener finished the same move first.
      if (error?.code === 'ENOENT' && await pathExists(to)) return;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt >= 8) {
        throw new OverdriveError(`Could not move ${from} to ${to}: ${error.message}. Close other sessions using this workspace and retry.`, 'WORKSPACE_BUSY');
      }
      await sleep(100 * (attempt + 1));
    }
  }
}

// Workspaces created before the rename keep their state: the state directory moves first and the
// configuration last, because configuration presence marks an initialized workspace.
export async function migrateLegacyWorkspace(root) {
  const [legacyState, state, legacyConfig, config] = [LEGACY_STATE_DIR, STATE_DIR, LEGACY_CONFIG_FILE, CONFIG_FILE].map(name => path.join(root, name));
  const [hasLegacyState, hasLegacyConfig] = await Promise.all([pathExists(legacyState), pathExists(legacyConfig)]);
  if (!hasLegacyState && !hasLegacyConfig) return false;
  for (const [legacy, current, present] of [[legacyState, state, hasLegacyState], [legacyConfig, config, hasLegacyConfig]]) {
    if (present && await pathExists(current)) {
      throw new OverdriveError(`Both ${path.basename(legacy)} and ${path.basename(current)} exist in ${root}. Keep the one holding current state and move the other aside.`, 'MIGRATION_CONFLICT');
    }
  }
  if (hasLegacyState) await renameWithRetry(legacyState, state);
  if (hasLegacyConfig) await renameWithRetry(legacyConfig, config);
  for (const name of ['.gitignore', 'AGENTS.md']) {
    const file = path.join(root, name);
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    const updated = LEGACY_TEXT.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
    if (updated !== text) await fs.writeFile(file, updated, 'utf8');
  }
  return true;
}

export async function resolveWorkspace(value) {
  const supplied = requiredText(value, 'workspace_path', { max: 4_096 });
  const absolute = path.resolve(supplied);
  let root;
  try {
    root = await fs.realpath(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new OverdriveError(`Workspace does not exist: ${absolute}`, 'WORKSPACE_NOT_FOUND');
    throw error;
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new OverdriveError('workspace_path must be a directory.', 'INVALID_WORKSPACE');
  await migrateLegacyWorkspace(root);
  return root;
}

export async function ensureManagedPath(root, target) {
  const resolved = contained(root, path.relative(path.resolve(root), path.resolve(target)));
  let cursor = path.resolve(root);
  const relative = path.relative(cursor, resolved);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new OverdriveError(`Managed path contains a symlink or junction: ${cursor}`, 'UNSAFE_PATH');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

export async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new OverdriveError(`Invalid JSON in ${file}.`, 'INVALID_STATE');
    throw error;
  }
}

export async function atomicWrite(root, file, content) {
  await ensureManagedPath(root, file);
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  await ensureManagedPath(root, temp);
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error) {
        // Windows can briefly deny replacement while another writer holds the destination.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt === 5) throw error;
        await sleep(10 * 2 ** attempt);
      }
    }
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function writeJson(root, file, value) {
  await atomicWrite(root, file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function exists(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function commandDescription(argv) {
  return argv.map(part => (/^[a-zA-Z0-9_./:@\\=-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

// On Windows a timed-out command's process tree is ended with taskkill /T; when taskkill cannot
// run, fails or stalls, the command itself is terminated directly, which cannot reach processes it
// started. The result waits for taskkill's outcome, and settles within two grace periods of the
// deadline even if a surviving process keeps the output open. A tree not confirmed stopped is
// named as terminationUncertain in a timed-out result or in the COMMAND_FAILED message; with
// confirmTermination it rejects with COMMAND_TERMINATION_UNCERTAIN instead. Only this child's PID
// is ever targeted, and never after it has exited.
export async function run(argv, { cwd, env = process.env, timeoutMs = 20 * 60_000, maxOutput = 2_000_000, allowFailure = false, rawOutput = false, confirmTermination = false, terminationGraceMs = 10_000 } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(part => typeof part !== 'string' || part.includes('\0'))) {
    throw new OverdriveError('Command arguments are invalid.', 'INVALID_COMMAND');
  }
  if (process.platform === 'win32' && /^(npm|npx|pnpm|yarn)(\.cmd)?$/i.test(argv[0])) {
    const manager = argv[0].replace(/\.cmd$/i, '').toLowerCase();
    const found = spawnSync('where.exe', [`${manager}.cmd`], { encoding: 'utf8', windowsHide: true });
    const folder = found.status === 0 ? path.dirname(found.stdout.trim().split(/\r?\n/)[0]) : null;
    const candidates = folder ? [
      path.join(folder, 'node_modules', 'npm', 'bin', `${manager}-cli.js`),
      path.join(folder, 'node_modules', 'corepack', 'dist', `${manager}.js`),
      path.join(folder, 'node_modules', manager, 'bin', `${manager}.cjs`),
      path.join(folder, 'node_modules', manager, 'bin', `${manager}.js`),
    ] : [];
    const script = candidates.find(candidate => fsSync.existsSync(candidate));
    if (script) argv = [process.execPath, script, ...argv.slice(1)];
  }
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const collect = (current, chunk) => {
      if (current.length >= maxOutput) {
        overflow = true;
        return current;
      }
      const next = current + chunk.toString();
      if (next.length > maxOutput) overflow = true;
      return next.slice(0, maxOutput);
    };
    child.stdout.on('data', chunk => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = collect(stderr, chunk); });
    let timedOut = false;
    let unconfirmed = null;
    let killing = false;
    let closed = null;
    let settled = false;
    let closeDeadline = null;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const uncertain = reason => new OverdriveError(`${commandDescription(argv)} passed its deadline and ${reason}; processes it started may still be running.`, 'COMMAND_TERMINATION_UNCERTAIN',
      { pid: child.pid, commandExited: exited(), output: `${stdout}\n${stderr}`.trim().slice(-4_000) });
    const stopDirectly = reason => {
      unconfirmed ??= reason;
      if (!exited()) { try { child.kill(); } catch { /* reported by the close deadline */ } }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
        return;
      }
      closeDeadline = setTimeout(() => settle(`did not close within ${Math.ceil(2 * terminationGraceMs / 1000)}s of it (${unconfirmed ?? 'taskkill did not stop it'})`), 2 * terminationGraceMs);
      // Output still open after the command exited means a descendant holds it, and that tree can no
      // longer be targeted safely through a PID that may have been reused.
      if (exited()) { unconfirmed ??= 'had already exited while its output stayed open, so its process tree could not be targeted'; return; }
      killing = true;
      const killed = reason => { clearTimeout(stalled); killing = false; if (reason) stopDirectly(reason); settle(); };
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      const stalled = setTimeout(() => { killer.kill(); killed('taskkill did not finish'); }, terminationGraceMs);
      killer.once('error', error => killed(`taskkill could not run (${error.message})`));
      killer.once('exit', code => killed(code === 0 ? null : `taskkill exited ${code ?? 'without a code'}`));
    }, timeoutMs);
    child.on('error', error => {
      // A failed direct termination emits here too; the close deadline reports that command.
      if (process.platform === 'win32' && timedOut && child.pid !== undefined) { unconfirmed ??= `stopping it failed (${error.message})`; return; }
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeDeadline);
      reject(new OverdriveError(`Unable to launch ${argv[0]}: ${error.message}`, 'COMMAND_LAUNCH_FAILED'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      closed = { code, durationMs: Date.now() - started };
      settle();
    });
    // The command can close before taskkill reports, so a close also waits for its outcome. The close
    // deadline settles regardless and releases the output pipes a surviving process may still hold.
    function settle(deadline = null) {
      if (settled || (!deadline && (!closed || killing))) return;
      settled = true;
      clearTimeout(closeDeadline);
      if (deadline) { child.stdout.destroy(); child.stderr.destroy(); }
      const code = closed ? closed.code : child.exitCode;
      const durationMs = closed ? closed.durationMs : Date.now() - started;
      const uncertainty = deadline ?? (unconfirmed && `${unconfirmed}, so its process tree was not confirmed stopped`);
      if (uncertainty && confirmTermination) return reject(uncertain(uncertainty));
      const terminationUncertain = uncertainty ? `Passed its deadline and ${uncertainty}; processes it started may still be running.` : null;
      if (allowFailure) return resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, timedOut, overflow, durationMs, argv, ...(terminationUncertain ? { terminationUncertain } : {}) });
      if (code === 0 && !overflow && !timedOut) return resolve({ stdout: rawOutput ? stdout : stdout.trim(), stderr: rawOutput ? stderr : stderr.trim() });
      const detail = stderr.trim().slice(-4_000) || stdout.trim().slice(-4_000) || 'No output';
      reject(new OverdriveError(`${commandDescription(argv)} failed${timedOut ? ' after its deadline' : overflow ? ' because its output was too large' : ` (exit ${code})`}${terminationUncertain ? ` (${terminationUncertain})` : ''}: ${detail}`, 'COMMAND_FAILED'));
    }
  });
}

export const git = (cwd, ...args) => run(['git', ...args], { cwd });

export function redactString(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[credentials-redacted]@')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ctx7sk-[A-Za-z0-9-]{20,})\b/g, '[redacted]')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]');
}

export async function normalizeRepositorySource(value) {
  const source = requiredText(value, 'repository', { max: 4_096 });
  if (/[\r\n]/.test(source)) throw new OverdriveError('Repository contains a newline.', 'INVALID_REPOSITORY');
  if (/^https?:\/\//i.test(source) || /^ssh:\/\//i.test(source) || /^git:\/\//i.test(source)) {
    let parsed;
    try { parsed = new URL(source); } catch { throw new OverdriveError('Repository URL is invalid.', 'INVALID_REPOSITORY'); }
    if (parsed.username || parsed.password) throw new OverdriveError('Repository URLs with embedded credentials are not stored. Use configured Git credentials instead.', 'CREDENTIAL_IN_URL');
    return { source, kind: 'url' };
  }
  if (/^[^/\\\s@:]+@[^/\\\s:]+:[^\s]+$/.test(source)) return { source, kind: 'ssh' };
  const local = path.resolve(source);
  let real;
  try { real = await fs.realpath(local); } catch { throw new OverdriveError(`Local repository does not exist: ${local}`, 'INVALID_REPOSITORY'); }
  if (!(await fs.stat(real)).isDirectory()) throw new OverdriveError('Local repository source must be a directory.', 'INVALID_REPOSITORY');
  return { source: real, kind: 'local' };
}

function lockOwnerAlive(record) {
  if (!Number.isInteger(record?.pid) || record.pid <= 0) return true;
  try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; }
  return true;
}

// Serialize stale-lock removal with a persistent SQLite write lock that survives pathname replacement
// and releases when its holder dies. Re-read under the guard so an old observation cannot remove a new live lock.
async function reclaimDeadLock(root, lockFile, observed) {
  const guard = new DatabaseSync(await ensureManagedPath(root, `${lockFile}.reclaim`));
  try {
    try { guard.exec('BEGIN IMMEDIATE'); } catch (error) { if ((error?.errcode & 0xff) === 5) return false; throw error; }
    let current;
    try { current = await fs.readFile(lockFile, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (current !== observed) return false;
    const stale = `${lockFile}.stale-${randomUUID()}`;
    await fs.rename(lockFile, stale);
    await fs.rm(stale, { force: true });
    return true;
  } finally {
    // Closing ends the empty transaction, so the guard file is never written.
    guard.close();
  }
}

// Link a fully written pending record to publish it exclusively; a crash leaves no lock or a complete one.
// Never fall back to rename, which could replace another owner's lock.
async function publishLock(lockFile, operation, record) {
  const pending = `${lockFile}.pending-${randomUUID()}`;
  try {
    await fs.writeFile(pending, record, { flag: 'wx', mode: 0o600 });
    try {
      await fs.link(pending, lockFile);
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw new OverdriveError(`Could not publish the ${operation} workspace lock: ${error?.message ?? error}`, 'LOCK_PUBLISH_FAILED', { code: error?.code });
    }
  } finally {
    await fs.rm(pending, { force: true });
  }
}

// A lock name is an operation name, or a lane control lock: `control-` followed by a whole feature
// slug. The prefix sits outside the 63-character body so every accepted slug keeps a distinct lock.
export async function withWorkspaceLock(root, operation, fn, { timeoutMs = 120_000 } = {}) {
  if (typeof operation !== 'string' || !/^(?:control-)?[a-z][a-z0-9-]{0,62}$/.test(operation)) {
    throw new OverdriveError('Workspace lock name is invalid.', 'INVALID_LOCK');
  }
  const lockDirectory = await ensureManagedPath(root, contained(root, STATE_DIR, 'locks'));
  await fs.mkdir(lockDirectory, { recursive: true });
  const lockFile = await ensureManagedPath(root, path.join(lockDirectory, `${operation}.lock`));
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (!await publishLock(lockFile, operation, JSON.stringify({ token, pid: process.pid, createdAt: now() }))) {
    try {
      const stat = await fs.stat(lockFile);
      const observed = await fs.readFile(lockFile, 'utf8');
      if (!lockOwnerAlive(JSON.parse(observed)) && Date.now() - stat.mtimeMs > 500 && await reclaimDeadLock(root, lockFile, observed)) continue;
    } catch (statError) {
      if (!(statError instanceof SyntaxError) && !['ENOENT', 'EACCES'].includes(statError?.code)) throw statError;
    }
    if (Date.now() >= deadline) throw new OverdriveError(`Timed out waiting for the ${operation} workspace lock.`, 'WORKSPACE_BUSY');
    await sleep(150);
  }
  try {
    return await fn();
  } finally {
    try {
      const record = JSON.parse(await fs.readFile(lockFile, 'utf8'));
      if (record.token === token) await fs.rm(lockFile, { force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function lineDiff(before = '', after = '') {
  const left = new Set(before.split(/\r?\n/));
  const right = new Set(after.split(/\r?\n/));
  let added = 0;
  let removed = 0;
  for (const line of right) if (!left.has(line)) added += 1;
  for (const line of left) if (!right.has(line)) removed += 1;
  return { added, removed };
}

export function summarizePatch(patch = '') {
  const files = new Set();
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.add(match[2]);
    else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return {
    fileCount: files.size,
    files: [...files].slice(0, 50),
    additions,
    deletions,
    digest: createHash('sha256').update(patch).digest('hex').slice(0, 16),
  };
}

export function parseJsonObject(value, name = 'value') {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') throw new OverdriveError(`${name} must be an object or JSON object string.`, 'INVALID_INPUT');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new OverdriveError(`${name} is not valid JSON.`, 'INVALID_INPUT'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new OverdriveError(`${name} must be a JSON object.`, 'INVALID_INPUT');
  return parsed;
}
