import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  integrationPath,
  isGitAncestor,
  mergeIntoIntegration,
  mirrorPath,
  refreshMirror,
  repositorySnapshot,
  resetIntegration,
  resolveMirrorRevision,
  runtimeGitConfig,
  snapshotCommit,
  syncLabCheckout,
  verifyCheckoutRevision,
} from './git.mjs';
import { featureBySlug, listFeatureRows, loadWorkspace, meta, parseJson, transaction } from './state.mjs';
import {
  OverdriveError,
  contained,
  ensureManagedPath,
  exists,
  git,
  now,
  optionalText,
  redactString,
  requiredText,
  resolveWorkspace,
  run,
  safeSlug,
  withWorkspaceLock, STATE_DIR,
} from './util.mjs';
import { addEvent, ensureLab, withContext, writeFeatureContext, writeIndex } from './workspace.mjs';

const SUITE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SEVERITIES = new Set(['blocking', 'minor']);
const FINDING_STATUSES = new Set(['open', 'resolved', 'wontfix']);

function suiteName(value, name = 'suite') {
  const suite = requiredText(value, name, { max: 63 });
  if (!SUITE_NAME.test(suite)) throw new OverdriveError(`${name} must name a lab/suites directory: lowercase letters, digits, - and _.`, 'INVALID_SUITE');
  return suite;
}

const targetName = value => (value === 'integration' || value === 'base' ? value : safeSlug(value, 'target'));
const agentName = value => (value === undefined || value === 'coordinator' ? 'coordinator' : safeSlug(value, 'from'));
const featureId = (db, slug) => db.prepare('SELECT id FROM features WHERE slug = ?').get(slug)?.id ?? null;
const runDirectory = (root, id) => contained(root, STATE_DIR, 'lab', 'runs', id, 'artifacts');
const runLog = (root, id) => contained(root, STATE_DIR, 'lab', 'runs', id, 'output.log');
// A call holds its target's lock while its runs there execute, so a queued call waits as long as those runs could
// still finish within the hour its MCP clients allow a call (tool_timeout_sec), and never less than two minutes.
const LAB_CALL_BUDGET_MS = 3_600_000;
const labRunLockWait = seconds => Math.max(120_000, LAB_CALL_BUDGET_MS - seconds * 1_000);
// Runs of one call on one target that execute at once, each in its own checkout.
const LAB_SLOTS = 3;

// Lock names allow 63 characters after the optional control- prefix, so a long lane slug is hashed.
function labLock(target) {
  const name = `lab-${target}`;
  return name.length <= 63 ? name : `lab-${createHash('sha256').update(target).digest('hex').slice(0, 16)}`;
}

// Lab targets and findings belong to feature lanes, never to QA agents.
function laneRow(ctx, slug) {
  const lane = featureBySlug(ctx.db, slug);
  if (lane.kind === 'qa') throw new OverdriveError(`${slug} is a QA agent, not a feature lane.`, 'INVALID_TARGET');
  return lane;
}

async function integrationClone(root) {
  const clone = await ensureManagedPath(root, integrationPath(root));
  if (!await exists(clone)) throw new OverdriveError('No integration has been built yet; run integration_build first.', 'INTEGRATION_NOT_BUILT');
  return clone;
}

const suiteNotFound = name => new OverdriveError(`No suite ${name}: lab/suites/${name}/suite.json does not exist.`, 'SUITE_NOT_FOUND');

// The live lab's suite, for listing and naming suites.
async function readSuite(root, lab, name) {
  const directory = await ensureManagedPath(root, contained(lab, 'suites', name));
  let text;
  try { text = await fs.readFile(contained(directory, 'suite.json'), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') throw suiteNotFound(name);
    throw error;
  }
  return parseSuite(name, text);
}

// The suite as recorded in a lab snapshot, which is what a run executes.
async function snapshotSuite(lab, revision, name) {
  const blob = await run(['git', 'cat-file', 'blob', `${revision}:suites/${name}/suite.json`], { cwd: lab, allowFailure: true });
  if (blob.exitCode !== 0) throw suiteNotFound(name);
  return parseSuite(name, blob.stdout);
}

function parseSuite(name, text) {
  const invalid = detail => new OverdriveError(`lab/suites/${name}/suite.json is invalid: ${detail}.`, 'INVALID_SUITE');
  let suite;
  try { suite = JSON.parse(text.replace(/^﻿/, '')); } catch { throw invalid('it is not JSON'); }
  const { argv, cwd = 'suite', timeout_seconds: timeout = 600, description } = suite ?? {};
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 200 || argv.some(part => typeof part !== 'string' || !part || part.includes('\0'))) throw invalid('argv must hold 1-200 non-empty strings');
  if (cwd !== 'suite' && cwd !== 'target') throw invalid('cwd must be "suite" or "target"');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw invalid('timeout_seconds must be an integer from 1 to 3600');
  return { argv, cwd, timeout, description: typeof description === 'string' ? description : '' };
}

