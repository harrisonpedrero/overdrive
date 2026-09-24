import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withWorkspaceLock } from '../plugins/feature-theater/scripts/util.mjs';

const CONTENDER = path.join(import.meta.dirname, 'fixtures', 'lock-contender.mjs');
const DEAD_PID = 2 ** 30;

async function lockWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-lock-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  });
  const locks = path.join(workspace, '.theater', 'locks');
  await fs.mkdir(locks, { recursive: true });
  await fs.mkdir(path.join(workspace, 'markers'));
  const lockFile = path.join(locks, 'features.lock');
  const contender = (...args) => {
    const child = spawn(process.execPath, [CONTENDER, workspace, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const line = new Promise((resolve, reject) => {
      child.stdout.on('data', () => { if (stdout.includes('\n')) resolve(stdout.split('\n')[0].trim()); });
      child.once('exit', code => reject(new Error(`contender ${args.join(' ')} exited ${code} before reporting`)));
    });
    const exited = once(child, 'exit').then(([code]) => ({ code, stdout: stdout.trim() }));
    return { child, line, exited };
  };
  const plantDeadLock = async () => {
    await fs.writeFile(lockFile, JSON.stringify({ token: randomUUID(), pid: DEAD_PID, createdAt: new Date().toISOString(), note: 'dead-owner' }));
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockFile, past, past);
  };
  return { workspace, locks, lockFile, contender, plantDeadLock, marker: file => fs.readFile(path.join(workspace, 'markers', file), 'utf8').catch(() => null) };
}

test('two processes reclaiming one dead-owner lock never share the callback or remove the replacement lock', async t => {
  const { lockFile, contender, plantDeadLock, marker } = await lockWorkspace(t);
  await plantDeadLock();
  const results = await Promise.all([contender('race', 'a').exited, contender('race', 'b').exited]);
  assert.deepEqual(results.map(result => result.code), [0, 0], JSON.stringify(results));
  assert.deepEqual(results.map(result => result.stdout), ['a', 'b']);
  assert.deepEqual([await marker('read-a'), await marker('read-b')], ['', ''], 'both contenders read the dead record');
  assert.equal(await marker('overlaps'), null, 'two contenders held the callback at once');
  assert.equal((await marker('removals')).trim().split('\n').length, 1, 'the lock path was removed more than once');
  await assert.rejects(fs.stat(lockFile), error => error.code === 'ENOENT');
});

test('two reclaimers in one process never share the callback or remove the replacement lock', async t => {
  const { workspace, lockFile, plantDeadLock } = await lockWorkspace(t);
  await plantDeadLock();
  const same = file => path.resolve(String(file)) === lockFile;
  const gate = () => { let open; const opened = new Promise(resolve => { open = resolve; }); return { open, wait: () => Promise.race([opened, new Promise(resolve => setTimeout(resolve, 2_000))]) }; };
  const bothRead = gate();
  const entered = gate();
  let deadReads = 0;
  let removals = 0;
  const { readFile, rename } = fs;
  t.after(() => { fs.readFile = readFile; fs.rename = rename; });
  fs.readFile = async function (file, ...rest) {
    const content = await readFile.call(this, file, ...rest);
    if (same(file) && String(content).includes('dead-owner') && deadReads < 2) {
      if (++deadReads === 2) bothRead.open();
      await bothRead.wait();
    }
    return content;
  };
  fs.rename = async function (from, ...rest) {
    if (same(from) && ++removals === 2) await entered.wait();
    return rename.call(this, from, ...rest);
  };
  let active = 0;
  let maxActive = 0;
  const reclaimer = name => withWorkspaceLock(workspace, 'features', async () => {
    maxActive = Math.max(maxActive, ++active);
    entered.open();
    await new Promise(resolve => setTimeout(resolve, 400));
    active -= 1;
    return name;
  }, { timeoutMs: 5_000 });
  assert.deepEqual(await Promise.all([reclaimer('a'), reclaimer('b')]), ['a', 'b']);
  assert.equal(deadReads, 2);
  assert.equal(maxActive, 1);
  assert.equal(removals, 1);
});

test('a live lock in another process is never stolen and is recovered once that process dies', async t => {
  const { workspace, lockFile, contender } = await lockWorkspace(t);
  const holder = contender('hold');
  assert.equal(await holder.line, 'held');
  const held = await fs.readFile(lockFile, 'utf8');
  assert.equal(JSON.parse(held).pid, holder.child.pid);
  await assert.rejects(withWorkspaceLock(workspace, 'features', () => assert.fail('entered a live lock'), { timeoutMs: 800 }), error => error.code === 'WORKSPACE_BUSY');
  assert.equal(await fs.readFile(lockFile, 'utf8'), held);

  holder.child.kill();
  await holder.exited;
  assert.equal(await withWorkspaceLock(workspace, 'features', () => 'after crash', { timeoutMs: 5_000 }), 'after crash');
  await assert.rejects(fs.stat(lockFile), error => error.code === 'ENOENT');
});

test('a dead-owner lock waits while another process holds the reclaim guard and recovers when that holder dies', async t => {
  const { workspace, locks, lockFile, contender, plantDeadLock } = await lockWorkspace(t);
  await plantDeadLock();
  assert.equal(await withWorkspaceLock(workspace, 'features', () => 'recovered', { timeoutMs: 2_000 }), 'recovered');
  assert.deepEqual(await fs.readdir(locks), ['features.lock.reclaim']);
  assert.equal((await fs.stat(`${lockFile}.reclaim`)).size, 0);

  await plantDeadLock();
  const guard = contender('guard');
  assert.equal(await guard.line, 'held');
  const planted = await fs.readFile(lockFile, 'utf8');
  await assert.rejects(withWorkspaceLock(workspace, 'features', () => assert.fail('reclaimed without the guard'), { timeoutMs: 800 }), error => error.code === 'WORKSPACE_BUSY');
  assert.equal(await fs.readFile(lockFile, 'utf8'), planted);
  guard.child.kill();
  await guard.exited;
  assert.equal(await withWorkspaceLock(workspace, 'features', () => 'after guard crash', { timeoutMs: 5_000 }), 'after guard crash');
  assert.deepEqual(await fs.readdir(locks), ['features.lock.reclaim']);
});

test('a throwing callback releases its lock and distinct lock names do not block each other', async t => {
  const { workspace, locks } = await lockWorkspace(t);
  await assert.rejects(withWorkspaceLock(workspace, 'features', () => withWorkspaceLock(workspace, 'agent-state', () => { throw new Error('boom'); }, { timeoutMs: 300 }), { timeoutMs: 300 }), /boom/);
  assert.equal(await withWorkspaceLock(workspace, 'features', () => withWorkspaceLock(workspace, 'agent-state', () => 'free', { timeoutMs: 300 }), { timeoutMs: 300 }), 'free');
  assert.deepEqual(await fs.readdir(locks), []);
});
