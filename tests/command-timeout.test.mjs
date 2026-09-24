import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { run } from '../plugins/feature-theater/scripts/util.mjs';
import { runChecks, updateChecks } from '../plugins/feature-theater/scripts/verification.mjs';
import { drainCheckQueue, enqueueChecks, inspectCheckQueue, resolveCheckJob } from '../plugins/feature-theater/scripts/check-queue.mjs';
import { createFeature, getFeatureContext, initializeManagedProject, recordCandidate, setFeatureStatus } from '../plugins/feature-theater/scripts/workspace.mjs';

const windowsOnly = { skip: process.platform !== 'win32' && 'taskkill applies only on Windows' };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const readPid = async file => Number(await fs.readFile(file, 'utf8'));
async function stopped(pid) {
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await sleep(50);
  return !alive(pid);
}
// A long-running node command that records its PID; it ends itself after 30s if cleanup ever fails.
const holder = pidFile => `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`;
// The same, first starting a descendant that shares its output pipes. On Windows it is detached so
// that ending the command itself does not also end it through node's kill-on-close job object.
const parentOf = (pidFile, childPidFile) => `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder(childPidFile))}], { stdio: 'inherit', detached: ${process.platform === 'win32'} }); ${holder(pidFile)}`;

// Puts a taskkill.exe first on PATH that exits 1 after delayMs without touching any process: node
// under that name, whose preload exits for it and does nothing in any other node process. Every PID
// recorded through pidFile is killed if still running, and the shim is removed afterwards.
async function failingTaskkill(t, { delayMs = 0 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-taskkill-'));
  const pidFiles = [];
  const previous = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    for (const file of pidFiles) {
      const pid = await readPid(file).catch(() => null);
      if (pid && alive(pid)) process.kill(pid);
      if (pid) assert.equal(await stopped(pid), true, `temporary process ${pid} is still running`);
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const shim = path.join(directory, 'taskkill.exe');
  await fs.link(process.execPath, shim).catch(() => fs.copyFile(process.execPath, shim));
  const preload = path.join(directory, 'taskkill-preload.cjs');
  await fs.writeFile(preload, `if (require('node:path').basename(process.execPath).toLowerCase() === 'taskkill.exe') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs}); process.exit(1); }\n`);
  process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`.trim();
  process.env.PATH = `${directory}${path.delimiter}${previous.PATH}`;
  // The real taskkill prints its help and exits 0 for /?; the shim exits 1.
  assert.equal(spawnSync('taskkill.exe', ['/?'], { windowsHide: true }).status, 1);
  return { pidFile: name => { const file = path.join(directory, `${name}.pid`); pidFiles.push(file); return file; } };
}

test('ordinary command results and a confirmed tree kill are unchanged by confirmTermination', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-tree-kill-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  for (const confirmTermination of [false, true]) {
    assert.equal((await run([process.execPath, '-e', "console.log('ok')"], { confirmTermination })).stdout, 'ok');
    assert.equal((await run([process.execPath, '-e', 'process.exit(3)'], { allowFailure: true, confirmTermination })).exitCode, 3);
    await assert.rejects(run([process.execPath, '-e', 'process.exit(3)'], { confirmTermination }), error => error.code === 'COMMAND_FAILED' && /exit 3/.test(error.message));
  }
  // The real tree kill (taskkill /T on Windows) stops the command and a descendant holding its output.
  const [parent, descendant] = [path.join(directory, 'parent.pid'), path.join(directory, 'descendant.pid')];
  const result = await run([process.execPath, '-e', parentOf(parent, descendant)], { timeoutMs: 1_000, allowFailure: true, confirmTermination: true });
  assert.equal(result.timedOut, true);
  for (const file of [parent, descendant]) assert.equal(await stopped(await readPid(file)), true);
});

test('a failed taskkill falls back to stopping the command and reports its tree unconfirmed', windowsOnly, async t => {
  const shim = await failingTaskkill(t);
  const plainPid = shim.pidFile('plain');
  const started = Date.now();
  // Callers that did not ask for confirmation still get their ordinary timed-out result, naming the uncertainty.
  const plain = await run([process.execPath, '-e', holder(plainPid)], { timeoutMs: 500, allowFailure: true });
  assert.equal(plain.timedOut, true);
  assert.match(plain.terminationUncertain, /taskkill exited 1, so its process tree was not confirmed stopped/);
  assert.equal(await stopped(await readPid(plainPid)), true);

  const confirmedPid = shim.pidFile('confirmed');
  await assert.rejects(run([process.execPath, '-e', holder(confirmedPid)], { timeoutMs: 500, allowFailure: true, confirmTermination: true }),
    error => error.code === 'COMMAND_TERMINATION_UNCERTAIN' && error.details.commandExited === true && /taskkill exited 1/.test(error.message));
  assert.equal(await stopped(await readPid(confirmedPid)), true);

  // A descendant that survives the direct stop keeps the output open; the close deadline reports it.
  const [parent, descendant] = [shim.pidFile('parent'), shim.pidFile('descendant')];
  await assert.rejects(run([process.execPath, '-e', parentOf(parent, descendant)], { timeoutMs: 1_000, allowFailure: true, confirmTermination: true, terminationGraceMs: 300 }),
    error => error.code === 'COMMAND_TERMINATION_UNCERTAIN' && error.details.commandExited === true && /did not close within 1s/.test(error.message));
  assert.equal(await stopped(await readPid(parent)), true);
  assert.equal(alive(await readPid(descendant)), true, 'the uncertainty is real: the descendant still runs until cleanup');
  assert.ok(Date.now() - started < 15_000);
});

test('a command that closes before taskkill reports failure is still unconfirmed', windowsOnly, async t => {
  // The command exits on its own ~200ms after its deadline; taskkill reports failure ~1500ms after it.
  await failingTaskkill(t, { delayMs: 1_500 });
  const command = [process.execPath, '-e', 'setTimeout(() => {}, 30000); setTimeout(() => process.exit(0), 700)'];
  const started = Date.now();
  await assert.rejects(run(command, { timeoutMs: 500, allowFailure: true, confirmTermination: true }),
    error => error.code === 'COMMAND_TERMINATION_UNCERTAIN' && error.details.commandExited === true && /taskkill exited 1/.test(error.message));
  assert.ok(Date.now() - started >= 1_900, 'settled only after taskkill reported');
  // Without confirmation the ordinary timed-out result also waits for taskkill and names the uncertainty.
  const plainStarted = Date.now();
  const plain = await run(command, { timeoutMs: 500, allowFailure: true });
  assert.ok(Date.now() - plainStarted >= 1_900, 'settled only after taskkill reported');
  assert.equal(plain.timedOut, true);
  assert.equal(plain.exitCode, 0);
  assert.match(plain.terminationUncertain, /taskkill exited 1/);
});

test('every timed-out Windows command settles within its close deadline while a descendant holds its output', windowsOnly, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-open-output-'));
  const pidFiles = [];
  const pidFile = name => { const file = path.join(directory, `${name}.pid`); pidFiles.push(file); return file; };
  t.after(async () => {
    for (const file of pidFiles) {
      const pid = await readPid(file).catch(() => null);
      if (pid && alive(pid)) process.kill(pid);
      if (pid) assert.equal(await stopped(pid), true, `temporary process ${pid} is still running`);
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const bounded = { timeoutMs: 500, terminationGraceMs: 300 };
  // The command exits at once but leaves a detached descendant holding its output, so the real
  // taskkill can no longer reach it; ordinary callers get a bounded, labelled timed-out result.
  const orphan = pidFile('orphan');
  const exitsEarly = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(holder(orphan))}], { stdio: 'inherit', detached: true }).unref()`;
  let started = Date.now();
  const result = await run([process.execPath, '-e', exitsEarly], { ...bounded, allowFailure: true });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.terminationUncertain, /did not close within 1s of it \(had already exited while its output stayed open/);
  assert.equal(alive(await readPid(orphan)), true, 'the uncertainty is real: the descendant still runs until cleanup');
  await assert.rejects(run([process.execPath, '-e', exitsEarly.replace(JSON.stringify(orphan), JSON.stringify(pidFile('orphan-strict')))], bounded),
    error => error.code === 'COMMAND_FAILED' && /after its deadline \(Passed its deadline and did not close/.test(error.message));

  // After a failed taskkill, the stopped command's surviving descendant likewise cannot hold an ordinary caller.
  const shim = await failingTaskkill(t);
  const [parent, descendant] = [shim.pidFile('parent'), shim.pidFile('descendant')];
  started = Date.now();
  const failed = await run([process.execPath, '-e', parentOf(parent, descendant)], { timeoutMs: 1_000, terminationGraceMs: 300, allowFailure: true });
  assert.ok(Date.now() - started < 5_000);
  assert.match(failed.terminationUncertain, /did not close within 1s of it \(taskkill exited 1\)/);
  assert.equal(await stopped(await readPid(parent)), true);
  assert.equal(alive(await readPid(descendant)), true);
});

// A lane with a passing receipt and a ready candidate whose check, while .hang names a PID file,
// records its PID there and outlives its one-second deadline.
async function verifiedLane(t, feature) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-uncertain-check-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 }));
  const args = { workspace_path: workspace, feature };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Hanging', description: 'A check can outlive its deadline.' });
  const repo = (await createFeature({ ...args, title: 'Hanging', outcome: 'Verified only when its checks settle.', spec: '# Hanging\n\nThe README exists.' })).feature.checkoutPath;
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.hang\n');
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', timeout_seconds: 1, argv: [process.execPath, '-e',
    "const fs = require('node:fs'); fs.readFileSync('README.md'); if (fs.existsSync('.hang')) { fs.writeFileSync(fs.readFileSync('.hang', 'utf8'), String(process.pid)); setTimeout(() => {}, 30000); }"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  const database = () => new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  const executedReceipts = () => {
    const db = database();
    try { return db.prepare("SELECT id, passed FROM evidence WHERE source = 'executed' ORDER BY rowid").all().map(row => ({ ...row })); }
    finally { db.close(); }
  };
  return { workspace, args, repo, database, executedReceipts, hang: pidFile => fs.writeFile(path.join(repo, '.hang'), pidFile) };
}

