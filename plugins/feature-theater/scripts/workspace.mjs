import { randomUUID } from 'node:crypto';
import { assertAgentIdle, assertVerified, featureContract, invalidateCandidates, verificationStatus } from './verification.mjs';
import { ownsAgent, recoverAgentState } from './ownership.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  TheaterError,
  atomicWrite,
  contained,
  ensureManagedPath,
  exists,
  lineDiff,
  normalizeRepositorySource,
  now,
  optionalText,
  requiredText,
  resolveWorkspace,
  run,
  safeSlug,
  withWorkspaceLock,
  writeJson,
} from './util.mjs';
import {
  createFeatureCheckout,
  diffSummary,
  checkoutPath,
  initializeMirror,
  inspectMirror,
  mirrorPath,
  profileRepository,
  refreshMirror,
  repositorySnapshot,
  resolveMirrorRevision,
  verifyCheckoutRevision,
} from './git.mjs';
import {
  featureBySlug,
  initializeDatabase,
  listFeatureRows,
  loadWorkspace,
  meta,
  newId,
  normalizeFeature,
  openDatabase,
  parseJson,
  recordEvent,
  transaction,
  workItems,
} from './state.mjs';

const FEATURE_STATUSES = new Set(['planned', 'active', 'paused', 'blocked', 'review', 'done', 'archived']);
const WORK_STATUSES = new Set(['planned', 'ready', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled']);
const WORK_KINDS = new Set(['scope', 'design', 'build', 'review', 'validate', 'repair', 'integrate']);

function closeContext(ctx) {
  try { ctx.db.close(); } catch { /* already closed */ }
}

async function withContext(workspacePath, fn) {
  const root = await resolveWorkspace(workspacePath);
  const ctx = await loadWorkspace(root);
  try { return await fn(ctx); } finally { closeContext(ctx); }
}

async function withCheckoutLock(root, slug, fn) {
  return withWorkspaceLock(root, `control-${slug}`, () => withWorkspaceLock(root, 'features', fn));
}

function progressFor(db, featureId) {
  const counts = Object.fromEntries([...WORK_STATUSES].map(status => [status, 0]));
  for (const row of db.prepare('SELECT status, COUNT(*) AS count FROM work_items WHERE feature_id = ? GROUP BY status').all(featureId)) {
    counts[row.status] = Number(row.count);
  }
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    total,
    done: counts.done,
    running: counts.running,
    ready: counts.ready,
    blocked: counts.blocked,
    failed: counts.failed,
    open: total - counts.done - counts.cancelled,
  };
}

function latestSpec(db, featureId) {
  return db.prepare('SELECT revision, content, rationale, created_at FROM spec_revisions WHERE feature_id = ? ORDER BY revision DESC LIMIT 1').get(featureId);
}

function latestCheckpoint(db, featureId) {
  const row = db.prepare('SELECT * FROM checkpoints WHERE feature_id = ? ORDER BY created_at DESC LIMIT 1').get(featureId);
  return row ? { ...row, unresolved: parseJson(row.unresolved_json, []) } : undefined;
}

function evidenceRows(db, featureId, limit = 50) {
  return db.prepare('SELECT * FROM evidence WHERE feature_id = ? ORDER BY created_at DESC LIMIT ?').all(featureId, limit)
    .map(({ output, ...row }) => ({ ...row, passed: row.passed === null ? null : Boolean(row.passed), outputAvailable: Boolean(output) }));
}

function pendingRows(db, featureId) {
  return db.prepare("SELECT request_id, method, summary, payload_json, created_at FROM pending_agent_requests WHERE feature_id = ? AND status = 'pending' ORDER BY created_at").all(featureId)
    .map(row => ({ ...row, payload: parseJson(row.payload_json, {}) }))
    .map(({ payload_json: _payload, ...row }) => row);
}

function candidateRows(db, featureId) {
  return db.prepare('SELECT * FROM candidates WHERE feature_id = ? ORDER BY created_at DESC LIMIT 20').all(featureId)
    .map(row => ({ ...row, checks: parseJson(row.checks_json, []) }))
    .map(({ checks_json: _checks, ...row }) => row);
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

async function ensureWorkspaceFiles(root, config) {
  const coordinatorConfig = contained(root, '.codex', 'config.toml');
  if (!await exists(coordinatorConfig)) await atomicWrite(root, coordinatorConfig, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  const ignoreFile = contained(root, '.gitignore');
  const required = [
    'features/',
    '.theater/cache/',
    '.theater/locks/',
    '.theater/state.sqlite3*',
    '.theater/events.ndjson',
    'theater.json',
    ...(config?.managedProject ? ['project/'] : []),
  ];
  let ignore = '';
  try { ignore = await fs.readFile(ignoreFile, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const missing = required.filter(line => !ignore.split(/\r?\n/).includes(line));
  if (missing.length) {
    const prefix = ignore && !ignore.endsWith('\n') ? '\n' : '';
    await atomicWrite(root, ignoreFile, `${ignore}${prefix}\n# Feature Theater local state\n${missing.join('\n')}\n`);
  }
  const agentsFile = contained(root, 'AGENTS.md');
  if (!await exists(agentsFile)) {
    await atomicWrite(root, agentsFile, `# Feature Theater coordinator\n\nUse the feature-theater skill for this workspace. This directory coordinates feature clones; application work belongs in the selected features/<feature>/repo checkout.\n\nOn a feature switch, checkpoint the outgoing lane, call the switch tool, honor its compaction directive, then load only the destination context packet. Recover from .theater/index.md, the focused context, live Git state, and the saved agent session. Never expose private chain-of-thought or treat an agent report as test evidence.\n`);
  }
}

function featureAgentInstructions(root, feature) {
  const contextFile = contained(root, '.theater', 'features', feature.slug, 'context.md');
  const specFile = contained(root, '.theater', 'features', feature.slug, 'spec.md');
  return `# Feature Theater lane: ${feature.slug}

You are the implementation director for exactly one feature lane. Work only inside repo/; Feature Theater context lives outside the application checkout. You are a lane worker, not the Theater coordinator: do not invoke Feature Theater tools, alter other lanes, or recursively inspect or steer this task. Apps, hooks, plugins, browser/computer control, and external MCP servers are deliberately unavailable; route cross-lane and external-system needs through your visible handoff.

Before each turn, read:

1. ${contextFile}
2. ${specFile}
3. the repository's applicable AGENTS.md and other local instructions under repo/

Use the durable work graph in the context packet to choose the next useful work. Keep exploration bounded, use native subagents only for genuinely independent work, and verify outcomes against the spec. Do not edit Feature Theater state files directly. Do not put coordination artifacts into application commits.

The coordinator owns work-item claims, lease renewals and status changes; follow the assigned work key when provided. If that assigned item still appears ready or unowned, report the bookkeeping mismatch once and continue the authorized implementation without trying to claim it yourself. Surface a conflicting assignment or unmet prerequisite before proceeding with the affected work; your final report does not itself mark work done or create execution receipts.

Your visible updates and final messages may be recorded as safe progress summaries. Never reveal private chain-of-thought. Record exact commands, revisions, and observed outcomes in your visible handoff. Remote pushes, pull requests, merges, destructive cleanup, and new external authority require explicit user authorization.

The coordinator owns final Git staging and commits. Implement and verify the requested change, then report the exact modified paths and remaining work. If Git metadata writes are blocked by the workspace sandbox, preserve the diff and hand it back; do not seek broader permissions just to make a local commit.

Optional housekeeping must not delay a useful handoff. If removal of your own ignored temporary probes or fixtures cannot proceed within available permissions, retain them and finish with their exact paths, purpose and deferred cleanup noted; do not retry or seek escalation solely for that cleanup. Distinguish retained files from live services or residue that affects correctness: report those conditions and any required shutdown or verification still outstanding.
`;
}

async function writeFeatureAgentFile(ctx, feature) {
  const file = contained(ctx.root, 'features', feature.slug, 'AGENTS.md');
  await atomicWrite(ctx.root, file, featureAgentInstructions(ctx.root, feature));
}

async function writeEventLog(ctx, event) {
  const file = contained(ctx.root, '.theater', 'events.ndjson');
  await withWorkspaceLock(ctx.root, 'events', async () => {
    await ensureManagedPath(ctx.root, file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  });
}

async function addEvent(ctx, event) {
  const stored = recordEvent(ctx.db, event);
  await writeEventLog(ctx, {
    id: stored.id,
    feature: event.featureId ? ctx.db.prepare('SELECT slug FROM features WHERE id = ?').get(event.featureId)?.slug ?? null : null,
    kind: event.kind,
    summary: event.summary,
    details: event.details ?? {},
    created_at: stored.created_at,
  });
  return stored;
}

export async function writeIndex(ctx) {
  const focus = meta(ctx.db, 'focus') || '';
  const features = listFeatureRows(ctx.db, { includeArchived: true });
  const rows = features.map(feature => {
    const progress = progressFor(ctx.db, feature.id);
    return `| ${feature.slug === focus ? '→' : ''} | ${markdownCell(feature.slug)} | ${markdownCell(feature.status)} | ${progress.done}/${progress.total || 0} | ${markdownCell(feature.agent_status)} | ${markdownCell(feature.next_action || '—')} |`;
  });
  const managedLine = ctx.config.managedProject
    ? `Managed project: ${ctx.config.managedProject.name} · ${ctx.config.defaultBranch} @ ${ctx.config.defaultRevision.slice(0, 12)}\n`
    : '';
  const body = `# Feature Theater index

Focused feature: ${focus || 'none'}
${managedLine}Updated: ${now()}

| Focus | Feature | State | Work done | Agent | Next action |
| --- | --- | --- | ---: | --- | --- |
${rows.length ? rows.join('\n') : '| | _No features yet_ | | | | |'}

This is a compact navigation projection. Load one feature's context packet instead of every spec.
`;
  await atomicWrite(ctx.root, contained(ctx.root, '.theater', 'index.md'), body);
}

export async function writeFeatureContext(ctx, featureOrSlug) {
  const feature = typeof featureOrSlug === 'string' ? featureBySlug(ctx.db, safeSlug(featureOrSlug)) : featureOrSlug;
  const work = workItems(ctx.db, feature.id);
  const checkpoint = latestCheckpoint(ctx.db, feature.id);
  const evidence = evidenceRows(ctx.db, feature.id, 10);
  const pending = pendingRows(ctx.db, feature.id);
  const canonicalSpec = latestSpec(ctx.db, feature.id);
  if (canonicalSpec) await atomicWrite(ctx.root, contained(ctx.root, '.theater', 'features', feature.slug, 'spec.md'), `${canonicalSpec.content.trim()}\n`);
  let snapshot;
  try { snapshot = await repositorySnapshot(feature.checkout_path, feature.base_revision); }
  catch (error) { snapshot = { unavailable: error.message }; }
  const workLines = work.length
    ? work.map(item => `- [${item.status === 'done' ? 'x' : ' '}] ${item.item_key} · ${item.kind} · ${item.status}: ${item.title}${item.dependencies.length ? ` (after ${item.dependencies.join(', ')})` : ''}${item.blocker ? ` — ${item.blocker}` : ''}`).join('\n')
    : '- No work items yet.';
  const evidenceLines = evidence.length
    ? evidence.map(item => `- ${item.source === 'executed' ? 'EXECUTED' : 'REPORTED'} ${item.passed === true ? 'PASS' : item.passed === false ? 'FAIL' : 'NOTE'} · ${item.kind}: ${item.summary}${item.revision ? ` (${item.revision.slice(0, 12)})` : ''}`).join('\n')
    : '- No evidence recorded yet.';
  const packet = `# ${feature.title}\n\nFeature: ${feature.slug}\nStatus: ${feature.status}\nOutcome: ${feature.outcome}\nBase: ${feature.base_revision}\nBranch: ${feature.branch}\nSpec revision: ${feature.spec_revision}\nAgent: ${feature.agent_status}${feature.thread_id ? ` · thread ${feature.thread_id}` : ''}\n\n## Current checkpoint\n\n${checkpoint?.summary || feature.summary || 'No checkpoint yet.'}\n\nNext action: ${checkpoint?.next_action || feature.next_action || 'Refine the spec and plan the first bounded work.'}\n${feature.blocker ? `\nBlocker: ${feature.blocker}\n` : ''}\n${checkpoint?.unresolved?.length ? `\nUnresolved: ${checkpoint.unresolved.join('; ')}\n` : ''}\n## Work graph\n\n${workLines}\n\n## Evidence\n\n${evidenceLines}\n\n## Live facts\n\n- Checkout: ${feature.checkout_path}\n- HEAD: ${snapshot.head ?? 'unavailable'}\n- Working tree: ${snapshot.clean === true ? 'clean' : snapshot.clean === false ? `${snapshot.changedFileCount} changed path(s)` : 'unavailable'}\n- Pending agent requests: ${pending.length}\n- Compaction pending: ${feature.compaction_pending ? 'yes' : 'no'}\n\nRead spec.md beside this file for the complete current specification. Treat this packet as navigation, not a substitute for Git and executed checks.\n`;
  await atomicWrite(ctx.root, contained(ctx.root, '.theater', 'features', feature.slug, 'context.md'), packet);
  return { feature, work, checkpoint, evidence, pending, snapshot };
}

async function existingInitialization(root, normalized) {
  return await withContext(root, async ctx => {
    if (ctx.config.repository !== normalized.source) {
      throw new TheaterError(`This workspace already tracks ${ctx.config.repository}; refusing to replace it with ${normalized.source}. Use a fresh workspace directory for a different repository.`, 'REPOSITORY_MISMATCH');
    }
    return { initialized: false, alreadyInitialized: true, workspace: overview(ctx) };
  });
}

async function initializeSource(root, normalized, additions = {}) {
  const existingConfig = contained(root, 'theater.json');
  if (await exists(existingConfig)) return await existingInitialization(root, normalized);
  await fs.mkdir(contained(root, '.theater', 'features'), { recursive: true });
  const mirror = await initializeMirror(root, normalized.source);
  const profile = await profileRepository(root, mirror.defaultRevision);
  const config = {
    formatVersion: 1,
    workspaceId: randomUUID(),
    repository: normalized.source,
    repositoryKind: additions.managedProject ? 'managed' : normalized.kind,
    defaultRevision: mirror.defaultRevision,
    defaultBranch: mirror.defaultBranch,
    model: 'gpt-6-astra',
    createdAt: now(),
    repositoryProfile: profile,
    ...additions,
  };
  const db = initializeDatabase(root, config);
  const ctx = { root, config, db };
  try {
    await addEvent(ctx, {
      kind: additions.managedProject ? 'workspace.project_created' : 'workspace.initialized',
      summary: `${additions.managedProject ? 'Created managed project' : 'Initialized Feature Theater'} at ${mirror.defaultRevision.slice(0, 12)}.`,
      details: { defaultBranch: mirror.defaultBranch, ecosystems: profile.ecosystems },
    });
    await writeJson(root, existingConfig, config);
    await ensureWorkspaceFiles(root, config);
    await writeIndex(ctx);
    return {
      initialized: true,
      workspace: overview(ctx),
      repositoryProfile: profile,
      ...(additions.managedProject ? { managedProject: overview(ctx).managedProject } : {}),
      next: additions.managedProject
        ? 'Create a foundation feature lane, refine its specification, and start its agent.'
        : 'Create a feature lane, then refine and save its specification before starting its agent.',
    };
  } finally {
    db.close();
  }
}

function partialInitializationError() {
  return new TheaterError('A partial .theater directory already exists. Inspect it before retrying initialization.', 'PARTIAL_INITIALIZATION');
}

export async function initializeWorkspace({ workspace_path, repository }) {
  const root = await resolveWorkspace(workspace_path);
  const normalized = await normalizeRepositorySource(repository);
  const existingConfig = contained(root, 'theater.json');
  if (await exists(existingConfig)) return await existingInitialization(root, normalized);
  if (await exists(contained(root, '.theater'))) throw partialInitializationError();
  return await withWorkspaceLock(root, 'initialize', () => initializeSource(root, normalized));
}

export async function initializeManagedProject({ workspace_path, project_name, description, default_branch = 'main' }) {
  const root = await resolveWorkspace(workspace_path);
  const name = requiredText(project_name, 'project_name', { max: 200 });
  if (/\r|\n/.test(name)) throw new TheaterError('project_name must be one line.', 'INVALID_INPUT');
  const brief = requiredText(description, 'description', { max: 50_000 });
  const branch = requiredText(default_branch, 'default_branch', { max: 200 });
  const project = await ensureManagedPath(root, contained(root, 'project'));
  const existingConfig = contained(root, 'theater.json');
  if (await exists(existingConfig)) {
    return await withContext(root, async ctx => {
      if (!ctx.config.managedProject
        || ctx.config.managedProject.name !== name
        || ctx.config.managedProject.description !== brief
        || ctx.config.managedProject.defaultBranch !== branch) {
        throw new TheaterError('This workspace is already initialized for a different repository or managed project.', 'ALREADY_INITIALIZED');
      }
      const workspace = overview(ctx);
      return { initialized: false, alreadyInitialized: true, workspace, managedProject: workspace.managedProject };
    });
  }
  if (await exists(contained(root, '.theater'))) throw partialInitializationError();
  if (await exists(project)) throw new TheaterError(`Managed project path is occupied: ${project}`, 'PROJECT_PATH_OCCUPIED');
  await run(['git', 'check-ref-format', '--branch', branch], { cwd: root });
  return await withWorkspaceLock(root, 'initialize', async () => {
    if (await exists(project)) throw new TheaterError(`Managed project path is occupied: ${project}`, 'PROJECT_PATH_OCCUPIED');
    await fs.mkdir(project);
    await atomicWrite(root, contained(project, 'README.md'), `# ${name}\n\n${brief}\n`);
    await atomicWrite(root, contained(project, 'AGENTS.md'), `# Project instructions\n\nThis is the canonical source repository for ${name}. Implement only the currently selected Feature Theater specification, preserve unrelated work, and report exact checks and revisions. Do not add orchestration state to application commits.\n`);
    await run(['git', 'init', '-b', branch], { cwd: project });
    await run(['git', 'add', '--', 'README.md', 'AGENTS.md'], { cwd: project });
    await run([
      'git',
      '-c', `core.hooksPath=${contained(root, '.theater', 'disabled-hooks')}`,
      '-c', 'commit.gpgSign=false',
      '-c', 'user.name=Feature Theater',
      '-c', 'user.email=feature-theater@local.invalid',
      'commit', '-m', `Initialize ${name}`,
    ], { cwd: project });
    const normalized = await normalizeRepositorySource(project);
    const result = await initializeSource(root, normalized, {
      managedProject: { name, description: brief, path: project, defaultBranch: branch },
    });
    return result;
  });
}

export function overview(ctx) {
  return {
    workspaceId: ctx.config.workspaceId,
    root: ctx.root,
    repository: ctx.config.repository,
    defaultBranch: ctx.config.defaultBranch,
    defaultRevision: ctx.config.defaultRevision,
    model: ctx.config.model,
    managedProject: ctx.config.managedProject
      ? {
          name: ctx.config.managedProject.name,
          path: ctx.config.managedProject.path,
          defaultBranch: ctx.config.managedProject.defaultBranch,
        }
      : null,
    focus: meta(ctx.db, 'focus') || null,
    featureCount: Number(ctx.db.prepare('SELECT COUNT(*) AS count FROM features').get().count),
  };
}

export async function doctorWorkspace({ workspace_path }) {
  const root = await resolveWorkspace(workspace_path);
  const checks = [];
  for (const [name, argv] of [['Git', ['git', '--version']], ['Node', ['node', '--version']], ['Codex', ['codex', '--version']]]) {
    try { checks.push({ name, ok: true, detail: (await run(argv, { cwd: root, timeoutMs: 15_000 })).stdout.split(/\r?\n/)[0] }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  }
  try {
    const ctx = await loadWorkspace(root);
    try {
      const integrity = ctx.db.prepare('PRAGMA integrity_check').get().integrity_check;
      checks.push({ name: 'State database', ok: integrity === 'ok', detail: integrity });
      const mirror = await inspectMirror(root);
      checks.push({ name: 'Repository cache', ok: Boolean(mirror.defaultRevision), detail: `${mirror.defaultBranch || 'detached'} @ ${mirror.defaultRevision.slice(0, 12)}` });
      if (ctx.config.managedProject) {
        const project = await ensureManagedPath(root, contained(root, 'project'));
        const snapshot = await repositorySnapshot(project);
        const healthy = snapshot.clean && snapshot.branch === ctx.config.managedProject.defaultBranch;
        checks.push({
          name: 'Managed project',
          ok: healthy,
          detail: `${snapshot.branch || 'detached'} @ ${snapshot.head.slice(0, 12)} · ${snapshot.clean ? 'clean' : `${snapshot.changedFileCount} changed path(s)`}`,
        });
      }
      checks.push({ name: 'Feature paths', ok: true, detail: `${listFeatureRows(ctx.db, { includeArchived: true }).length} registered lane(s)` });
    } finally { ctx.db.close(); }
  } catch (error) {
    checks.push({ name: 'Workspace', ok: false, detail: error.message });
  }
  return { root, ok: checks.every(check => check.ok), checks };
}

export async function createFeature({ workspace_path, feature, title, outcome, base_revision, base_feature, priority = 0, spec }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const cleanTitle = requiredText(title || slug.replaceAll('-', ' '), 'title', { max: 200 });
  const cleanOutcome = requiredText(outcome, 'outcome', { max: 10_000 });
  const baseSlug = base_feature === undefined ? null : safeSlug(base_feature, 'base feature');
  if (baseSlug && (typeof base_revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base_revision))) {
    throw new TheaterError('base_feature requires an explicitly selected full commit ID in base_revision.', 'INVALID_REVISION');
  }
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new TheaterError('priority must be an integer from -100 to 100.', 'INVALID_INPUT');
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      if (ctx.db.prepare('SELECT 1 FROM features WHERE slug = ?').get(slug)) throw new TheaterError(`Feature already exists: ${slug}`, 'FEATURE_EXISTS');
      const baseSource = baseSlug ? featureBySlug(ctx.db, baseSlug) : null;
      const baseRepository = baseSource ? await ensureManagedPath(root, baseSource.checkout_path) : mirrorPath(root);
      const selectedBase = baseSource ? await verifyCheckoutRevision(baseRepository, base_revision) : null;
      if (selectedBase && selectedBase.toLowerCase() !== base_revision.toLowerCase()) {
        throw new TheaterError('base_revision must identify the exact source commit, not a hexadecimal ref name.', 'INVALID_REVISION');
      }
      const refreshed = await refreshMirror(root);
      const profile = await profileRepository(root, refreshed.defaultRevision);
      ctx.config.defaultRevision = refreshed.defaultRevision;
      ctx.config.defaultBranch = refreshed.defaultBranch;
      ctx.config.repositoryProfile = profile;
      const base = selectedBase || await resolveMirrorRevision(root, base_revision || refreshed.defaultRevision);
      const clone = await createFeatureCheckout(root, ctx.config, slug, base, baseRepository);
      const created = now();
      const id = newId('feature');
      const initialSpec = optionalText(spec, 'spec', { max: 500_000 });
      transaction(ctx.db, () => {
        meta(ctx.db, 'default_revision', refreshed.defaultRevision);
        meta(ctx.db, 'default_branch', refreshed.defaultBranch);
        ctx.db.prepare(`
          INSERT INTO features(id, slug, title, outcome, status, priority, base_revision, branch, checkout_path, spec_revision, summary, next_action, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, slug, cleanTitle, cleanOutcome, priority, base, clone.branch, clone.destination, initialSpec ? 1 : 0, 'Feature lane created.', initialSpec ? 'Plan the first bounded work from the accepted spec.' : 'Refine and save the feature specification.', created, created);
        if (initialSpec) ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, 1, ?, ?, ?)')
          .run(newId('spec'), id, initialSpec, 'Initial feature specification.', created);
        ctx.db.prepare('INSERT INTO checkpoints(id, feature_id, head_revision, summary, next_action, unresolved_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(newId('checkpoint'), id, base, 'Feature lane created.', initialSpec ? 'Plan the first bounded work from the accepted spec.' : 'Refine and save the feature specification.', '[]', created);
        if (!meta(ctx.db, 'focus')) meta(ctx.db, 'focus', slug);
      });
      const row = featureBySlug(ctx.db, slug);
      const specBody = initialSpec || `# ${cleanTitle}\n\n## Outcome\n\n${cleanOutcome}\n\n## User-visible behavior\n\n## Constraints and compatibility\n\n## Acceptance criteria\n\n## Out of scope\n\n## Open decisions\n`;
      await atomicWrite(root, contained(root, '.theater', 'features', slug, 'spec.md'), `${specBody.trim()}\n`);
      await writeFeatureAgentFile(ctx, row);
      await addEvent(ctx, { featureId: id, kind: 'feature.created', summary: `Created ${slug} from ${base.slice(0, 12)}.`, details: { branch: clone.branch, checkout: clone.destination, baseFeature: baseSlug, baseRevision: base } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      await writeJson(root, contained(root, 'theater.json'), ctx.config);
      return {
        feature: summarizeFeature(ctx, row),
        baseFeature: baseSlug,
        repositoryProfile: profile,
        contextPath: contained(root, '.theater', 'features', slug, 'context.md'),
        specPath: contained(root, '.theater', 'features', slug, 'spec.md'),
        next: initialSpec ? 'Review the saved spec and plan work items.' : 'Develop the spec with the user, then call theater_spec_update.',
      };
    } finally { ctx.db.close(); }
  });
}

function summarizeFeature(ctx, feature) {
  return {
    slug: feature.slug,
    title: feature.title,
    outcome: feature.outcome,
    status: feature.status,
    priority: feature.priority,
    progress: progressFor(ctx.db, feature.id),
    summary: feature.summary,
    nextAction: feature.next_action,
    blocker: feature.blocker || null,
    specRevision: feature.spec_revision,
    checkoutPath: feature.checkout_path,
    branch: feature.branch,
    baseRevision: feature.base_revision,
    agent: {
      status: feature.agent_status,
      threadId: feature.thread_id ?? null,
      activeTurnId: feature.active_turn_id ?? null,
    },
    compactionPending: feature.compaction_pending,
  };
}

export async function listFeatures({ workspace_path, include_archived = false, refresh_git = false }) {
  return await withContext(workspace_path, async ctx => {
    const focus = meta(ctx.db, 'focus') || null;
    const features = [];
    for (const feature of listFeatureRows(ctx.db, { includeArchived: Boolean(include_archived) })) {
      const result = summarizeFeature(ctx, recoverAgentState(ctx, feature));
      result.focused = feature.slug === focus;
      if (refresh_git) {
        try { result.git = await repositorySnapshot(feature.checkout_path, feature.base_revision); }
        catch (error) { result.git = { error: error.message }; }
      }
      features.push(result);
    }
    return { workspace: overview(ctx), features };
  });
}

export async function getFeatureContext({ workspace_path, feature, timeline_limit = 20 }) {
  return await withContext(workspace_path, async ctx => {
    const row = recoverAgentState(ctx, featureBySlug(ctx.db, safeSlug(feature)));
    reconcileReady(ctx.db, row.id);
    const projection = await writeFeatureContext(ctx, row);
    const spec = latestSpec(ctx.db, row.id);
    const timeline = timelineRows(ctx.db, row.id, timeline_limit);
    return {
      feature: summarizeFeature(ctx, featureBySlug(ctx.db, row.slug)),
      specification: spec ?? { revision: 0, content: await fs.readFile(contained(ctx.root, '.theater', 'features', row.slug, 'spec.md'), 'utf8') },
      workItems: projection.work,
      checkpoint: projection.checkpoint,
      evidence: projection.evidence,
      candidates: candidateRows(ctx.db, row.id),
      verification: verificationStatus(ctx, row, projection.snapshot.head),
      pendingAgentRequests: projection.pending,
      git: projection.snapshot,
      timeline,
      contextPath: contained(ctx.root, '.theater', 'features', row.slug, 'context.md'),
    };
  });
}

export async function updateSpec({ workspace_path, feature, content, rationale = '' }) {
  const cleanContent = requiredText(content, 'content', { max: 500_000 });
  const cleanRationale = optionalText(rationale, 'rationale', { max: 20_000 }) || '';
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const previous = latestSpec(ctx.db, row.id)?.content || '';
      if (previous.trim() === cleanContent.trim()) return { changed: false, revision: row.spec_revision, diff: { added: 0, removed: 0 } };
      const revision = row.spec_revision + 1;
      const stamp = now();
      transaction(ctx.db, () => {
        invalidateCandidates(ctx.db, row.id);
        ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newId('spec'), row.id, revision, cleanContent, cleanRationale, stamp);
        ctx.db.prepare('UPDATE features SET spec_revision = ?, updated_at = ?, next_action = ? WHERE id = ?')
          .run(revision, stamp, 'Reconcile the work graph with the revised specification.', row.id);
      });
      const diff = lineDiff(previous, cleanContent);
      await atomicWrite(root, contained(root, '.theater', 'features', slug, 'spec.md'), `${cleanContent}\n`);
      await addEvent(ctx, { featureId: row.id, kind: 'spec.revised', summary: `Saved spec revision ${revision} (+${diff.added}/-${diff.removed} logical lines).`, details: { revision, rationale: cleanRationale } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return { changed: true, revision, diff, specPath: contained(root, '.theater', 'features', slug, 'spec.md'), next: 'Update the durable work graph to reflect this revision.' };
    } finally { ctx.db.close(); }
  });
}

function workKey(value, name = 'work item key') {
  const key = requiredText(value, name, { max: 63 });
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,62}$/.test(key)) throw new TheaterError(`${name} has an invalid format.`, 'INVALID_WORK_KEY');
  return key;
}

function validateWorkGraph(db, featureId) {
  const items = workItems(db, featureId);
  const graph = new Map(items.map(item => [item.item_key, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  function visit(key, chain = []) {
    if (visiting.has(key)) throw new TheaterError(`Work graph cycle: ${[...chain, key].join(' -> ')}`, 'WORK_GRAPH_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) {
      if (!graph.has(dependency)) throw new TheaterError(`Unknown dependency ${dependency} for ${key}.`, 'UNKNOWN_DEPENDENCY');
      visit(dependency, [...chain, key]);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of graph.keys()) visit(key);
}

export function reconcileReady(db, featureId) {
  const items = workItems(db, featureId);
  const status = new Map(items.map(item => [item.item_key, item.status]));
  const updates = [];
  for (const item of items) {
    if (!['planned', 'ready'].includes(item.status)) continue;
    const runnable = item.dependencies.every(key => status.get(key) === 'done');
    const next = runnable ? 'ready' : 'planned';
    if (next !== item.status) updates.push([next, now(), item.id]);
  }
  const statement = db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?');
  for (const update of updates) statement.run(...update);
  return updates.length;
}

export async function planWork({ workspace_path, feature, items }) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw new TheaterError('items must contain 1 to 200 work items.', 'INVALID_INPUT');
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TheaterError(`items[${index}] must be an object.`, 'INVALID_INPUT');
    const key = workKey(item.key, `items[${index}].key`);
    const kind = item.kind || 'build';
    if (!WORK_KINDS.has(kind)) throw new TheaterError(`Unknown work kind: ${kind}`, 'INVALID_INPUT');
    const priority = item.priority ?? 0;
    if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new TheaterError(`Invalid priority for ${key}.`, 'INVALID_INPUT');
    const dependencies = item.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.length > 100) throw new TheaterError(`Invalid dependencies for ${key}.`, 'INVALID_INPUT');
    return {
      key,
      title: requiredText(item.title, `${key}.title`, { max: 500 }),
      description: optionalText(item.description, `${key}.description`, { max: 50_000 }) || '',
      acceptance: optionalText(item.acceptance, `${key}.acceptance`, { max: 50_000 }) || '',
      kind,
      priority,
      dependencies: [...new Set(dependencies.map(dep => workKey(dep, `${key}.dependency`)))],
    };
  });
  if (new Set(normalized.map(item => item.key)).size !== normalized.length) throw new TheaterError('Work item keys must be unique in one plan call.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      assertAgentIdle(row);
      const previousContract = featureContract(ctx.db, row);
      const stamp = now();
      transaction(ctx.db, () => {
        const existing = workItems(ctx.db, row.id);
        const byKey = new Map(existing.map(item => [item.item_key, item]));
        const immutable = new Set();
        for (const item of normalized) {
          const found = byKey.get(item.key);
          if (found) {
            const definitionChanged = found.title !== item.title
              || found.description !== item.description
              || found.kind !== item.kind
              || Number(found.priority) !== item.priority
              || found.acceptance !== item.acceptance
              || JSON.stringify([...found.dependencies].sort()) !== JSON.stringify([...item.dependencies].sort());
            if (['running', 'review', 'done', 'cancelled'].includes(found.status)) {
              if (definitionChanged) throw new TheaterError(`${found.status} item ${item.key} is immutable; add a new repair or follow-up item.`, 'INVALID_TRANSITION');
              immutable.add(item.key);
              continue;
            }
            ctx.db.prepare(`UPDATE work_items SET title = ?, description = ?, kind = ?, status = ?, priority = ?, acceptance = ?, updated_at = ? WHERE id = ?`)
              .run(item.title, item.description, item.kind, found.status, item.priority, item.acceptance, stamp, found.id);
          } else {
            const id = newId('work');
            ctx.db.prepare(`INSERT INTO work_items(id, feature_id, item_key, title, description, kind, status, priority, acceptance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(id, row.id, item.key, item.title, item.description, item.kind, 'planned', item.priority, item.acceptance, stamp, stamp);
            byKey.set(item.key, { id, item_key: item.key, status: 'planned' });
          }
        }
        for (const item of normalized) {
          if (immutable.has(item.key)) continue;
          const id = byKey.get(item.key).id;
          ctx.db.prepare('DELETE FROM work_dependencies WHERE work_item_id = ?').run(id);
          for (const dependency of item.dependencies) {
            const target = byKey.get(dependency) ?? ctx.db.prepare('SELECT id FROM work_items WHERE feature_id = ? AND item_key = ?').get(row.id, dependency);
            if (!target) throw new TheaterError(`Unknown dependency ${dependency} for ${item.key}.`, 'UNKNOWN_DEPENDENCY');
            ctx.db.prepare('INSERT INTO work_dependencies(work_item_id, depends_on_id) VALUES (?, ?)').run(id, target.id);
          }
        }
        validateWorkGraph(ctx.db, row.id);
        reconcileReady(ctx.db, row.id);
        if (previousContract !== featureContract(ctx.db, row)) invalidateCandidates(ctx.db, row.id);
        ctx.db.prepare('UPDATE features SET next_action = ?, updated_at = ? WHERE id = ?').run('Start or continue the highest-priority ready work.', stamp, row.id);
      });
      await addEvent(ctx, { featureId: row.id, kind: 'work.planned', summary: `Reconciled ${normalized.length} work item(s) with spec revision ${row.spec_revision}.`, details: { keys: normalized.map(item => item.key) } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { feature: summarizeFeature(ctx, current), workItems: workItems(ctx.db, row.id), next: 'Claim the selected ready work with theater_work_update, then dispatch its key and outcome to the feature agent.' };
    } finally { ctx.db.close(); }
  });
}

const ALLOWED_WORK_TRANSITIONS = {
  planned: new Set(['planned', 'ready', 'running', 'blocked', 'cancelled']),
  ready: new Set(['planned', 'ready', 'running', 'blocked', 'cancelled']),
  running: new Set(['running', 'blocked', 'review', 'done', 'failed', 'cancelled']),
  blocked: new Set(['planned', 'ready', 'running', 'blocked', 'cancelled']),
  review: new Set(['running', 'review', 'done', 'failed', 'cancelled']),
  failed: new Set(['planned', 'ready', 'running', 'failed', 'cancelled']),
  done: new Set(['done']),
  cancelled: new Set(['cancelled']),
};

export async function updateWork({ workspace_path, feature, key, status, owner, summary, blocker, result_revision, lease_seconds = 3600 }) {
  if (!WORK_STATUSES.has(status)) throw new TheaterError(`Unknown work status: ${status}`, 'INVALID_INPUT');
  if (!Number.isInteger(lease_seconds) || lease_seconds < 60 || lease_seconds > 86_400) throw new TheaterError('lease_seconds must be from 60 to 86400.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const itemKey = workKey(key);
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const featureWork = workItems(ctx.db, row.id);
      const item = featureWork.find(candidate => candidate.item_key === itemKey);
      if (!item) throw new TheaterError(`Unknown work item: ${itemKey}`, 'WORK_ITEM_NOT_FOUND');
      if (!ALLOWED_WORK_TRANSITIONS[item.status]?.has(status)) throw new TheaterError(`Invalid work transition: ${item.status} -> ${status}`, 'INVALID_TRANSITION');
      const cleanOwner = optionalText(owner, 'owner', { max: 200 });
      const cleanSummary = optionalText(summary, 'summary', { max: 50_000 }) || '';
      const cleanBlocker = optionalText(blocker, 'blocker', { max: 20_000 }) || '';
      if (status === 'running' && !cleanOwner) throw new TheaterError('Running work requires an owner.', 'INVALID_INPUT');
      if (status === 'done' && !cleanSummary) throw new TheaterError('Completed work requires a result summary.', 'INVALID_INPUT');
      if (['blocked', 'failed'].includes(status) && !cleanBlocker) throw new TheaterError(`${status} work requires a blocker or failure description.`, 'INVALID_INPUT');
      if (status === 'running') {
        const statuses = new Map(featureWork.map(candidate => [candidate.item_key, candidate.status]));
        const waitingOn = item.dependencies.filter(dependency => statuses.get(dependency) !== 'done');
        if (waitingOn.length) throw new TheaterError(`${itemKey} is waiting on: ${waitingOn.join(', ')}.`, 'DEPENDENCY_NOT_READY');
      }
      let revision = optionalText(result_revision, 'result_revision', { max: 200 });
      if (revision) revision = await verifyCheckoutRevision(row.checkout_path, revision);
      if (item.status === 'running' && item.owner && item.owner !== cleanOwner && item.lease_expires_at && item.lease_expires_at > now()) {
        throw new TheaterError(`${itemKey} is leased to ${item.owner} until ${item.lease_expires_at}.`, 'WORK_LEASED');
      }
      const lease = status === 'running' ? new Date(Date.now() + lease_seconds * 1000).toISOString() : null;
      const clearResultRevision = ['planned', 'ready', 'running'].includes(status);
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`UPDATE work_items SET status = ?, owner = ?, result_summary = ?, blocker = ?, result_revision = CASE WHEN ? THEN NULL ELSE COALESCE(?, result_revision) END, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
          .run(status, status === 'running' ? cleanOwner : item.owner, cleanSummary, cleanBlocker, clearResultRevision ? 1 : 0, revision ?? null, lease, stamp, item.id);
        reconcileReady(ctx.db, row.id);
        ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(stamp, row.id);
      });
      await addEvent(ctx, { featureId: row.id, workItemId: item.id, kind: `work.${status}`, summary: `${itemKey} is ${status}${cleanSummary ? `: ${cleanSummary}` : cleanBlocker ? `: ${cleanBlocker}` : '.'}`, details: { owner: cleanOwner, revision, leaseExpiresAt: lease } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { item: workItems(ctx.db, row.id).find(candidate => candidate.item_key === itemKey), feature: summarizeFeature(ctx, current) };
    } finally { ctx.db.close(); }
  });
}

function cleanStringArray(value, name, max = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new TheaterError(`${name} must be an array with at most ${max} entries.`, 'INVALID_INPUT');
  return value.map((entry, index) => requiredText(entry, `${name}[${index}]`, { max: 20_000 }));
}

export async function checkpointFeature({ workspace_path, feature, summary, next_action, unresolved = [] }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const cleanSummary = requiredText(summary, 'summary', { max: 50_000 });
  const next = requiredText(next_action, 'next_action', { max: 20_000 });
  const openQuestions = cleanStringArray(unresolved, 'unresolved');
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const snapshot = await repositorySnapshot(row.checkout_path, row.base_revision);
      const stamp = now();
      const id = newId('checkpoint');
      transaction(ctx.db, () => {
        ctx.db.prepare('INSERT INTO checkpoints(id, feature_id, head_revision, dirty_summary, summary, next_action, unresolved_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, row.id, snapshot.head, snapshot.clean ? 'clean' : `${snapshot.changedFileCount} changed path(s)`, cleanSummary, next, JSON.stringify(openQuestions), stamp);
        ctx.db.prepare('UPDATE features SET summary = ?, next_action = ?, compaction_pending = 1, updated_at = ? WHERE id = ?').run(cleanSummary, next, stamp, row.id);
      });
      await addEvent(ctx, { featureId: row.id, kind: 'feature.checkpointed', summary: cleanSummary, details: { head: snapshot.head, clean: snapshot.clean, nextAction: next, unresolved: openQuestions } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { checkpointId: id, feature: summarizeFeature(ctx, current), git: snapshot, compaction: { featureSession: Boolean(row.thread_id), metaSession: 'recommended_at_switch' } };
    } finally { ctx.db.close(); }
  });
}

export async function switchFeature({ workspace_path, feature }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const destination = featureBySlug(ctx.db, slug);
      if (destination.status === 'archived') throw new TheaterError('Archived features cannot become the active focus.', 'INVALID_TRANSITION');
      const outgoingSlug = meta(ctx.db, 'focus') || null;
      if (outgoingSlug === slug) {
        const packet = await writeFeatureContext(ctx, destination);
        return { changed: false, focus: slug, feature: summarizeFeature(ctx, destination), git: packet.snapshot, coordinatorCompactionRecommended: false };
      }
      let outgoing = null;
      if (outgoingSlug) {
        outgoing = featureBySlug(ctx.db, outgoingSlug);
        const checkpoint = latestCheckpoint(ctx.db, outgoing.id);
        if (!checkpoint || checkpoint.created_at < outgoing.updated_at) throw new TheaterError(`Checkpoint ${outgoing.slug} after its latest change before switching.`, 'CHECKPOINT_REQUIRED');
      }
      const stamp = now();
      transaction(ctx.db, () => {
        if (outgoing) ctx.db.prepare('UPDATE features SET compaction_pending = 1, updated_at = ? WHERE id = ?').run(stamp, outgoing.id);
        meta(ctx.db, 'focus', slug);
      });
      await addEvent(ctx, { featureId: destination.id, kind: 'focus.switched', summary: `Focused ${slug}${outgoing ? ` after checkpointing ${outgoing.slug}` : ''}.`, details: { from: outgoing?.slug ?? null, to: slug } });
      const current = featureBySlug(ctx.db, slug);
      const packet = await writeFeatureContext(ctx, current);
      if (outgoing) await writeFeatureContext(ctx, outgoing.slug);
      await writeIndex(ctx);
      return {
        changed: true,
        from: outgoing ? summarizeFeature(ctx, featureBySlug(ctx.db, outgoing.slug)) : null,
        focus: slug,
        feature: summarizeFeature(ctx, current),
        contextPath: contained(root, '.theater', 'features', slug, 'context.md'),
        git: packet.snapshot,
        compactFeatureThreadId: outgoing?.thread_id ?? null,
        coordinatorCompactionRecommended: Boolean(outgoing),
        compactionDirective: outgoing
          ? 'Compact the outgoing feature session now if idle. The coordinator has a durable semantic checkpoint; recommend /compact after this response when the outgoing lane contributed substantial context, then reload only the destination packet.'
          : 'Load only the destination context packet.',
      };
    } finally { ctx.db.close(); }
  });
}

export async function setFeatureStatus({ workspace_path, feature, status, blocker, disposition }) {
  if (!FEATURE_STATUSES.has(status)) throw new TheaterError(`Unknown feature status: ${status}`, 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withCheckoutLock(root, slug, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (row.status === status && status === 'archived') return { feature: summarizeFeature(ctx, row), unchanged: true };
      const cleanBlocker = optionalText(blocker, 'blocker', { max: 20_000 }) || '';
      const cleanDisposition = optionalText(disposition, 'disposition', { max: 20_000 }) || '';
      if (status === 'blocked' && !cleanBlocker) throw new TheaterError('A blocked feature requires a blocker.', 'INVALID_INPUT');
      if (status === 'archived' && !cleanDisposition) throw new TheaterError('Archiving requires a disposition.', 'INVALID_INPUT');
      let completionCandidate = null;
      if (status === 'done') {
        assertAgentIdle(row);
        const progress = progressFor(ctx.db, row.id);
        if (progress.open > 0) throw new TheaterError(`Feature still has ${progress.open} open work item(s).`, 'COMPLETION_NOT_PROVEN');
        completionCandidate = ctx.db.prepare("SELECT * FROM candidates WHERE feature_id = ? AND status IN ('ready','accepted') ORDER BY rowid DESC LIMIT 1").get(row.id);
        if (!completionCandidate) throw new TheaterError('Feature completion requires a ready integration candidate.', 'COMPLETION_NOT_PROVEN');
        const snapshot = await repositorySnapshot(row.checkout_path, row.base_revision);
        if (!snapshot.clean || snapshot.head !== completionCandidate.revision) throw new TheaterError('The ready candidate must still be the clean checkout HEAD.', 'STALE_CANDIDATE');
        assertVerified(ctx, row, completionCandidate.revision, completionCandidate);
        if (row.status === status) return { feature: summarizeFeature(ctx, row), unchanged: true };
      }
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare('UPDATE features SET status = ?, blocker = ?, summary = CASE WHEN ? <> \'\' THEN ? ELSE summary END, updated_at = ? WHERE id = ?')
          .run(status, cleanBlocker, cleanDisposition, cleanDisposition, stamp, row.id);
        if (completionCandidate) ctx.db.prepare("UPDATE candidates SET status = 'accepted' WHERE id = ?").run(completionCandidate.id);
      });
      await addEvent(ctx, { featureId: row.id, kind: `feature.${status}`, summary: cleanDisposition || cleanBlocker || `Feature marked ${status}.`, details: {} });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { feature: summarizeFeature(ctx, current) };
    } finally { ctx.db.close(); }
  });
}

export async function recordEvidence({ workspace_path, feature, work_item, kind, summary, command, artifact, revision, passed }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const evidenceKind = requiredText(kind, 'kind', { max: 100 });
  const cleanSummary = requiredText(summary, 'summary', { max: 50_000 });
  if (passed !== undefined && typeof passed !== 'boolean') throw new TheaterError('passed must be true or false.', 'INVALID_INPUT');
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      let work = null;
      if (work_item) {
        work = ctx.db.prepare('SELECT * FROM work_items WHERE feature_id = ? AND item_key = ?').get(row.id, workKey(work_item));
        if (!work) throw new TheaterError(`Unknown work item: ${work_item}`, 'WORK_ITEM_NOT_FOUND');
      }
      let resolved = optionalText(revision, 'revision', { max: 200 });
      if (resolved) resolved = await verifyCheckoutRevision(row.checkout_path, resolved);
      const id = newId('evidence');
      const stamp = now();
      ctx.db.prepare('INSERT INTO evidence(id, feature_id, work_item_id, kind, summary, command, artifact, revision, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, row.id, work?.id ?? null, evidenceKind, cleanSummary, optionalText(command, 'command', { max: 20_000 }) ?? null, optionalText(artifact, 'artifact', { max: 4_096 }) ?? null, resolved ?? null, passed === undefined ? null : passed ? 1 : 0, stamp);
      ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(stamp, row.id);
      await addEvent(ctx, { featureId: row.id, workItemId: work?.id ?? null, kind: 'evidence.recorded', summary: `${passed === true ? 'PASS' : passed === false ? 'FAIL' : 'NOTE'} · ${evidenceKind}: ${cleanSummary}`, details: { revision: resolved, artifact: artifact ?? null } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      return { evidenceId: id, feature: slug, revision: resolved ?? null };
    } finally { ctx.db.close(); }
  });
}

export async function recordCandidate({ workspace_path, feature, revision = 'HEAD', summary, checks, allow_dirty = false }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const cleanSummary = requiredText(summary, 'summary', { max: 50_000 });
  const cleanChecks = cleanStringArray(checks, 'checks');
  if (!cleanChecks.length) throw new TheaterError('A candidate requires at least one executed check.', 'COMPLETION_NOT_PROVEN');
  return await withCheckoutLock(root, slug, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      assertAgentIdle(row);
      const resolved = await verifyCheckoutRevision(row.checkout_path, revision);
      const snapshot = await repositorySnapshot(row.checkout_path, row.base_revision);
      if (snapshot.head !== resolved) throw new TheaterError(`Candidate ${resolved.slice(0, 12)} is not the checkout HEAD ${snapshot.head.slice(0, 12)}.`, 'STALE_CANDIDATE');
      if (allow_dirty || !snapshot.clean) throw new TheaterError('Candidates require a clean committed checkout.', 'DIRTY_CANDIDATE');
      const verification = assertVerified(ctx, row, resolved);
      const changes = await diffSummary(row.checkout_path, row.base_revision, resolved);
      const id = newId('candidate');
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare("UPDATE candidates SET status = 'superseded' WHERE feature_id = ? AND status = 'ready'").run(row.id);
        ctx.db.prepare('INSERT INTO candidates(id, feature_id, revision, base_revision, summary, checks_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'ready\', ?)')
          .run(id, row.id, resolved, row.base_revision, cleanSummary, JSON.stringify(cleanChecks), stamp);
        ctx.db.prepare('UPDATE candidates SET spec_revision = ?, contract_hash = ? WHERE id = ?').run(row.spec_revision, verification.contractHash, id);
        ctx.db.prepare("UPDATE features SET status = 'review', summary = ?, next_action = ?, updated_at = ? WHERE id = ?")
          .run(cleanSummary, 'Review or integrate the exact recorded candidate.', stamp, row.id);
      });
      await addEvent(ctx, { featureId: row.id, kind: 'candidate.recorded', summary: `Recorded candidate ${resolved.slice(0, 12)} with ${cleanChecks.length} check(s).`, details: { candidateId: id, checks: cleanChecks, clean: snapshot.clean } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { candidateId: id, revision: resolved, baseRevision: row.base_revision, checks: cleanChecks, changes, feature: summarizeFeature(ctx, current) };
    } finally { ctx.db.close(); }
  });
}

