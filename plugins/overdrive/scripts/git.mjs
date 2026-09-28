import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  OverdriveError,
  contained,
  ensureManagedPath,
  exists,
  git,
  redactString,
  run,
  safeSlug, STATE_DIR,
} from './util.mjs';

export const mirrorPath = root => contained(root, STATE_DIR, 'cache', 'repository.git');
export const featureRoot = (root, slug) => contained(root, 'features', safeSlug(slug));
export const checkoutPath = (root, slug) => contained(featureRoot(root, slug), 'repo');
export const labPath = root => contained(root, 'lab');
export const integrationPath = root => contained(root, STATE_DIR, 'lab', 'integration');

// Deep paths fail with "Filename too long" on Windows unless each working tree opts in; clone -c keeps it in the clone's config.
const LONG_PATHS = process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];

// Runtime-made commits and checkouts never run repository hooks or prompt for a signing key.
export const runtimeGitConfig = root => ['-c', `core.hooksPath=${contained(root, STATE_DIR, 'disabled-hooks')}`, '-c', 'commit.gpgSign=false'];

const automationEnv = (extra = {}) => ({
  ...process.env,
  GIT_AUTHOR_NAME: AUTOMATION_IDENTITY.name, GIT_AUTHOR_EMAIL: AUTOMATION_IDENTITY.email,
  GIT_COMMITTER_NAME: AUTOMATION_IDENTITY.name, GIT_COMMITTER_EMAIL: AUTOMATION_IDENTITY.email,
  ...extra,
});

// Creates a repository whose first commit holds the directory's files, attributed to OVERDRIVE automation.
export async function initializeRepository(root, directory, branch, message) {
  await git(directory, 'init', '-b', branch);
  if (LONG_PATHS.length) await git(directory, 'config', 'core.longpaths', 'true');
  await git(directory, 'add', '-A');
  await run(['git', ...runtimeGitConfig(root), 'commit', '-m', message], { cwd: directory, env: automationEnv() });
}

async function fetchCommit(repository, source, commit) {
  const present = await run(['git', 'cat-file', '-e', `${commit}^{commit}`], { cwd: repository, allowFailure: true });
  if (present.exitCode !== 0) await git(repository, 'fetch', '--no-tags', '--no-write-fetch-head', source, commit);
}

