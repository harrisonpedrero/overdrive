import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OverdriveError,
  contained,
  ensureManagedPath,
  exists,
  git,
  now,
  run,
  safeSlug, STATE_DIR,
} from './util.mjs';

export const mirrorPath = root => contained(root, STATE_DIR, 'cache', 'repository.git');
export const featureRoot = (root, slug) => contained(root, 'features', safeSlug(slug));
export const checkoutPath = (root, slug) => contained(featureRoot(root, slug), 'repo');

async function assertFullRepository(repository) {
  for (const [target, label] of [[repository, 'repository'], [path.join(repository, '.git'), '.git directory']]) {
    let stat;
    try { stat = await fs.lstat(target); }
    catch { throw new OverdriveError(`Repository ${label} is missing: ${target}`, 'INVALID_CHECKOUT'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new OverdriveError(`Repository ${label} must be a real directory: ${target}`, 'UNSAFE_CHECKOUT');
    }
  }
}

export async function initializeMirror(root, repository) {
  const mirror = await ensureManagedPath(root, mirrorPath(root));
  if (await exists(mirror)) throw new OverdriveError('Repository cache already exists.', 'ALREADY_INITIALIZED');
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  await run(['git', 'clone', '--mirror', '--', repository, mirror], { cwd: root });
  const info = await inspectMirror(root);
  if (!info.defaultRevision) throw new OverdriveError('Repository has no committed default revision.', 'EMPTY_REPOSITORY');
  return info;
}

export async function refreshMirror(root) {
  const mirror = mirrorPath(root);
  await run(['git', '--git-dir', mirror, 'remote', 'update', '--prune'], { cwd: root });
  return inspectMirror(root);
}

export async function inspectMirror(root) {
  const mirror = mirrorPath(root);
  const revision = (await run(['git', '--git-dir', mirror, 'rev-parse', '--verify', 'HEAD^{commit}'], { cwd: root })).stdout;
  let defaultBranch = '';
  try {
    defaultBranch = (await run(['git', '--git-dir', mirror, 'symbolic-ref', '--short', 'HEAD'], { cwd: root })).stdout.replace(/^refs\/heads\//, '');
  } catch {
    defaultBranch = '';
  }
  return { defaultRevision: revision, defaultBranch };
}

export async function resolveMirrorRevision(root, revision) {
  const candidate = revision?.trim() || 'HEAD';
  if (candidate.includes('\0') || candidate.startsWith('-')) throw new OverdriveError('Invalid base revision.', 'INVALID_REVISION');
  try {
    return (await run(['git', '--git-dir', mirrorPath(root), 'rev-parse', '--verify', `${candidate}^{commit}`], { cwd: root })).stdout;
  } catch {
    throw new OverdriveError(`Base revision does not resolve to a commit: ${candidate}`, 'INVALID_REVISION');
  }
}

async function showFromGitDir(root, gitDir, revision, file) {
  try {
    return (await run(['git', '--git-dir', gitDir, 'show', `${revision}:${file}`], { cwd: root, maxOutput: 500_000 })).stdout;
  } catch {
    return undefined;
  }
}

// Profiles a committed tree, never a working tree, so hints describe exactly the selected revision.
// The cache is the default object store; a feature clone's .git holds commits the cache lacks.
export async function profileRepository(root, revision, gitDir = mirrorPath(root)) {
  const names = (await run(['git', '--git-dir', gitDir, 'ls-tree', '-r', '--name-only', revision], { cwd: root, maxOutput: 5_000_000 })).stdout
    .split(/\r?\n/).filter(Boolean);
  const files = new Set(names);
  const profile = {
    ecosystems: [],
    setupCandidates: [],
    checkCandidates: [],
    instructionFiles: names.filter(name => /(^|\/)(AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md)$/i.test(name)).slice(0, 100),
  };

  if (files.has('package.json')) {
    profile.ecosystems.push('node');
    if (files.has('pnpm-lock.yaml')) profile.setupCandidates.push(['corepack', 'pnpm', 'install', '--frozen-lockfile']);
    else if (files.has('yarn.lock')) profile.setupCandidates.push(['corepack', 'yarn', 'install', '--immutable']);
    else if (files.has('package-lock.json') || files.has('npm-shrinkwrap.json')) profile.setupCandidates.push(['npm', 'ci']);
    else if (files.has('bun.lock') || files.has('bun.lockb')) profile.setupCandidates.push(['bun', 'install', '--frozen-lockfile']);
    else profile.setupCandidates.push(['npm', 'install']);
    const raw = await showFromGitDir(root, gitDir, revision, 'package.json');
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        for (const name of ['check', 'typecheck', 'test', 'lint']) {
          if (typeof pkg?.scripts?.[name] === 'string') profile.checkCandidates.push(['npm', 'run', name]);
        }
      } catch {
        profile.warnings = ['package.json could not be parsed from the selected revision.'];
      }
    }
  }
  if (files.has('pyproject.toml') || files.has('requirements.txt') || files.has('setup.py')) {
    profile.ecosystems.push('python');
    if (files.has('uv.lock')) profile.setupCandidates.push(['uv', 'sync', '--frozen']);
    else if (files.has('requirements.txt')) profile.setupCandidates.push(['python', '-m', 'pip', 'install', '-r', 'requirements.txt']);
    if (files.has('pytest.ini') || files.has('conftest.py') || names.some(name => /(^|\/)tests?\//.test(name))) profile.checkCandidates.push(['python', '-m', 'pytest']);
  }
  if (files.has('Cargo.toml')) {
    profile.ecosystems.push('rust');
    profile.setupCandidates.push(['cargo', 'fetch']);
    profile.checkCandidates.push(['cargo', 'test']);
  }
  if (files.has('go.mod')) {
    profile.ecosystems.push('go');
    profile.setupCandidates.push(['go', 'mod', 'download']);
    profile.checkCandidates.push(['go', 'test', './...']);
  }
  if (files.has('Gemfile')) {
    profile.ecosystems.push('ruby');
    profile.setupCandidates.push(['bundle', 'install']);
    if (names.some(name => /(^|\/)spec\//.test(name))) profile.checkCandidates.push(['bundle', 'exec', 'rspec']);
  }
  if (files.has('pom.xml')) {
    profile.ecosystems.push('maven');
    profile.checkCandidates.push(['mvn', 'test']);
  }
  if (files.has('gradlew') || files.has('gradlew.bat')) {
    profile.ecosystems.push('gradle');
    profile.checkCandidates.push([process.platform === 'win32' ? 'gradlew.bat' : './gradlew', 'test']);
  }
  return profile;
}

export const AUTOMATION_IDENTITY = Object.freeze({ name: 'OVERDRIVE', email: 'overdrive@local.invalid' });
// Command-line and environment scopes belong to one process, so only file-backed config can supply
// an identity a later worker commit will also see.
const DURABLE_SCOPES = new Set(['system', 'global', 'local', 'worktree']);

// Variables that take precedence over Git config for a commit made in this process's environment,
// which lane workers inherit.
const IDENTITY_ENVIRONMENT = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
const PROVENANCE_MARKERS = { 'overdrive.identity': 'identity', 'overdrive.identityorigin': 'origin', 'overdrive.identitysource': 'source' };

// Reads user.name/user.email from durable Git config (last value wins, as for a commit) plus the
// clone-local OVERDRIVE provenance markers. -C keeps a missing repository a Git failure, not a launch
// failure; `readable` is false when Git could not read the repository at all.
async function configuredIdentity(repository, scope = null) {
  const result = await run(['git', '-C', repository, 'config', ...(scope ? [`--${scope}`] : []), '--show-scope', '--get-regexp', '^(user\\.(name|email)|overdrive\\.identity(origin|source)?)$'], { allowFailure: true });
  const identity = { readable: result.exitCode === 0 || result.exitCode === 1, marker: {} };
  if (result.exitCode !== 0) return identity;
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^([a-z]+)\t(user\.name|user\.email|overdrive\.identity(?:origin|source)?)(?: (.*))?$/);
    if (!match || !DURABLE_SCOPES.has(match[1])) continue;
    const value = (match[3] ?? '').trim();
    if (match[2].startsWith('overdrive.')) {
      if (match[1] === 'local') identity.marker[PROVENANCE_MARKERS[match[2]]] = value;
      continue;
    }
    const key = match[2].slice('user.'.length);
    if (value) identity[key] = { value, scope: match[1] };
    else delete identity[key];
  }
  return identity;
}

const identityComplete = identity => Boolean(identity.name && identity.email);
const formatIdent = ident => ident ? `${ident.name} <${ident.email}>` : null;

// Git's own resolution for a commit here: environment, command-line config, then config files.
async function effectiveIdent(repository, variable) {
  const result = await run(['git', '-C', repository, 'var', variable], { allowFailure: true });
  const match = result.exitCode === 0 ? result.stdout.match(/^(.*) <([^<>]*)> \d+ [+-]\d{4}$/) : null;
  return match ? { name: match[1], email: match[2] } : null;
}

async function recordProvenance(destination, name, email, origin, source = null) {
  await git(destination, 'config', '--local', 'user.name', name);
  await git(destination, 'config', '--local', 'user.email', email);
  await git(destination, 'config', '--local', 'overdrive.identityOrigin', origin);
  await git(destination, 'config', '--local', 'overdrive.identity', `${name} <${email}>`);
  if (source) await git(destination, 'config', '--local', 'overdrive.identitySource', source);
}

// Describes the author and committer a commit in this checkout would actually get, and where the
// configured identity came from. Provenance recorded by OVERDRIVE applies only while the clone-local
// identity still matches it.
export async function readCommitIdentity(repository, note = null) {
  const [configured, author, committer] = await Promise.all([
    configuredIdentity(repository), effectiveIdent(repository, 'GIT_AUTHOR_IDENT'), effectiveIdent(repository, 'GIT_COMMITTER_IDENT'),
  ]);
  const complete = identityComplete(configured);
  const pair = complete ? `${configured.name.value} <${configured.email.value}>` : null;
  const scope = complete ? (configured.name.scope === configured.email.scope ? configured.name.scope : `${configured.name.scope}+${configured.email.scope}`) : null;
  const recorded = scope === 'local' && configured.marker.identity === pair ? configured.marker.origin : null;
  const origin = !complete ? 'missing'
    : recorded === 'source' || recorded === 'automation' ? recorded
      : scope === 'local' && pair === formatIdent(AUTOMATION_IDENTITY) ? 'automation' : 'configured';
  const label = origin === 'automation' ? 'OVERDRIVE automation fallback in clone-local config; no human identity was configured'
    : origin === 'source' ? `copied into clone-local config from the adopted local source${configured.marker.source ? ` ${configured.marker.source}` : ''}`
      : origin === 'configured' ? `${scope === 'local' ? 'clone-local' : scope} Git config` : 'no complete user.name and user.email in Git config';
  const environment = IDENTITY_ENVIRONMENT.filter(key => process.env[key]);
  const overridden = Boolean(author && committer) && (formatIdent(author) !== pair || formatIdent(committer) !== pair);
  const automation = formatIdent(author) === formatIdent(AUTOMATION_IDENTITY) && formatIdent(committer) === formatIdent(AUTOMATION_IDENTITY);
  let summary;
  if (!author || !committer) summary = `No usable commit identity (${label}); commits in this clone will fail until a lane-local user.name and user.email are set.`;
  else if (overridden) summary = `Author ${formatIdent(author)}, committer ${formatIdent(committer)} · this environment's ${environment.length ? environment.join(', ') : 'Git overrides'} take precedence over ${pair ?? 'Git config'} (${label})`;
  else summary = `${pair} · ${label}`;
  return {
    author: formatIdent(author),
    committer: formatIdent(committer),
    name: complete ? configured.name.value : null,
    email: complete ? configured.email.value : null,
    scope,
    origin,
    source: origin === 'source' ? configured.marker.source ?? null : null,
    automation,
    overridden,
    environment,
    override: [`git -C "${repository}" config user.name "Your Name"`, `git -C "${repository}" config user.email "you@example.com"`],
    summary: note ? `${summary}. ${note}` : summary,
  };
}

// Keeps an explicit clone identity, carries an adopted local source's repository-local pair (which
// outranks global config in that source too), keeps any other complete configured identity, and
// otherwise attributes commits in this clone only to OVERDRIVE automation. Global and system config
// are never written, and no human author is invented. Environment overrides are reported, not changed.
async function configureCommitIdentity(destination, config) {
  const current = await configuredIdentity(destination);
  const explicit = [current.name?.scope, current.email?.scope].every(scope => scope === 'local' || scope === 'worktree');
  if (identityComplete(current) && explicit) return readCommitIdentity(destination);
  let note = null;
  if (config.repositoryKind === 'local') {
    const source = await configuredIdentity(config.repository, 'local');
    if (identityComplete(source)) {
      await recordProvenance(destination, source.name.value, source.email.value, 'source', config.repository);
      return readCommitIdentity(destination);
    }
    if (!source.readable) note = `The adopted local source ${config.repository} could not be read, so its repository-local identity was not considered`;
  }
  if (!identityComplete(current)) await recordProvenance(destination, AUTOMATION_IDENTITY.name, AUTOMATION_IDENTITY.email, 'automation');
  return readCommitIdentity(destination, note);
}

export async function createFeatureCheckout(root, config, slug, baseRevision, baseRepository = mirrorPath(root)) {
  const destinationRoot = await ensureManagedPath(root, featureRoot(root, slug));
  const destination = await ensureManagedPath(root, checkoutPath(root, slug));
  if (await exists(destinationRoot)) throw new OverdriveError(`Feature directory is occupied: ${destinationRoot}`, 'FEATURE_PATH_OCCUPIED');
  await fs.mkdir(destinationRoot, { recursive: true });
  try {
    // --no-local makes every feature self-contained instead of depending on the cache's object store.
    await run(['git', 'clone', '--no-local', '--no-checkout', '--', mirrorPath(root), destination], { cwd: root });
    // The selected commit may exist only in a sibling clone or outside the cache's advertised refs.
    await git(destination, 'fetch', '--no-tags', '--no-write-fetch-head', baseRepository, baseRevision);
    const branch = `feature/${slug}`;
    await git(destination, 'check-ref-format', '--branch', branch);
    await git(destination, 'checkout', '-b', branch, baseRevision);
    await git(destination, 'remote', 'set-url', 'origin', config.repository);
    await git(destination, 'config', 'fetch.prune', 'true');
    await fs.appendFile(path.join(destination, '.git', 'info', 'exclude'), '\n/.overdrive/\n', 'utf8');
    const commitIdentity = await configureCommitIdentity(destination, config);
    return { destination, branch, commitIdentity };
  } catch (error) {
    throw new OverdriveError(error.message, error.code || 'CHECKOUT_FAILED', {
      checkoutPath: destination, featurePath: destinationRoot, baseRevision,
      recovery: 'Checkout creation stopped before feature registration. Preserve and inspect this partial directory before an authorized recovery; an occupied path is never overwritten automatically.',
    });
  }
}

export async function repositorySnapshot(repository, baseRevision = undefined) {
  await assertFullRepository(repository);
  const head = (await git(repository, 'rev-parse', 'HEAD')).stdout;
  let branch = '';
  try { branch = (await git(repository, 'branch', '--show-current')).stdout; } catch { branch = ''; }
  const porcelain = (await run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repository, rawOutput: true })).stdout;
  const entries = porcelain.split('\0').filter(Boolean);
  const lines = [];
  const changedFiles = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    lines.push(entry);
    changedFiles.push(entry.slice(3));
    if (/R|C/.test(entry.slice(0, 2))) index++;
  }
  let ahead = undefined;
  let behind = undefined;
  if (baseRevision) {
    try {
      const counts = (await git(repository, 'rev-list', '--left-right', '--count', `${baseRevision}...HEAD`)).stdout.split(/\s+/).map(Number);
      behind = counts[0];
      ahead = counts[1];
    } catch {
      // A base may have been pruned from a manually rewritten clone; the head/status remain useful.
    }
  }
  return {
    head,
    branch,
    clean: lines.length === 0,
    changedFileCount: lines.length,
    changedFiles: changedFiles.slice(0, 200),
    status: lines.slice(0, 200),
    ahead,
    behind,
  };
}

