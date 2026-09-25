// Cross-process modes for the workspace-lock tests.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withWorkspaceLock } from '../../plugins/overdrive/scripts/util.mjs';

const [workspace, mode, name = mode] = process.argv.slice(2);
const lockFile = path.join(workspace, '.overdrive', 'locks', 'features.lock');
const markers = path.join(workspace, 'markers');
const marker = file => path.join(markers, file);
const exists = file => fs.access(marker(file)).then(() => true, () => false);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => { for (const end = Date.now() + 5_000; Date.now() < end && !(await condition());) await sleep(10); };
const same = file => path.resolve(String(file)) === lockFile;

if (mode === 'guard') {
  // A collected connection closes and releases its lock, so the interval keeps it referenced.
  const guard = new DatabaseSync(`${lockFile}.reclaim`);
  guard.exec('BEGIN IMMEDIATE');
  console.log('held');
  setInterval(() => guard.isOpen, 1_000);
} else if (mode === 'hold') {
  await withWorkspaceLock(workspace, 'features', () => { console.log('held'); return new Promise(() => setInterval(() => {}, 1_000)); });
} else if (mode === 'crash-writing') {
  // Die after persisting only a prefix of the lock record, whichever file receives it.
  const { open, writeFile } = fs;
  const inLocks = file => path.dirname(path.resolve(String(file))) === path.dirname(lockFile);
  const crash = async (write, data) => { await write(String(data).slice(0, 10)); process.exit(86); };
  fs.open = async function (file, ...rest) {
    const handle = await open.call(this, file, ...rest);
    if (inLocks(file)) { const write = handle.writeFile.bind(handle); handle.writeFile = data => crash(write, data); }
    return handle;
  };
  fs.writeFile = async function (file, data, ...rest) {
    if (inLocks(file)) return crash(prefix => writeFile.call(this, file, prefix, ...rest), data);
    return writeFile.call(this, file, data, ...rest);
  };
  await withWorkspaceLock(workspace, 'features', () => { console.log('entered'); process.exit(1); });
} else if (mode === 'crash-published') {
  // Die immediately after the lock path is published, before the callback or any cleanup runs.
  const { link } = fs;
  fs.link = async function (from, to) {
    await link.call(this, from, to);
    if (same(to)) process.exit(87);
  };
  await withWorkspaceLock(workspace, 'features', () => { console.log('entered'); process.exit(1); });
} else {
  const { readFile, rename } = fs;
  let observedDead = false;
  fs.readFile = async function (file, ...rest) {
    const content = await readFile.call(this, file, ...rest);
    if (same(file) && !observedDead && String(content).includes('dead-owner')) {
      observedDead = true;
      await fs.writeFile(marker(`read-${name}`), '');
      await until(async () => await exists('read-a') && await exists('read-b'));
    }
    return content;
  };
  fs.rename = async function (from, ...rest) {
    if (same(from)) {
      await fs.appendFile(marker('removals'), `${name}\n`);
      try { await fs.writeFile(marker('first-removal'), name, { flag: 'wx' }); } catch { await until(() => exists('entered')); }
    }
    return rename.call(this, from, ...rest);
  };
  const result = await withWorkspaceLock(workspace, 'features', async () => {
    try { await fs.writeFile(marker('holder'), name, { flag: 'wx' }); } catch { await fs.appendFile(marker('overlaps'), `${name}\n`); }
    await fs.writeFile(marker('entered'), name);
    await sleep(400);
    await fs.rm(marker('holder'), { force: true });
    return name;
  }, { timeoutMs: 10_000 });
  console.log(result);
}