// Commits the working tree (tracked and unignored files) through a temporary index, so the checkout's
// own index, branch and files are untouched. A snapshot carries HEAD's date, so an unchanged tree always
// yields the same commit, and a ref keeps it reachable in the checkout.
export async function snapshotCommit(checkout) {
  const [head, headTree, headTime] = (await git(checkout, 'show', '-s', '--format=%H%n%T%n%ct', 'HEAD')).stdout.split(/\r?\n/);
  const gitDir = (await git(checkout, 'rev-parse', '--absolute-git-dir')).stdout;
  const index = path.join(gitDir, `overdrive-snapshot-${randomUUID()}.index`);
  const date = `${headTime} +0000`;
  const env = automationEnv({ GIT_INDEX_FILE: index, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const inSnapshot = args => run(['git', ...args], { cwd: checkout, env });
  try {
    // A copy of the real index only saves rehashing unchanged files; add -A then matches the working tree.
    try { await fs.copyFile(path.join(gitDir, 'index'), index); } catch { await inSnapshot(['read-tree', 'HEAD']); }
    await inSnapshot(['add', '-A']);
    const tree = (await inSnapshot(['write-tree'])).stdout;
    if (tree === headTree) return head;
    const commit = (await inSnapshot(['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', 'OVERDRIVE snapshot of uncommitted changes'])).stdout;
    await git(checkout, 'update-ref', `refs/overdrive/snapshots/${commit}`, commit);
    return commit;
  } finally {
    await fs.rm(index, { force: true });
  }
}

// Git run in a directory without a valid .git of its own acts on an enclosing repository instead,
// which a forced checkout or clean there would damage.
async function assertOwnClone(clone) {
  const gitDir = await run(['git', 'rev-parse', '--git-dir'], { cwd: clone, allowFailure: true });
  if (gitDir.exitCode !== 0 || gitDir.stdout !== '.git') {
    throw new OverdriveError(`${clone} is not a Git clone of its own, such as after an interrupted clone. Move it aside so OVERDRIVE can clone it again; OVERDRIVE never deletes it.`, 'CLONE_INVALID', { path: clone });
  }
}

// A lab checkout (a product target or a lab snapshot) is runtime-owned scratch: each sync discards tracked
// edits and untracked files but keeps ignored dependency directories such as node_modules. A target's origin
// is the repository, as in a lane clone, because builds such as SourceLink read it; fetches name their source explicitly.
export async function syncLabCheckout(root, area, directory, source, commit, origin = source) {
  const target = await ensureManagedPath(root, contained(root, STATE_DIR, 'lab', area, directory));
  if (!await exists(target)) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await run(['git', 'clone', '--no-checkout', ...LONG_PATHS, '--', source, target], { cwd: root });
    await git(target, 'remote', 'set-url', 'origin', origin);
  } else await assertOwnClone(target);
  await fetchCommit(target, source, commit);
  await run(['git', ...runtimeGitConfig(root), 'checkout', '--detach', '-f', commit], { cwd: target });
  await git(target, 'clean', '-fd');
  return target;
}

// Moves the integration clone to base. Its uncommitted changes, such as a conflict resolution in
// progress, belong to an agent and are never discarded; a HEAD other than the last build's
// (builtHead), such as a committed resolution, stays reachable under refs/overdrive/integration/.
export async function resetIntegration(root, base, baseSource, builtHead, origin) {
  const clone = await ensureManagedPath(root, integrationPath(root));
  const fresh = !await exists(clone);
  if (fresh) {
    await fs.mkdir(path.dirname(clone), { recursive: true });
    await run(['git', 'clone', '--no-checkout', ...LONG_PATHS, '--', mirrorPath(root), clone], { cwd: root });
    await git(clone, 'remote', 'set-url', 'origin', origin);
  } else {
    await assertOwnClone(clone);
    const { clean, head } = await repositorySnapshot(clone);
    if (!clean) throw new OverdriveError(`The integration clone ${clone} has uncommitted changes, such as an unfinished conflict resolution. Commit them there, or discard them yourself (git merge --abort ends a pending merge); OVERDRIVE never discards them.`, 'INTEGRATION_DIRTY', { path: clone });
    if (head !== builtHead && head !== base) await git(clone, 'update-ref', `refs/overdrive/integration/${head}`, head);
  }
  // rerere replays conflict resolutions an agent committed here, so a rebuild does not redo them.
  await git(clone, 'config', 'rerere.enabled', 'true');
  await git(clone, 'config', 'rerere.autoupdate', 'true');
  // Conflict markers show the merge base's version too, which a resolver needs to see what each side changed.
  await git(clone, 'config', 'merge.conflictStyle', 'zdiff3');
  await fetchCommit(clone, baseSource, base);
  // A fresh --no-checkout clone has an empty index, which only a forced checkout populates.
  await run(['git', ...runtimeGitConfig(root), 'checkout', '--detach', ...(fresh ? ['-f'] : []), base], { cwd: clone });
  return clone;
}

// Returns the conflicted paths; a conflicted merge stays in place for an agent to resolve. A lane
// that already contains the build so far is fast-forwarded, so its tested commit stays the head;
// an explicit --ff overrides a user's merge.ff setting.
export async function mergeIntoIntegration(root, clone, source, commit, message) {
  await fetchCommit(clone, source, commit);
  // Dated at its later parent, as a snapshot is, so rebuilding the same lanes on the same base gives the same commit.
  const time = Math.max(...(await git(clone, 'show', '-s', '--format=%ct', 'HEAD', commit)).stdout.split(/\r?\n/).map(Number));
  const env = automationEnv({ GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` });
  const merged = await run(['git', ...runtimeGitConfig(root), 'merge', '--ff', '--no-edit', '-m', message, commit], { cwd: clone, env, allowFailure: true });
  if (merged.exitCode === 0) return [];
  const conflicts = (await run(['git', 'diff', '--name-only', '-z', '--diff-filter=U'], { cwd: clone, rawOutput: true })).stdout.split('\0').filter(Boolean);
  if (conflicts.length) return conflicts;
  if (await exists(path.join(clone, '.git', 'MERGE_HEAD'))) {
    // rerere resolved every conflict from a recorded resolution; conclude the merge it describes.
    await run(['git', ...runtimeGitConfig(root), 'commit', '--no-edit'], { cwd: clone, env });
    return [];
  }
  throw new OverdriveError(`Merging ${commit} into the integration clone failed: ${(merged.stderr || merged.stdout).slice(-4_000)}`, 'INTEGRATION_FAILED');
}

// The paths merging commit into head would conflict on, merged in memory so the clone's index, working tree and any
// merge in progress stay untouched. Resolutions rerere recorded are not replayed here.
export async function mergeConflicts(clone, source, head, commit, timeoutMs) {
  try {
    await fetchCommit(clone, source, commit);
    const result = await run(['git', 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, commit], { cwd: clone, rawOutput: true, allowFailure: true, timeoutMs });
    // Exit 1 means conflicts only when a tree was written; merge-tree also exits 1 for commits it cannot merge.
    const [tree, ...files] = result.stdout.split('\0');
    if (result.timedOut || result.exitCode > 1 || !/^[0-9a-f]{40,64}$/.test(tree)) throw new Error(result.timedOut ? 'it timed out' : result.stderr.trim().slice(-500) || `git merge-tree exited ${result.exitCode}`);
    return { files: files.filter(Boolean) };
  } catch (error) {
    return { unavailable: `Previewing ${commit.slice(0, 12)} failed: ${redactString(error.message)}` };
  }
}

// Applies a patch the lab snapshot holds to a synced lab target; the target's next sync restores it.
const execFileAsync = promisify(execFile);
const PATCH_MAX_BYTES = 10 * 1024 * 1024;

export async function applyMutant(checkout, lab, labRevision, patch) {
  const invalid = reason => new OverdriveError(`Mutant ${patch} ${reason}.`, 'MUTANT_INVALID');
  // The committed blob, not the snapshot checkout's copy, which line-ending settings such as core.autocrlf may have converted.
  const bytes = await execFileAsync('git', ['cat-file', 'blob', `${labRevision}:${patch}`], { cwd: lab, encoding: 'buffer', maxBuffer: PATCH_MAX_BYTES, windowsHide: true })
    .then(({ stdout }) => stdout, error => {
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw invalid('is larger than the 10 MiB mutant patch limit');
      return null;
    });
  if (!bytes) throw invalid('is not a file in the lab snapshot');
  const applied = await run(['git', 'apply', '-'], { cwd: checkout, input: bytes, allowFailure: true });
  if (applied.exitCode !== 0) throw invalid(`does not apply to the target: ${redactString(applied.stderr).slice(-1_000)}`);
  if (!(await run(['git', 'status', '--porcelain'], { cwd: checkout })).stdout) throw invalid('leaves the target unchanged');
}

// Keeps each command line well under Windows' 32,767-character limit.
const PATHSPEC_CHUNK_CHARS = 16_000;

function pathspecChunks(paths) {
  const chunks = [];
  let size = Infinity;
  for (const file of paths) {
    if (size + file.length > PATHSPEC_CHUNK_CHARS) { chunks.push([]); size = 0; }
    chunks.at(-1).push(file);
    size += file.length + 1;
  }
  return chunks;
}

// Paths at or under `paths` where commit differs from its unique merge base with base, so a lane only behind base shows none.
// Literal pathspecs and --no-renames keep every original path, and each step stops at deadline (epoch ms).
export async function changesSinceMergeBase(clone, source, base, commit, paths, deadline) {
  const step = async (args, exitCodes = [0]) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error('its time limit ran out');
    const result = await run(['git', ...args], { cwd: clone, rawOutput: true, allowFailure: true, timeoutMs });
    if (result.timedOut) throw new Error('its time limit ran out');
    if (result.overflow || !exitCodes.includes(result.exitCode)) throw new Error(result.stderr.trim().slice(-500) || `git ${args[0]} failed`);
    return result;
  };
  try {
    if ((await step(['cat-file', '-e', `${commit}^{commit}`], [0, 1, 128])).exitCode !== 0) {
      await step(['fetch', '--no-tags', '--no-write-fetch-head', source, commit]);
    }
    const found = (await step(['merge-base', '--all', base, commit], [0, 1])).stdout.split(/\s+/).filter(Boolean);
    if (found.length !== 1) return { unavailable: found.length ? `${commit.slice(0, 12)} has ${found.length} merge bases with the build base (${found.map(id => id.slice(0, 12)).join(', ')}), so none was chosen.` : `${commit.slice(0, 12)} shares no history with the build base.` };
    const changed = [];
    for (const chunk of pathspecChunks(paths)) {
      const result = await step(['--literal-pathspecs', 'diff-tree', '-r', '-z', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', found[0], commit, '--', ...chunk]);
      changed.push(...result.stdout.split('\0').filter(Boolean));
    }
    return { mergeBase: found[0], paths: changed };
  } catch (error) {
    return { unavailable: `Comparing ${commit.slice(0, 12)} failed: ${redactString(error.message)}` };
  }
}

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

// Where Git has no usable identity at all, commits in this repository are attributed to OVERDRIVE
// automation through its local config, as in feature clones.
export async function ensureCommitIdentity(repository) {
  if (await effectiveIdent(repository, 'GIT_COMMITTER_IDENT')) return;
  await git(repository, 'config', '--local', 'user.name', AUTOMATION_IDENTITY.name);
  await git(repository, 'config', '--local', 'user.email', AUTOMATION_IDENTITY.email);
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
    await run(['git', 'clone', '--no-local', '--no-checkout', ...LONG_PATHS, '--', mirrorPath(root), destination], { cwd: root });
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
    changedFiles: changedFiles.slice(0, 200).map(redactString),
    status: lines.slice(0, 200).map(line => line.slice(0, 3) + redactString(line.slice(3))),
    ahead,
    behind,
  };
}

export async function verifyCheckoutRevision(repository, revision) {
  await assertFullRepository(repository);
  if (!revision || revision.startsWith('-') || revision.includes('\0')) throw new OverdriveError('Revision is invalid.', 'INVALID_REVISION');
  let resolved;
  try { resolved = (await git(repository, 'rev-parse', '--verify', `${revision}^{commit}`)).stdout; }
  catch { throw new OverdriveError(`Revision does not resolve: ${revision}`, 'INVALID_REVISION'); }
  return resolved;
}

export async function isGitAncestor(repository, ancestor, descendant) {
  try {
    await run(['git', 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: repository });
    return true;
  } catch (error) {
    if (error?.code === 'COMMAND_FAILED') return false;
    throw error;
  }
}

// Exact committed ancestry in a repository whose descendant commit was read: an ancestor object
// absent from it cannot be in that history, while any other Git failure stays unknown and throws.
async function containsCommit(repository, ancestor, descendant) {
  if (ancestor === descendant) return true;
  const options = { cwd: repository, allowFailure: true, timeoutMs: 30_000 };
  const compared = await run(['git', 'merge-base', '--is-ancestor', ancestor, descendant], options);
  if (!compared.timedOut && (compared.exitCode === 0 || compared.exitCode === 1)) return compared.exitCode === 0;
  const present = await run(['git', 'rev-parse', '--quiet', '--verify', `${ancestor}^{commit}`], options);
  if (!present.timedOut && present.exitCode === 1) return false;
  throw new OverdriveError('Git could not compare the commits.', 'COMMAND_FAILED');
}

// Reads a parent lane's committed HEAD and checks the parent's and the child's histories, each in its
// own repository; nothing is fetched or written.
export async function parentLaneAncestry(parentRepository, selectedRevision, laneRepository, laneHead) {
  await assertFullRepository(parentRepository);
  const head = (await git(parentRepository, 'rev-parse', '--verify', 'HEAD^{commit}')).stdout;
  return {
    head,
    selectedInParentHistory: await containsCommit(parentRepository, selectedRevision, head),
    headInLane: await containsCommit(laneRepository, head, laneHead),
  };
}

const CHANGED_FILE_LIMIT = 100;
const CHANGED_PATH_MAX = 300;
const TREE_DIFF_OUTPUT_MAX = 16_000_000;
// Product test files by common naming conventions: a test directory, test_*, *_test.*, *.spec.*, FooTest.*.
const PRODUCT_TEST_PATH = /(?:^|\/)(?:[Tt]ests?|[Ss]pec|__tests__|testdata|[^/]+\.Tests?)\/|(?:^|\/)test_[^/]*$|[._-](?:tests?|spec)\.[^/]+$|(?:Tests?|Spec)\.[^/.]+$/;

const clipPath = text => `${text.slice(0, CHANGED_PATH_MAX - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;

// Paths are redacted before clipping, so clipping never cuts a secret the redactor would have recognized.
function reviewFile(file) {
  const path = redactString(file.path);
  const previousPath = file.previousPath === undefined ? undefined : redactString(file.previousPath);
  const clipped = path.length > CHANGED_PATH_MAX || previousPath?.length > CHANGED_PATH_MAX;
  const fit = text => (text.length > CHANGED_PATH_MAX ? clipPath(text) : text);
  return { ...file, path: fit(path), ...(previousPath === undefined ? {} : { previousPath: fit(previousPath) }), ...(clipped ? { pathClipped: true } : {}) };
}

// Parses diff-tree -z --raw --numstat: a raw record per file, then a numstat record per file in the
// same order, a rename carrying both paths. Returns null unless the output parses completely.
function parseTreeDiff(output) {
  const tokens = output.split('\0');
  const files = [];
  let index = 0;
  while (tokens[index]?.startsWith(':')) {
    const status = tokens[index].slice(tokens[index].lastIndexOf(' ') + 1);
    const renamed = /^[RC]/.test(status);
    files.push(renamed
      ? { status: status[0], path: tokens[index + 2], previousPath: tokens[index + 1], similarity: Number(status.slice(1)) }
      : { status: status[0], path: tokens[index + 1] });
    index += renamed ? 3 : 2;
  }
  for (const file of files) {
    const counts = tokens[index]?.match(/^(-|\d+)\t(-|\d+)\t/);
    if (!counts || file.path === undefined) return null;
    index += file.previousPath === undefined ? 1 : 3;
    if (counts[1] === '-') file.binary = true;
    else Object.assign(file, { insertions: Number(counts[1]), deletions: Number(counts[2]) });
  }
  return index === tokens.length - 1 && tokens[index] === '' ? files : null;
}

// Best effort: a failed check names no revision, leaving Git's own error as the reason.
async function missingCommit(repository, revisions) {
  for (const revision of revisions) {
    try {
      const present = await run(['git', 'cat-file', '-e', `${revision}^{commit}`], { cwd: repository, allowFailure: true, timeoutMs: 10_000 });
      if (present.exitCode === 1 || present.exitCode === 128) return revision;
    } catch {
      return null;
    }
  }
  return null;
}

// The committed change between two exact commits, compared tree to tree, so the index, working tree
// and any merge-base stay out of it. Plumbing with --no-ext-diff and --no-textconv runs no configured helper.
export async function committedChanges(repository, from, to) {
  const unavailable = reason => ({ from: from ?? null, to, unavailable: reason });
  if (!from) return unavailable('No base revision is recorded to compare with.');
  let result;
  try {
    result = await run(['git', 'diff-tree', '-r', '-z', '-M', '--raw', '--numstat', '--no-ext-diff', '--no-textconv', from, to], { cwd: repository, rawOutput: true, allowFailure: true, maxOutput: TREE_DIFF_OUTPUT_MAX, timeoutMs: 60_000 });
  } catch (error) {
    return unavailable(`Git could not compare the commits: ${redactString(error.message).slice(0, 500)}`);
  }
  if (result.overflow) return unavailable('The change is too large to list exactly.');
  if (result.timedOut) return unavailable('Comparing the commits did not finish in time.');
  if (result.exitCode !== 0) {
    const missing = await missingCommit(repository, [from, to]);
    return unavailable(missing
      ? `${missing.slice(0, 12)} is not a commit in this clone; it may have been pruned or rewritten.`
      : `Git could not compare the commits: ${redactString(result.stderr.trim()).slice(-500)}`);
  }
  const files = parseTreeDiff(result.stdout);
  if (!files) return unavailable('Git returned a change list that could not be read exactly.');
  const total = key => files.reduce((sum, file) => sum + (file[key] ?? 0), 0);
  const listed = files.slice(0, CHANGED_FILE_LIMIT).map(reviewFile);
  const productTests = files.filter(file => PRODUCT_TEST_PATH.test(file.path) || PRODUCT_TEST_PATH.test(file.previousPath ?? ''))
    .slice(0, CHANGED_FILE_LIMIT).map(file => reviewFile(file).path);
  return {
    from, to,
    fileCount: files.length,
    insertions: total('insertions'),
    deletions: total('deletions'),
    binaryFiles: files.filter(file => file.binary).length,
    files: listed,
    ...(productTests.length ? { productTests } : {}),
    // Any lossy list is marked: files left out, or a listed path clipped.
    truncated: files.length > listed.length || listed.some(file => file.pathClipped),
  };
}