// A checkout fingerprint is a bounded, best-effort observation of the Git-visible checkout, never
// an atomic snapshot: the status read and the content reads after it are separate moments, and
// external writes can land between or after them. Two observations that differ prove drift; two
// that match prove only that both observations matched.
export const CHECKOUT_FINGERPRINT_VERSION = 1;
export const FINGERPRINT_LIMITS = Object.freeze({
  statusBytes: 32 * 1024 * 1024,
  statusTimeoutMs: 60_000,
  contentFiles: 10_000,
  contentBytes: 256 * 1024 * 1024,
  contentDeadlineMs: 30_000,
});
const FINGERPRINT_COMPONENTS = ['head', 'index', 'paths', 'contents'];
// Optional locks stay off so an observation never rewrites the index a worker may be using.
// Rename detection is heuristic, so a staged rename is recorded as its exact delete and add.
const FINGERPRINT_STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'];

// Length-prefixed parts keep each digest unambiguous for arbitrary path bytes.
function digestParts(hash, ...parts) {
  for (const part of parts) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(String(part), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
}

function componentDigest(component) {
  const hash = crypto.createHash('sha256');
  digestParts(hash, `overdrive-checkout-v${CHECKOUT_FINGERPRINT_VERSION}`, component);
  return hash;
}

// Splits a record's space-separated leading fields from the raw path bytes that follow them.
function splitRecord(record, count) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const end = record.indexOf(0x20, start);
    if (end < 0) return null;
    fields.push(record.toString('latin1', start, end));
    start = end + 1;
  }
  return { fields, path: record.subarray(start) };
}

