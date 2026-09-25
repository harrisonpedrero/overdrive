import { createHash, randomUUID } from 'node:crypto';
import { assertAgentIdle, assertVerified, assertWorkersStopped, captureFeatureContract, featureChecks, verificationStatus } from './verification.mjs';
import { AGENT_BUSY_SQL, DESCENDANTS_CLEAR_SQL, WORKERS_CLEAR_SQL, descendantsKey, ownsAgent, recoverAgentState, unconfirmedDescendants, workersKey } from './ownership.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codexExecutable } from './app-server.mjs';
import { claudeExecutable, normalizeWorkerOptions } from './claude-worker.mjs';
import {
  OverdriveError,
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
  writeJson, STATE_DIR, CONFIG_FILE,
} from './util.mjs';
import {
  createFeatureCheckout,
  diffSummary,
  initializeMirror,
  inspectMirror,
  mirrorPath,
  profileRepository,
  readCommitIdentity,
  refreshMirror,
  repositorySnapshot,
  resolveMirrorRevision,
  verifyCheckoutRevision,
} from './git.mjs';
import {
  assertBoundCheckout,
  bindCandidateChecks,
  candidateChecksKey,
  candidateRecordedSummary,
  featureBySlug,
  initializeDatabase,
  listFeatureRows,
  loadWorkspace,
  meta,
  newId,
  parseJson,
  readWorkspaceConfig,
  projectCandidateEvent,
  receiptCheckText,
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

function evidenceRows(db, featureId, limit = 50) {
  return db.prepare('SELECT * FROM evidence WHERE feature_id = ? ORDER BY created_at DESC LIMIT ?').all(featureId, limit)
    .map(({ output, ...row }) => ({ ...row, passed: row.passed === null ? null : Boolean(row.passed), outputAvailable: Boolean(output) }));
}

function pendingRows(db, featureId) {
  return db.prepare("SELECT request_id, method, summary, payload_json, created_at FROM pending_agent_requests WHERE feature_id = ? AND status = 'pending' ORDER BY created_at").all(featureId)
    .map(row => ({ ...row, payload: parseJson(row.payload_json, {}) }))
    .map(({ payload_json: _payload, ...row }) => row);
}

// A candidate's checks are the executed receipts behind its exact revision and current contract.
function receiptChecks(verification) {
  return verification.checks.filter(check => check.receipt).map(check => {
    const receipt = { key: check.key, receiptId: check.receipt.id, status: check.status, required: check.required, reused: check.reused };
    return { text: receiptCheckText(receipt), receipt };
  });
}

// Displayed checks are rebuilt from the candidate's marker; an unmarked row predates receipt provenance,
// and saved strings that differ from the marker are shown apart as unverified, even when they name a receipt.
function candidateRows(db, featureId) {
  return db.prepare('SELECT * FROM candidates WHERE feature_id = ? ORDER BY created_at DESC LIMIT 20').all(featureId)
    .map(row => ({ ...row, ...bindCandidateChecks(db, row.id, parseJson(row.checks_json, [])) }))
    .map(({ checks_json: _checks, ...row }) => row);
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim();
}

async function ensureWorkspaceFiles(root, config) {
  const coordinatorConfig = contained(root, '.codex', 'config.toml');
  if (config?.harness !== 'claude' && !await exists(coordinatorConfig)) await atomicWrite(root, coordinatorConfig, 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n');
  const ignoreFile = contained(root, '.gitignore');
  const required = [
    'features/',
    '.overdrive/cache/',
    '.overdrive/locks/',
    '.overdrive/state.sqlite3*',
    '.overdrive/events.ndjson',
    'overdrive.json',
    ...(config?.managedProject ? ['project/'] : []),
  ];
  let ignore = '';
  try { ignore = await fs.readFile(ignoreFile, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const missing = required.filter(line => !ignore.split(/\r?\n/).includes(line));
  if (missing.length) {
    const prefix = ignore && !ignore.endsWith('\n') ? '\n' : '';
    await atomicWrite(root, ignoreFile, `${ignore}${prefix}\n# OVERDRIVE local state\n${missing.join('\n')}\n`);
  }
  const agentsFile = contained(root, 'AGENTS.md');
  if (!await exists(agentsFile)) {
    await atomicWrite(root, agentsFile, `# OVERDRIVE coordinator\n\nUse the overdrive skill for this workspace. This directory coordinates feature clones; application work belongs in the selected features/<feature>/repo checkout.\n\nRecover from .overdrive/index.md, each lane's context packet, live Git state, and the saved agent sessions. Never expose private chain-of-thought or treat an agent report as test evidence.\n`);
  }
}

function featureAgentInstructions(root, feature) {
  const contextFile = contained(root, STATE_DIR, 'features', feature.slug, 'context.md');
  const specFile = contained(root, STATE_DIR, 'features', feature.slug, 'spec.md');
  return `# OVERDRIVE lane: ${feature.slug}

You are the implementation director for exactly one feature lane. Work only inside repo/; OVERDRIVE context lives outside the application checkout. You are a lane worker, not the OVERDRIVE coordinator: do not invoke OVERDRIVE coordinator tools, alter other lanes, or recursively inspect or steer this task. Apps, hooks, plugins, browser/computer control, and external MCP servers are deliberately unavailable; route cross-lane and external-system needs through your visible handoff.

Before each turn, read:

1. ${contextFile}
2. ${specFile}
3. the repository's applicable AGENTS.md, CLAUDE.md and other local instructions under repo/

Use the durable work graph in the context packet to choose the next useful work. Each running item there names a file holding its saved description and acceptance criteria; read that file for your assigned work key before implementing it. Keep exploration bounded, use native subagents only for genuinely independent work, and verify outcomes against the spec. Do not edit OVERDRIVE state files directly. Do not put coordination artifacts into application commits.

The coordinator owns work-item status changes; follow the assigned work key when provided. Surface a conflicting assignment or unmet prerequisite before proceeding with the affected work; your final report does not itself mark work done or create execution receipts.

Your visible updates and final messages may be recorded as safe progress summaries. Never reveal private chain-of-thought. Record exact commands, revisions, and observed outcomes in your visible handoff. Remote pushes, pull requests, merges, destructive cleanup, and new external authority require explicit user authorization.

The coordinator owns final Git staging and commits. Implement and verify the requested change, then report the exact modified paths and remaining work. If Git metadata writes are blocked by the workspace sandbox, preserve the diff and hand it back; do not seek broader permissions just to make a local commit.

Keep temporary verification executables and their local support/fixture inputs available while coordinator review or registered execution still needs them. Leave the ignored originals in place, or preserve byte-exact inert source copies before removing runnable files; report archive locations, hashes, original restore paths, exact commands and source revisions. Hashes and result JSON are not source archives. This temporary handoff retention does not require permanent tests or application commits. Once downstream use is complete, ordinary temporary-file cleanup applies; do not wait for cleanup to deliver the handoff.

Optional housekeeping must not delay a useful handoff. If removal of your own ignored temporary probes or fixtures cannot proceed within available permissions, retain them and finish with their exact paths, purpose and deferred cleanup noted; do not retry or seek escalation solely for that cleanup. Distinguish retained files from live services or residue that affects correctness: report those conditions and any required shutdown or verification still outstanding.
`;
}

async function writeFeatureAgentFile(ctx, feature) {
  const file = contained(ctx.root, 'features', feature.slug, 'AGENTS.md');
  await atomicWrite(ctx.root, file, featureAgentInstructions(ctx.root, feature));
}

async function writeEventLog(ctx, event) {
  const file = contained(ctx.root, STATE_DIR, 'events.ndjson');
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
  const features = listFeatureRows(ctx.db, { includeArchived: true });
  const rows = features.map(feature => {
    const progress = progressFor(ctx.db, feature.id);
    return `| ${markdownCell(feature.slug)} | ${markdownCell(feature.status)} | ${progress.done}/${progress.total || 0} | ${markdownCell(feature.agent_status)} | ${markdownCell(feature.next_action || '—')} |`;
  });
  const managedLine = ctx.config.managedProject
    ? `Managed project: ${ctx.config.managedProject.name} · ${ctx.config.defaultBranch} @ ${ctx.config.defaultRevision.slice(0, 12)}\n`
    : '';
  const body = `# OVERDRIVE index

${managedLine}Updated: ${now()}

| Feature | State | Work done | Agent | Next action |
| --- | --- | ---: | --- | --- |
${rows.length ? rows.join('\n') : '| _No features yet_ | | | | |'}

This is a compact navigation projection. Load one feature's context packet instead of every spec.
`;
  await atomicWrite(ctx.root, contained(ctx.root, STATE_DIR, 'index.md'), body);
}

// Stored text goes in a fence longer than any backtick run it contains, so Markdown in it can
// neither close the fence nor read as a section of the file.
function verbatimBlock(text) {
  if (!text) return '_None saved._\n';
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}\n`;
}

// Running work keeps its complete saved text in a keyed file beside the packet, so the packet stays
// compact however many long items are running. The prefix keeps keys such as "con.x" from naming a
// Windows device, and the digest keeps case-distinct keys apart on case-insensitive file systems.
function workDetailsName(key) {
  return `item-${key}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}.md`;
}

// Every generated file starts with this marker, which also carries a digest of the text below it.
function workDetailsMarker(key) {
  return `<!-- OVERDRIVE generated work details: ${key} · `;
}

function workDetails(feature, item) {
  const body = `# Work item \`${item.item_key}\`\n\nFeature: ${feature.slug}\nKind: ${item.kind}\nStatus: ${item.status}\n\nSaved text appears verbatim inside each fence.\n\n## Description\n\n${verbatimBlock(item.description)}\n## Acceptance\n\n${verbatimBlock(item.acceptance)}`;
  return `${workDetailsMarker(item.item_key)}${createHash('sha256').update(body).digest('hex').slice(0, 16)} -->\n${body}`;
}

// Whether a regular file starts with the given text, reading only that much of it.
// With a size requirement, comparing the entire expected content also proves equality.
async function fileStartsWith(file, text, size) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || (size !== undefined && stat.size !== size)) return false;
  const expected = Buffer.from(text);
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(expected.length);
    let bytesRead = 0;
    while (bytesRead < head.length) {
      const result = await handle.read(head, bytesRead, head.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) return false;
      bytesRead += result.bytesRead;
    }
    return head.equals(expected);
  } finally { await handle.close(); }
}