async function isGitAncestor(repository, ancestor, descendant) {
  try {
    await run(['git', 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: repository });
    return true;
  } catch (error) {
    if (error?.code === 'COMMAND_FAILED') return false;
    throw error;
  }
}

export async function promoteManagedCandidate({ workspace_path, feature, revision, summary }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const cleanSummary = optionalText(summary, 'summary', { max: 50_000 });
  // Promotion changes the revision used by lane creation, so both operations share one lock.
  return await withCheckoutLock(root, slug, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const managed = ctx.config.managedProject;
      if (!managed) {
        throw new TheaterError('Candidate promotion is built in only for projects created by Feature Theater. Use the repository\'s normal review and integration flow for an adopted repository.', 'NOT_MANAGED_PROJECT');
      }
      const project = await ensureManagedPath(root, contained(root, 'project'));
      if (path.resolve(managed.path) !== project) throw new TheaterError('Managed project path does not match this workspace.', 'INVALID_STATE');
      const row = featureBySlug(ctx.db, slug);
      if (row.status !== 'done') throw new TheaterError('Complete the feature evidence and candidate gates before promotion.', 'PROMOTION_NOT_READY');
      assertAgentIdle(row);
      let resolved = optionalText(revision, 'revision', { max: 200 });
      if (resolved) resolved = await verifyCheckoutRevision(row.checkout_path, resolved);
      const candidate = resolved
        ? ctx.db.prepare("SELECT * FROM candidates WHERE feature_id = ? AND revision = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1").get(row.id, resolved)
        : ctx.db.prepare("SELECT * FROM candidates WHERE feature_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1").get(row.id);
      if (!candidate) throw new TheaterError('No accepted candidate matches this promotion request.', 'PROMOTION_NOT_READY');
      assertVerified(ctx, row, candidate.revision, candidate);
      const featureSnapshot = await repositorySnapshot(row.checkout_path, row.base_revision);
      if (!featureSnapshot.clean || featureSnapshot.head !== candidate.revision) {
        throw new TheaterError('The accepted candidate must still be the clean feature checkout HEAD.', 'STALE_CANDIDATE');
      }
      const projectSnapshot = await repositorySnapshot(project);
      if (!projectSnapshot.clean) throw new TheaterError('The managed project has uncommitted changes; preserve or resolve them before promotion.', 'DIRTY_MANAGED_PROJECT');
      if (projectSnapshot.branch !== managed.defaultBranch) {
        throw new TheaterError(`Managed project must be on ${managed.defaultBranch}, not ${projectSnapshot.branch || 'a detached HEAD'}.`, 'WRONG_MANAGED_BRANCH');
      }
      const candidateRef = `refs/feature-theater/candidates/${slug}/${candidate.revision}`;
      await run(['git', 'fetch', '--no-tags', row.checkout_path, `${candidate.revision}:${candidateRef}`], { cwd: project });
      const fetched = await verifyCheckoutRevision(project, candidateRef);
      if (fetched !== candidate.revision) throw new TheaterError('Fetched candidate revision does not match the accepted candidate.', 'STALE_CANDIDATE');
      const alreadyIncluded = await isGitAncestor(project, candidate.revision, projectSnapshot.head);
      if (!alreadyIncluded) {
        const canFastForward = await isGitAncestor(project, projectSnapshot.head, candidate.revision);
        if (!canFastForward) {
          throw new TheaterError('The managed project and candidate have diverged. Rebase or repair the feature lane; Feature Theater will not synthesize or resolve a merge silently.', 'PROMOTION_NOT_FAST_FORWARD');
        }
        await run(['git', '-c', `core.hooksPath=${contained(root, '.theater', 'disabled-hooks')}`, 'merge', '--ff-only', candidateRef], { cwd: project });
      }
      const promotedSnapshot = await repositorySnapshot(project);
      if (!promotedSnapshot.clean || !await isGitAncestor(project, candidate.revision, promotedSnapshot.head)) {
        throw new TheaterError('Managed project verification failed after promotion.', 'PROMOTION_FAILED');
      }
      const refreshed = await refreshMirror(root);
      const profile = await profileRepository(root, refreshed.defaultRevision);
      ctx.config.defaultRevision = refreshed.defaultRevision;
      ctx.config.defaultBranch = refreshed.defaultBranch;
      ctx.config.repositoryProfile = profile;
      const stamp = now();
      transaction(ctx.db, () => {
        meta(ctx.db, 'default_revision', refreshed.defaultRevision);
        meta(ctx.db, 'default_branch', refreshed.defaultBranch);
        if (!alreadyIncluded) {
          ctx.db.prepare('UPDATE features SET summary = ?, next_action = ?, updated_at = ? WHERE id = ?')
            .run(cleanSummary || candidate.summary, 'Create the next feature lane from the promoted managed-project revision.', stamp, row.id);
        }
      });
      await writeJson(root, contained(root, 'theater.json'), ctx.config);
      if (!alreadyIncluded) {
        await addEvent(ctx, {
          featureId: row.id,
          kind: 'candidate.promoted',
          summary: cleanSummary || `Promoted ${candidate.revision.slice(0, 12)} to ${managed.defaultBranch}.`,
          details: { revision: candidate.revision, project, branch: managed.defaultBranch },
        });
      }
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return {
        promoted: !alreadyIncluded,
        alreadyIncluded,
        feature: slug,
        candidateRevision: candidate.revision,
        managedProject: { path: project, branch: managed.defaultBranch, head: promotedSnapshot.head },
        repositoryProfile: profile,
        next: 'New feature lanes now start from the refreshed managed-project revision.',
      };
    } finally { ctx.db.close(); }
  });
}

