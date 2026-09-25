import fs from 'node:fs/promises';
import path from 'node:path';
import {
  OverdriveError,
  contained,
  ensureManagedPath,
  exists,
  git,
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