async function listSuites(root, lab) {
  let entries = [];
  try { entries = await fs.readdir(contained(lab, 'suites'), { withFileTypes: true }); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const suites = [];
  for (const entry of entries.filter(item => item.isDirectory() && SUITE_NAME.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    try { suites.push({ name: entry.name, description: (await readSuite(root, lab, entry.name)).description }); }
    catch (error) { if (error?.code !== 'SUITE_NOT_FOUND') suites.push({ name: entry.name, error: error.message }); }
  }
  return suites;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function artifactManifest(directory) {
  const names = (await fs.readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort();
  const files = [];
  for (const name of names.slice(0, 1_000)) {
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of createReadStream(path.join(directory, name))) { hash.update(chunk); size += chunk.length; }
      files.push({ path: name, size, sha256: hash.digest('hex') });
    } catch (error) {
      // A process left running by an uncertain run may still hold the file.
      files.push({ path: name, error: error.code ?? error.message });
    }
  }
  return files;
}

async function execute(argv, options) {
  try {
    const result = await run(argv, { ...options, maxOutput: 500_000, combinedTail: true, allowFailure: true, confirmTermination: true });
    return {
      status: result.exitCode === 0 && !result.timedOut ? 'passed' : 'failed',
      exitCode: result.exitCode,
      output: [result.timedOut ? `[timed out after ${options.timeoutMs / 1000}s]` : '', result.overflow ? '[earlier output dropped]' : '', result.stdout],
    };
  } catch (error) {
    // A command that could not start failed; one whose processes may still be running is uncertain.
    return { status: error?.code === 'COMMAND_TERMINATION_UNCERTAIN' ? 'uncertain' : 'failed', exitCode: null, output: [error.message, error.details?.output ?? ''] };
  }
}

function presentRun(root, row, outputLog) {
  const { argv_json: argv, artifacts_json: artifacts, output, ...rest } = row;
  const files = parseJson(artifacts, []);
  return {
    ...rest, argv: parseJson(argv, []), outputTail: (output ?? '').slice(-4_000), ...(outputLog ? { outputLog } : {}),
    artifacts: { directory: runDirectory(root, row.id), count: files.length, files: files.slice(0, 50) },
  };
}

// The lanes an integration commit contains, judged by Git ancestry rather than by the recorded build.
async function integratedLanes(ctx, clone, commit) {
  const lanes = [];
  for (const lane of parseJson(meta(ctx.db, 'integration'), null)?.features ?? []) {
    if (await isGitAncestor(clone, lane.revision, commit)) lanes.push(lane);
  }
  return lanes;
}

// The recorded build is where the clone started; an agent may since have resolved and committed a conflict.
async function integrationStatus(ctx) {
  const built = parseJson(meta(ctx.db, 'integration'), null);
  const clone = integrationPath(ctx.root);
  if (!built || !await exists(path.join(clone, '.git'))) return built;
  const head = (await git(clone, 'rev-parse', 'HEAD')).stdout;
  const included = (await integratedLanes(ctx, clone, head)).map(lane => lane.slug);
  const conflictFiles = (await git(clone, 'diff', '--name-only', '--diff-filter=U')).stdout.split('\n').filter(Boolean);
  return {
    base: built.base, head, built_at: built.built_at, path: clone, included,
    pending: built.features.map(lane => lane.slug).filter(slug => !included.includes(slug)),
    ...(conflictFiles.length ? { conflictFiles } : {}),
  };
}

// A pass resolves a finding only at a revision that contains the one it was found at and is not
// part of the failing run's revision, such as the HEAD under a snapshot whose uncommitted change failed.
// A failing integration commit exists only in the integration clone, so that check runs there.
async function resolvableFindings(ctx, repository, suite, features, commit) {
  if (!features.length) return [];
  const rows = ctx.db.prepare(`SELECT findings.id, feature, found_revision, lab_runs.revision AS failed_revision, lab_runs.target AS failed_target FROM findings LEFT JOIN lab_runs ON lab_runs.id = findings.found_run
    WHERE findings.status = 'open' AND repro_suite = ? AND feature IN (${features.map(() => '?').join(', ')})`).all(suite, ...features);
  const integration = integrationPath(ctx.root);
  const resolved = [];
  for (const row of rows) {
    if (row.found_revision && !await isGitAncestor(repository, row.found_revision, commit)) continue;
    const failedIn = row.failed_target === 'integration' && await exists(integration) ? integration : repository;
    if (row.failed_revision && await isGitAncestor(failedIn, commit, row.failed_revision)) continue;
    resolved.push(row);
  }
  return resolved;
}

// What a run tests, and the lanes whose findings its pass can resolve; base belongs to no lane.
// By default only a lane's own agent tests its working tree; anyone else tests what the lane committed.
async function runSubject(ctx, target, lane, requested, creator) {
  if (target === 'base' && !lane) return { ...await baseTarget(ctx, requested), features: [] };
  if (lane) {
    const subject = !requested && lane.slug === creator ? { revision: await snapshotCommit(lane.checkout_path) } : await laneRevision(lane.checkout_path, requested);
    return { source: lane.checkout_path, features: [lane.slug], ...subject };
  }
  const source = await integrationClone(ctx.root);
  const revision = requested ? await verifyCheckoutRevision(source, requested) : (await git(source, 'rev-parse', 'HEAD')).stdout;
  return { source, revision, features: (await integratedLanes(ctx, source, revision)).map(entry => entry.slug) };
}

// An identical run (target, suite, revision and lab snapshot) that ended after this call arrived ran while
// it waited for the target's lock, so it answers this call too; one that ended earlier never does.
function identicalRunSince(db, { target, suite, revision, lab_revision }, arrived) {
  const row = db.prepare("SELECT * FROM lab_runs WHERE target = ? AND suite = ? AND revision = ? AND lab_revision = ? AND status IN ('passed', 'failed') ORDER BY created_at DESC LIMIT 1")
    .get(target, suite, revision, lab_revision);
  return row && Date.parse(row.created_at) + row.duration_ms >= arrived ? row : null;
}

function runSummary(root, row) {
  const { argv: _argv, artifacts: { files: _files, ...artifacts }, ...summary } = presentRun(root, row, runLog(root, row.id));
  return { ...summary, artifacts };
}

function runResponse(root, { row, details, notes }) {
  return { run: runSummary(root, row), ...details, next: [...notes, `Earlier output is in run.outputLog; lab_get {"run": "${row.id}"} lists its artifacts.`].join(' ') };
}

function batchResponse(root, requests, results) {
  const notes = new Set();
  const runs = results.map(({ value, error }, index) => {
    if (error) return { suite: requests[index].name, target: requests[index].target, error: error.message, code: error.code ?? null };
    value.notes.forEach(note => notes.add(note));
    const run = runSummary(root, value.row);
    return { ...run, outputTail: run.outputTail.slice(-1_000), ...value.details };
  });
  return { runs, next: [...notes, 'Each run\'s earlier output is in its outputLog; lab_get {"run": "<id>"} lists its artifacts.'].join(' ') };
}

// The single form is a batch of one.
function labRequests({ suite, target, revision, batch }) {
  if (batch === undefined) return [{ suite, target, revision }];
  if (suite !== undefined || target !== undefined || revision !== undefined) throw new OverdriveError('Pass either suite, target and revision, or batch, not both.', 'INVALID_INPUT');
  if (!Array.isArray(batch) || batch.length < 1 || batch.length > 8) throw new OverdriveError('batch must list 1-8 runs.', 'INVALID_INPUT');
  return batch;
}

const settle = promise => promise.then(value => ({ value }), error => ({ error }));

// One run on a synced checkout in the given slot: reuse an identical run, or execute and record it.
async function runOnSlot(ctx, { name, target, lane, spec }, subject, slot, call) {
  const { source, revision: commit, features, uncommittedFiles } = subject;
  // Processes of a run whose termination is uncertain may still use its target and lab directories. Slugs never
  // contain --, so slot directories never collide with a lane's.
  const uncertain = Number(ctx.db.prepare("SELECT COUNT(*) AS count FROM lab_runs WHERE target = ? AND status = 'uncertain'").get(target).count);
  const directory = `${uncertain ? `${target}--${uncertain}` : target}${slot ? `--s${slot}` : ''}`;
  const checkout = await syncLabCheckout(ctx.root, 'targets', directory, source, commit, ctx.config.repository);
  const { labRevision } = call;
  const details = target === 'integration' ? { included: features } : {};
  const notes = uncommittedFiles ? [`${target} has uncommitted changes that this run of its HEAD left out.`] : [];
  const reused = identicalRunSince(ctx.db, { target, suite: name, revision: commit, lab_revision: labRevision }, call.arrived);
  if (reused) return { row: reused, details: { reused: true, resolvedFindings: [], ...details }, notes: ['An identical run finished while this call waited for the target, so it was not repeated.', ...notes] };
  // The suite runs from the lab snapshot recorded as lab_revision, never from the live lab QA may be editing.
  const lab = await syncLabCheckout(ctx.root, 'snapshots', directory, call.lab, labRevision);
  const id = `run-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const artifacts = await ensureManagedPath(ctx.root, runDirectory(ctx.root, id));
  await fs.mkdir(artifacts, { recursive: true });
  const cwd = spec.cwd === 'target' ? checkout : await ensureManagedPath(ctx.root, contained(lab, 'suites', name));
  const env = {
    ...process.env,
    OVERDRIVE_TARGET: checkout, OVERDRIVE_REVISION: commit, OVERDRIVE_LAB: lab, OVERDRIVE_SUITE: name,
    OVERDRIVE_ARTIFACTS: artifacts, OVERDRIVE_PORT: String(await freePort()),
  };
  const row = {
    id, suite: name, target, revision: commit, lab_revision: labRevision, argv_json: JSON.stringify(spec.argv), cwd,
    status: 'running', created_by: call.creator, created_at: now(),
  };
  ctx.db.prepare(`INSERT INTO lab_runs(${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row));
  const started = Date.now();
  const result = await execute(spec.argv, { cwd, env, timeoutMs: spec.timeout * 1_000 });
  const log = redactString(result.output.filter(Boolean).join('\n'));
  await fs.writeFile(runLog(ctx.root, id), log, 'utf8');
  Object.assign(row, {
    exit_code: result.exitCode, status: result.status, output: log.slice(-24_000),
    duration_ms: Date.now() - started, artifacts_json: JSON.stringify(await artifactManifest(artifacts)),
  });
  const resolvable = row.status === 'passed' ? await resolvableFindings(ctx, source, name, features, commit) : [];
  const stamp = now();
  // A finding another run of this call resolved first stays credited to that run.
  const resolved = transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE lab_runs SET exit_code = ?, status = ?, output = ?, duration_ms = ?, artifacts_json = ? WHERE id = ?')
      .run(row.exit_code, row.status, row.output, row.duration_ms, row.artifacts_json, id);
    const resolve = ctx.db.prepare("UPDATE findings SET status = 'resolved', resolved_revision = ?, resolved_run = ?, updated_at = ? WHERE id = ? AND status = 'open'");
    const changed = resolvable.filter(finding => resolve.run(commit, id, stamp, finding.id).changes);
    for (const finding of changed) withdrawFindingMessage(ctx.db, finding);
    return changed;
  });
  if (lane) await addEvent(ctx, { featureId: lane.id, kind: 'lab.run', summary: `Suite ${name} ${row.status} at ${commit.slice(0, 12)} (${id}).`, details: { run: id, suite: name, revision: commit, status: row.status, exitCode: row.exit_code } });
  for (const finding of resolved) {
    await addEvent(ctx, { featureId: featureId(ctx.db, finding.feature), kind: 'finding.resolved', summary: `Finding ${finding.id} resolved: suite ${name} passed at ${commit.slice(0, 12)} (${id}).`, details: { finding: finding.id, run: id, revision: commit } });
  }
  return { row, details: { resolvedFindings: resolved.map(finding => finding.id), ...details }, notes };
}