function timelineRows(db, featureId, limit = 30) {
  const bounded = Math.max(1, Math.min(Number(limit) || 30, 200));
  return db.prepare('SELECT id, kind, summary, details_json, created_at FROM events WHERE feature_id = ? ORDER BY id DESC LIMIT ?').all(featureId, bounded)
    .map(row => ({ id: Number(row.id), kind: row.kind, summary: row.summary, details: parseJson(row.details_json, {}), createdAt: row.created_at }));
}

export async function readTimeline({ workspace_path, feature, limit = 30 }) {
  return await withContext(workspace_path, async ctx => {
    const row = featureBySlug(ctx.db, safeSlug(feature));
    return { feature: row.slug, events: timelineRows(ctx.db, row.id, limit), safety: 'Only explicit instructions, visible messages/plans, Git facts, and generated progress summaries are recorded. Private reasoning is excluded.' };
  });
}

export async function featureRuntime({ workspace_path, feature, allow_inactive = false }) {
  return await withContext(workspace_path, async ctx => {
    const row = recoverAgentState(ctx, featureBySlug(ctx.db, safeSlug(feature)));
    if (!allow_inactive && ['paused', 'done', 'archived'].includes(row.status)) throw new TheaterError(`Feature ${row.slug} is ${row.status}; resume or reactivate it before starting work.`, 'INVALID_TRANSITION');
    const packet = await writeFeatureContext(ctx, row);
    await writeFeatureAgentFile(ctx, row);
    return {
      root: ctx.root,
      feature: row,
      contextPath: contained(ctx.root, '.theater', 'features', row.slug, 'context.md'),
      specPath: contained(ctx.root, '.theater', 'features', row.slug, 'spec.md'),
      agentFile: contained(ctx.root, 'features', row.slug, 'AGENTS.md'),
      work: packet.work,
      developerInstructions: featureAgentInstructions(ctx.root, row),
    };
  });
}

