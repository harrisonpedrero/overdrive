import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export class TheaterError extends Error {
  constructor(message, code = 'THEATER_ERROR', details = undefined) {
    super(message);
    this.name = 'TheaterError';
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

export const now = () => new Date().toISOString();
export const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function requiredText(value, name, { max = 200_000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new TheaterError(`${name} is required.`, 'INVALID_INPUT');
  if (value.length > max) throw new TheaterError(`${name} is too long.`, 'INVALID_INPUT');
  if (value.includes('\0')) throw new TheaterError(`${name} contains a null byte.`, 'INVALID_INPUT');
  return value.trim();
}

export function optionalText(value, name, options) {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, name, options);
}

const RESERVED_NAMES = new Set([
  'archive', 'aux', 'cache', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'con', 'features', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9', 'nul',
  'paused', 'prn', 'runtime', 'theater', 'tmp',
]);

export function safeSlug(value, name = 'feature') {
  const slug = requiredText(value, name, { max: 63 }).toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(slug) || slug.includes('--') || RESERVED_NAMES.has(slug)) {
    throw new TheaterError(`${name} must start with a letter and use lowercase letters, digits, or single hyphens.`, 'INVALID_SLUG');
  }
  return slug;
}

export function contained(root, ...parts) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TheaterError('A managed path would escape the workspace.', 'PATH_ESCAPE');
  }
  return target;
}

export async function resolveWorkspace(value) {
  const supplied = requiredText(value, 'workspace_path', { max: 4_096 });
  const absolute = path.resolve(supplied);
  let root;
  try {
    root = await fs.realpath(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new TheaterError(`Workspace does not exist: ${absolute}`, 'WORKSPACE_NOT_FOUND');
    throw error;
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new TheaterError('workspace_path must be a directory.', 'INVALID_WORKSPACE');
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
      if (stat.isSymbolicLink()) throw new TheaterError(`Managed path contains a symlink or junction: ${cursor}`, 'UNSAFE_PATH');
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
    if (error instanceof SyntaxError) throw new TheaterError(`Invalid JSON in ${file}.`, 'INVALID_STATE');
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

export async function run(argv, { cwd, env = process.env, timeoutMs = 20 * 60_000, maxOutput = 2_000_000, allowFailure = false, rawOutput = false } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(part => typeof part !== 'string' || part.includes('\0'))) {
    throw new TheaterError('Command arguments are invalid.', 'INVALID_COMMAND');
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
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
        killer.once('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
      }
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(new TheaterError(`Unable to launch ${argv[0]}: ${error.message}`, 'COMMAND_LAUNCH_FAILED'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (allowFailure) return resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, timedOut, overflow, durationMs: Date.now() - started, argv });
      if (code === 0 && !overflow && !timedOut) return resolve({ stdout: rawOutput ? stdout : stdout.trim(), stderr: rawOutput ? stderr : stderr.trim() });
      const detail = stderr.trim().slice(-4_000) || stdout.trim().slice(-4_000) || 'No output';
      reject(new TheaterError(`${commandDescription(argv)} failed${timedOut ? ' after its deadline' : overflow ? ' because its output was too large' : ` (exit ${code})`}: ${detail}`, 'COMMAND_FAILED'));
    });
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
  if (/[\r\n]/.test(source)) throw new TheaterError('Repository contains a newline.', 'INVALID_REPOSITORY');
  if (/^https?:\/\//i.test(source) || /^ssh:\/\//i.test(source) || /^git:\/\//i.test(source)) {
    let parsed;
    try { parsed = new URL(source); } catch { throw new TheaterError('Repository URL is invalid.', 'INVALID_REPOSITORY'); }
    if (parsed.username || parsed.password) throw new TheaterError('Repository URLs with embedded credentials are not stored. Use configured Git credentials instead.', 'CREDENTIAL_IN_URL');
    return { source, kind: 'url' };
  }
  if (/^[^/\\\s@:]+@[^/\\\s:]+:[^\s]+$/.test(source)) return { source, kind: 'ssh' };
  const local = path.resolve(source);
  let real;
  try { real = await fs.realpath(local); } catch { throw new TheaterError(`Local repository does not exist: ${local}`, 'INVALID_REPOSITORY'); }
  if (!(await fs.stat(real)).isDirectory()) throw new TheaterError('Local repository source must be a directory.', 'INVALID_REPOSITORY');
  return { source: real, kind: 'local' };
}

export async function withWorkspaceLock(root, operation, fn, { timeoutMs = 120_000 } = {}) {
  if (typeof operation !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(operation)) {
    throw new TheaterError('Workspace lock name is invalid.', 'INVALID_LOCK');
  }
  const lockDirectory = await ensureManagedPath(root, contained(root, '.theater', 'locks'));
  await fs.mkdir(lockDirectory, { recursive: true });
  const lockFile = await ensureManagedPath(root, path.join(lockDirectory, `${operation}.lock`));
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: now() }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = await fs.stat(lockFile);
        const record = JSON.parse(await fs.readFile(lockFile, 'utf8'));
        let alive = true;
        if (Number.isInteger(record.pid) && record.pid > 0) {
          try { process.kill(record.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        }
        if (!alive && Date.now() - stat.mtimeMs > 500) {
          const stale = `${lockFile}.stale-${randomUUID()}`;
          await fs.rename(lockFile, stale);
          await fs.rm(stale, { force: true });
          continue;
        }
      } catch (statError) {
        if (!(statError instanceof SyntaxError) && !['ENOENT', 'EACCES'].includes(statError?.code)) throw statError;
      }
      if (Date.now() >= deadline) throw new TheaterError(`Timed out waiting for the ${operation} workspace lock.`, 'WORKSPACE_BUSY');
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
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
  if (typeof value !== 'string') throw new TheaterError(`${name} must be an object or JSON object string.`, 'INVALID_INPUT');
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new TheaterError(`${name} is not valid JSON.`, 'INVALID_INPUT'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TheaterError(`${name} must be a JSON object.`, 'INVALID_INPUT');
  return parsed;
}