test('an unconfirmed check stop records no receipt and reserves the clone until execution_stopped', windowsOnly, async t => {
  const shim = await failingTaskkill(t);
  const { workspace, args, repo, executedReceipts, hang } = await verifiedLane(t, 'hanging');
  const directPid = shim.pidFile('direct');
  const queuedPid = shim.pidFile('queued');
  const receipts = executedReceipts();

  await hang(directPid);
  await assert.rejects(runChecks(args), error => error.code === 'COMMAND_TERMINATION_UNCERTAIN' && /^direct-/.test(error.details.reservedBy) && /No receipt was recorded/.test(error.message));
  assert.equal(await stopped(await readPid(directPid)), true);
  assert.deepEqual(executedReceipts(), receipts);
  const reserved = (await inspectCheckQueue({ workspace_path: workspace })).jobs.find(job => job.direct);
  assert.equal(reserved.status, 'interrupted');
  assert.equal((await getFeatureContext(args)).timeline[0].kind, 'checks.execution_uncertain');
  // The earlier pass stays on record but cannot be used, and the clone cannot be verified again.
  const reservedError = error => error.code === 'CHECK_EXECUTION_RESERVED' && error.message.includes(reserved.key);
  await assert.rejects(runChecks(args), reservedError);
  await assert.rejects(recordCandidate({ ...args, summary: 'Ready again.', checks: ['README receipt'] }), reservedError);
  await assert.rejects(setFeatureStatus({ ...args, status: 'done' }), reservedError);
  await assert.rejects(resolveCheckJob({ workspace_path: workspace, job_key: reserved.key, action: 'cancel', reason: 'Unverified.' }), error => error.code === 'EXECUTION_UNCERTAIN');
  await resolveCheckJob({ workspace_path: workspace, job_key: reserved.key, action: 'cancel', reason: 'The check process exited.', execution_stopped: true });

  // A queued run keeps its own job interrupted, again without a receipt.
  await hang(queuedPid);
  await enqueueChecks({ workspace_path: workspace, jobs: [{ key: 'hanging-readme', feature: 'hanging', check_key: 'readme' }] });
  const queued = (await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'hanging-readme');
  assert.equal(queued.status, 'interrupted');
  assert.match(queued.reason, /No receipt was recorded/);
  assert.equal(await stopped(await readPid(queuedPid)), true);
  assert.deepEqual(executedReceipts(), receipts);
  await assert.rejects(runChecks(args), error => error.code === 'CHECK_EXECUTION_RESERVED');
  await resolveCheckJob({ workspace_path: workspace, job_key: 'hanging-readme', action: 'cancel', reason: 'The check process exited.', execution_stopped: true });

  await fs.rm(path.join(repo, '.hang'));
  assert.equal((await runChecks(args)).verification.ready, true);
  await setFeatureStatus({ ...args, status: 'done' });
  assert.equal((await getFeatureContext(args)).feature.status, 'done');
});