export async function saveAgentSession({ workspace_path, feature, thread_id, turn_id = null, status, summary = undefined, compacted = false, owner_token, only_if_starting = false }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || (only_if_starting && row.agent_status !== 'starting')) return { ignored: true };
      const cleanSummary = summary ? requiredText(summary, 'summary', { max: 100_000 }) : undefined;
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`UPDATE features SET thread_id = ?, active_turn_id = ?, agent_status = ?, summary = COALESCE(?, summary), compaction_pending = CASE WHEN ? THEN 0 ELSE compaction_pending END, updated_at = ? WHERE id = ?`)
          .run(thread_id, turn_id, status, cleanSummary ?? null, compacted ? 1 : 0, stamp, row.id);
        if (status === 'disconnected') {
          ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND thread_id = ? AND status = 'pending'").run(stamp, row.id, thread_id);
        }
      });
      if (cleanSummary) await addEvent(ctx, { featureId: row.id, kind: `agent.${status}`, summary: cleanSummary, details: { threadId: thread_id, turnId: turn_id } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return summarizeFeature(ctx, featureBySlug(ctx.db, slug));
    } finally { ctx.db.close(); }
  });
}

export async function recordAgentEvent({ workspace_path, feature, kind, summary, details = {}, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
      const cleanSummary = requiredText(summary, 'summary', { max: 100_000 });
      return await addEvent(ctx, { featureId: row.id, kind, summary: cleanSummary, details });
    } finally { ctx.db.close(); }
  });
}