// Writes details for running work and returns the file for each running key, leaving a file whose
// complete content already matches untouched. Cleanup removes only regular files this code
// generated, proved by their exact name and marker, so notes left in the directory survive.
async function writeWorkDetails(ctx, feature, work) {
  const directory = await ensureManagedPath(ctx.root, contained(ctx.root, STATE_DIR, 'features', feature.slug, 'work'));
  const files = new Map(work.filter(item => item.status === 'running').map(item => [item.item_key, contained(directory, workDetailsName(item.item_key))]));
  for (const item of work) {
    const file = files.get(item.item_key);
    if (!file) continue;
    const content = workDetails(feature, item);
    await ensureManagedPath(ctx.root, file);
    if (!await fileStartsWith(file, content, Buffer.byteLength(content))) await atomicWrite(ctx.root, file, content);
  }
  const current = new Set(files.values());
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    const key = entry.name.match(/^item-([A-Za-z][A-Za-z0-9._-]{0,62})-[0-9a-f]{8}\.md$/)?.[1];
    const file = contained(directory, entry.name);
    if (!entry.isFile() || !key || workDetailsName(key) !== entry.name || current.has(file)) continue;
    await ensureManagedPath(ctx.root, file);
    if (await fileStartsWith(file, workDetailsMarker(key))) await fs.rm(file, { force: true });
  }
  return files;
}

export async function writeFeatureContext(ctx, featureOrSlug) {
  const feature = typeof featureOrSlug === 'string' ? featureBySlug(ctx.db, safeSlug(featureOrSlug)) : featureOrSlug;
  const work = workItems(ctx.db, feature.id);
  const evidence = evidenceRows(ctx.db, feature.id, 10);
  const pending = pendingRows(ctx.db, feature.id);
  const canonicalSpec = latestSpec(ctx.db, feature.id);
  if (canonicalSpec) await atomicWrite(ctx.root, contained(ctx.root, STATE_DIR, 'features', feature.slug, 'spec.md'), `${canonicalSpec.content.trim()}\n`);
  let snapshot;
  try { snapshot = await repositorySnapshot(feature.checkout_path, feature.base_revision); }
  catch (error) { snapshot = { unavailable: error.message }; }
  let identity = null;
  if (!snapshot.unavailable) {
    try { identity = await readCommitIdentity(feature.checkout_path); } catch { identity = null; }
  }
  const identityLine = identity
    ? `- Commit identity: ${identity.summary}${identity.automation || !identity.author || !identity.committer ? `. Lane-local override: run ${identity.override.map(command => `\`${command}\``).join(' then ')}` : ''}\n`
    : '';
  const detailFiles = await writeWorkDetails(ctx, feature, work);
  const workLines = work.length
    ? work.map(item => `- [${item.status === 'done' ? 'x' : ' '}] ${item.item_key} · ${item.kind} · ${item.status}: ${item.title}${item.dependencies.length ? ` (after ${item.dependencies.join(', ')})` : ''}${item.blocker ? ` — ${item.blocker}` : ''}${detailFiles.has(item.item_key) ? `\n  - ${item.item_key} description and acceptance: ${detailFiles.get(item.item_key)}` : ''}`).join('\n')
    : '- No work items yet.';
  const evidenceLines = evidence.length
    ? evidence.map(item => `- ${item.source === 'executed' ? 'EXECUTED' : 'REPORTED'} ${item.passed === true ? 'PASS' : item.passed === false ? 'FAIL' : 'NOTE'} · ${item.kind}: ${item.summary}${item.revision ? ` (${item.revision.slice(0, 12)})` : ''}`).join('\n')
    : '- No evidence recorded yet.';
  const packet = `# ${feature.title}\n\nFeature: ${feature.slug}\nStatus: ${feature.status}\nOutcome: ${feature.outcome}\nBase: ${feature.base_revision}\nBranch: ${feature.branch}\nSpec revision: ${feature.spec_revision}\nAgent: ${feature.agent_status}${feature.thread_id ? ` · thread ${feature.thread_id} (${feature.thread_harness ?? 'backend unknown'})` : ''}\n\n## Summary\n\n${feature.summary || 'None yet.'}\n${feature.next_action ? `\nNext action: ${feature.next_action}\n` : ''}${feature.blocker ? `\nBlocker: ${feature.blocker}\n` : ''}\n## Work graph\n\n${workLines}\n\n## Evidence\n\n${evidenceLines}\n\n## Live facts\n\n- Checkout: ${feature.checkout_path}\n- HEAD: ${snapshot.head ?? 'unavailable'}\n- Working tree: ${snapshot.clean === true ? 'clean' : snapshot.clean === false ? `${snapshot.changedFileCount} changed path(s)` : 'unavailable'}\n${identityLine}- Pending agent requests: ${pending.length}\n- Compaction pending: ${feature.compaction_pending ? 'yes' : 'no'}\n\nRead spec.md beside this file for the complete current specification. Treat this packet as navigation, not a substitute for Git and executed checks.\n`;
  await atomicWrite(ctx.root, contained(ctx.root, STATE_DIR, 'features', feature.slug, 'context.md'), packet);
  return { feature, work, evidence, pending, snapshot, commitIdentity: identity };
}

async function existingInitialization(root, normalized) {
  return await withContext(root, async ctx => {
    if (ctx.config.repository !== normalized.source) {
      throw new OverdriveError(`This workspace already tracks ${ctx.config.repository}; refusing to replace it with ${normalized.source}. Use a fresh workspace directory for a different repository.`, 'REPOSITORY_MISMATCH');
    }
    return { initialized: false, alreadyInitialized: true, workspace: overview(ctx) };
  });
}

async function initializeSource(root, normalized, additions = {}) {
  const existingConfig = contained(root, CONFIG_FILE);
  if (await exists(existingConfig)) return await existingInitialization(root, normalized);
  await fs.mkdir(contained(root, STATE_DIR, 'features'), { recursive: true });
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
      summary: `${additions.managedProject ? 'Created managed project' : 'Initialized OVERDRIVE'} at ${mirror.defaultRevision.slice(0, 12)}.`,
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
  return new OverdriveError('A partial .overdrive directory already exists. Inspect it before retrying initialization.', 'PARTIAL_INITIALIZATION');
}

const HARNESSES = new Set(['codex', 'claude']);

