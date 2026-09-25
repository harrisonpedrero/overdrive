import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { git } from '../plugins/overdrive/scripts/util.mjs';
import { FINGERPRINT_LIMITS, checkoutFingerprint, compareCheckoutFingerprints, repositorySnapshot } from '../plugins/overdrive/scripts/git.mjs';
import { checkpointFeature, createFeature, getFeatureContext, initializeWorkspace, switchFeature, updateSpec } from '../plugins/overdrive/scripts/workspace.mjs';

const commit = (repo, message) => git(repo, '-c', 'user.name=Checkout Test', '-c', 'user.email=checkout@example.invalid', 'commit', '-q', '-m', message);

async function repository(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-fingerprint-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  await git(repo, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 1;\n');
  await fs.writeFile(path.join(repo, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(repo, '.gitignore'), 'build.log\n');
  await git(repo, 'add', '.');
  await commit(repo, 'base');
  return repo;
}

const compare = async (repo, saved) => compareCheckoutFingerprints(saved, await checkoutFingerprint(repo));

test('fingerprints same-count byte changes that status and counts cannot see', async t => {
  const repo = await repository(t);
  const untracked = path.join(repo, 'notes-café-☃.bin');
  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 2;\n');
  await fs.writeFile(untracked, Buffer.from([9, 9, 9]));
  const saved = await checkoutFingerprint(repo);
  const before = await repositorySnapshot(repo);
  assert.equal(saved.indeterminate.length, 0);
  assert.deepEqual(saved.counts, { statusEntries: 2, hashedFiles: 2, hashedBytes: (await fs.stat(path.join(repo, 'app.js'))).size + 3 });

  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 3;\n');
  const after = await repositorySnapshot(repo);
  assert.deepEqual([after.changedFileCount, after.status], [before.changedFileCount, before.status]);
  assert.deepEqual(await compare(repo, saved), { status: 'changed', changed: ['contents'], indeterminate: [] });

  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 2;\n');
  assert.equal((await compare(repo, saved)).status, 'fresh');
  await fs.writeFile(untracked, Buffer.from([9, 9, 8]));
  assert.deepEqual((await compare(repo, saved)).changed, ['contents']);
});

test('separates HEAD, index and working-tree paths, and ignores what Git ignores', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 2;\n');
  await git(repo, 'add', 'app.js');
  const staged = await checkoutFingerprint(repo);
  const indexFile = path.join(repo, '.git', 'index');
  const indexStat = (await fs.stat(indexFile)).mtimeMs;

  // Stat-only changes, ignored files and repeated observation leave the fingerprint and the index alone.
  await fs.utimes(path.join(repo, 'data.bin'), new Date(), new Date(Date.now() + 5_000));
  await fs.writeFile(path.join(repo, 'build.log'), 'generated');
  assert.equal((await compare(repo, staged)).status, 'fresh');
  assert.equal((await fs.stat(indexFile)).mtimeMs, indexStat);

  await fs.writeFile(path.join(repo, 'app.js'), 'export const value = 3;\n');
  await git(repo, 'add', 'app.js');
  assert.deepEqual((await compare(repo, staged)).changed, ['index']);
  const restaged = await checkoutFingerprint(repo);

  await git(repo, 'mv', 'data.bin', 'moved.bin');
  assert.deepEqual((await compare(repo, restaged)).changed, ['index']);
  await git(repo, 'mv', 'moved.bin', 'data.bin');
  await fs.rename(path.join(repo, 'data.bin'), path.join(repo, 'renamed.bin'));
  assert.deepEqual((await compare(repo, restaged)).changed, ['paths', 'contents']);
  await fs.rename(path.join(repo, 'renamed.bin'), path.join(repo, 'data.bin'));

  await commit(repo, 'restaged');
  const committed = await checkoutFingerprint(repo);
  assert.deepEqual((await compare(repo, restaged)).changed, ['head', 'index']);
  await git(repo, 'switch', '-q', '-c', 'other');
  assert.deepEqual((await compare(repo, committed)).changed, ['head']);
});

test('never equates a bounded partial scan with equality, but still proves definite drift', async t => {
  const repo = await repository(t);
  await fs.writeFile(path.join(repo, 'new.txt'), 'untracked');
  const partial = await checkoutFingerprint(repo, { ...FINGERPRINT_LIMITS, contentFiles: 0 });
  assert.equal(partial.contents, null);
  assert.deepEqual(partial.indeterminate.map(item => [item.component, item.reason, item.detail.limit]), [['contents', 'oversized', 'contentFiles']]);
  assert.deepEqual(await compare(repo, partial), { status: 'indeterminate', changed: [], indeterminate: ['contents'] });
  await git(repo, 'add', 'new.txt');
  assert.deepEqual(await compare(repo, partial), { status: 'changed', changed: ['index', 'paths'], indeterminate: ['contents'] });
  assert.deepEqual(compareCheckoutFingerprints(null, partial), { status: 'unverified', reason: 'no_fingerprint', changed: [], indeterminate: [] });
});

async function lanes(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'checkout-freshness-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'source');
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(source);
  await fs.mkdir(workspace);
  await git(source, 'init', '-q', '-b', 'main');
  await fs.writeFile(path.join(source, 'app.js'), 'export const value = 1;\n');
  await git(source, 'add', '.');
  await commit(source, 'base');
  await initializeWorkspace({ workspace_path: workspace, repository: source });
  const alpha = { workspace_path: workspace, feature: 'alpha' };
  const beta = { workspace_path: workspace, feature: 'beta' };
  await createFeature({ ...alpha, title: 'Alpha', outcome: 'Alpha outcome.' });
  await createFeature({ ...beta, title: 'Beta', outcome: 'Beta outcome.' });
  const checkout = path.join(workspace, 'features', 'alpha', 'repo');
  const database = path.join(workspace, '.overdrive', 'state.sqlite3');
  const sql = (statement, ...params) => {
    const db = new DatabaseSync(database);
    try { return db.prepare(statement).run(...params); } finally { db.close(); }
  };
  return { workspace, alpha, beta, checkout, database, sql };
}

const rejectsWith = (promise, code, reason) => assert.rejects(promise, error => {
  assert.equal(error.code, code);
  assert.equal(error.details.reason, reason);
  return true;
});

test('an idle lane cannot switch after same-count checkout drift; an active worker switches with a caveat', async t => {
  const { alpha, beta, checkout, sql, workspace } = await lanes(t);
  // The creation checkpoint fingerprints the new clone, so an untouched lane round-trips cleanly.
  assert.equal((await switchFeature(beta)).checkoutFreshness.status, 'fresh');
  assert.equal((await switchFeature(alpha)).focus, 'alpha');

  await fs.writeFile(path.join(checkout, 'app.js'), 'export const value = 2;\n');
  await checkpointFeature({ ...alpha, summary: 'Alpha edits app.js.', next_action: 'Continue.' });
  await fs.writeFile(path.join(checkout, 'app.js'), 'export const value = 3;\n');
  await assert.rejects(switchFeature(beta), error => {
    assert.equal(error.code, 'CHECKPOINT_REQUIRED');
    assert.equal(error.details.reason, 'checkout_changed');
    assert.deepEqual(error.details.checkout.changed, ['contents']);
    assert.equal(error.details.worker.active, false);
    return true;
  });

  // Semantic-generation freshness is checked first.
  await updateSpec({ ...alpha, content: '# Alpha\n\nRevised.\n', rationale: 'Exercise precedence.' });
  await rejectsWith(switchFeature(beta), 'CHECKPOINT_REQUIRED', 'changed');
  await checkpointFeature({ ...alpha, summary: 'Alpha spec is revised.', next_action: 'Continue.' });

  // A live session owner with no turn is not an active worker.
  await fs.writeFile(path.join(checkout, 'app.js'), 'export const value = 4;\n');
  sql("INSERT OR REPLACE INTO meta(key, value) SELECT 'agent-owner:' || id, ? FROM features WHERE slug = 'alpha'", JSON.stringify({ token: 'owner', pid: process.pid }));
  sql("UPDATE features SET agent_status = 'idle' WHERE slug = 'alpha'");
  await assert.rejects(switchFeature(beta), error => error.details.reason === 'checkout_changed' && error.details.worker.ownerAlive === true);

  sql("UPDATE features SET active_turn_id = 'turn-1' WHERE slug = 'alpha'");
  const switched = await switchFeature(beta);
  assert.equal(switched.focus, 'beta');
  assert.deepEqual([switched.checkoutFreshness.status, switched.checkoutFreshness.worker, switched.checkoutFreshness.changed], ['changed', 'active', ['contents']]);
  assert.match(switched.checkoutFreshness.caveat, /worker was active/);
  const packet = await fs.readFile(path.join(workspace, '.overdrive', 'features', 'alpha', 'context.md'), 'utf8');
  assert.match(packet, /CHECKOUT FRESHNESS CAVEAT: Checkout changed after checkpoint/);
  assert.match((await getFeatureContext(alpha)).checkoutCaveat.message, /contents/);

  // A complete checkpoint clears the caveat.
  sql("UPDATE features SET active_turn_id = NULL WHERE slug = 'alpha'");
  await checkpointFeature({ ...alpha, summary: 'Alpha work settled.', next_action: 'Continue.' });
  assert.equal((await getFeatureContext(alpha)).checkoutCaveat, null);
  assert.doesNotMatch(await fs.readFile(path.join(workspace, '.overdrive', 'features', 'alpha', 'context.md'), 'utf8'), /CAVEAT/);
});

// Worker state is read inside the switch transaction, after the Git scan, so a worker that became
// active after the observation takes this path too: a matching observation is not freshness.
test('an active worker keeps a visible caveat even when its checkout matched the checkpoint', async t => {
  const { alpha, beta, checkout, sql, workspace } = await lanes(t);
  await fs.writeFile(path.join(checkout, 'app.js'), 'export const value = 2;\n');
  sql("UPDATE features SET active_turn_id = 'turn-1' WHERE slug = 'alpha'");
  const drifted = await switchFeature(beta);
  assert.equal(drifted.checkoutFreshness.status, 'changed');
  await switchFeature(alpha);

  // The checkout now matches a new checkpoint, but the worker is still running.
  await checkpointFeature({ ...alpha, summary: 'Alpha edits app.js.', next_action: 'Continue.' });
  const matched = await switchFeature(beta);
  assert.deepEqual([matched.checkoutFreshness.status, matched.checkoutFreshness.worker], ['fresh', 'active']);
  assert.match(matched.checkoutFreshness.caveat, /matched checkpoint .*worker was active/);
  const caveat = (await getFeatureContext(alpha)).checkoutCaveat;
  assert.deepEqual([caveat?.status, caveat?.worker], ['fresh', 'active']);
  assert.match(await fs.readFile(path.join(workspace, '.overdrive', 'features', 'alpha', 'context.md'), 'utf8'), /CHECKOUT FRESHNESS CAVEAT: Checkout matched checkpoint/);

  // Once the worker is idle, a fresh comparison clears it.
  await switchFeature(alpha);
  sql("UPDATE features SET active_turn_id = NULL WHERE slug = 'alpha'");
  const idle = await switchFeature(beta);
  assert.deepEqual([idle.checkoutFreshness.status, idle.checkoutFreshness.caveat], ['fresh', null]);
  assert.equal((await getFeatureContext(alpha)).checkoutCaveat, null);
});

test('an indeterminate comparison needs explicit acceptance and never overrides definite drift', async t => {
  const { alpha, beta, checkout, database, sql } = await lanes(t);
  await switchFeature(alpha);
  await checkpointFeature({ ...alpha, summary: 'Alpha is scoped.', next_action: 'Continue.' });
  const db = new DatabaseSync(database);
  const latest = db.prepare("SELECT c.id, c.checkout_fingerprint_json FROM checkpoints c JOIN features f ON f.id = c.feature_id WHERE f.slug = 'alpha' ORDER BY c.rowid DESC LIMIT 1").get();
  db.close();
  const partial = { ...JSON.parse(latest.checkout_fingerprint_json), contents: null, indeterminate: [{ component: 'contents', reason: 'oversized', detail: { limit: 'contentBytes' } }] };
  sql('UPDATE checkpoints SET checkout_fingerprint_json = ? WHERE id = ?', JSON.stringify(partial), latest.id);

  await rejectsWith(switchFeature(beta), 'CHECKOUT_INDETERMINATE', 'checkout_indeterminate');
  await assert.rejects(switchFeature({ ...beta, accept_unverified_checkout: 'yes' }), error => error.code === 'INVALID_INPUT');
  const accepted = await switchFeature({ ...beta, accept_unverified_checkout: true });
  assert.deepEqual([accepted.checkoutFreshness.status, accepted.checkoutFreshness.accepted], ['indeterminate', true]);
  assert.match(accepted.checkoutFreshness.caveat, /contents oversized/);
  assert.match(accepted.checkoutFreshness.caveat, /explicitly accepted as unverified/);

  // A staged change is definite index drift, which the acceptance flag cannot override.
  await switchFeature(alpha);
  await fs.writeFile(path.join(checkout, 'app.js'), 'export const value = 5;\n');
  await git(checkout, 'add', 'app.js');
  await rejectsWith(switchFeature({ ...beta, accept_unverified_checkout: true }), 'CHECKPOINT_REQUIRED', 'checkout_changed');
});

test('checkpoints saved before checkout fingerprints must be renewed after the schema 6 upgrade', async t => {
  const { alpha, beta, database, sql } = await lanes(t);
  await switchFeature(alpha);
  await checkpointFeature({ ...alpha, summary: 'Saved by schema 5.', next_action: 'Continue.' });
  const db = new DatabaseSync(database);
  db.exec("ALTER TABLE checkpoints DROP COLUMN checkout_fingerprint_json; UPDATE meta SET value = '5' WHERE key = 'schema_version'");
  db.close();

  await rejectsWith(switchFeature(beta), 'CHECKPOINT_REQUIRED', 'checkout_unverified');
  const upgraded = new DatabaseSync(database);
  assert.equal(upgraded.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '7');
  upgraded.close();
  // An active worker may still switch from an unverified checkpoint, with a caveat.
  sql("UPDATE features SET agent_status = 'uncertain' WHERE slug = 'alpha'");
  const active = await switchFeature(beta);
  assert.deepEqual([active.checkoutFreshness.status, active.checkoutFreshness.reason, active.checkoutFreshness.worker], ['unverified', 'no_fingerprint', 'active']);
  // Beta's creation checkpoint predates the upgrade too, so it is renewed before focus returns.
  await rejectsWith(switchFeature(alpha), 'CHECKPOINT_REQUIRED', 'checkout_unverified');
  await checkpointFeature({ ...beta, summary: 'Beta renewed after upgrade.', next_action: 'Continue.' });
  assert.equal((await switchFeature(alpha)).checkoutFreshness.status, 'fresh');
  sql("UPDATE features SET agent_status = 'idle' WHERE slug = 'alpha'");
  await checkpointFeature({ ...alpha, summary: 'Renewed after upgrade.', next_action: 'Continue.' });
  assert.equal((await switchFeature(beta)).checkoutFreshness.status, 'fresh');
});