// A call's runs on one target share its lock and run up to LAB_SLOTS at a time, each slot in its own checkout.
async function runOnTarget(ctx, requests, call) {
  const { target } = requests[0];
  return await withWorkspaceLock(ctx.root, labLock(target), async () => {
    // Under this target's lock a run still marked running belongs to a runtime that exited mid-run.
    ctx.db.prepare("UPDATE lab_runs SET status = 'uncertain', output = 'OVERDRIVE stopped before this run finished; its processes may have outlived it.' WHERE target = ? AND status = 'running'").run(target);
    // One at a time, so two snapshots of one checkout never race on its refs.
    const subjects = [];
    for (const request of requests) subjects.push(await settle(runSubject(ctx, target, request.lane, request.requested, call.creator)));
    const results = [];
    let next = 0;
    const slot = async index => {
      while (next < requests.length) {
        const at = next++;
        results[at] = subjects[at].error ? subjects[at] : await settle(runOnSlot(ctx, requests[at], subjects[at].value, index, call));
      }
    };
    await Promise.all(Array.from({ length: Math.min(requests.length, LAB_SLOTS) }, (_, index) => slot(index)));
    return results;
  }, { timeoutMs: labRunLockWait(Math.ceil(requests.length / LAB_SLOTS) * Math.max(...requests.map(request => request.spec.timeout))) });
}