function harnessAddition(harness) {
  if (harness === undefined) return {};
  if (!HARNESSES.has(harness)) throw new OverdriveError('harness must be codex or claude.', 'INVALID_INPUT');
  return { harness };
}

function codexWorkerModel(config, slug) {
  const settings = config.codex;
  if (settings !== undefined && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) {
    throw new OverdriveError('overdrive.json codex must be an object.', 'INVALID_STATE');
  }
  const options = settings ?? {};
  const laneModels = options.laneModels === undefined ? {} : options.laneModels;
  if (laneModels === null || typeof laneModels !== 'object' || Array.isArray(laneModels)) {
    throw new OverdriveError('overdrive.json codex.laneModels must be an object.', 'INVALID_STATE');
  }
  for (const model of [options.model, ...Object.values(laneModels)]) {
    if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(model))) {
      throw new OverdriveError('overdrive.json codex.model and codex.laneModels values must be model names.', 'INVALID_STATE');
    }
  }
  return (Object.hasOwn(laneModels, slug) ? laneModels[slug] : undefined) ?? options.model ?? 'gpt-6-sol';
}

// overdrive.json selects the lane worker harness and its workspace or lane model.
export function workerHarness(config, slug) {
  const harness = config.harness ?? 'codex';
  if (!HARNESSES.has(harness)) throw new OverdriveError(`overdrive.json harness must be codex or claude, not ${JSON.stringify(harness)}.`, 'INVALID_STATE');
  if (harness === 'codex') return { harness, workerModel: codexWorkerModel(config, slug), harnessOptions: {} };
  const settings = config.claude && typeof config.claude === 'object' && !Array.isArray(config.claude) ? config.claude : {};
  const laneModels = settings.laneModels && typeof settings.laneModels === 'object' ? settings.laneModels : {};
  const model = (Object.hasOwn(laneModels, slug) ? laneModels[slug] : undefined) ?? settings.model ?? null;
  if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(model))) throw new OverdriveError('overdrive.json claude.model and claude.laneModels values must be model names.', 'INVALID_STATE');
  const { model: _model, laneModels: _laneModels, ...harnessOptions } = settings;
  return { harness, workerModel: model, harnessOptions };
}

// overdrive.json chooses the harness for new sessions only; a saved session always runs on the
// harness that created it. Unknown legacy ownership yields no harness, so callers refuse it.
function sessionHarness(config, row, forceNew = false) {
  if (!row.thread_id || forceNew) return workerHarness(config, row.slug);
  if (!HARNESSES.has(row.thread_harness)) return { harness: null, workerModel: null, harnessOptions: {} };
  return workerHarness({ ...config, harness: row.thread_harness }, row.slug);
}

export async function initializeWorkspace({ workspace_path, repository, harness }) {
  const root = await resolveWorkspace(workspace_path);
  const additions = harnessAddition(harness);
  const normalized = await normalizeRepositorySource(repository);
  const existingConfig = contained(root, CONFIG_FILE);
  if (await exists(existingConfig)) return await existingInitialization(root, normalized);
  if (await exists(contained(root, STATE_DIR))) throw partialInitializationError();
  return await withWorkspaceLock(root, 'initialize', () => initializeSource(root, normalized, additions));
}