test('a direct check reservation fails closed on the lane when the queue cannot record it', windowsOnly, async t => {
  const shim = await failingTaskkill(t);
  const { workspace, args, repo, executedReceipts, hang } = await verifiedLane(t, 'unqueued');
  const receipts = executedReceipts();
  // A directory where the queue lock file belongs makes the interrupted job impossible to write.
  const queueLock = path.join(workspace, '.theater', 'locks', 'verification-queue.lock');
  await fs.mkdir(queueLock, { recursive: true });
  await hang(shim.pidFile('direct'));
  let reservedBy;
  await assert.rejects(runChecks(args), error => {
    reservedBy = error.details?.reservedBy;
    return error.code === 'COMMAND_TERMINATION_UNCERTAIN' && /^direct-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reservedBy)
      && Boolean(error.details.reservationError) && /recorded on the lane only/.test(error.message);
  });
  await fs.rm(queueLock, { recursive: true });
  assert.deepEqual(executedReceipts(), receipts);
  assert.equal((await inspectCheckQueue({ workspace_path: workspace })).jobs.length, 0);
  const reservedError = error => error.code === 'CHECK_EXECUTION_RESERVED' && error.message.includes(reservedBy);
  await assert.rejects(runChecks(args), reservedError);
  await assert.rejects(recordCandidate({ ...args, summary: 'Ready again.', checks: ['README receipt'] }), reservedError);
  await assert.rejects(setFeatureStatus({ ...args, status: 'done' }), reservedError);
  // A queued check for the lane is deferred before its command starts rather than interrupted.
  await enqueueChecks({ workspace_path: workspace, jobs: [{ key: 'unqueued-readme', feature: 'unqueued', check_key: 'readme' }] });
  const deferred = (await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'unqueued-readme');
  assert.equal(deferred.status, 'queued');
  assert.equal(deferred.attempts.at(-1).status, 'deferred');
  assert.deepEqual(executedReceipts(), receipts);

  await assert.rejects(resolveCheckJob({ workspace_path: workspace, job_key: reservedBy, action: 'cancel', reason: 'Unverified.' }), error => error.code === 'EXECUTION_UNCERTAIN');
  await assert.rejects(resolveCheckJob({ workspace_path: workspace, job_key: reservedBy, action: 'retry', reason: 'No job.', execution_stopped: true }), error => error.code === 'INVALID_INPUT');
  // A queue job that shares the marker's key but is not interrupted still cannot release it unconfirmed.
  await enqueueChecks({ workspace_path: workspace, jobs: [{ key: reservedBy, feature: 'unqueued', check_key: 'readme' }] });
  await assert.rejects(resolveCheckJob({ workspace_path: workspace, job_key: reservedBy, action: 'cancel', reason: 'Unverified.' }), error => error.code === 'EXECUTION_UNCERTAIN');
  await assert.rejects(runChecks(args), reservedError);
  assert.equal((await resolveCheckJob({ workspace_path: workspace, job_key: reservedBy, action: 'cancel', reason: 'The check process exited.', execution_stopped: true })).job.status, 'cancelled');
  await fs.rm(path.join(repo, '.hang'));
  assert.equal((await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'unqueued-readme').status, 'passed');
  await setFeatureStatus({ ...args, status: 'done' });
  assert.equal((await getFeatureContext(args)).feature.status, 'done');
});