export async function runLabSuite({ workspace_path, batch, from, ...single }) {
  const requests = labRequests({ ...single, batch }).map(entry => ({
    name: suiteName(entry?.suite), target: targetName(entry?.target), requested: optionalText(entry?.revision, 'revision', { max: 200 }),
  }));
  const keys = requests.map(({ name, target, requested }) => `${target} ${name} ${requested ?? ''}`);
  if (new Set(keys).size !== keys.length) throw new OverdriveError('Each run can appear once in a batch; to repeat a scenario, repeat it inside its suite.', 'INVALID_INPUT');
  const call = { creator: agentName(from), arrived: Date.now() };
  return await withContext(workspace_path, async ctx => {
    call.lab = await ensureLab(ctx.root);
    // Every run of the call reads and executes its suite from this one snapshot.
    call.labRevision = await snapshotCommit(call.lab);
    const byTarget = new Map();
    for (const request of requests) {
      request.spec = await snapshotSuite(call.lab, call.labRevision, request.name);
      // A lane named base from before the control target keeps its lab address.
      request.lane = request.target === 'integration' || (request.target === 'base' && !featureId(ctx.db, 'base')) ? null : laneRow(ctx, request.target);
      byTarget.set(request.target, [...byTarget.get(request.target) ?? [], request]);
    }
    const results = new Map();
    await Promise.all([...byTarget.values()].map(async group => {
      const settled = await settle(runOnTarget(ctx, group, call));
      group.forEach((request, index) => results.set(request, settled.error ? settled : settled.value[index]));
    }));
    const ordered = requests.map(request => results.get(request));
    if (batch !== undefined) return batchResponse(ctx.root, requests, ordered);
    if (ordered[0].error) throw ordered[0].error;
    return runResponse(ctx.root, ordered[0].value);
  });
}

export async function getLab({ workspace_path, run: runId, suite, target, findings }) {
  if (findings !== undefined && findings !== 'open' && findings !== 'all') throw new OverdriveError('findings must be open or all.', 'INVALID_INPUT');
  const suiteFilter = suite === undefined ? null : suiteName(suite);
  const targetFilter = target === undefined ? null : targetName(target);
  const runKey = runId === undefined ? null : requiredText(runId, 'run', { max: 100 });
  return await withContext(workspace_path, async ctx => {
    if (runKey) {
      const row = ctx.db.prepare('SELECT * FROM lab_runs WHERE id = ?').get(runKey);
      if (!row) throw new OverdriveError(`Unknown lab run: ${runKey}`, 'RUN_NOT_FOUND');
      const log = runLog(ctx.root, row.id);
      return { run: presentRun(ctx.root, row, await exists(log) ? log : null) };
    }
    const lab = await ensureLab(ctx.root);
    const result = {
      lab,
      suites: await listSuites(ctx.root, lab),
      runs: ctx.db.prepare('SELECT id, suite, target, revision, status, exit_code, duration_ms, created_by, created_at FROM lab_runs WHERE (? IS NULL OR suite = ?) AND (? IS NULL OR target = ?) ORDER BY created_at DESC LIMIT 10')
        .all(suiteFilter, suiteFilter, targetFilter, targetFilter),
      integration: await integrationStatus(ctx),
    };
    if (findings) {
      // Findings belong to lanes, so an integration shows those of the lanes it includes.
      const lanes = targetFilter === 'integration' ? result.integration?.included ?? [] : targetFilter ? [targetFilter] : null;
      const laneFilter = lanes ? `AND feature IN (${lanes.map(() => '?').join(', ')})` : '';
      result.findings = ctx.db.prepare(`SELECT * FROM findings WHERE (? = 'all' OR status = 'open') ${laneFilter} ORDER BY created_at DESC LIMIT 200`)
        .all(findings, ...(lanes ?? []));
    }
    return result;
  });
}