export async function initializeManagedProject({ workspace_path, project_name, description, default_branch = 'main', harness }) {
  const root = await resolveWorkspace(workspace_path);
  const additions = harnessAddition(harness);
  const name = requiredText(project_name, 'project_name', { max: 200 });
  if (/\r|\n/.test(name)) throw new OverdriveError('project_name must be one line.', 'INVALID_INPUT');
  const brief = requiredText(description, 'description', { max: 50_000 });
  const branch = requiredText(default_branch, 'default_branch', { max: 200 });
  const project = await ensureManagedPath(root, contained(root, 'project'));
  const existingConfig = contained(root, CONFIG_FILE);
  if (await exists(existingConfig)) {
    return await withContext(root, async ctx => {
      if (!ctx.config.managedProject
        || ctx.config.managedProject.name !== name
        || ctx.config.managedProject.description !== brief
        || ctx.config.managedProject.defaultBranch !== branch) {
        throw new OverdriveError('This workspace is already initialized for a different repository or managed project.', 'ALREADY_INITIALIZED');
      }
      const workspace = overview(ctx);
      return { initialized: false, alreadyInitialized: true, workspace, managedProject: workspace.managedProject };
    });
  }
  if (await exists(contained(root, STATE_DIR))) throw partialInitializationError();
  if (await exists(project)) throw new OverdriveError(`Managed project path is occupied: ${project}`, 'PROJECT_PATH_OCCUPIED');
  await run(['git', 'check-ref-format', '--branch', branch], { cwd: root });
  return await withWorkspaceLock(root, 'initialize', async () => {
    if (await exists(project)) throw new OverdriveError(`Managed project path is occupied: ${project}`, 'PROJECT_PATH_OCCUPIED');
    await fs.mkdir(project);
    await atomicWrite(root, contained(project, 'README.md'), `# ${name}\n\n${brief}\n`);
    await atomicWrite(root, contained(project, 'AGENTS.md'), `# Project instructions\n\nThis is the canonical source repository for ${name}. Implement only the currently selected OVERDRIVE specification, preserve unrelated work, and report exact checks and revisions. Do not add orchestration state to application commits.\n`);
    await run(['git', 'init', '-b', branch], { cwd: project });
    await run(['git', 'add', '--', 'README.md', 'AGENTS.md'], { cwd: project });
    await run([
      'git',
      '-c', `core.hooksPath=${contained(root, STATE_DIR, 'disabled-hooks')}`,
      '-c', 'commit.gpgSign=false',
      '-c', 'user.name=OVERDRIVE',
      '-c', 'user.email=overdrive@local.invalid',
      'commit', '-m', `Initialize ${name}`,
    ], { cwd: project });
    const normalized = await normalizeRepositorySource(project);
    const result = await initializeSource(root, normalized, {
      ...additions,
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
    harness: ctx.config.harness ?? 'codex',
    managedProject: ctx.config.managedProject
      ? {
          name: ctx.config.managedProject.name,
          path: ctx.config.managedProject.path,
          defaultBranch: ctx.config.managedProject.defaultBranch,
        }
      : null,
    featureCount: Number(ctx.db.prepare('SELECT COUNT(*) AS count FROM features').get().count),
  };
}

const HARNESS_CLIS = {
  codex: { name: 'Codex', executable: codexExecutable, override: 'CODEX_CLI_PATH' },
  claude: { name: 'Claude Code', executable: claudeExecutable, override: 'CLAUDE_CLI_PATH' },
};

export async function doctorWorkspace({ workspace_path }) {
  const root = await resolveWorkspace(workspace_path);
  const checks = [];
  const version = async command => (await run([command, '--version'], { cwd: root, timeoutMs: 15_000 })).stdout.split(/\r?\n/)[0];
  for (const [name, command] of [['Git', 'git'], ['Node', 'node']]) {
    try { checks.push({ name, ok: true, detail: await version(command) }); }
    catch (error) { checks.push({ name, ok: false, detail: error.message }); }
  }
  // Only the configured worker harness is probed, through the executable a lane launch would use.
  let config = null;
  let cli = null;
  try {
    config = await readWorkspaceConfig(root);
    const { harness, harnessOptions } = workerHarness(config, '');
    if (harness === 'claude') normalizeWorkerOptions(harnessOptions);
    cli = HARNESS_CLIS[harness];
    checks.push({ name: 'Configuration', ok: true, detail: `${harness} worker harness` });
  } catch (error) {
    checks.push({ name: 'Configuration', ok: false, detail: error.message });
  }
  if (cli) {
    try {
      const command = cli.executable();
      if (!command) throw new OverdriveError(`${cli.name} CLI not found.`, 'CLI_NOT_FOUND');
      checks.push({ name: cli.name, ok: true, detail: `${await version(command)} (${command})` });
    } catch (error) {
      checks.push({ name: cli.name, ok: false, detail: `${error.message.replace(/\.?$/, '.')} Install it or set ${cli.override}.` });
    }
  }
  // An unreadable overdrive.json was already reported; the database and cache are still inspected
  // independently so one damaged part does not hide the health of the others.
  let ctx = null;
  if (config) {
    try {
      ctx = await loadWorkspace(root);
      const integrity = ctx.db.prepare('PRAGMA integrity_check').get().integrity_check;
      checks.push({ name: 'State database', ok: integrity === 'ok', detail: integrity });
    } catch (error) {
      ctx?.db.close();
      ctx = null;
      checks.push({ name: 'Workspace', ok: false, detail: error.message });
    }
  }
  try {
    try {
      const mirror = await inspectMirror(root);
      checks.push({ name: 'Repository cache', ok: Boolean(mirror.defaultRevision), detail: `${mirror.defaultBranch || 'detached'} @ ${mirror.defaultRevision.slice(0, 12)}` });
    } catch (error) {
      checks.push({ name: 'Repository cache', ok: false, detail: error.message });
    }
    if (ctx) {
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
      const lanes = listFeatureRows(ctx.db, { includeArchived: true });
      const unbound = lanes.filter(lane => lane.checkout_location?.bound === false);
      checks.push({
        name: 'Feature paths',
        ok: unbound.length === 0,
        detail: unbound.length
          ? `${unbound.length} of ${lanes.length} lane(s) not bound to this workspace: ${unbound.map(lane => `${lane.slug} (${lane.checkout_location.reason === 'linked_path' ? `linked via ${lane.checkout_location.link}` : `recorded at ${lane.checkout_location.recorded}`})`).join('; ')}`
          : `${lanes.length} registered lane(s)`,
      });
    }
  } catch (error) {
    checks.push({ name: 'Workspace', ok: false, detail: error.message });
  } finally { ctx?.db.close(); }
  return { root, ok: checks.every(check => check.ok), checks };
}

export async function createFeature({ workspace_path, feature, title, outcome, base_revision, base_feature, priority = 0, spec }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const cleanTitle = requiredText(title || slug.replaceAll('-', ' '), 'title', { max: 200 });
  const cleanOutcome = requiredText(outcome, 'outcome', { max: 10_000 });
  const initialSpec = optionalText(spec, 'spec', { max: 500_000 });
  const baseSlug = base_feature === undefined ? null : safeSlug(base_feature, 'base feature');
  if (baseSlug && (typeof base_revision !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base_revision))) {
    throw new OverdriveError('base_feature requires an explicitly selected full commit ID in base_revision.', 'INVALID_REVISION');
  }
  if (!Number.isInteger(priority) || priority < -100 || priority > 100) throw new OverdriveError('priority must be an integer from -100 to 100.', 'INVALID_INPUT');
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      if (ctx.db.prepare('SELECT 1 FROM features WHERE slug = ?').get(slug)) throw new OverdriveError(`Feature already exists: ${slug}`, 'FEATURE_EXISTS');
      const baseSource = baseSlug ? featureBySlug(ctx.db, baseSlug) : null;
      const baseRepository = baseSource ? await ensureManagedPath(root, baseSource.checkout_path) : mirrorPath(root);
      const selectedBase = baseSource ? await verifyCheckoutRevision(baseRepository, base_revision) : null;
      if (selectedBase && selectedBase.toLowerCase() !== base_revision.toLowerCase()) {
        throw new OverdriveError('base_revision must identify the exact source commit, not a hexadecimal ref name.', 'INVALID_REVISION');
      }
      // An exact sibling commit needs the cache only as a clone seed, so canonical source may be unavailable;
      // its default HEAD is reported as cached rather than refreshed.
      const canonicalSource = selectedBase ? 'cached' : 'refreshed';
      const refreshed = selectedBase ? await inspectMirror(root) : await refreshMirror(root);
      // The cached default profile describes only the refreshed canonical default.
      const defaultProfile = selectedBase ? null : await profileRepository(root, refreshed.defaultRevision);
      if (!selectedBase) {
        ctx.config.defaultRevision = refreshed.defaultRevision;
        ctx.config.defaultBranch = refreshed.defaultBranch;
        ctx.config.repositoryProfile = defaultProfile;
      }
      const base = selectedBase || await resolveMirrorRevision(root, base_revision || refreshed.defaultRevision);
      const clone = await createFeatureCheckout(root, ctx.config, slug, base, baseRepository);
      // Setup and check hints describe the lane's own committed base, which may be a sibling-only
      // or nondefault commit; the new clone is the one object store guaranteed to contain it.
      const profile = defaultProfile && base === refreshed.defaultRevision
        ? defaultProfile
        : await profileRepository(root, base, path.join(clone.destination, '.git'));
      const created = now();
      const id = newId('feature');
      transaction(ctx.db, () => {
        if (!selectedBase) {
          meta(ctx.db, 'default_revision', refreshed.defaultRevision);
          meta(ctx.db, 'default_branch', refreshed.defaultBranch);
        }
        ctx.db.prepare(`
          INSERT INTO features(id, slug, title, outcome, status, priority, base_revision, branch, checkout_path, spec_revision, summary, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, slug, cleanTitle, cleanOutcome, priority, base, clone.branch, clone.destination, initialSpec ? 1 : 0, 'Feature lane created.', created, created);
        if (initialSpec) ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, 1, ?, ?, ?)')
          .run(newId('spec'), id, initialSpec, 'Initial feature specification.', created);
      });
      const row = featureBySlug(ctx.db, slug);
      const specBody = initialSpec || `# ${cleanTitle}\n\n## Outcome\n\n${cleanOutcome}\n\n## User-visible behavior\n\n## Constraints and compatibility\n\n## Acceptance criteria\n\n## Out of scope\n\n## Open decisions\n`;
      await atomicWrite(root, contained(root, STATE_DIR, 'features', slug, 'spec.md'), `${specBody.trim()}\n`);
      await writeFeatureAgentFile(ctx, row);
      const { author, committer, origin: identityOrigin, scope: identityScope, source: identitySource, overridden } = clone.commitIdentity;
      await addEvent(ctx, { featureId: id, kind: 'feature.created', summary: `Created ${slug} from ${base.slice(0, 12)}.`, details: { branch: clone.branch, checkout: clone.destination, baseFeature: baseSlug, baseRevision: base, commitIdentity: { author, committer, origin: identityOrigin, scope: identityScope, source: identitySource, overridden } } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      await writeJson(root, contained(root, CONFIG_FILE), ctx.config);
      return {
        feature: summarizeFeature(ctx, row),
        baseFeature: baseSlug,
        repositoryProfile: profile,
        canonicalSource: { status: canonicalSource, defaultRevision: refreshed.defaultRevision, defaultBranch: refreshed.defaultBranch },
        commitIdentity: clone.commitIdentity,
        contextPath: contained(root, STATE_DIR, 'features', slug, 'context.md'),
        specPath: contained(root, STATE_DIR, 'features', slug, 'spec.md'),
        next: `${initialSpec ? 'Review the saved spec and plan work items.' : 'Develop the spec with the user, then save it with feature_update.'}${clone.commitIdentity.automation ? ' Disclose that this lane commits as the OVERDRIVE automation identity and show the optional lane-local override from commitIdentity.override; work and commits need not wait for an answer.' : clone.commitIdentity.overridden ? ' Disclose that inherited Git identity overrides decide this lane\'s author and committer (see commitIdentity).' : ''}`,
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
    ...(feature.checkout_location?.bound === false ? { checkoutLocation: { bound: false, reason: feature.checkout_location.reason, recordedPath: feature.checkout_location.recorded } } : {}),
    branch: feature.branch,
    baseRevision: feature.base_revision,
    agent: {
      status: feature.agent_status,
      threadId: feature.thread_id ?? null,
      harness: feature.thread_id ? feature.thread_harness ?? 'unknown' : null,
      activeTurnId: feature.active_turn_id ?? null,
    },
    compactionPending: feature.compaction_pending,
  };
}

export async function listFeatures({ workspace_path, include_archived = false, refresh_git = false }) {
  return await withContext(workspace_path, async ctx => {
    const features = [];
    for (const feature of listFeatureRows(ctx.db, { includeArchived: Boolean(include_archived) })) {
      const result = summarizeFeature(ctx, recoverAgentState(ctx, feature));
      if (refresh_git) {
        try { result.git = await repositorySnapshot(assertBoundCheckout(feature).checkout_path, feature.base_revision); }
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
    const projection = await writeFeatureContext(ctx, row);
    const spec = latestSpec(ctx.db, row.id);
    const timeline = timelineRows(ctx.db, row.id, timeline_limit);
    return {
      feature: summarizeFeature(ctx, row),
      specification: spec ?? { revision: 0, content: await fs.readFile(contained(ctx.root, STATE_DIR, 'features', row.slug, 'spec.md'), 'utf8') },
      workItems: projection.work,
      evidence: projection.evidence,
      candidates: candidateRows(ctx.db, row.id),
      verification: verificationStatus(ctx, row, projection.snapshot.head),
      pendingAgentRequests: projection.pending,
      git: projection.snapshot,
      commitIdentity: projection.commitIdentity,
      timeline,
      contextPath: contained(ctx.root, STATE_DIR, 'features', row.slug, 'context.md'),
    };
  });
}

function workKey(value, name = 'work item key') {
  const key = requiredText(value, name, { max: 63 });
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,62}$/.test(key)) throw new OverdriveError(`${name} has an invalid format.`, 'INVALID_WORK_KEY');
  return key;
}

// An omitted field stays unchanged; null or blank text clears it.
function editableText(value, name, max) {
  if (value === undefined) return undefined;
  return optionalText(value, name, { max }) ?? '';
}

function validateWorkGraph(db, featureId) {
  const items = workItems(db, featureId);
  const graph = new Map(items.map(item => [item.item_key, item.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  function visit(key, chain = []) {
    if (visiting.has(key)) throw new OverdriveError(`Work graph cycle: ${[...chain, key].join(' -> ')}`, 'WORK_GRAPH_CYCLE');
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) {
      if (!graph.has(dependency)) throw new OverdriveError(`Unknown dependency ${dependency} for ${key}.`, 'UNKNOWN_DEPENDENCY');
      visit(dependency, [...chain, key]);
    }
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of graph.keys()) visit(key);
}

// Planned and ready are derived from dependency completion; every other status is set explicitly.
function reconcileReady(db, featureId) {
  const items = workItems(db, featureId);
  const status = new Map(items.map(item => [item.item_key, item.status]));
  const statement = db.prepare('UPDATE work_items SET status = ?, updated_at = ? WHERE id = ?');
  for (const item of items) {
    if (!['planned', 'ready'].includes(item.status)) continue;
    const next = item.dependencies.every(key => status.get(key) === 'done') ? 'ready' : 'planned';
    if (next !== item.status) statement.run(next, now(), item.id);
  }
}

function workItemInput(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new OverdriveError(`items[${index}] must be an object.`, 'INVALID_INPUT');
  const key = workKey(item.key, `items[${index}].key`);
  if (item.kind !== undefined && !WORK_KINDS.has(item.kind)) throw new OverdriveError(`Unknown work kind: ${item.kind}`, 'INVALID_INPUT');
  if (item.status !== undefined && !WORK_STATUSES.has(item.status)) throw new OverdriveError(`Unknown work status: ${item.status}`, 'INVALID_INPUT');
  if (item.depends_on !== undefined && (!Array.isArray(item.depends_on) || item.depends_on.length > 100)) throw new OverdriveError(`Invalid depends_on for ${key}.`, 'INVALID_INPUT');
  return {
    key,
    title: item.title === undefined ? undefined : requiredText(item.title, `${key}.title`, { max: 500 }),
    description: editableText(item.description, `${key}.description`, 50_000),
    acceptance: editableText(item.acceptance, `${key}.acceptance`, 50_000),
    kind: item.kind,
    status: item.status,
    result: editableText(item.result, `${key}.result`, 50_000),
    blocker: editableText(item.blocker, `${key}.blocker`, 20_000),
    dependsOn: item.depends_on && [...new Set(item.depends_on.map(dep => workKey(dep, `${key}.depends_on`)))],
  };
}

export async function updateWork({ workspace_path, feature, items = [], remove = [] }) {
  if (!Array.isArray(items) || items.length > 200) throw new OverdriveError('items must contain at most 200 work items.', 'INVALID_INPUT');
  if (!Array.isArray(remove) || remove.length > 200) throw new OverdriveError('remove must contain at most 200 work keys.', 'INVALID_INPUT');
  const normalized = items.map(workItemInput);
  const removed = new Set(remove.map((key, index) => workKey(key, `remove[${index}]`)));
  const keys = new Set(normalized.map(item => item.key));
  if (keys.size !== normalized.length) throw new OverdriveError('Work item keys must be unique in one call.', 'INVALID_INPUT');
  if (!keys.size && !removed.size) throw new OverdriveError('Submit work items or keys to remove.', 'INVALID_INPUT');
  if ([...removed].some(key => keys.has(key))) throw new OverdriveError('A work item cannot be updated and removed in one call.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const stamp = now();
      transaction(ctx.db, () => {
        const existing = new Map(workItems(ctx.db, row.id).map(item => [item.item_key, item]));
        for (const key of removed) if (!existing.has(key)) throw new OverdriveError(`Unknown work item: ${key}`, 'WORK_ITEM_NOT_FOUND');
        // A check scoped to removed work could no longer resolve its scope, which every verification read needs.
        const scoped = featureChecks(ctx.db, row.id).find(check => check.work_scope?.some(key => removed.has(key)));
        if (scoped) throw new OverdriveError(`Check ${scoped.key} is scoped to work being removed; change its work_scope with checks_update first.`, 'INVALID_INPUT');
        const ids = new Map([...existing].map(([key, item]) => [key, item.id]));
        for (const item of normalized) {
          const found = existing.get(item.key);
          if (!found && item.title === undefined) throw new OverdriveError(`${item.key}.title is required for a new work item.`, 'INVALID_INPUT');
          const values = [
            item.title ?? found.title, item.description ?? found?.description ?? '', item.kind ?? found?.kind ?? 'build',
            item.status ?? found?.status ?? 'planned', item.acceptance ?? found?.acceptance ?? '', item.result ?? found?.result_summary ?? '',
            item.blocker ?? found?.blocker ?? '', stamp,
          ];
          if (found) {
            ctx.db.prepare('UPDATE work_items SET title = ?, description = ?, kind = ?, status = ?, acceptance = ?, result_summary = ?, blocker = ?, updated_at = ? WHERE id = ?').run(...values, found.id);
          } else {
            const id = newId('work');
            ctx.db.prepare('INSERT INTO work_items(title, description, kind, status, acceptance, result_summary, blocker, updated_at, id, feature_id, item_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...values, id, row.id, item.key, stamp);
            ids.set(item.key, id);
          }
        }
        for (const item of normalized.filter(item => item.dependsOn)) {
          ctx.db.prepare('DELETE FROM work_dependencies WHERE work_item_id = ?').run(ids.get(item.key));
          for (const dependency of item.dependsOn) {
            if (!ids.has(dependency)) throw new OverdriveError(`Unknown dependency ${dependency} for ${item.key}.`, 'UNKNOWN_DEPENDENCY');
            ctx.db.prepare('INSERT INTO work_dependencies(work_item_id, depends_on_id) VALUES (?, ?)').run(ids.get(item.key), ids.get(dependency));
          }
        }
        // Removal would silently drop the edges of work that still depends on the removed item.
        const dependent = workItems(ctx.db, row.id).find(item => !removed.has(item.item_key) && item.dependencies.some(key => removed.has(key)));
        if (dependent) throw new OverdriveError(`${dependent.item_key} still depends on removed work.`, 'UNKNOWN_DEPENDENCY');
        for (const key of removed) ctx.db.prepare('DELETE FROM work_items WHERE id = ?').run(ids.get(key));
        validateWorkGraph(ctx.db, row.id);
        reconcileReady(ctx.db, row.id);
        ctx.db.prepare('UPDATE features SET updated_at = ? WHERE id = ?').run(stamp, row.id);
      });
      await addEvent(ctx, { featureId: row.id, kind: 'work.updated', summary: `Updated ${keys.size} work item(s)${removed.size ? ` and removed ${removed.size}` : ''}.`, details: { keys: [...keys], removed: [...removed] } });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { feature: summarizeFeature(ctx, current), workItems: workItems(ctx.db, row.id).filter(item => keys.has(item.item_key)) };
    } finally { ctx.db.close(); }
  });
}

function cleanStringArray(value, name, max = 100) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new OverdriveError(`${name} must be an array with at most ${max} entries.`, 'INVALID_INPUT');
  return value.map((entry, index) => requiredText(entry, `${name}[${index}]`, { max: 20_000 }));
}

// Validates an update before anything acts on it, such as stopping a worker.
export function featureUpdateInput({ status, spec, spec_rationale, summary, next_action, blocker, unresolved }) {
  if (status !== undefined && !FEATURE_STATUSES.has(status)) throw new OverdriveError(`Unknown feature status: ${status}`, 'INVALID_INPUT');
  return {
    status,
    spec: spec === undefined ? undefined : requiredText(spec, 'spec', { max: 500_000 }),
    rationale: optionalText(spec_rationale, 'spec_rationale', { max: 20_000 }) || '',
    summary: editableText(summary, 'summary', 50_000),
    nextAction: editableText(next_action, 'next_action', 20_000),
    // A blocker describes the blocked state, so another status given without one clears it.
    blocker: editableText(blocker, 'blocker', 20_000) ?? (status !== undefined && status !== 'blocked' ? '' : undefined),
    unresolved: unresolved === undefined ? undefined : cleanStringArray(unresolved, 'unresolved'),
  };
}

export async function updateFeature(args) {
  const input = featureUpdateInput(args);
  const root = await resolveWorkspace(args.workspace_path);
  return await withWorkspaceLock(root, 'features', () => applyFeatureUpdate(root, safeSlug(args.feature), input));
}

// Records an update for a caller that already holds the lane's control lock and has stopped its
// worker. The write itself refuses a lane whose worker may still be live, so a pause or archive
// can never claim a stop that did not happen.
export async function updateStoppedFeature(args) {
  const input = featureUpdateInput(args);
  const root = await resolveWorkspace(args.workspace_path);
  return await withWorkspaceLock(root, 'features', () => applyFeatureUpdate(root, safeSlug(args.feature), input, { requireStopped: true }));
}

async function applyFeatureUpdate(root, slug, { status, spec, rationale, summary, nextAction, blocker, unresolved }, { requireStopped = false } = {}) {
  const ctx = await loadWorkspace(root);
  try {
    const row = featureBySlug(ctx.db, slug);
    const previousSpec = latestSpec(ctx.db, row.id)?.content || '';
    const specChanged = spec !== undefined && previousSpec.trim() !== spec;
    const revision = row.spec_revision + (specChanged ? 1 : 0);
    const stamp = now();
    transaction(ctx.db, () => {
      if (specChanged) ctx.db.prepare('INSERT INTO spec_revisions(id, feature_id, revision, content, rationale, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('spec'), row.id, revision, spec, rationale, stamp);
      const stopped = requireStopped ? ` AND NOT ${AGENT_BUSY_SQL} AND ${DESCENDANTS_CLEAR_SQL} AND ${WORKERS_CLEAR_SQL}` : '';
      const changed = ctx.db.prepare(`UPDATE features SET status = COALESCE(?, status), spec_revision = ?, summary = COALESCE(?, summary), next_action = COALESCE(?, next_action), blocker = COALESCE(?, blocker), updated_at = ? WHERE id = ?${stopped}`)
        .run(status ?? null, revision, summary ?? null, nextAction ?? null, blocker ?? null, stamp, row.id);
      if (!changed.changes) throw new OverdriveError(`The ${slug} worker may still be running, so the lane was not marked ${status}.`, 'STOP_UNCONFIRMED');
    });
    let specResult;
    if (specChanged) {
      const diff = lineDiff(previousSpec, spec);
      specResult = { revision, diff, specPath: contained(root, STATE_DIR, 'features', slug, 'spec.md') };
      await addEvent(ctx, { featureId: row.id, kind: 'spec.revised', summary: `Saved spec revision ${revision} (+${diff.added}/-${diff.removed} logical lines).`, details: { revision, rationale } });
    }
    const statusChanged = status !== undefined && status !== row.status;
    const notes = Object.fromEntries(Object.entries({ summary, nextAction, blocker, unresolved }).filter(([, value]) => value !== undefined));
    if (statusChanged || Object.keys(notes).length) {
      await addEvent(ctx, { featureId: row.id, kind: statusChanged ? `feature.${status}` : 'feature.updated', summary: summary || blocker || (statusChanged ? `Feature marked ${status}.` : 'Feature notes updated.'), details: notes });
    }
    const current = featureBySlug(ctx.db, slug);
    await writeFeatureContext(ctx, current);
    await writeIndex(ctx);
    return { feature: summarizeFeature(ctx, current), ...(specResult ? { spec: specResult } : {}) };
  } finally { ctx.db.close(); }
}

export async function recordEvidence({ workspace_path, feature, work_item, kind, summary, command, artifact, revision, passed }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  const evidenceKind = requiredText(kind, 'kind', { max: 100 });
  const cleanSummary = requiredText(summary, 'summary', { max: 50_000 });
  if (passed !== undefined && typeof passed !== 'boolean') throw new OverdriveError('passed must be true or false.', 'INVALID_INPUT');
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      let work = null;
      if (work_item) {
        work = ctx.db.prepare('SELECT * FROM work_items WHERE feature_id = ? AND item_key = ?').get(row.id, workKey(work_item));
        if (!work) throw new OverdriveError(`Unknown work item: ${work_item}`, 'WORK_ITEM_NOT_FOUND');
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
  // Caller-described checks are prose, not proof; they are kept apart as unverified notes.
  const notes = cleanStringArray(checks, 'checks');
  return await withCheckoutLock(root, slug, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      // Recording moves the lane to review, so an archived lane must be reactivated explicitly first.
      if (row.status === 'archived') throw new OverdriveError(`Feature ${slug} is archived; reactivate it with feature_update before recording a candidate.`, 'INVALID_TRANSITION');
      // Likewise a paused lane stays paused until it is explicitly resumed.
      if (row.status === 'paused') throw new OverdriveError(`Feature ${slug} is paused; resume it with feature_update before recording a candidate.`, 'INVALID_TRANSITION');
      assertAgentIdle(row);
      assertWorkersStopped(ctx.db, row);
      const resolved = await verifyCheckoutRevision(row.checkout_path, revision);
      const snapshot = await repositorySnapshot(row.checkout_path, row.base_revision);
      if (snapshot.head !== resolved) throw new OverdriveError(`Candidate ${resolved.slice(0, 12)} is not the checkout HEAD ${snapshot.head.slice(0, 12)}.`, 'STALE_CANDIDATE');
      if (allow_dirty || !snapshot.clean) throw new OverdriveError('Candidates require a clean committed checkout.', 'DIRTY_CANDIDATE');
      const verification = assertVerified(ctx, row, resolved);
      const derived = receiptChecks(verification);
      const executed = derived.map(check => check.text);
      const changes = await diffSummary(row.checkout_path, row.base_revision, resolved);
      const id = newId('candidate');
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare("UPDATE candidates SET status = 'superseded' WHERE feature_id = ? AND status = 'ready'").run(row.id);
        ctx.db.prepare('INSERT INTO candidates(id, feature_id, revision, base_revision, summary, checks_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'ready\', ?)')
          .run(id, row.id, resolved, row.base_revision, cleanSummary, JSON.stringify(executed), stamp);
        ctx.db.prepare('UPDATE candidates SET spec_revision = ?, contract_hash = ? WHERE id = ?').run(row.spec_revision, verification.contractHash, id);
        captureFeatureContract(ctx.db, row);
        meta(ctx.db, candidateChecksKey(id), JSON.stringify({ version: 1, source: 'executed-receipts', receipts: derived.map(check => check.receipt) }));
        ctx.db.prepare("UPDATE features SET status = 'review', summary = ?, updated_at = ? WHERE id = ?").run(cleanSummary, stamp, row.id);
      });
      await addEvent(ctx, {
        featureId: row.id, kind: 'candidate.recorded',
        summary: candidateRecordedSummary(resolved, executed.length, notes.length),
        details: { candidateId: id, checks: executed, unverifiedNotes: notes, clean: snapshot.clean },
      });
      const current = featureBySlug(ctx.db, slug);
      await writeFeatureContext(ctx, current);
      await writeIndex(ctx);
      return { candidateId: id, revision: resolved, baseRevision: row.base_revision, checks: executed, unverifiedNotes: notes, checkProvenance: 'executed-receipts', changes, feature: summarizeFeature(ctx, current) };
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
        throw new OverdriveError('Candidate promotion is built in only for projects created by OVERDRIVE. Use the repository\'s normal review and integration flow for an adopted repository.', 'NOT_MANAGED_PROJECT');
      }
      const project = await ensureManagedPath(root, contained(root, 'project'));
      if (path.resolve(managed.path) !== project) throw new OverdriveError('Managed project path does not match this workspace.', 'INVALID_STATE');
      const row = featureBySlug(ctx.db, slug);
      assertAgentIdle(row);
      let resolved = optionalText(revision, 'revision', { max: 200 });
      if (resolved) resolved = await verifyCheckoutRevision(row.checkout_path, resolved);
      const candidate = resolved
        ? ctx.db.prepare("SELECT * FROM candidates WHERE feature_id = ? AND revision = ? AND status IN ('ready','accepted') ORDER BY created_at DESC LIMIT 1").get(row.id, resolved)
        : ctx.db.prepare("SELECT * FROM candidates WHERE feature_id = ? AND status IN ('ready','accepted') ORDER BY created_at DESC LIMIT 1").get(row.id);
      if (!candidate) throw new OverdriveError('No recorded candidate matches this promotion request.', 'PROMOTION_NOT_READY');
      assertVerified(ctx, row, candidate.revision, candidate);
      const featureSnapshot = await repositorySnapshot(row.checkout_path, row.base_revision);
      if (!featureSnapshot.clean || featureSnapshot.head !== candidate.revision) {
        throw new OverdriveError('The candidate must still be the clean feature checkout HEAD.', 'STALE_CANDIDATE');
      }
      const projectSnapshot = await repositorySnapshot(project);
      if (!projectSnapshot.clean) throw new OverdriveError('The managed project has uncommitted changes; preserve or resolve them before promotion.', 'DIRTY_MANAGED_PROJECT');
      if (projectSnapshot.branch !== managed.defaultBranch) {
        throw new OverdriveError(`Managed project must be on ${managed.defaultBranch}, not ${projectSnapshot.branch || 'a detached HEAD'}.`, 'WRONG_MANAGED_BRANCH');
      }
      const candidateRef = `refs/overdrive/candidates/${slug}/${candidate.revision}`;
      await run(['git', 'fetch', '--no-tags', row.checkout_path, `${candidate.revision}:${candidateRef}`], { cwd: project });
      const fetched = await verifyCheckoutRevision(project, candidateRef);
      if (fetched !== candidate.revision) throw new OverdriveError('Fetched candidate revision does not match the candidate.', 'STALE_CANDIDATE');
      const alreadyIncluded = await isGitAncestor(project, candidate.revision, projectSnapshot.head);
      if (!alreadyIncluded) {
        const canFastForward = await isGitAncestor(project, projectSnapshot.head, candidate.revision);
        if (!canFastForward) {
          throw new OverdriveError('The managed project and candidate have diverged. Rebase or repair the feature lane; OVERDRIVE will not synthesize or resolve a merge silently.', 'PROMOTION_NOT_FAST_FORWARD');
        }
        await run(['git', '-c', `core.hooksPath=${contained(root, STATE_DIR, 'disabled-hooks')}`, 'merge', '--ff-only', candidateRef], { cwd: project });
      }
      const promotedSnapshot = await repositorySnapshot(project);
      if (!promotedSnapshot.clean || !await isGitAncestor(project, candidate.revision, promotedSnapshot.head)) {
        throw new OverdriveError('Managed project verification failed after promotion.', 'PROMOTION_FAILED');
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
        if (!alreadyIncluded) ctx.db.prepare('UPDATE features SET summary = ?, updated_at = ? WHERE id = ?').run(cleanSummary || candidate.summary, stamp, row.id);
      });
      await writeJson(root, contained(root, CONFIG_FILE), ctx.config);
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
    .map(row => projectCandidateEvent(db, { id: Number(row.id), kind: row.kind, summary: row.summary, details: parseJson(row.details_json, {}), createdAt: row.created_at }));
}

export async function featureRuntime({ workspace_path, feature, allow_inactive = false, force_new_session = false }) {
  return await withContext(workspace_path, async ctx => {
    const row = recoverAgentState(ctx, featureBySlug(ctx.db, safeSlug(feature)));
    if (!allow_inactive && ['paused', 'done', 'archived'].includes(row.status)) throw new OverdriveError(`Feature ${row.slug} is ${row.status}; resume or reactivate it before starting work.`, 'INVALID_TRANSITION');
    const packet = await writeFeatureContext(ctx, row);
    await writeFeatureAgentFile(ctx, row);
    return {
      root: ctx.root,
      feature: row,
      contextPath: contained(ctx.root, STATE_DIR, 'features', row.slug, 'context.md'),
      specPath: contained(ctx.root, STATE_DIR, 'features', row.slug, 'spec.md'),
      agentFile: contained(ctx.root, 'features', row.slug, 'AGENTS.md'),
      work: packet.work,
      developerInstructions: featureAgentInstructions(ctx.root, row),
      ...sessionHarness(ctx.config, row, force_new_session),
    };
  });
}

// Binds the lane to a session it just created, recording the owning harness. The replaced
// binding is kept in the timeline so its conversation stays reachable in its own backend.
export async function bindAgentSession({ workspace_path, feature, thread_id, harness, expected_thread_id = null, compacted = false, owner_token }) {
  if (!HARNESSES.has(harness)) throw new OverdriveError('A native session must record its owning harness.', 'SESSION_OWNER_UNKNOWN');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) throw new OverdriveError('Another controller took this lane before its new session could be saved.', 'AGENT_OWNED');
      if ((row.thread_id ?? null) !== expected_thread_id || row.active_turn_id) throw new OverdriveError('The lane session changed before its replacement could be saved; inspect it and retry.', 'SESSION_CHANGED');
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`UPDATE features SET thread_id = ?, thread_harness = ?, active_turn_id = NULL, agent_status = 'starting', compaction_pending = CASE WHEN ? THEN 0 ELSE compaction_pending END, updated_at = ? WHERE id = ?`)
          .run(thread_id, harness, compacted ? 1 : 0, stamp, row.id);
        if (row.thread_id) ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND thread_id = ? AND status = 'pending'").run(stamp, row.id, row.thread_id);
      });
      if (row.thread_id) await addEvent(ctx, { featureId: row.id, kind: 'agent.session_replaced', summary: `Replaced native session ${row.thread_id} (${row.thread_harness ?? 'backend unknown'}) with ${thread_id} (${harness}). The previous conversation remains in its own backend.`, details: { previousThreadId: row.thread_id, previousHarness: row.thread_harness ?? null, threadId: thread_id, harness } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return summarizeFeature(ctx, featureBySlug(ctx.db, slug));
    } finally { ctx.db.close(); }
  });
}

// Undoes bindAgentSession when the new session never started a turn, restoring the previous
// binding (or none) so a failed replacement cannot strand the lane on an unusable session.
export async function releaseAgentSession({ workspace_path, feature, thread_id, previous_thread_id = null, previous_harness = null, compaction_pending = false, summary, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id || row.active_turn_id || row.agent_status !== 'starting') return { ignored: true };
      const cleanSummary = requiredText(summary, 'summary', { max: 100_000 });
      ctx.db.prepare(`UPDATE features SET thread_id = ?, thread_harness = ?, agent_status = 'failed', compaction_pending = ?, summary = ?, updated_at = ? WHERE id = ?`)
        .run(previous_thread_id, previous_thread_id ? previous_harness : null, compaction_pending ? 1 : 0, cleanSummary, now(), row.id);
      await addEvent(ctx, { featureId: row.id, kind: 'agent.failed', summary: cleanSummary, details: { threadId: thread_id, restoredThreadId: previous_thread_id, restoredHarness: previous_thread_id ? previous_harness : null } });
      await writeFeatureContext(ctx, featureBySlug(ctx.db, slug));
      await writeIndex(ctx);
      return summarizeFeature(ctx, featureBySlug(ctx.db, slug));
    } finally { ctx.db.close(); }
  });
}

