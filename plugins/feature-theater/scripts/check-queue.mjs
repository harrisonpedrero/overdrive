import { randomUUID } from 'node:crypto';
import { CHECK_QUEUE_META, featureBySlug, loadWorkspace, meta, newId, recordEvent } from './state.mjs';
import { repositorySnapshot } from './git.mjs';
import { assertAgentIdle, featureChecks, featureContract, runChecks, verificationStatus } from './verification.mjs';
import { TheaterError, now, requiredText, resolveWorkspace, safeSlug, withWorkspaceLock } from './util.mjs';

const activeRunners = new Set();
const HISTORY_LIMIT = 500;
const RETIRED_EVENT = 'checks.queue_retired';
const settled = job => ['passed', 'cancelled'].includes(job.status);
const reserving = job => ['running', 'interrupted'].includes(job.status);
const resources = job => [`clone:${job.featureId}`, ...job.resources.map(key => `shared:${key}`)];
const overlaps = (left, right) => resources(left).some(key => resources(right).includes(key));

function alive(owner) {
  if (!owner) return false;
  if (owner.pid === process.pid) return activeRunners.has(owner.token);
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function receipt(ctx, job) {
  if (!job.attempts.length) return null;
  return ctx.db.prepare(`SELECT id, passed, duration_ms, created_at FROM evidence WHERE id = ?
    AND feature_id = ? AND source = 'executed' AND check_key = ? AND revision = ? AND contract_hash = ?`).get(
    job.attempts.at(-1).receiptId, job.featureId, job.checkKey, job.revision, job.contractHash,
  );
}

function finish(job, evidence) {
  job.status = evidence.passed ? 'passed' : 'failed';
  job.reason = evidence.passed ? null : 'Inspect the failed receipt before explicitly retrying or replanning.';
  Object.assign(job.attempts.at(-1), { finishedAt: evidence.created_at, executionMs: evidence.duration_ms, status: job.status });
}

function recover(ctx, queue) {
  if (alive(queue.runner)) return;
  queue.runner = null;
  for (const job of queue.jobs.filter(job => job.status === 'running')) {
    const evidence = receipt(ctx, job);
    if (evidence) finish(job, evidence);
    else {
      job.status = 'interrupted';
      job.reason = 'Controller ended without a durable completion receipt. Establish command termination before releasing its clone and shared resources.';
      job.attempts.at(-1).status = 'interrupted';
    }
  }
}

async function access(root, operation) {
  return withWorkspaceLock(root, 'verification-queue', async () => {
    const ctx = await loadWorkspace(root);
    try {
      const raw = meta(ctx.db, CHECK_QUEUE_META);
      const queue = raw ? JSON.parse(raw) : { version: 1, runner: null, jobs: [] };
      if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw new TheaterError('Unsupported verification queue state.', 'INVALID_STATE');
      recover(ctx, queue);
      const result = await operation(ctx, queue);
      meta(ctx.db, CHECK_QUEUE_META, JSON.stringify(queue));
      return result;
    } finally { ctx.db.close(); }
  });
}

function keys(value, label, maximum = 50) {
  if (!Array.isArray(value) || value.length > maximum || value.some(key => typeof key !== 'string' || safeSlug(key, label) !== key) || new Set(value).size !== value.length) {
    throw new TheaterError(`${label} must contain unique lowercase keys (at most ${maximum}).`, 'INVALID_INPUT');
  }
  return [...value].sort();
}

async function binding(ctx, job) {
  const feature = featureBySlug(ctx.db, job.feature);
  const snapshot = await repositorySnapshot(feature.checkout_path);
  if (feature.id !== job.featureId || !snapshot.clean || snapshot.head !== job.revision || featureContract(ctx.db, feature) !== job.contractHash) {
    throw new TheaterError('Commit, clean checkout, or full verification contract changed; replan this action.', 'STALE_QUEUE_JOB');
  }
  return feature;
}

// A direct run holds its lane's control lock while its command may leave transient files in the clone, so a
// clone is judged only under that lock. It is tried, never awaited: a direct run can take this queue's lock
// while holding its own, so waiting here could deadlock.
async function whileLanesIdle(root, slugs, fn) {
  const [slug, ...rest] = slugs;
  if (!slug) return fn();
  let held = false;
  try {
    return await withWorkspaceLock(root, `control-${slug}`, () => { held = true; return whileLanesIdle(root, rest, fn); }, { timeoutMs: 0 });
  } catch (error) {
    if (held || error?.code !== 'WORKSPACE_BUSY') throw error;
    throw new TheaterError(`Waiting for a direct check or control operation on ${slug} to finish before judging its clone.`, 'LANE_BUSY');
  }
}

function retiredJob(db, key) {
  const row = db.prepare(`SELECT details_json FROM events WHERE kind = ? AND json_extract(details_json, '$.job.key') = ?
    ORDER BY id DESC LIMIT 1`).get(RETIRED_EVENT, key);
  return row ? JSON.parse(row.details_json).job : null;
}

// Only settled jobs leave the bounded queue, oldest first. Anything a remaining job depends on, this request names,
// or the live drain started stays; the full record moves to the event log and its receipts stay in evidence.
function retirable(queue, jobs, keep, excess) {
  const since = queue.runner ? Date.parse(queue.runner.startedAt) : Infinity;
  const retired = new Set();
  let progress = true;
  while (progress && retired.size < excess) {
    progress = false;
    const remaining = jobs.filter(job => !retired.has(job));
    const referenced = new Set(remaining.flatMap(job => job.dependsOn));
    for (const job of remaining) {
      if (retired.size >= excess) break;
      if (!settled(job) || keep.has(job) || referenced.has(job.key) || job.attempts.some(attempt => Date.parse(attempt.startedAt) >= since)) continue;
      retired.add(job); progress = true;
    }
  }
  return retired;
}

export async function enqueueChecks(args) {
  if (!Array.isArray(args.jobs) || !args.jobs.length || args.jobs.length > 50) throw new TheaterError('Supply 1–50 verification jobs.', 'INVALID_INPUT');
  const root = await resolveWorkspace(args.workspace_path);
  return access(root, async (ctx, queue) => {
    const additions = [];
    for (const input of args.jobs) {
      const key = safeSlug(input.key, 'job key');
      if (additions.some(job => job.key === key)) throw new TheaterError('Job keys must be unique.', 'INVALID_INPUT');
      const feature = featureBySlug(ctx.db, safeSlug(input.feature));
      assertAgentIdle(feature);
      if (!featureChecks(ctx.db, feature.id).some(check => check.key === input.check_key)) throw new TheaterError('Unknown configured check key.', 'INVALID_INPUT');
      const snapshot = await repositorySnapshot(feature.checkout_path);
      if (!snapshot.clean) throw new TheaterError('Commit reviewed changes before queueing verification.', 'DIRTY_CANDIDATE');
      const job = {
        key, feature: feature.slug, featureId: feature.id, checkKey: input.check_key,
        revision: snapshot.head, contractHash: featureContract(ctx.db, feature),
        dependsOn: keys(input.depends_on ?? [], 'dependency key'), resources: keys(input.resources ?? [], 'resource key', 20),
      };
      const live = queue.jobs.find(item => item.key === key);
      const existing = live ?? retiredJob(ctx.db, key);
      if (existing && Object.keys(job).some(field => JSON.stringify(existing[field]) !== JSON.stringify(job[field]))) {
        throw new TheaterError('Job key already binds a different action; use a new key for a new revision or plan.', 'QUEUE_KEY_CONFLICT');
      }
      additions.push(live ?? (existing ? { ...existing, retired: true } : { ...job, status: 'queued', queuedAt: now(), eligibleAt: null, reason: null, attempts: [] }));
    }
    let combined = [...queue.jobs, ...additions.filter(job => !job.retired && !queue.jobs.includes(job))];
    const retiring = combined.length > HISTORY_LIMIT ? retirable(queue, combined, new Set(additions), combined.length - HISTORY_LIMIT) : new Set();
    combined = combined.filter(job => !retiring.has(job));
    if (combined.length > HISTORY_LIMIT) {
      throw new TheaterError(`The queue retains at most ${HISTORY_LIMIT} jobs and none of the excess is settled, unreferenced history. Review failed, stale or interrupted jobs and retry or cancel them before queueing more.`, 'QUEUE_LIMIT');
    }
    const visiting = new Set(), visited = new Set();
    function visit(job) {
      if (visiting.has(job.key)) throw new TheaterError('Queue dependencies must be acyclic.', 'INVALID_INPUT');
      if (visited.has(job.key)) return;
      visiting.add(job.key);
      for (const key of job.dependsOn) {
        const dependency = combined.find(item => item.key === key);
        if (!dependency) {
          throw new TheaterError(retiredJob(ctx.db, key) ? `Dependency ${key} settled and was retired from queue history; depend on a fresh job instead.` : `Unknown dependency: ${key}`, 'INVALID_INPUT');
        }
        visit(dependency);
      }
      visiting.delete(job.key); visited.add(job.key);
    }
    combined.forEach(visit);
    for (const job of retiring) {
      recordEvent(ctx.db, { featureId: job.featureId, kind: RETIRED_EVENT, summary: `Retired settled queue job ${job.key} (${job.status}); its receipts remain in evidence.`, details: { job } });
    }
    queue.jobs = combined;
    return { jobs: additions, ...(retiring.size ? { retired: [...retiring].map(job => job.key) } : {}) };
  });
}

export async function inspectCheckQueue(args) {
  return access(await resolveWorkspace(args.workspace_path), (_ctx, queue) => queue);
}

function bounded(value, fallback, maximum, name) {
  const actual = value ?? fallback;
  if (!Number.isInteger(actual) || actual < 1 || actual > maximum) throw new TheaterError(`${name} must be 1–${maximum}.`, 'INVALID_INPUT');
  return actual;
}

export async function drainCheckQueue(args) {
  const parallel = bounded(args.max_parallel, 2, 4, 'max_parallel');
  const maximum = bounded(args.max_checks, 10, 50, 'max_checks');
  const seconds = bounded(args.admission_seconds, 60, 300, 'admission_seconds');
  const root = await resolveWorkspace(args.workspace_path);
  const token = randomUUID();
  activeRunners.add(token);
  const executing = new Map(), deferred = new Set();
  const started = [];
  const deadline = Date.now() + seconds * 1000;
  try {
    await access(root, (_ctx, queue) => {
      if (queue.runner) throw new TheaterError('A live controller already owns this verification drain.', 'QUEUE_OWNED');
      queue.runner = { token, pid: process.pid, startedAt: now() };
    });
    async function execute(job) {
      let error = null;
      try {
        await runChecks({ workspace_path: root, feature: job.feature, check_keys: [job.checkKey] }, {
          receiptId: job.attempts.at(-1).receiptId, revision: job.revision, contractHash: job.contractHash,
        });
      } catch (caught) { error = caught; }
      await access(root, (ctx, queue) => {
        const current = queue.jobs.find(item => item.key === job.key);
        const evidence = receipt(ctx, current);
        if (evidence) finish(current, evidence);
        // A lane reservation outside the queue (a direct run's marker) refuses the job before its command starts.
        else if (['AGENT_BUSY', 'WORKSPACE_BUSY', 'CHECK_EXECUTION_RESERVED'].includes(error?.code)) {
          current.status = 'queued'; current.reason = error.message; deferred.add(job.key);
          Object.assign(current.attempts.at(-1), { status: 'deferred', finishedAt: now(), executionMs: 0 });
        } else {
          current.status = ['STALE_QUEUE_JOB', 'DIRTY_CANDIDATE', 'CHECKS_REQUIRED', 'INVALID_INPUT'].includes(error?.code) ? 'stale' : 'interrupted';
          current.reason = error?.message ?? 'No completion receipt; establish command termination before retry.';
          current.attempts.at(-1).status = current.status;
        }
        recordEvent(ctx.db, { featureId: current.featureId, kind: 'checks.queue_finished', summary: `Queued check ${current.key}: ${current.status}.`, details: { jobKey: current.key, status: current.status, attempt: current.attempts.at(-1) } });
      });
      return job.key;
    }
    while (true) {
      const admitted = await access(root, async (ctx, queue) => {
        if (queue.runner?.token !== token) throw new TheaterError('Queue ownership changed.', 'QUEUE_OWNED');
        const selected = [];
        for (const job of queue.jobs) {
          if (job.status !== 'queued' || deferred.has(job.key)) continue;
          const dependencies = job.dependsOn.map(key => queue.jobs.find(item => item.key === key));
          if (dependencies.some(item => item.status !== 'passed')) {
            job.reason = `Waiting for: ${dependencies.filter(item => item.status !== 'passed').map(item => `${item.key} (${item.status})`).join(', ')}`;
            continue;
          }
          // A command still using a clone can leave transient files there; judge that clone only after the command settles.
          if (queue.jobs.some(other => reserving(other) && overlaps(job, other))
            || dependencies.some(dependency => queue.jobs.some(other => other.status === 'running' && other.featureId === dependency.featureId))) {
            job.eligibleAt ??= now(); job.reason = 'Waiting for a reserved clone or shared resource.'; continue;
          }
          try {
            await whileLanesIdle(root, [...new Set([job, ...dependencies].map(item => item.feature))].sort(), async () => {
              for (const dependency of dependencies) {
                const dependencyFeature = await binding(ctx, dependency);
                const latest = verificationStatus(ctx, dependencyFeature, dependency.revision).checks.find(check => check.key === dependency.checkKey);
                if (latest?.status !== 'passed') throw new TheaterError(`Dependency lacks current passing evidence: ${dependency.key}; review and replan.`, 'STALE_QUEUE_JOB');
              }
              assertAgentIdle(await binding(ctx, job));
            });
          } catch (error) {
            job.reason = error.message;
            if (!['AGENT_BUSY', 'LANE_BUSY'].includes(error.code)) job.status = 'stale';
            continue;
          }
          job.eligibleAt ??= now();
          if (executing.size + selected.length >= parallel || started.length + selected.length >= maximum || Date.now() >= deadline) continue;
          job.status = 'running'; job.reason = null;
          const startedAt = now();
          job.attempts.push({ receiptId: newId('evidence'), status: 'running', startedAt,
            queueWaitMs: Date.parse(startedAt) - Date.parse(job.queuedAt),
            eligibleWaitMs: Date.parse(startedAt) - Date.parse(job.eligibleAt), finishedAt: null, executionMs: null });
          selected.push(job);
        }
        return selected;
      });
      for (const job of admitted) {
        started.push(job.key);
        executing.set(job.key, execute(job));
      }
      if (!executing.size) break;
      const completed = await Promise.race(executing.values());
      executing.delete(completed);
    }
    return await access(root, (_ctx, queue) => ({
      started, jobs: queue.jobs, admissionExpired: Date.now() >= deadline,
      completed: queue.jobs.filter(job => started.includes(job.key) && ['passed', 'failed'].includes(job.status)).map(job => ({ key: job.key, feature: job.feature, status: job.status, receiptId: job.attempts.at(-1).receiptId })),
      needsAttention: queue.jobs.filter(job => ['failed', 'stale', 'interrupted'].includes(job.status)).map(job => ({ key: job.key, feature: job.feature, status: job.status, reason: job.reason })),
      nextAction: 'Reconcile completed receipts and ready feature handoffs now. Review failures before retry; drain remaining eligible work without waiting for a heartbeat.',
    }));
  } finally {
    await Promise.allSettled(executing.values());
    try { await access(root, (_ctx, queue) => { if (queue.runner?.token === token) queue.runner = null; }); }
    finally { activeRunners.delete(token); }
  }
}

export async function resolveCheckJob(args) {
  const key = safeSlug(args.job_key, 'job key');
  const reason = requiredText(args.reason, 'reason', { max: 2000 });
  if (!['retry', 'cancel'].includes(args.action)) throw new TheaterError('Action must be retry or cancel.', 'INVALID_INPUT');
  return access(await resolveWorkspace(args.workspace_path), async (ctx, queue) => {
    const job = queue.jobs.find(item => item.key === key);
    // A direct run's lane marker names its job, and may be all that was recorded if the queue could not be written.
    const marker = ctx.db.prepare("SELECT key FROM meta WHERE key LIKE 'checks-uncertain:%' AND json_extract(value, '$.jobKey') = ?").get(key);
    if (!job && !marker) throw new TheaterError('Queue job not found.', 'INVALID_INPUT');
    if (job?.status === 'running' || job?.status === 'passed') throw new TheaterError('Running or passing jobs cannot be resolved or rerun.', 'INVALID_INPUT');
    if ((marker || job.status === 'interrupted') && args.execution_stopped !== true) throw new TheaterError('First establish that the previous command and its children stopped, then confirm execution_stopped.', 'EXECUTION_UNCERTAIN');
    if (!job && args.action === 'retry') throw new TheaterError('This reservation has no queue job to retry; cancel it, then run or queue the check again.', 'INVALID_INPUT');
    if (job && args.action === 'retry') {
      assertAgentIdle(await binding(ctx, job));
      job.queuedAt = now(); job.eligibleAt = null;
    }
    const resolution = { action: args.action, reason, at: now(), executionStopped: args.execution_stopped === true };
    if (marker) {
      ctx.db.prepare('DELETE FROM meta WHERE key = ?').run(marker.key);
      recordEvent(ctx.db, { featureId: marker.key.slice('checks-uncertain:'.length), kind: 'checks.execution_resolved', summary: `Released the clone reserved by check job ${key}: ${reason}`, details: { jobKey: key, resolution } });
    }
    if (!job) return { job: { key, status: 'cancelled', resolution } };
    job.status = args.action === 'retry' ? 'queued' : 'cancelled';
    job.reason = reason;
    job.resolution = resolution;
    return { job };
  });
}