export async function savePendingAgentRequest({ workspace_path, feature, request_id, thread_id, turn_id, method, summary, payload, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
      const stamp = now();
      ctx.db.prepare(`INSERT OR REPLACE INTO pending_agent_requests(request_id, feature_id, thread_id, turn_id, method, summary, payload_json, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`)
        .run(String(request_id), row.id, thread_id, turn_id ?? null, method, summary, JSON.stringify(payload ?? {}), stamp);
      ctx.db.prepare("UPDATE features SET agent_status = 'waiting_for_user', updated_at = ? WHERE id = ?").run(stamp, row.id);
      await addEvent(ctx, { featureId: row.id, kind: 'agent.input_required', summary, details: { requestId: String(request_id), method } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return { requestId: String(request_id), feature: slug };
    } finally { ctx.db.close(); }
  });
}

export async function pendingAgentRequest({ workspace_path, feature, request_id }) {
  return await withContext(workspace_path, async ctx => {
    const row = featureBySlug(ctx.db, safeSlug(feature));
    const request = ctx.db.prepare("SELECT * FROM pending_agent_requests WHERE feature_id = ? AND request_id = ? AND status = 'pending'").get(row.id, String(request_id));
    if (!request) throw new TheaterError(`No pending request ${request_id} for ${row.slug}.`, 'REQUEST_NOT_FOUND');
    return { ...request, payload: parseJson(request.payload_json, {}) };
  });
}