// Session state changes only for the session the lane is bound to, so late events from a
// replaced session cannot mutate its replacement. New sessions are bound by bindAgentSession.
export async function saveAgentSession({ workspace_path, feature, thread_id, turn_id = null, status, summary = undefined, compacted = false, owner_token, only_if_status = null, orphan_requests = false }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (row.thread_id !== thread_id || !ownsAgent(ctx.db, row.id, owner_token) || (only_if_status && row.agent_status !== only_if_status)) return { ignored: true };
      const cleanSummary = summary ? requiredText(summary, 'summary', { max: 100_000 }) : undefined;
      const stamp = now();
      transaction(ctx.db, () => {
        ctx.db.prepare(`UPDATE features SET active_turn_id = ?, agent_status = ?, summary = COALESCE(?, summary), compaction_pending = CASE WHEN ? THEN 0 ELSE compaction_pending END, updated_at = ? WHERE id = ?`)
          .run(turn_id, status, cleanSummary ?? null, compacted ? 1 : 0, stamp, row.id);
        if (status === 'disconnected' || orphan_requests) {
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

export async function recordAgentEvent({ workspace_path, feature, kind, summary, details = {}, owner_token, thread_id = undefined }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || (thread_id !== undefined && row.thread_id !== thread_id)) return { ignored: true };
      const cleanSummary = requiredText(summary, 'summary', { max: 100_000 });
      return await addEvent(ctx, { featureId: row.id, kind, summary: cleanSummary, details });
    } finally { ctx.db.close(); }
  });
}

