import fs from 'node:fs/promises';
import path from 'node:path';
import {
  TheaterError,
  contained,
  ensureManagedPath,
  exists,
  git,
  run,
  safeSlug,
} from './util.mjs';

export const mirrorPath = root => contained(root, '.theater', 'cache', 'repository.git');
export const featureRoot = (root, slug) => contained(root, 'features', safeSlug(slug));
export const checkoutPath = (root, slug) => contained(featureRoot(root, slug), 'repo');

async function assertFullRepository(repository) {
  for (const [target, label] of [[repository, 'repository'], [path.join(repository, '.git'), '.git directory']]) {
    let stat;
    try { stat = await fs.lstat(target); }
    catch { throw new TheaterError(`Repository ${label} is missing: ${target}`, 'INVALID_CHECKOUT'); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TheaterError(`Repository ${label} must be a real directory: ${target}`, 'UNSAFE_CHECKOUT');
    }
  }
}

export async function initializeMirror(root, repository) {
  const mirror = await ensureManagedPath(root, mirrorPath(root));
  if (await exists(mirror)) throw new TheaterError('Repository cache already exists.', 'ALREADY_INITIALIZED');
  await fs.mkdir(path.dirname(mirror), { recursive: true });
  await run(['git', 'clone', '--mirror', '--', repository, mirror], { cwd: root });
  const info = await inspectMirror(root);
  if (!info.defaultRevision) throw new TheaterError('Repository has no committed default revision.', 'EMPTY_REPOSITORY');
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
  if (candidate.includes('\0') || candidate.startsWith('-')) throw new TheaterError('Invalid base revision.', 'INVALID_REVISION');
  try {
    return (await run(['git', '--git-dir', mirrorPath(root), 'rev-parse', '--verify', `${candidate}^{commit}`], { cwd: root })).stdout;
  } catch {
    throw new TheaterError(`Base revision does not resolve to a commit: ${candidate}`, 'INVALID_REVISION');
  }
}

async function showFromMirror(root, revision, file) {
  try {
    return (await run(['git', '--git-dir', mirrorPath(root), 'show', `${revision}:${file}`], { cwd: root, maxOutput: 500_000 })).stdout;
  } catch {
    return undefined;
  }
}

export async function profileRepository(root, revision) {
  const names = (await run(['git', '--git-dir', mirrorPath(root), 'ls-tree', '-r', '--name-only', revision], { cwd: root, maxOutput: 5_000_000 })).stdout
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
    const raw = await showFromMirror(root, revision, 'package.json');
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

export async function createFeatureCheckout(root, config, slug, baseRevision) {
  const destinationRoot = await ensureManagedPath(root, featureRoot(root, slug));
  const destination = await ensureManagedPath(root, checkoutPath(root, slug));
  if (await exists(destinationRoot)) throw new TheaterError(`Feature directory is occupied: ${destinationRoot}`, 'FEATURE_PATH_OCCUPIED');
  await fs.mkdir(destinationRoot, { recursive: true });
  // --no-local makes every feature self-contained instead of depending on the cache's object store.
  await run(['git', 'clone', '--no-local', '--no-checkout', '--', mirrorPath(root), destination], { cwd: root });
  const branch = `feature/${slug}`;
  await git(destination, 'check-ref-format', '--branch', branch);
  await git(destination, 'checkout', '-b', branch, baseRevision);
  await git(destination, 'remote', 'set-url', 'origin', config.repository);
  await git(destination, 'config', 'fetch.prune', 'true');
  await fs.appendFile(path.join(destination, '.git', 'info', 'exclude'), '\n/.theater/\n', 'utf8');
  return { destination, branch };
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
  if (!revision || revision.startsWith('-') || revision.includes('\0')) throw new TheaterError('Candidate revision is invalid.', 'INVALID_REVISION');
  let resolved;
  try { resolved = (await git(repository, 'rev-parse', '--verify', `${revision}^{commit}`)).stdout; }
  catch { throw new TheaterError(`Candidate revision does not resolve: ${revision}`, 'INVALID_REVISION'); }
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