const RECORD_FIELDS = { 1: 8, 2: 9, u: 10 };

// With -z every porcelain v2 line is NUL-terminated. Branch headers are ASCII key/value lines;
// records carry raw path bytes, and a '2' record's original path is the following NUL field.
function parseFingerprintStatus(output) {
  const lines = [];
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    const stop = end < 0 ? output.length : end;
    lines.push(output.subarray(start, stop));
    start = stop + 1;
  }
  const headers = new Map();
  const records = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.length) continue;
    const kind = String.fromCharCode(line[0]);
    if (kind === '#') {
      const space = line.indexOf(0x20, 2);
      if (space > 2) headers.set(line.toString('latin1', 2, space), line.subarray(space + 1));
      continue;
    }
    if (kind === '!') continue;
    if (kind === '?') {
      records.push({ kind, path: line.subarray(2) });
      continue;
    }
    const split = RECORD_FIELDS[kind] ? splitRecord(line, RECORD_FIELDS[kind]) : null;
    if (!split || !split.path.length) return { error: `Unrecognized status record type ${JSON.stringify(kind)}.` };
    const record = { kind, fields: split.fields, path: split.path };
    if (kind === '2') {
      record.origPath = lines[++index];
      if (!record.origPath) return { error: 'A rename record has no original path.' };
    }
    records.push(record);
  }
  return { headers, records };
}

