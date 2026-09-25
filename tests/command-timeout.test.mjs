import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { run } from '../plugins/overdrive/scripts/util.mjs';

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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-taskkill-'));
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-tree-kill-'));
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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-open-output-'));
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