function reproduction(finding, sender, foundRun, integration) {
  const suite = finding.repro_suite;
  if (!suite) return `There is no repro suite yet; your context packet names it once ${sender} adds it. Ask ${sender} only if the body above does not say how to reproduce it.`;
  if (foundRun?.target !== 'integration') return `Reproduce it with lab_run {"suite": "${suite}", "target": "${finding.feature}"}, which tests your current working tree; a passing run resolves this finding.`;
  return `Suite ${suite} failed on integration ${foundRun.revision.slice(0, 12)} (${foundRun.id}), which combines your lane with others, so a lab_run on your lane alone may not reproduce it; to reproduce it locally, fetch ${foundRun.revision} from ${integration} without merging it into your branch. A passing run of ${suite} on an integration build that includes your fix resolves this finding.`;
}

function findingMessage(finding, sender, foundRun, integration) {
  const reproduce = reproduction(finding, sender, foundRun, integration);
  return `Finding ${finding.id} (${finding.severity}): ${finding.title}\n\n${finding.body}\n\n${reproduce} Fix it at the root cause, commit, and tell ${sender} what changed.`;
}

// A closed finding's fix request that its lane has not received yet must never reach it.
function withdrawFindingMessage(db, finding) {
  const prefix = `Finding ${finding.id} (`;
  db.prepare("UPDATE messages SET status = 'withdrawn' WHERE to_agent = ? AND status = 'pending' AND substr(body, 1, ?) = ?").run(finding.feature, prefix.length, prefix);
}