const displayPath = raw => raw.toString('utf8');

async function hashContents(repository, wanted, limits) {
  const hash = componentDigest('contents');
  const base = Buffer.from(`${repository}/`, 'utf8');
  const deadline = Date.now() + limits.contentDeadlineMs;
  let files = 0;
  let bytes = 0;
  const stop = (reason, detail) => ({ indeterminate: { component: 'contents', reason, detail }, files, bytes });
  if (wanted.length > limits.contentFiles) return stop('oversized', { limit: 'contentFiles', max: limits.contentFiles, observed: wanted.length });
  for (const raw of wanted) {
    if (Date.now() > deadline) return stop('deadline', { limit: 'contentDeadlineMs', max: limits.contentDeadlineMs, hashedFiles: files });
    const target = Buffer.concat([base, raw]);
    let before;
    try { before = await fs.lstat(target, { bigint: true }); }
    catch (error) {
      // Removed after status listed it: record the absence, which differs from any later content.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') { digestParts(hash, raw, 'missing'); continue; }
      return stop('unreadable', { path: displayPath(raw), code: error?.code ?? 'UNKNOWN' });
    }
    try {
      if (before.isSymbolicLink()) {
        // Links, including Windows junctions, are recorded by target and never followed.
        const link = await fs.readlink(target, { encoding: 'buffer' });
        digestParts(hash, raw, 'symlink', link);
        files++;
        bytes += link.length;
        continue;
      }
      if (!before.isFile()) return stop('unsupported_type', { path: displayPath(raw) });
      const size = Number(before.size);
      if (bytes + size > limits.contentBytes) return stop('oversized', { limit: 'contentBytes', max: limits.contentBytes, observed: bytes + size });
      const file = crypto.createHash('sha256');
      let read = 0;
      if (size > 0) {
        for await (const chunk of createReadStream(target, { start: 0, end: size - 1 })) {
          file.update(chunk);
          read += chunk.length;
        }
      }
      const after = await fs.lstat(target, { bigint: true });
      if (read !== size || !after.isFile() || after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        return stop('unstable', { path: displayPath(raw) });
      }
      digestParts(hash, raw, 'file', String(size), file.digest());
      files++;
      bytes += size;
    } catch (error) {
      return stop(error?.code === 'ENOENT' ? 'unstable' : 'unreadable', { path: displayPath(raw), code: error?.code ?? 'UNKNOWN' });
    }
  }
  return { digest: hash.digest('hex'), files, bytes };
}