export async function resolveAgentRequestRecord({ workspace_path, feature, request_id, summary, status = 'resolved', owner_token, thread_id, ignore_missing = false }) {
  if (!['resolved', 'orphaned'].includes(status)) throw new TheaterError('Request resolution status is invalid.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
      const result = ctx.db.prepare("UPDATE pending_agent_requests SET status = ?, resolved_at = ? WHERE feature_id = ? AND request_id = ? AND status = 'pending' AND (? IS NULL OR thread_id = ?)").run(status, now(), row.id, String(request_id), thread_id ?? null, thread_id ?? null);
      if (!result.changes && ignore_missing) return { ignored: true };
      if (!result.changes) throw new TheaterError(`No pending request ${request_id} for ${slug}.`, 'REQUEST_NOT_FOUND');
      ctx.db.prepare(`UPDATE features SET agent_status = CASE
        WHEN active_turn_id IS NULL AND agent_status <> 'waiting_for_user' THEN agent_status
        WHEN EXISTS (SELECT 1 FROM pending_agent_requests WHERE feature_id = features.id AND status = 'pending') THEN 'waiting_for_user'
        WHEN active_turn_id IS NULL THEN 'idle' ELSE 'running' END, updated_at = ? WHERE id = ?`).run(now(), row.id);
      await addEvent(ctx, { featureId: row.id, kind: status === 'resolved' ? 'agent.input_resolved' : 'agent.input_orphaned', summary: requiredText(summary, 'summary', { max: 20_000 }), details: { requestId: String(request_id) } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return { status };
    } finally { ctx.db.close(); }
  });
}

export async function markCompacted({ workspace_path, feature, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
      ctx.db.prepare('UPDATE features SET compaction_pending = 0 WHERE id = ?').run(row.id);
      await addEvent(ctx, { featureId: row.id, kind: 'agent.compacted', summary: 'Compacted the feature agent at a saved checkpoint.', details: { threadId: row.thread_id } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return summarizeFeature(ctx, current);
    } finally { ctx.db.close(); }
  });
}

export async function queueCompaction({ workspace_path, feature, owner_token }) {
  return withContext(workspace_path, async ctx => {
    const row = featureBySlug(ctx.db, safeSlug(feature));
    if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
    ctx.db.prepare('UPDATE features SET compaction_pending = 1 WHERE id = ?').run(row.id);
    return { queued: true };
  });
}