// Records that a worker process of the bound session was stopped without its process tree, so
// tools it launched may still be running. Guarded like other session writes. Every occurrence
// gets a new generation, so an attestation about an earlier one cannot cover it; the same turn
// reported twice (by its interrupt and by its completion) is one occurrence.
const attestedDescendantsKey = (featureId, threadId, turnId) => `agent-descendants-attested:${featureId}:${threadId}:${turnId}`;

export async function markDescendantsUnconfirmed({ workspace_path, feature, thread_id, turn_id = null, summary, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id) return { ignored: true };
      // A completion delivered after attestation must not recreate the marker it cleared.
      if (turn_id && meta(ctx.db, attestedDescendantsKey(row.id, thread_id, turn_id))) return { recorded: false, attested: true };
      const previous = unconfirmedDescendants(ctx.db, row.id);
      if (turn_id && previous?.threadId === thread_id && previous?.turnId === turn_id) return { recorded: false, generation: previous.generation };
      const cleanSummary = requiredText(summary, 'summary', { max: 20_000 });
      const generation = randomUUID();
      meta(ctx.db, descendantsKey(row.id), JSON.stringify({ generation, occurrences: (previous?.occurrences ?? 0) + 1, threadId: thread_id, turnId: turn_id, summary: cleanSummary, at: now() }));
      await addEvent(ctx, { featureId: row.id, kind: 'agent.descendants_unconfirmed', summary: cleanSummary, details: { threadId: thread_id, turnId: turn_id, generation } });
      return { recorded: true, generation };
    } finally { ctx.db.close(); }
  });
}