// Components: head (commit and branch), index (entries that differ from HEAD), paths (working-tree
// status, including untracked names) and contents (raw bytes of every path whose working copy
// differs from the index, plus untracked files). Clean tracked files are covered by Git's own
// status and are never read. A component that could not be observed completely is null, never a
// digest of a partial scan. Ignored files, assume-unchanged/skip-worktree entries, submodule
// internals and untracked nested repositories are excluded; the last two are counted. A path that
// is itself a link is recorded by target, but Git for Windows lists the files beneath an untracked
// junction individually, and those are hashed as listed.
export async function checkoutFingerprint(repository, limits = FINGERPRINT_LIMITS) {
  await assertFullRepository(repository);
  const started = Date.now();
  const fingerprint = {
    version: CHECKOUT_FINGERPRINT_VERSION,
    algorithm: 'sha256',
    observedAt: now(),
    head: null,
    index: null,
    paths: null,
    contents: null,
    counts: { statusEntries: 0, hashedFiles: 0, hashedBytes: 0 },
    excluded: [],
    indeterminate: [],
    durationMs: 0,
  };
  const finish = () => { fingerprint.durationMs = Date.now() - started; return fingerprint; };
  let status;
  try {
    status = await run(FINGERPRINT_STATUS, { cwd: repository, binary: true, allowFailure: true, maxOutput: limits.statusBytes, timeoutMs: limits.statusTimeoutMs });
  } catch (error) {
    fingerprint.indeterminate.push({ component: 'all', reason: 'status_failed', detail: { message: error.message } });
    return finish();
  }
  if (status.timedOut || status.overflow || status.exitCode !== 0) {
    const reason = status.timedOut ? 'status_deadline' : status.overflow ? 'status_oversized' : 'status_failed';
    fingerprint.indeterminate.push({ component: 'all', reason, detail: { exitCode: status.exitCode, stderr: status.stderr.slice(-2_000) } });
    return finish();
  }
  const parsed = parseFingerprintStatus(status.stdout);
  if (parsed.error) {
    fingerprint.indeterminate.push({ component: 'all', reason: 'status_unparsed', detail: { message: parsed.error } });
    return finish();
  }
  const oid = parsed.headers.get('branch.oid');
  const ref = parsed.headers.get('branch.head');
  if (oid && ref) {
    const text = ref.toString('utf8');
    fingerprint.head = { oid: oid.toString('latin1'), ref: text, ...(Buffer.from(text, 'utf8').equals(ref) ? {} : { refHex: ref.toString('hex') }) };
  } else {
    fingerprint.indeterminate.push({ component: 'head', reason: 'status_unparsed', detail: { message: 'Git status reported no branch headers.' } });
  }
  const index = componentDigest('index');
  const paths = componentDigest('paths');
  const wanted = [];
  const excluded = new Map();
  const exclude = kind => excluded.set(kind, (excluded.get(kind) ?? 0) + 1);
  for (const record of parsed.records) {
    if (record.kind === '?') {
      digestParts(paths, '?', record.path);
      // Untracked-all lists files individually; only a nested repository is reported as a directory.
      if (record.path[record.path.length - 1] === 0x2f) exclude('nested_repository');
      else wanted.push(record.path);
      continue;
    }
    if (record.kind === 'u') {
      const [, xy, sub, m1, m2, m3, mW, h1, h2, h3] = record.fields;
      digestParts(index, 'u', xy, m1, m2, m3, h1, h2, h3, record.path);
      digestParts(paths, 'u', sub, mW, record.path);
      if (sub[0] === 'S') exclude('submodule_internals');
      else wanted.push(record.path);
      continue;
    }
    const [, xy, sub, mH, mI, mW, hH, hI] = record.fields;
    const origPath = record.origPath ?? Buffer.alloc(0);
    // An entry equal to HEAD is absent from status, so only a staged change says anything about the index.
    if (xy[0] !== '.') digestParts(index, record.kind, xy[0], mH, mI, hH, hI, record.path, origPath);
    if (xy[1] !== '.' || sub !== 'N...') digestParts(paths, record.kind, xy[1], sub, mW, record.path);
    if (sub[0] === 'S') exclude('submodule_internals');
    else if (xy[1] !== '.' && xy[1] !== 'D') wanted.push(record.path);
  }
  fingerprint.index = index.digest('hex');
  fingerprint.paths = paths.digest('hex');
  fingerprint.counts.statusEntries = parsed.records.length;
  fingerprint.excluded = [...excluded].map(([kind, count]) => ({ kind, count }));
  const contents = await hashContents(repository, wanted, limits);
  fingerprint.counts.hashedFiles = contents.files;
  fingerprint.counts.hashedBytes = contents.bytes;
  if (contents.indeterminate) fingerprint.indeterminate.push(contents.indeterminate);
  else fingerprint.contents = contents.digest;
  return finish();
}