export async function recordFinding({ workspace_path, id, feature, title, body, severity, repro_suite, status, note, from }) {
  const slug = safeSlug(feature);
  const sender = agentName(from);
  if (severity !== undefined && !SEVERITIES.has(severity)) throw new OverdriveError('severity must be blocking or minor.', 'INVALID_INPUT');
  if (status !== undefined && !FINDING_STATUSES.has(status)) throw new OverdriveError('status must be open, resolved or wontfix.', 'INVALID_INPUT');
  if (status === 'resolved' && sender !== 'coordinator') throw new OverdriveError('A passing lab_run of the repro suite resolves a finding. Use wontfix with a note for a judgment call, or ask the coordinator.', 'INVALID_INPUT');
  const findingId = id === undefined ? undefined : requiredText(id, 'id', { max: 100 });
  const changes = Object.fromEntries(Object.entries({
    title: optionalText(title, 'title', { max: 500 }),
    body: optionalText(body, 'body', { max: 50_000 }),
    severity,
    status,
    repro_suite: repro_suite === undefined ? undefined : suiteName(repro_suite, 'repro_suite'),
    note: optionalText(note, 'note', { max: 20_000 }),
  }).filter(([, value]) => value !== undefined));
  return await withContext(workspace_path, async ctx => {
    const lane = laneRow(ctx, slug);
    if (changes.repro_suite) await readSuite(ctx.root, await ensureLab(ctx.root), changes.repro_suite);
    const head = (await git(lane.checkout_path, 'rev-parse', 'HEAD')).stdout;
    const stamp = now();
    const { finding, existing, opened } = transaction(ctx.db, () => {
      const existing = findingId === undefined ? null : ctx.db.prepare('SELECT * FROM findings WHERE id = ?').get(findingId);
      if (findingId !== undefined && !existing) throw new OverdriveError(`Unknown finding: ${findingId}`, 'FINDING_NOT_FOUND');
      if (existing && existing.feature !== slug) throw new OverdriveError(`Finding ${findingId} belongs to ${existing.feature}, not ${slug}.`, 'INVALID_INPUT');
      if (!existing && (!changes.title || !changes.body)) throw new OverdriveError('A new finding needs a title and body.', 'INVALID_INPUT');
      const finding = {
        ...(existing ?? { id: `finding-${randomUUID().slice(0, 8)}`, feature: slug, severity: 'blocking', status: 'open', found_revision: head, created_by: sender, created_at: stamp }),
        ...changes,
        updated_at: stamp,
      };
      // Text inherited from an older row is redacted too, so an update never carries a stored secret forward.
      for (const field of ['title', 'body', 'note']) if (finding[field] != null) finding[field] = redactString(finding[field]);
      const opened = finding.status === 'open' && existing?.status !== 'open';
      // A new or reopened finding is judged from the lane's current head and latest failure, and a coordinator's resolution records where it was judged.
      if (opened) Object.assign(finding, { found_revision: head, found_run: null, resolved_revision: null, resolved_run: null });
      else if (finding.status !== existing?.status) Object.assign(finding, { resolved_revision: finding.status === 'resolved' ? head : null, resolved_run: null });
      // Many findings are first seen on an integration build, so its failing runs count too.
      if (finding.repro_suite && !finding.found_run) {
        finding.found_run = ctx.db.prepare("SELECT id FROM lab_runs WHERE target IN (?, 'integration') AND suite = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1").get(slug, finding.repro_suite)?.id ?? null;
      }
      const columns = ['id', 'feature', 'title', 'body', 'severity', 'status', 'repro_suite', 'found_revision', 'found_run', 'resolved_revision', 'resolved_run', 'note', 'created_by', 'created_at', 'updated_at'];
      ctx.db.prepare(`INSERT OR REPLACE INTO findings(${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => finding[column] ?? null));
      if (opened) {
        const foundRun = finding.found_run ? ctx.db.prepare('SELECT id, target, revision FROM lab_runs WHERE id = ?').get(finding.found_run) : null;
        ctx.db.prepare("INSERT INTO messages(from_agent, to_agent, body, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(sender, slug, redactString(findingMessage(finding, sender, foundRun, integrationPath(ctx.root))), stamp);
      } else if (existing?.status === 'open' && finding.status !== 'open') withdrawFindingMessage(ctx.db, finding);
      return { finding, existing, opened };
    });
    await addEvent(ctx, {
      featureId: lane.id,
      kind: existing ? 'finding.updated' : 'finding.recorded',
      summary: redactString(`Finding ${finding.id} ${finding.status} (${finding.severity}): ${finding.title}`),
      details: { finding: finding.id, status: finding.status, severity: finding.severity, reproSuite: finding.repro_suite ?? null, from: sender, messaged: opened },
    });
    return { finding, messagedLane: opened };
  });
}

function laneReference(value, index) {
  const text = requiredText(value, `features[${index}]`, { max: 300 });
  const at = text.indexOf('@');
  return {
    slug: safeSlug(at < 0 ? text : text.slice(0, at), `features[${index}]`),
    ref: at < 0 ? undefined : requiredText(text.slice(at + 1), `features[${index}] revision`, { max: 200 }),
  };
}

async function integrationBase(ctx, ref) {
  if (ctx.config.managedProject) {
    const project = await ensureManagedPath(ctx.root, contained(ctx.root, 'project'));
    return { source: project, revision: await verifyCheckoutRevision(project, ref ?? 'HEAD') };
  }
  const refreshed = await refreshMirror(ctx.root);
  return { source: mirrorPath(ctx.root), revision: ref ? await resolveMirrorRevision(ctx.root, ref) : refreshed.defaultRevision };
}

// A commit only a lane holds, such as the foundation lane's commit that later lanes start from.
// Only a commit ID counts: a lane checkout's own branch and remote names are not base.
async function laneCommit(ctx, ref) {
  for (const lane of listFeatureRows(ctx.db)) {
    const revision = lane.kind === 'qa' ? null : await verifyCheckoutRevision(lane.checkout_path, ref).catch(() => null);
    if (revision?.startsWith(ref.toLowerCase())) return { source: lane.checkout_path, revision };
  }
  return null;
}

// Unlike an integration build, a control run does not fetch upstream; it tests the cached revision.
async function baseTarget(ctx, ref) {
  try {
    if (ctx.config.managedProject) return await integrationBase(ctx, ref);
    return { source: mirrorPath(ctx.root), revision: await resolveMirrorRevision(ctx.root, ref) };
  } catch (error) {
    const found = error?.code === 'INVALID_REVISION' && ref ? await laneCommit(ctx, ref) : null;
    if (!found) throw error;
    return found;
  }
}

// integrate accepts only committed lane work, so an unpinned lane contributes its HEAD and counts what it leaves out.
async function laneRevision(checkout, ref) {
  if (ref) return { revision: await verifyCheckoutRevision(checkout, ref) };
  const { head, clean, changedFileCount } = await repositorySnapshot(checkout);
  return { revision: head, ...(clean ? {} : { uncommittedFiles: changedFileCount }) };
}

export async function buildIntegration({ workspace_path, features, base, from }) {
  if (!Array.isArray(features) || features.length < 1 || features.length > 50) throw new OverdriveError('features must list 1-50 lanes.', 'INVALID_INPUT');
  const requested = features.map(laneReference);
  if (new Set(requested.map(entry => entry.slug)).size !== requested.length) throw new OverdriveError('Each lane can appear once in an integration.', 'INVALID_INPUT');
  const baseRef = optionalText(base, 'base', { max: 200 });
  const caller = agentName(from);
  return await withContext(workspace_path, ctx => withWorkspaceLock(ctx.root, labLock('integration'), async () => {
    const built = parseJson(meta(ctx.db, 'integration'), null)?.head ?? null;
    const lanes = [];
    for (const { slug, ref } of requested) {
      const checkout = laneRow(ctx, slug).checkout_path;
      lanes.push({ slug, checkout, ...await laneRevision(checkout, ref) });
    }
    const start = await integrationBase(ctx, baseRef);
    const clone = await resetIntegration(ctx.root, start.revision, start.source, built, ctx.config.repository);
    // Recorded before merging, so a failed build never leaves an older composition describing this clone.
    const composition = { base: start.revision, features: lanes.map(({ checkout, ...lane }) => lane), head: null, built_at: now() };
    meta(ctx.db, 'integration', JSON.stringify(composition));
    for (const lane of lanes) {
      const files = await mergeIntoIntegration(ctx.root, clone, lane.checkout, lane.revision, `Integrate ${lane.slug} ${lane.revision.slice(0, 12)}`);
      if (files.length) { composition.conflict = { feature: lane.slug, files: files.slice(0, 200) }; break; }
    }
    if (!composition.conflict) composition.head = (await git(clone, 'rev-parse', 'HEAD')).stdout;
    meta(ctx.db, 'integration', JSON.stringify(composition));
    await addEvent(ctx, {
      kind: composition.conflict ? 'integration.conflict' : 'integration.built',
      summary: composition.conflict
        ? `Integration stopped at a conflict merging ${composition.conflict.feature}.`
        : `Built integration ${composition.head.slice(0, 12)} of ${lanes.map(lane => lane.slug).join(', ')}.`,
      details: composition,
    });
    const notes = [];
    // Only QA resolves conflicts in the clone, and a merge left in place would block its next build.
    if (composition.conflict && caller === 'coordinator') {
      await git(clone, 'merge', '--abort');
      notes.push(`Merging ${composition.conflict.feature} conflicted, so the merge was aborted. Send the conflicting files to the owning lanes, or have qa rebuild and resolve a trivial conflict in the integration clone.`);
    } else if (composition.conflict) {
      notes.push(`The conflicted merge is left in ${clone}. Resolve and commit it there to test it with lab_run target integration, or run git merge --abort there and have the lanes reconcile before rebuilding.`);
    }
    const leftOut = lanes.filter(lane => lane.uncommittedFiles).map(lane => lane.slug);
    if (leftOut.length) notes.push(`Uncommitted files in ${leftOut.join(', ')} are not in this build; to include them, have each lane commit, then rebuild.`);
    // A rebuild of the same lanes, or a fast-forward to a lane head QA already tested, can land on a commit with runs.
    const runs = composition.head ? latestRunsBySuite(ctx, composition.head) : [];
    if (runs.length) notes.push(`${composition.head.slice(0, 12)} already has runs (${runs.map(run => `${run.suite} ${run.status}`).join(', ')}); integrate counts a pass at this commit on any target, so a suite that passed here needs no rerun unless it changed since.`);
    return { integration: composition, path: clone, ...(runs.length ? { runs } : {}), ...(notes.length ? { next: notes.join(' ') } : {}) };
  }));
}

// Only committed lane work is integrated, never a snapshot of a working tree.
async function assertCommitted(lane, revision) {
  if (!await isGitAncestor(lane.checkout_path, revision, 'HEAD')) {
    throw new OverdriveError(`${revision.slice(0, 12)} is not committed on ${lane.branch}. Have the ${lane.slug} agent commit its work, then test and integrate that commit.`, 'INTEGRATE_DIRTY');
  }
}

async function laneTarget(ctx, slug, requested) {
  const lane = laneRow(ctx, slug);
  const snapshot = await repositorySnapshot(lane.checkout_path);
  if (!requested && !snapshot.clean) throw new OverdriveError(`${slug} has uncommitted changes. Have its agent commit them, then test and integrate that commit.`, 'INTEGRATE_DIRTY');
  const commit = requested ? await verifyCheckoutRevision(lane.checkout_path, requested) : snapshot.head;
  await assertCommitted(lane, commit);
  return { target: slug, commit, source: lane.checkout_path, branch: lane.branch, lanes: [slug] };
}

// The recorded composition describes only the current build, so an older commit is refused.
async function integrationTarget(ctx, requested) {
  const clone = await integrationClone(ctx.root);
  const snapshot = await repositorySnapshot(clone);
  if (!snapshot.clean) throw new OverdriveError(`The integration clone ${clone} has uncommitted changes; commit or discard them there first.`, 'INTEGRATE_DIRTY');
  const commit = requested ? await verifyCheckoutRevision(clone, requested) : snapshot.head;
  if (!await isGitAncestor(clone, commit, 'HEAD')) {
    throw new OverdriveError(`${commit.slice(0, 12)} is not part of the current integration build. Rebuild it with integration_build, test the new head, and integrate that.`, 'INTEGRATE_STALE');
  }
  const lanes = await integratedLanes(ctx, clone, commit);
  for (const lane of lanes) await assertCommitted(laneRow(ctx, lane.slug), lane.revision);
  return { target: 'integration', commit, source: clone, branch: null, lanes: lanes.map(lane => lane.slug) };
}

async function markLanesDone(ctx, lanes, summary, details) {
  const stamp = now();
  transaction(ctx.db, () => {
    // The agent's last handoff stays in the timeline; the lane summary says where its work went.
    const done = ctx.db.prepare("UPDATE features SET status = 'done', summary = ?, next_action = '', updated_at = ? WHERE slug = ? AND status <> 'archived'");
    for (const slug of lanes) done.run(summary, stamp, slug);
  });
  for (const slug of lanes) {
    await addEvent(ctx, { featureId: featureId(ctx.db, slug), kind: 'lab.integrated', summary, details });
    await writeFeatureContext(ctx, laneRow(ctx, slug));
  }
  await writeIndex(ctx);
}

// Every suite's latest verdict at the commit, so integrate cites what was actually run there.
function latestRunsBySuite(ctx, commit) {
  const latest = new Map();
  for (const row of ctx.db.prepare('SELECT id, suite, target, status FROM lab_runs WHERE revision = ? ORDER BY created_at DESC').all(commit)) {
    if (!latest.has(row.suite)) latest.set(row.suite, row);
  }
  return [...latest.values()];
}

function evidenceGapsNote(runs, suitesNotRun) {
  const unpassed = runs.filter(run => run.status !== 'passed').map(run => run.suite);
  return [
    unpassed.length ? `The latest runs of ${unpassed.join(', ')} at this commit have not passed; check them with lab_get before reporting the delivery.` : '',
    suitesNotRun.length ? `${suitesNotRun.join(', ')} never ran at this commit; do not report them as passing it.` : '',
  ].filter(Boolean).join(' ');
}

// An adopted repository is never published to; a tested commit with no open blocking findings is
// delivered, and the user publishes it with the returned push command or fetches it into their own clone.
async function deliverAdopted(ctx, { target, commit, source, branch, lanes }, passing, blocking, runs, suitesNotRun) {
  const delivered = Boolean(passing) && !blocking.length;
  // The integration clone holds its commit only as a detached HEAD, which the next rebuild moves.
  await git(source, 'update-ref', `refs/overdrive/delivered/${commit}`, commit);
  if (delivered) await markLanesDone(ctx, lanes, `Delivered in ${commit.slice(0, 12)}; not published.`, { target, commit, runs });
  const ref = `${commit}:refs/heads/${branch ?? '<branch>'}`;
  const push = `git -C "${source}" push "${ctx.config.repository}" ${ref}`;
  const fetch = `git fetch "${source}" ${ref}`;
  const gaps = evidenceGapsNote(runs, suitesNotRun);
  return {
    published: false, target, commit, branch, path: source, lanes, lanesDone: delivered, runs, ...(suitesNotRun.length ? { suitesNotRun } : {}),
    openBlockingFindings: blocking.map(finding => finding.id), push, fetch,
    next: `OVERDRIVE never publishes to an adopted repository. ${delivered ? 'The included lanes are marked done.' : 'The lanes stay open until this commit has a passing lab run and no open blocking findings.'} With the user's authority, run the push command, with their fork's URL instead when they cannot push to the repository, then merge the branch through the repository's normal review; otherwise give the user the fetch command, which creates that branch at this commit in their own clone.${branch ? '' : ' In either command, replace <branch> with a new branch name.'}${gaps ? ` ${gaps}` : ''}`,
  };
}

// A suite that has only run on base and passed there, such as a harness self-test, checks the lab rather than the lanes.
async function suitesNotRunAt(ctx, runs) {
  const baseOnly = new Set(ctx.db.prepare("SELECT suite FROM lab_runs GROUP BY suite HAVING SUM(target <> 'base') = 0 AND SUM(status = 'passed') > 0").all().map(row => row.suite));
  return (await listSuites(ctx.root, await ensureLab(ctx.root))).map(suite => suite.name)
    .filter(name => !baseOnly.has(name) && !runs.some(run => run.suite === name));
}

async function promote(ctx, { target, commit, source, branch, lanes }) {
  const passing = ctx.db.prepare("SELECT id FROM lab_runs WHERE revision = ? AND status = 'passed' ORDER BY created_at DESC LIMIT 1").get(commit) ?? null;
  const runs = latestRunsBySuite(ctx, commit);
  const suitesNotRun = await suitesNotRunAt(ctx, runs);
  const blocking = lanes.length
    ? ctx.db.prepare(`SELECT id, feature, title FROM findings WHERE status = 'open' AND severity = 'blocking' AND feature IN (${lanes.map(() => '?').join(', ')})`).all(...lanes)
    : [];
  const managed = ctx.config.managedProject;
  if (!managed) return await deliverAdopted(ctx, { target, commit, source, branch, lanes }, passing, blocking, runs, suitesNotRun);
  if (!passing) throw new OverdriveError(`No passing lab run at ${commit.slice(0, 12)}; run lab_run against ${target} at that revision first.`, 'INTEGRATE_UNTESTED');
  if (blocking.length) {
    throw new OverdriveError(`Open blocking findings: ${blocking.map(finding => `${finding.id} (${finding.feature}: ${finding.title})`).join('; ')}.`, 'INTEGRATE_BLOCKED', { findings: blocking.map(finding => finding.id) });
  }
  const project = await ensureManagedPath(ctx.root, contained(ctx.root, 'project'));
  const before = await repositorySnapshot(project);
  if (!before.clean) throw new OverdriveError('The managed project has uncommitted changes; preserve or resolve them before integrating.', 'DIRTY_MANAGED_PROJECT');
  if (before.branch !== managed.defaultBranch) throw new OverdriveError(`The managed project must be on ${managed.defaultBranch}, not ${before.branch || 'a detached HEAD'}.`, 'WRONG_MANAGED_BRANCH');
  await git(project, 'fetch', '--no-tags', source, `${commit}:refs/overdrive/integrate/${commit}`);
  const alreadyIncluded = await isGitAncestor(project, commit, before.head);
  if (!alreadyIncluded && !await isGitAncestor(project, before.head, commit)) {
    throw new OverdriveError(`${commit.slice(0, 12)} does not contain the project HEAD ${before.head.slice(0, 12)}, so integrating it would not be a fast-forward. Build the integration on the current project HEAD (integration_build does by default) or have the lane merge it, then test the new commit.`, 'PROMOTION_NOT_FAST_FORWARD');
  }
  if (!alreadyIncluded) await run(['git', ...runtimeGitConfig(ctx.root), 'merge', '--ff-only', commit], { cwd: project });
  const refreshed = await refreshMirror(ctx.root);
  transaction(ctx.db, () => {
    meta(ctx.db, 'default_revision', refreshed.defaultRevision);
    meta(ctx.db, 'default_branch', refreshed.defaultBranch);
  });
  await markLanesDone(ctx, lanes, `Integrated ${commit.slice(0, 12)} into project/ ${managed.defaultBranch}.`, { target, commit, runs });
  const gaps = evidenceGapsNote(runs, suitesNotRun);
  return {
    integrated: !alreadyIncluded, alreadyIncluded, target, commit, lanes, runs, ...(suitesNotRun.length ? { suitesNotRun } : {}),
    project: { path: project, branch: managed.defaultBranch, head: alreadyIncluded ? before.head : commit },
    ...(gaps ? { next: gaps } : {}),
  };
}

export async function integrate({ workspace_path, target, revision }) {
  const targetSlug = targetName(target);
  const requested = optionalText(revision, 'revision', { max: 200 });
  const root = await resolveWorkspace(workspace_path);
  // Integration moves the revision new lanes start from, so it shares the lane-creation lock.
  return await withWorkspaceLock(root, 'features', async () => {
    const ctx = await loadWorkspace(root);
    try {
      if (targetSlug !== 'integration') return await promote(ctx, await laneTarget(ctx, targetSlug, requested));
      return await withWorkspaceLock(root, labLock('integration'), async () => promote(ctx, await integrationTarget(ctx, requested)));
    } finally { ctx.db.close(); }
  });
}