export async function readUnconfirmedDescendants({ workspace_path, feature }) {
  return await withContext(workspace_path, async ctx => unconfirmedDescendants(ctx.db, featureBySlug(ctx.db, safeSlug(feature)).id));
}

// Registered before a Claude turn request can reach its worker. A controller restart loses the
// process handle, so this record remains until its owning bridge confirms the worker's whole
// process tree ended or was stopped, a later controller finds its recorded containment job gone,
// or the coordinator attests it has stopped.
export async function registerWorkerGuard({ workspace_path, feature, thread_id, guard_id, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id) return { ignored: true };
      const guards = parseJson(meta(ctx.db, workersKey(row.id)), []);
      if (!guards.some(guard => guard.id === guard_id)) guards.push({ id: guard_id, threadId: thread_id });
      meta(ctx.db, workersKey(row.id), JSON.stringify(guards));
      return { registered: true };
    } finally { ctx.db.close(); }
  });
}

// Records the containment job a Claude worker's process tree runs in, once the tree is inside it,
// so a later controller can prove from the job's absence that every process in it has ended.
export async function recordWorkerGuardJob({ workspace_path, feature, thread_id, guard_id, job, owner_token }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || row.thread_id !== thread_id) return { ignored: true };
      const guards = parseJson(meta(ctx.db, workersKey(row.id)), []);
      const guard = guards.find(entry => entry.id === guard_id);
      if (!guard) return { recorded: false };
      guard.job = requiredText(job, 'job', { max: 200 });
      meta(ctx.db, workersKey(row.id), JSON.stringify(guards));
      return { recorded: true };
    } finally { ctx.db.close(); }
  });
}