export const fingerprintComplete = fingerprint => Boolean(fingerprint) && fingerprint.indeterminate.length === 0
  && FINGERPRINT_COMPONENTS.every(component => fingerprint[component] !== null);

// Any component observed completely on both sides that differs is definite drift, even when
// another component is unknown. Otherwise an unknown component leaves freshness indeterminate.
export function compareCheckoutFingerprints(saved, current) {
  if (!saved) return { status: 'unverified', reason: 'no_fingerprint', changed: [], indeterminate: [] };
  if (saved.version !== CHECKOUT_FINGERPRINT_VERSION) return { status: 'unverified', reason: 'fingerprint_version', changed: [], indeterminate: [] };
  const changed = [];
  const unknown = [];
  for (const component of FINGERPRINT_COMPONENTS) {
    const before = saved[component] ?? null;
    const after = current?.[component] ?? null;
    if (before === null || after === null) unknown.push(component);
    else if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(component);
  }
  return { status: changed.length ? 'changed' : unknown.length ? 'indeterminate' : 'fresh', changed, indeterminate: unknown };
}

export function fingerprintSummary(fingerprint) {
  if (!fingerprint) return null;
  const { head, observedAt, counts, excluded, indeterminate } = fingerprint;
  return { head, observedAt, counts, excluded, indeterminate };
}

export async function verifyCheckoutRevision(repository, revision) {
  await assertFullRepository(repository);
  if (!revision || revision.startsWith('-') || revision.includes('\0')) throw new OverdriveError('Candidate revision is invalid.', 'INVALID_REVISION');
  let resolved;
  try { resolved = (await git(repository, 'rev-parse', '--verify', `${revision}^{commit}`)).stdout; }
  catch { throw new OverdriveError(`Candidate revision does not resolve: ${revision}`, 'INVALID_REVISION'); }
  return resolved;
}

export async function diffSummary(repository, fromRevision, toRevision = 'HEAD') {
  await assertFullRepository(repository);
  const output = (await git(repository, 'diff', '--stat', '--summary', `${fromRevision}..${toRevision}`)).stdout;
  const names = (await git(repository, 'diff', '--name-status', `${fromRevision}..${toRevision}`)).stdout;
  return {
    stat: output,
    files: names ? names.split(/\r?\n/).filter(Boolean).slice(0, 200) : [],
  };
}