export async function readWorkerGuards({ workspace_path, feature }) {
  return await withContext(workspace_path, async ctx => parseJson(meta(ctx.db, workersKey(featureBySlug(ctx.db, safeSlug(feature)).id)), []));
}

// job_gone: the caller verified the guard's containment job no longer exists or holds no process.
// unused: the turn request the guard was registered for was refused before any worker started.
export async function clearWorkerGuards({ workspace_path, feature, guard_id = null, evidence = null, job_gone = false, unused = false }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const guards = parseJson(meta(ctx.db, workersKey(row.id)), []);
      const remaining = guard_id ? guards.filter(guard => guard.id !== guard_id) : [];
      if (remaining.length === guards.length) return { cleared: false };
      transaction(ctx.db, () => {
        if (remaining.length) meta(ctx.db, workersKey(row.id), JSON.stringify(remaining));
        else ctx.db.prepare('DELETE FROM meta WHERE key = ?').run(workersKey(row.id));
      });
      const summary = evidence ? `The coordinator attested that no worker or tool process for this lane is running: ${evidence}`
        : job_gone ? 'The worker\'s process-tree job no longer exists or holds no process, so every process launched under it has ended.'
          : unused ? 'The turn request was refused before any worker process started.'
            : 'The owning bridge confirmed the worker and every process it launched stopped.';
      const basis = job_gone ? 'job_gone' : unused ? 'refused_request' : null;
      await addEvent(ctx, { featureId: row.id, kind: evidence ? 'agent.workers_attested' : 'agent.worker_stopped', summary, details: { guardId: guard_id, cleared: guards.length - remaining.length, ...(basis ? { basis } : {}) } });
      return { cleared: true };
    } finally { ctx.db.close(); }
  });
}

// Clears the unconfirmed-descendants marker on the coordinator's evidence that none is running,
// only if it is still the generation the evidence was given for.
export async function attestDescendantsStopped({ workspace_path, feature, evidence, generation }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const marker = unconfirmedDescendants(ctx.db, row.id);
      if (!marker) return { cleared: false };
      if (marker.generation !== generation) return { cleared: false, stale: true };
      transaction(ctx.db, () => {
        if (marker.turnId) meta(ctx.db, attestedDescendantsKey(row.id, marker.threadId, marker.turnId), marker.generation);
        ctx.db.prepare('DELETE FROM meta WHERE key = ?').run(descendantsKey(row.id));
      });
      await addEvent(ctx, { featureId: row.id, kind: 'agent.descendants_attested', summary: `The coordinator attested that no process launched by the stopped worker is running: ${evidence}`, details: { basis: 'coordinator_attestation', marker } });
      return { cleared: true };
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
      // A controller may only raise requests from the session the lane is currently bound to.
      if (!ownsAgent(ctx.db, row.id, owner_token) || (owner_token && row.thread_id !== thread_id)) return { ignored: true };
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
    if (!request) throw new OverdriveError(`No pending request ${request_id} for ${row.slug}.`, 'REQUEST_NOT_FOUND');
    return { ...request, payload: parseJson(request.payload_json, {}) };
  });
}

export async function resolveAgentRequestRecord({ workspace_path, feature, request_id, summary, status = 'resolved', owner_token, thread_id, ignore_missing = false }) {
  if (!['resolved', 'orphaned'].includes(status)) throw new OverdriveError('Request resolution status is invalid.', 'INVALID_INPUT');
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token)) return { ignored: true };
      const result = ctx.db.prepare("UPDATE pending_agent_requests SET status = ?, resolved_at = ? WHERE feature_id = ? AND request_id = ? AND status = 'pending' AND (? IS NULL OR thread_id = ?)").run(status, now(), row.id, String(request_id), thread_id ?? null, thread_id ?? null);
      if (!result.changes && ignore_missing) return { ignored: true };
      if (!result.changes) throw new OverdriveError(`No pending request ${request_id} for ${slug}.`, 'REQUEST_NOT_FOUND');
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

export async function markCompacted({ workspace_path, feature, owner_token, thread_id = undefined }) {
  const root = await resolveWorkspace(workspace_path);
  const slug = safeSlug(feature);
  return await withWorkspaceLock(root, 'agent-state', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      if (!ownsAgent(ctx.db, row.id, owner_token) || (thread_id !== undefined && row.thread_id !== thread_id)) return { ignored: true };
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
