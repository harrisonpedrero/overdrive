import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createAgentRuntime } from '../plugins/feature-theater/scripts/agent-runtime.mjs';
import { WorkerBridge } from '../plugins/feature-theater/scripts/app-server.mjs';
import { callTool } from '../plugins/feature-theater/scripts/tools.mjs';
import { git, withWorkspaceLock } from '../plugins/feature-theater/scripts/util.mjs';
import { readEvidence, runChecks, updateChecks } from '../plugins/feature-theater/scripts/verification.mjs';
import { drainCheckQueue, enqueueChecks } from '../plugins/feature-theater/scripts/check-queue.mjs';
import { initializeManagedProject, createFeature, recordCandidate, setFeatureStatus, updateSpec, getFeatureContext, listFeatures, bindAgentSession, saveAgentSession, registerWorkerGuard, readWorkerGuards, clearWorkerGuards, markDescendantsUnconfirmed, readUnconfirmedDescendants, attestDescendantsStopped } from '../plugins/feature-theater/scripts/workspace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('every accepted slug length acquires its own control lock for checks, candidates and agent turns', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-long-slug-'));
  const runtime = createAgentRuntime(new WorkerBridge({ claude: { launch: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-claude-cli.mjs')] } } }));
  t.after(async () => {
    await runtime.shutdownAgentRuntime();
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  });
  await callTool('theater_project_create', { workspace_path: workspace, project_name: 'Long slugs', description: 'Exercise slug boundaries.', harness: 'claude' });
  const slug = (length, lead = 'l') => `${lead}${'a'.repeat(length - 1)}`;
  const slugs = [slug(55), slug(56), slug(63), slug(63, 'm')];
  assert.deepEqual(slugs.map(value => value.length), [55, 56, 63, 63]);
  for (const feature of slugs) {
    const args = { workspace_path: workspace, feature };
    await callTool('theater_feature_create', { ...args, title: `Length ${feature.length}`, outcome: 'Operates under its control lock.', spec: '# Long\n\nThe README exists.' });
    await callTool('theater_checks_update', { ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
    assert.equal((await callTool('theater_checks_run', args)).verification.ready, true);
    await callTool('theater_candidate_record', { ...args, summary: 'Ready.', checks: ['README receipt'] });
    const started = await runtime.startFeatureAgent({ ...args, instruction: 'Write one file.' });
    assert.ok(started.threadId);
    for (let attempt = 0; (await getFeatureContext(args)).feature.agent.status !== 'idle'; attempt++) {
      assert.ok(attempt < 200, `agent for ${feature.length}-character slug did not finish`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok((await getFeatureContext(args)).candidates.length > 0);
  }

  // Slugs sharing their first 55 characters keep distinct locks: one lane's lock never blocks another.
  const [, , first, second] = slugs;
  assert.equal(await withWorkspaceLock(workspace, `control-${first}`, () => withWorkspaceLock(workspace, `control-${first.slice(0, 55)}`, () =>
    withWorkspaceLock(workspace, `control-${second}`, () => 'distinct', { timeoutMs: 300 }), { timeoutMs: 300 })), 'distinct');
  await assert.rejects(withWorkspaceLock(workspace, `control-${first}`, () => withWorkspaceLock(workspace, `control-${first}`, () => {}, { timeoutMs: 300 })), error => error.code === 'WORKSPACE_BUSY');

  for (const name of ['features', 'agent-state', 'verification-queue', slug(63), `control-${slug(1)}`]) assert.equal(await withWorkspaceLock(workspace, name, () => name), name);
  for (const name of [slug(64), `control-${slug(64)}`, `xontrol-${slug(63)}`, `control-1${'a'.repeat(62)}`, `control-${slug(63).toUpperCase()}`, `control--${slug(62)}`, '', 'Features', '-x', '1x', 'control-../x', 'control-a/b', 'a.b', 'a b', `control-${slug(3)}\n`, 42, null]) {
    await assert.rejects(withWorkspaceLock(workspace, name, () => assert.fail(`lock ${JSON.stringify(name)} ran`)), error => error.code === 'INVALID_LOCK', JSON.stringify(name));
  }
  for (const [feature, code] of [[slug(64), 'INVALID_INPUT'], [`${slug(30)}--${slug(31)}`, 'INVALID_SLUG'], [`1${slug(62)}`, 'INVALID_SLUG']]) {
    const refused = { workspace_path: workspace, feature };
    await assert.rejects(callTool('theater_feature_create', { ...refused, title: 'Refused', outcome: 'Refused.', spec: '# Refused' }), error => error.code === code, feature);
    await assert.rejects(callTool('theater_checks_update', { ...refused, checks: [] }), error => error.code === code, feature);
    await assert.rejects(callTool('theater_candidate_record', { ...refused, summary: 'No lane.', checks: [] }), error => error.code === code, feature);
    await assert.rejects(runtime.startFeatureAgent(refused), error => error.code === code, feature);
  }
});

test('latest required receipt and current specification gate delivery; dirty checks cannot pass', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-evidence-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'alpha' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Evidence', description: 'Exercise actual receipt gates.' });
  const lane = await createFeature({ ...args, title: 'Alpha', outcome: 'Verified behavior.', spec: '# Alpha\n\nThe README exists.' });
  const repo = lane.feature.checkoutPath;
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.check-fails\n');
  await updateChecks({ ...args, checks: [{ key: 'actual', purpose: 'Read the committed README and fixture state', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md'); if (require('node:fs').existsSync('.check-fails')) process.exit(7)"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await setFeatureStatus({ ...args, status: 'done' });
  await fs.writeFile(path.join(repo, '.check-fails'), 'fail');
  assert.equal((await runChecks(args)).verification.ready, false);
  await assert.rejects(recordCandidate({ ...args, summary: 'Stale pass.', checks: ['old receipt'] }), error => error.code === 'COMPLETION_NOT_PROVEN');
  await fs.rm(path.join(repo, '.check-fails'));
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready again.', checks: ['current receipt'] });
  await setFeatureStatus({ ...args, status: 'done' });
  await updateSpec({ ...args, content: '# Alpha\n\nThe README must also describe startup.', rationale: 'New acceptance behavior.' });
  assert.equal((await getFeatureContext(args)).feature.status, 'active');
  await assert.rejects(recordCandidate({ ...args, summary: 'Old contract.', checks: ['old receipt'] }), error => error.code === 'COMPLETION_NOT_PROVEN');
  await updateChecks({ ...args, checks: [{ key: 'mutating', purpose: 'Detect a check that changes source', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('unexpected.txt', 'mutated')"] }] });
  const changed = await runChecks(args);
  assert.equal(changed.receipts[0].passed, false);
  assert.match(changed.receipts[0].summary, /checkout changed/);
  assert.equal((await git(repo, 'status', '--porcelain')).stdout.includes('unexpected.txt'), true);
});

test('an archived lane refuses candidates until it is explicitly reactivated', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-archived-candidate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'shelved' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Archive', description: 'Archive stays terminal.' });
  await createFeature({ ...args, title: 'Shelved', outcome: 'Stays archived.', spec: '# Shelved\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await setFeatureStatus({ ...args, status: 'archived', disposition: 'Shelved without integration.' });
  const archived = await getFeatureContext(args);
  assert.equal(archived.verification.ready, true);
  await assert.rejects(recordCandidate({ ...args, summary: 'Sneak back in.', checks: ['README receipt'] }), error => error.code === 'INVALID_TRANSITION' && /archived/.test(error.message) && /reactivate/i.test(error.message));
  const after = await getFeatureContext(args);
  assert.equal(after.feature.status, 'archived');
  assert.equal(after.feature.summary, archived.feature.summary);
  assert.equal(after.feature.nextAction, archived.feature.nextAction);
  assert.deepEqual(after.candidates, archived.candidates);
  assert.equal((await listFeatures({ workspace_path: workspace })).features.some(feature => feature.slug === 'shelved'), false);
  await setFeatureStatus({ ...args, status: 'active' });
  const reopened = await recordCandidate({ ...args, summary: 'Ready after reactivation.', checks: ['README receipt'] });
  assert.equal(reopened.feature.status, 'review');
  assert.equal((await listFeatures({ workspace_path: workspace })).features.some(feature => feature.slug === 'shelved'), true);
});

test('a paused lane refuses candidates until it is explicitly resumed', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-paused-candidate-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'held' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Pause', description: 'Pause stays a boundary.' });
  await createFeature({ ...args, title: 'Held', outcome: 'Stays paused.', spec: '# Held\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await setFeatureStatus({ ...args, status: 'paused' });
  const paused = await getFeatureContext(args);
  assert.equal(paused.verification.ready, true);
  await assert.rejects(recordCandidate({ ...args, summary: 'Slip past the pause.', checks: ['README receipt'] }), error => error.code === 'INVALID_TRANSITION' && /paused/.test(error.message) && /resume/i.test(error.message));
  const after = await getFeatureContext(args);
  assert.equal(after.feature.status, 'paused');
  assert.equal(after.feature.summary, paused.feature.summary);
  assert.equal(after.feature.nextAction, paused.feature.nextAction);
  assert.deepEqual(after.candidates, paused.candidates);
  assert.deepEqual(after.timeline, paused.timeline);
  await setFeatureStatus({ ...args, status: 'active' });
  const resumed = await recordCandidate({ ...args, summary: 'Ready after resuming.', checks: ['README receipt'] });
  assert.equal(resumed.feature.status, 'review');
  const reviewed = await getFeatureContext(args);
  assert.equal(reviewed.candidates.filter(candidate => candidate.status === 'ready').length, 1);
  assert.equal(reviewed.candidates.find(candidate => candidate.status === 'ready').summary, 'Ready after resuming.');
});

test('candidate checks come only from executed receipts; caller check strings stay unverified notes', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-candidate-provenance-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'proven' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Provenance', description: 'Candidate checks are receipts.' });
  await createFeature({ ...args, title: 'Proven', outcome: 'Only executed checks count.', spec: '# Proven\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [
    { key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] },
    { key: 'browser', purpose: 'Optional browser pass', required: false, argv: [process.execPath, '-e', 'process.exit(3)'] },
    { key: 'lint', purpose: 'Optional lint never reached', required: false, argv: [process.execPath, '-e', 'process.exit(0)'] },
  ] });
  // The optional failure stops the run, so lint never executes and must not appear as performed.
  const run = await runChecks(args);
  assert.equal(run.verification.ready, true);
  assert.deepEqual(run.receipts.map(receipt => [receipt.key, receipt.passed]), [['readme', true], ['browser', false]]);
  const [readme, browser] = run.receipts;
  const invented = ['security audit: passed', 'browser e2e: passed'];
  const recorded = await callTool('theater_candidate_record', { ...args, summary: 'Ready.', checks: invented });

  const expected = [`readme: passed · receipt ${readme.id}`, `browser (optional): failed · receipt ${browser.id}`];
  assert.deepEqual(recorded.checks, expected);
  assert.deepEqual(recorded.unverifiedNotes, invented);
  assert.equal(recorded.checkProvenance, 'executed-receipts');

  const context = await getFeatureContext(args);
  const [candidate] = context.candidates;
  assert.equal(candidate.id, recorded.candidateId);
  assert.deepEqual(candidate.checks, expected);
  assert.deepEqual(candidate.unverifiedChecks, []);
  assert.equal(candidate.checkProvenance, 'executed-receipts');
  assert.equal('checks_json' in candidate, false);
  const event = context.timeline.find(entry => entry.kind === 'candidate.recorded');
  assert.match(event.summary, /with 2 executed check receipt\(s\); 2 unverified caller note\(s\)\.$/);
  assert.deepEqual(event.details.checks, expected);
  assert.deepEqual(event.details.unverifiedNotes, invented);
  for (const shown of [recorded.checks, candidate.checks, event.details.checks]) {
    assert.ok(shown.every(entry => typeof entry === 'string'));
    // Only the label is inspected: hex receipt ids can contain any of these letters.
    assert.equal(shown.some(entry => /security|e2e|lint/.test(entry.split(' · receipt ')[0])), false);
  }
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  try {
    assert.deepEqual(JSON.parse(db.prepare('SELECT checks_json FROM candidates WHERE id = ?').get(recorded.candidateId).checks_json), expected);
    // The runtime's provenance marker is what makes these strings executed checks.
    assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(`candidate-checks:${recorded.candidateId}`).value), { version: 1, source: 'executed-receipts', receipts: [
      { key: 'readme', receiptId: readme.id, status: 'passed', required: true, reused: false },
      { key: 'browser', receiptId: browser.id, status: 'failed', required: false, reused: false },
    ] });
  } finally { db.close(); }

  // Notes are optional; the receipt gate alone admits a candidate, and still refuses without it.
  const bare = await recordCandidate({ ...args, summary: 'Ready without notes.' });
  assert.deepEqual(bare.checks, expected);
  assert.deepEqual(bare.unverifiedNotes, []);
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the README again', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  await assert.rejects(recordCandidate({ ...args, summary: 'Notes are not receipts.', checks: ['readme: passed'] }), error => error.code === 'COMPLETION_NOT_PROVEN');

  // Rows written before receipt provenance stay readable, but carry no runtime marker: their strings are
  // historical caller claims, never shown as run, even when they exactly match a real receipt's text.
  const statePath = path.join(workspace, '.theater', 'state.sqlite3');
  const legacyClaims = ['npm test: passed', ...expected, `browser: passed · receipt ${browser.id} · reused`];
  const forgeLegacy = claims => {
    const raw = new DatabaseSync(statePath);
    try {
      raw.prepare("INSERT OR REPLACE INTO candidates(id, feature_id, revision, base_revision, summary, checks_json, status, created_at) SELECT 'candidate-legacy', feature_id, revision, base_revision, 'Legacy.', ?, 'superseded', '2000-01-01T00:00:00.000Z' FROM candidates WHERE id = ?")
        .run(JSON.stringify(claims), recorded.candidateId);
    } finally { raw.close(); }
  };
  const legacyRow = async () => (await getFeatureContext(args)).candidates.find(entry => entry.id === 'candidate-legacy');
  forgeLegacy(legacyClaims);
  const forged = await legacyRow();
  assert.deepEqual([forged.checks, forged.unverifiedChecks, forged.checkProvenance], [[], legacyClaims, 'legacy-caller-reported']);

  // A receipt executed after the legacy row cannot promote a claim that happens to name it.
  const later = await runChecks(args);
  assert.equal(later.verification.ready, true);
  const laterClaim = `readme: passed · receipt ${later.receipts[0].id}`;
  forgeLegacy([...legacyClaims, laterClaim]);
  const legacy = await legacyRow();
  assert.deepEqual(legacy.checks, []);
  assert.deepEqual(legacy.unverifiedChecks, [...legacyClaims, laterClaim]);
  assert.equal(legacy.checkProvenance, 'legacy-caller-reported');

  // A fresh runtime-recorded candidate for that later receipt is still shown as executed.
  const fresh = await recordCandidate({ ...args, summary: 'Ready on the later receipt.' });
  assert.deepEqual(fresh.checks, [laterClaim]);
  const listed = (await getFeatureContext(args)).candidates.find(entry => entry.id === fresh.candidateId);
  assert.deepEqual([listed.checks, listed.unverifiedChecks, listed.checkProvenance], [[laterClaim], [], 'executed-receipts']);

  // Pre-provenance candidate.recorded events stay immutable but are read as caller claims; marked events are unchanged.
  const legacySummary = 'Recorded candidate 91a0e4c0ab4b with 2 check(s).';
  const legacyDetails = { candidateId: 'candidate-legacy', checks: ['security audit: passed', expected[0]], clean: true };
  const events = new DatabaseSync(statePath);
  let legacyEventId;
  try {
    const { feature_id: featureId } = events.prepare('SELECT feature_id FROM candidates WHERE id = ?').get(fresh.candidateId);
    legacyEventId = Number(events.prepare("INSERT INTO events(feature_id, kind, summary, details_json, created_at) VALUES (?, 'candidate.recorded', ?, ?, '2000-01-01T00:00:00.000Z')")
      .run(featureId, legacySummary, JSON.stringify(legacyDetails)).lastInsertRowid);
  } finally { events.close(); }
  const projectedSummary = 'Recorded candidate 91a0e4c0ab4b with 2 caller-reported check claim(s), not verified as executed.';
  const projectedDetails = { candidateId: 'candidate-legacy', clean: true, checks: [], unverifiedChecks: legacyDetails.checks, checkProvenance: 'legacy-caller-reported' };
  const views = [
    (await getFeatureContext({ ...args, timeline_limit: 200 })).timeline,
    (await callTool('theater_timeline', { ...args, limit: 200 })).events,
  ];
  for (const timeline of views) {
    const legacyEvent = timeline.find(entry => entry.id === legacyEventId);
    assert.equal(legacyEvent.summary, projectedSummary);
    assert.deepEqual(legacyEvent.details, projectedDetails);
    for (const [candidateId, checks] of [[recorded.candidateId, expected], [fresh.candidateId, [laterClaim]]]) {
      const marked = timeline.find(entry => entry.kind === 'candidate.recorded' && entry.details.candidateId === candidateId);
      assert.match(marked.summary, /executed check receipt\(s\)/);
      assert.deepEqual(marked.details.checks, checks);
      assert.equal('unverifiedChecks' in marked.details, false);
    }
  }
  const activity = (await callTool('theater_state', { ...args, components: ['activity'] })).selected.activity;
  assert.equal(activity.find(entry => entry.id === legacyEventId).summary, projectedSummary);
  assert.match(activity.find(entry => entry.kind === 'candidate.recorded' && entry.id !== legacyEventId).summary, /with 1 executed check receipt\(s\)\.$/);
  const stored = new DatabaseSync(statePath);
  try { assert.deepEqual({ ...stored.prepare('SELECT summary, details_json FROM events WHERE id = ?').get(legacyEventId) }, { summary: legacySummary, details_json: JSON.stringify(legacyDetails) }); }
  finally { stored.close(); }
});

test('marked candidate rows and events display only checks bound to the marker receipts', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-candidate-tamper-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'bound' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Bound', description: 'Marked checks bind to receipts.' });
  await createFeature({ ...args, title: 'Bound', outcome: 'Tampered claims stay unverified.', spec: '# Bound\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [
    { key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] },
    { key: 'browser', purpose: 'Optional browser pass', required: false, argv: [process.execPath, '-e', 'process.exit(3)'] },
  ] });
  const [readme, browser] = (await runChecks(args)).receipts;
  const recorded = await callTool('theater_candidate_record', { ...args, summary: 'Ready.' });
  const expected = [`readme: passed · receipt ${readme.id}`, `browser (optional): failed · receipt ${browser.id}`];
  assert.deepEqual(recorded.checks, expected);

  const statePath = path.join(workspace, '.theater', 'state.sqlite3');
  const sql = (query, ...values) => {
    const db = new DatabaseSync(statePath);
    try { return db.prepare(query).run(...values); } finally { db.close(); }
  };
  const markerKey = `candidate-checks:${recorded.candidateId}`;
  const original = (() => {
    const db = new DatabaseSync(statePath);
    try {
      return {
        marker: db.prepare('SELECT value FROM meta WHERE key = ?').get(markerKey).value,
        event: { ...db.prepare("SELECT id, summary, details_json FROM events WHERE kind = 'candidate.recorded' AND json_extract(details_json, '$.candidateId') = ?").get(recorded.candidateId) },
      };
    } finally { db.close(); }
  })();
  const candidate = async () => (await getFeatureContext(args)).candidates.find(entry => entry.id === recorded.candidateId);
  const eventViews = async () => {
    const find = timeline => timeline.find(entry => entry.id === Number(original.event.id));
    return [find((await getFeatureContext({ ...args, timeline_limit: 200 })).timeline), find((await callTool('theater_timeline', { ...args, limit: 200 })).events)];
  };
  const activitySummary = async () => (await callTool('theater_state', { ...args, components: ['activity'] })).selected.activity.find(entry => entry.id === Number(original.event.id)).summary;
  const bound = value => [value.checks, value.unverifiedChecks ?? [], value.checkProvenance ?? 'executed-receipts'];

  // Altered saved row strings are never promoted; verified checks still come from the marker's receipts.
  const invented = `security audit: passed · receipt ${readme.id}`;
  for (const saved of [[expected[0], invented, expected[1]], [expected[0], `browser (optional): passed · receipt ${browser.id}`]]) {
    sql('UPDATE candidates SET checks_json = ? WHERE id = ?', JSON.stringify(saved), recorded.candidateId);
    assert.deepEqual(bound(await candidate()), [expected, saved.filter(entry => !expected.includes(entry)), 'marker-mismatch']);
  }
  sql('UPDATE candidates SET checks_json = ? WHERE id = ?', JSON.stringify(expected), recorded.candidateId);
  assert.deepEqual(bound(await candidate()), [expected, [], 'executed-receipts']);

  // A marked event with altered checks, or any summary claim (count, candidate hash, note count) that differs
  // from the one rebuilt from the candidate record, is projected as unverified with a rebuilt summary.
  const originalDetails = JSON.parse(original.event.details_json);
  const rebuilt = `Candidate ${recorded.revision.slice(0, 12)} event does not match its receipt record; 2 executed check receipt(s) verified.`;
  assert.equal(original.event.summary, `Recorded candidate ${recorded.revision.slice(0, 12)} with 2 executed check receipt(s).`);
  sql('UPDATE events SET details_json = ? WHERE id = ?', JSON.stringify({ ...originalDetails, checks: [...expected, invented] }), original.event.id);
  for (const event of await eventViews()) {
    assert.deepEqual(bound(event.details), [expected, [invented], 'marker-mismatch']);
    assert.equal(event.summary, rebuilt);
  }
  for (const [summary, details] of [
    [original.event.summary.replace('with 2 executed', 'with 5 executed'), originalDetails],
    [original.event.summary.replace(recorded.revision.slice(0, 12), 'deadbeefcafe'), originalDetails],
    [original.event.summary.replace(/\.$/, '; 3 unverified caller note(s).'), originalDetails],
    [original.event.summary, { ...originalDetails, unverifiedNotes: ['security audit: passed'] }],
  ]) {
    sql('UPDATE events SET summary = ?, details_json = ? WHERE id = ?', summary, JSON.stringify(details), original.event.id);
    for (const event of await eventViews()) {
      assert.deepEqual(bound(event.details), [expected, [], 'marker-mismatch'], summary);
      assert.equal(event.summary, rebuilt, summary);
    }
    assert.equal(await activitySummary(), rebuilt, summary);
  }
  sql('UPDATE events SET summary = ?, details_json = ? WHERE id = ?', original.event.summary, original.event.details_json, original.event.id);

  // A marker naming a receipt that does not exist, or with an altered outcome, verifies nothing.
  const marker = JSON.parse(original.marker);
  for (const receipts of [
    [...marker.receipts, { key: 'security', receiptId: 'evidence_forged', status: 'passed', required: false, reused: false }],
    marker.receipts.map(entry => entry.key === 'browser' ? { ...entry, status: 'passed' } : entry),
  ]) {
    sql('UPDATE meta SET value = ? WHERE key = ?', JSON.stringify({ ...marker, receipts }), markerKey);
    assert.deepEqual(bound(await candidate()), [[], expected, 'marker-mismatch']);
    for (const event of await eventViews()) assert.deepEqual(bound(event.details), [[], expected, 'marker-mismatch']);
  }

  // Restored to the runtime's record, the candidate and its event read exactly as recorded.
  sql('UPDATE meta SET value = ? WHERE key = ?', original.marker, markerKey);
  assert.deepEqual(bound(await candidate()), [expected, [], 'executed-receipts']);
  for (const event of await eventViews()) assert.deepEqual([event.summary, event.details], [original.event.summary, originalDetails]);
  assert.equal(await activitySummary(), original.event.summary);
});

test('marker receipts must be eligible under the candidate contract; stale same-revision receipts verify nothing', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-candidate-contract-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'contracted' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Contracted', description: 'Marker receipts bind to the candidate contract.' });
  await createFeature({ ...args, title: 'Contracted', outcome: 'Only eligible receipts verify.', spec: '# Contracted\n\nThe README exists.' });
  const readmeCheck = (extra = {}) => ({ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"], ...extra });
  const lintCheck = extra => ({ key: 'lint', purpose: 'Lint the README', argv: [process.execPath, '-e', 'process.exit(0)'], ...extra });
  const statePath = path.join(workspace, '.theater', 'state.sqlite3');
  const sql = (query, ...values) => {
    const db = new DatabaseSync(statePath);
    try { return db.prepare(query).get(...values); } finally { db.close(); }
  };
  const view = async candidateId => {
    const context = await getFeatureContext({ ...args, timeline_limit: 200 });
    const row = context.candidates.find(entry => entry.id === candidateId);
    const event = context.timeline.find(entry => entry.kind === 'candidate.recorded' && entry.details.candidateId === candidateId);
    return { row: [row.checks, row.checkProvenance], event: [event.details.checks, event.details.checkProvenance ?? 'executed-receipts'] };
  };
  const withMarker = async (candidateId, receipts, assertion) => {
    const key = `candidate-checks:${candidateId}`;
    const original = sql('SELECT value FROM meta WHERE key = ?', key).value;
    sql('UPDATE meta SET value = ? WHERE key = ?', JSON.stringify({ ...JSON.parse(original), receipts }), key);
    try { await assertion(); } finally { sql('UPDATE meta SET value = ? WHERE key = ?', original, key); }
  };
  const mismatch = { row: [[], 'marker-mismatch'], event: [[], 'marker-mismatch'] };

  // Contract C1 runs readme (receipt A); C2 adds lint without changing readme's binding and runs both.
  await updateChecks({ ...args, checks: [readmeCheck()] });
  const [stale] = (await runChecks(args)).receipts;
  await updateChecks({ ...args, checks: [readmeCheck(), lintCheck()] });
  const [direct, lint] = (await runChecks(args)).receipts;
  const first = await recordCandidate({ ...args, summary: 'Direct receipts.' });
  const firstChecks = [`readme: passed · receipt ${direct.id}`, `lint: passed · receipt ${lint.id}`];
  assert.deepEqual((await view(first.candidateId)), { row: [firstChecks, 'executed-receipts'], event: [firstChecks, 'executed-receipts'] });
  const lintEntry = { key: 'lint', receiptId: lint.id, status: 'passed', required: true, reused: false };
  // A same-revision receipt from the older contract is not direct proof, and C2 has no reuse policy for a passing reuse.
  for (const reused of [false, true]) {
    await withMarker(first.candidateId, [{ key: 'readme', receiptId: stale.id, status: 'passed', required: true, reused }, lintEntry], async () => {
      assert.deepEqual(await view(first.candidateId), mismatch);
    });
  }
  // Real receipt ids still verify nothing when the entries disagree with the candidate contract's checks:
  // a relabelled required flag, a key outside the contract, a missing required check or a duplicate.
  const readmeEntry = { key: 'readme', receiptId: direct.id, status: 'passed', required: true, reused: false };
  for (const receipts of [
    [readmeEntry, { ...lintEntry, required: false }],
    [readmeEntry, lintEntry, { ...lintEntry, key: 'security', required: false }],
    [readmeEntry],
    [readmeEntry, lintEntry, readmeEntry],
  ]) {
    await withMarker(first.candidateId, receipts, async () => assert.deepEqual(await view(first.candidateId), mismatch));
  }

  // C3 opts readme into same-revision reuse (its binding is unchanged) and makes lint optional: readme reuses its C2 receipt.
  await updateChecks({ ...args, checks: [readmeCheck({ reuse_same_revision: true }), lintCheck({ required: false })] });
  const reusedCandidate = await recordCandidate({ ...args, summary: 'Reused receipt.' });
  const reusedChecks = [`readme: passed · receipt ${direct.id} · reused`];
  assert.deepEqual(reusedCandidate.checks, reusedChecks);
  assert.deepEqual(await view(reusedCandidate.candidateId), { row: [reusedChecks, 'executed-receipts'], event: [reusedChecks, 'executed-receipts'] });

  // C4 changes readme's definition and runs it (receipt E). The C3 candidate still validates against its own
  // contract, but a marker pointing at E, directly or as a reuse with a different binding, verifies nothing.
  await updateChecks({ ...args, checks: [readmeCheck({ purpose: 'Read the README again', reuse_same_revision: true }), lintCheck({ required: false })] });
  const [changed] = (await runChecks({ ...args, check_keys: ['readme'] })).receipts;
  assert.deepEqual(await view(reusedCandidate.candidateId), { row: [reusedChecks, 'executed-receipts'], event: [reusedChecks, 'executed-receipts'] });
  for (const reused of [false, true]) {
    await withMarker(reusedCandidate.candidateId, [{ key: 'readme', receiptId: changed.id, status: 'passed', required: true, reused }], async () => {
      assert.deepEqual(await view(reusedCandidate.candidateId), mismatch);
    });
  }

  // A candidate contract snapshot saved before its required/reuse policies were recorded fails closed.
  const { contract_hash: contract, feature_id: featureId } = sql('SELECT contract_hash, feature_id FROM candidates WHERE id = ?', reusedCandidate.candidateId);
  const snapshotKey = `verification-contract:${featureId}:${contract}`;
  const snapshot = sql('SELECT value FROM meta WHERE key = ?', snapshotKey).value;
  assert.deepEqual([JSON.parse(snapshot).required, JSON.parse(snapshot).reuse], [['readme'], ['readme']]);
  for (const policy of ['reuse', 'required']) {
    const { [policy]: _policy, ...withoutPolicy } = JSON.parse(snapshot);
    sql('UPDATE meta SET value = ? WHERE key = ?', JSON.stringify(withoutPolicy), snapshotKey);
    assert.deepEqual(await view(reusedCandidate.candidateId), mismatch, policy);
  }
  sql('UPDATE meta SET value = ? WHERE key = ?', snapshot, snapshotKey);
  assert.deepEqual(await view(reusedCandidate.candidateId), { row: [reusedChecks, 'executed-receipts'], event: [reusedChecks, 'executed-receipts'] });
});

test('restoring an exact contract recognizes its receipt past newer passes from other contracts, but not past a newer failure', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-restore-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'restore' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Restore', description: 'Return to an earlier check contract.' });
  const lane = await createFeature({ ...args, title: 'Restore', outcome: 'Exact receipts survive a contract round trip.', spec: '# Restore\n\nThe README exists.' });
  await fs.appendFile(path.join(lane.feature.checkoutPath, '.git', 'info', 'exclude'), '\n.check-fails\n');
  const readme = { key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md'); if (require('node:fs').existsSync('.check-fails')) process.exit(7)"] };
  const optional = (purpose = 'Lint nothing') => ({ key: 'lint', purpose, required: false, argv: [process.execPath, '-e', ''] });
  const status = async () => (await getFeatureContext(args)).verification;
  const readmeStatus = async () => (await status()).checks.find(check => check.key === 'readme');

  // A runs readme; A+optional adds an optional check without changing readme's binding and runs both at the same HEAD.
  await updateChecks({ ...args, checks: [readme] });
  const exact = (await runChecks(args)).receipts[0];
  const contractA = (await status()).contractHash;
  await updateChecks({ ...args, checks: [readme, optional()] });
  const [newer] = (await runChecks(args)).receipts;
  assert.notEqual(newer.id, exact.id);

  // Returning to A finds A's own exact receipt behind the newer passing A+optional receipt.
  await updateChecks({ ...args, checks: [readme] });
  const restored = await status();
  assert.equal(restored.contractHash, contractA);
  assert.equal(restored.ready, true);
  assert.deepEqual([restored.checks[0].status, restored.checks[0].receipt.id, restored.checks[0].reused], ['passed', exact.id, false]);
  assert.deepEqual((await recordCandidate({ ...args, summary: 'Restored contract.' })).checks, [`readme: passed · receipt ${exact.id}`]);

  // A contract with no exact receipt at this HEAD and no reuse policy stays missing despite equal-binding passes.
  await updateChecks({ ...args, checks: [readme, optional('Lint something else')] });
  const unproven = await status();
  assert.equal(unproven.ready, false);
  assert.deepEqual([unproven.checks[0].status, unproven.checks[0].receipt, unproven.checks[0].reuseBlockedBy], ['missing', null, undefined]);

  // A newer same-binding failure under A+optional is not hidden by A's older exact success.
  await updateChecks({ ...args, checks: [readme, optional()] });
  await fs.writeFile(path.join(lane.feature.checkoutPath, '.check-fails'), 'fail');
  const [failed] = (await runChecks({ ...args, check_keys: ['readme'] })).receipts;
  assert.equal(failed.passed, false);
  await updateChecks({ ...args, checks: [readme] });
  const blocked = await readmeStatus();
  assert.deepEqual([blocked.status, blocked.receipt.id, blocked.reused], ['failed', failed.id, true]);
  assert.equal((await status()).ready, false);
  await assert.rejects(recordCandidate({ ...args, summary: 'Hidden failure.' }), error => error.code === 'COMPLETION_NOT_PROVEN');

  // A fresh exact run under A supersedes the failure.
  await fs.rm(path.join(lane.feature.checkoutPath, '.check-fails'));
  const [rerun] = (await runChecks(args)).receipts;
  assert.deepEqual([(await readmeStatus()).receipt.id, (await status()).ready], [rerun.id, true]);
});

test('a Claude worker guard that outlives its completed turn blocks checks and candidates until it clears', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-live-worker-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'lingering' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Lingering', description: 'A worker can outlive its turn.' });
  await createFeature({ ...args, title: 'Lingering', outcome: 'Verified only after the worker exits.', spec: '# Lingering\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  // The turn completed and the lane reads idle, but its worker process has not exited yet.
  await bindAgentSession({ ...args, thread_id: 'claude-thread', harness: 'claude' });
  await registerWorkerGuard({ ...args, thread_id: 'claude-thread', guard_id: 'live-process' });
  await saveAgentSession({ ...args, thread_id: 'claude-thread', status: 'idle' });
  const executedReceipts = () => {
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
    try { return db.prepare("SELECT id FROM evidence WHERE source = 'executed' ORDER BY rowid").all().map(row => row.id); }
    finally { db.close(); }
  };
  const receipts = executedReceipts();
  // A queued job passes admission on the idle status alone; its runChecks call must still defer it.
  await enqueueChecks({ workspace_path: workspace, jobs: [{ key: 'lingering-readme', feature: 'lingering', check_key: 'readme' }] });
  const deferred = (await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'lingering-readme');
  assert.equal(deferred.status, 'queued');
  assert.equal(deferred.attempts.at(-1).status, 'deferred');
  assert.match(deferred.reason, /worker process/);
  assert.deepEqual(executedReceipts(), receipts);
  const before = await getFeatureContext(args);
  assert.equal(before.feature.agent.status, 'idle');
  assert.equal(before.verification.ready, true);
  const lingering = error => error.code === 'AGENT_BUSY' && error.details?.workerGuards === 1 && /worker process/.test(error.message);
  await assert.rejects(runChecks(args), lingering);
  await assert.rejects(recordCandidate({ ...args, summary: 'Ready while the worker runs.', checks: ['README receipt'] }), lingering);
  const after = await getFeatureContext(args);
  assert.deepEqual(executedReceipts(), receipts);
  assert.equal(after.feature.status, 'active');
  assert.deepEqual(after.candidates, before.candidates);
  assert.deepEqual(after.timeline, before.timeline);
  assert.deepEqual(await readWorkerGuards(args), [{ id: 'live-process', threadId: 'claude-thread' }]);

  await clearWorkerGuards({ ...args, guard_id: 'live-process' });
  const drained = (await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'lingering-readme');
  assert.equal(drained.status, 'passed');
  assert.deepEqual(executedReceipts(), [...receipts, drained.attempts.at(-1).receiptId]);
  const run = await runChecks(args);
  assert.deepEqual(run.receipts.map(receipt => receipt.passed), [true]);
  assert.equal(run.verification.ready, true);
  const recorded = await recordCandidate({ ...args, summary: 'Ready after the worker exited.', checks: ['README receipt'] });
  assert.equal(recorded.feature.status, 'review');
  assert.deepEqual((await getFeatureContext(args)).candidates.map(candidate => candidate.status), ['ready']);
});

test('an unconfirmed-descendants marker blocks checks and candidates until an attestation clears it', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-descendants-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'orphans' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Orphans', description: 'Tools can outlive their worker.' });
  await createFeature({ ...args, title: 'Orphans', outcome: 'Verified only after its tools are confirmed stopped.', spec: '# Orphans\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  // The worker was stopped without its process tree and exited, so no guard remains, but tools it
  // launched may still be running in the checkout.
  await bindAgentSession({ ...args, thread_id: 'claude-thread', harness: 'claude' });
  const marker = await markDescendantsUnconfirmed({ ...args, thread_id: 'claude-thread', turn_id: 'turn-1', summary: 'The worker was stopped without its process tree.' });
  await saveAgentSession({ ...args, thread_id: 'claude-thread', status: 'idle' });
  assert.deepEqual(await readWorkerGuards(args), []);
  const executedReceipts = () => {
    const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
    try { return db.prepare("SELECT id FROM evidence WHERE source = 'executed' ORDER BY rowid").all().map(row => row.id); }
    finally { db.close(); }
  };
  const receipts = executedReceipts();
  const marked = await getFeatureContext(args);
  await enqueueChecks({ workspace_path: workspace, jobs: [{ key: 'orphans-readme', feature: 'orphans', check_key: 'readme' }] });
  const deferred = (await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'orphans-readme');
  assert.equal(deferred.status, 'queued');
  assert.equal(deferred.attempts.at(-1).status, 'deferred');
  assert.match(deferred.reason, /may still be running/);
  assert.deepEqual(executedReceipts(), receipts);
  const before = await getFeatureContext(args);
  // The deferral is recorded as a still-queued job, never as an executed check.
  assert.deepEqual(before.timeline.slice(1), marked.timeline);
  assert.equal(before.timeline[0].kind, 'checks.queue_finished');
  assert.equal(before.timeline[0].details.status, 'queued');
  assert.equal(before.feature.agent.status, 'idle');
  assert.equal(before.verification.ready, true);
  assert.deepEqual(before.candidates, marked.candidates);
  const orphaned = error => error.code === 'AGENT_BUSY' && error.details?.unconfirmedDescendants === true && error.details?.turnId === 'turn-1'
    && /may still be running/.test(error.message) && /prior_turn_attestation/.test(error.message);
  await assert.rejects(runChecks(args), orphaned);
  await assert.rejects(recordCandidate({ ...args, summary: 'Ready while its tools run.', checks: ['README receipt'] }), orphaned);
  const after = await getFeatureContext(args);
  assert.deepEqual(executedReceipts(), receipts);
  assert.equal(after.feature.status, 'active');
  assert.equal(after.verification.ready, true);
  assert.deepEqual(after.candidates, before.candidates);
  assert.deepEqual(after.timeline, before.timeline);
  assert.equal((await readUnconfirmedDescendants(args)).generation, marker.generation);

  assert.equal((await attestDescendantsStopped({ ...args, evidence: 'No process runs in the checkout.', generation: marker.generation })).cleared, true);
  assert.equal(await readUnconfirmedDescendants(args), null);
  const drained = (await drainCheckQueue({ workspace_path: workspace })).jobs.find(job => job.key === 'orphans-readme');
  assert.equal(drained.status, 'passed');
  assert.deepEqual(executedReceipts(), [...receipts, drained.attempts.at(-1).receiptId]);
  const run = await runChecks(args);
  assert.deepEqual(run.receipts.map(receipt => receipt.passed), [true]);
  assert.equal(run.verification.ready, true);
  const recorded = await recordCandidate({ ...args, summary: 'Ready after its tools were confirmed stopped.', checks: ['README receipt'] });
  assert.equal(recorded.feature.status, 'review');
  assert.deepEqual((await getFeatureContext(args)).candidates.map(candidate => candidate.status), ['ready']);
});

test('a worker guard or unconfirmed-descendants marker blocks completion until it clears', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-completion-worker-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'finishing' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Finishing', description: 'Completion waits for stopped workers.' });
  await createFeature({ ...args, title: 'Finishing', outcome: 'Accepted only after its worker exits.', spec: '# Finishing\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  const { candidateId } = await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  // The turn completed and the lane reads idle, but its worker process has not exited yet.
  await bindAgentSession({ ...args, thread_id: 'claude-thread', harness: 'claude' });
  await registerWorkerGuard({ ...args, thread_id: 'claude-thread', guard_id: 'live-process' });
  await saveAgentSession({ ...args, thread_id: 'claude-thread', status: 'idle' });
  const unchanged = async (before, refusal) => {
    await assert.rejects(setFeatureStatus({ ...args, status: 'done' }), refusal);
    const after = await getFeatureContext(args);
    assert.equal(after.feature.status, 'review');
    assert.deepEqual(after.candidates.map(candidate => [candidate.id, candidate.status]), [[candidateId, 'ready']]);
    assert.deepEqual(after.candidates, before.candidates);
    assert.deepEqual(after.timeline, before.timeline);
  };
  const guarded = await getFeatureContext(args);
  assert.equal(guarded.feature.agent.status, 'idle');
  assert.equal(guarded.verification.ready, true);
  await unchanged(guarded, error => error.code === 'AGENT_BUSY' && error.details?.workerGuards === 1 && /worker process/.test(error.message));

  // The worker exits, but a stop without its process tree leaves its tools unconfirmed.
  await clearWorkerGuards({ ...args, guard_id: 'live-process' });
  const marker = await markDescendantsUnconfirmed({ ...args, thread_id: 'claude-thread', turn_id: 'turn-1', summary: 'The worker was stopped without its process tree.' });
  await unchanged(await getFeatureContext(args), error => error.code === 'AGENT_BUSY' && error.details?.unconfirmedDescendants === true && error.details?.turnId === 'turn-1'
    && /may still be running/.test(error.message) && /prior_turn_attestation/.test(error.message));

  assert.equal((await attestDescendantsStopped({ ...args, evidence: 'No process runs in the checkout.', generation: marker.generation })).cleared, true);
  const done = await setFeatureStatus({ ...args, status: 'done' });
  assert.equal(done.feature.status, 'done');
  assert.deepEqual((await getFeatureContext(args)).candidates.map(candidate => [candidate.id, candidate.status]), [[candidateId, 'accepted']]);
});

test('a worker guard or running status saved while completion reads the checkout still refuses it', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-completion-race-'));
  const started = path.join(workspace, 'snapshot-started');
  const release = path.join(workspace, 'snapshot-release');
  t.after(async () => {
    await fs.writeFile(release, '');
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  });
  const args = { workspace_path: workspace, feature: 'racing' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Racing', description: 'Completion rechecks workers as it writes.' });
  const lane = await createFeature({ ...args, title: 'Racing', outcome: 'Never accepted beside a live worker.', spec: '# Racing\n\nThe README exists.' });
  await updateChecks({ ...args, checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  assert.equal((await runChecks(args)).verification.ready, true);
  const { candidateId } = await recordCandidate({ ...args, summary: 'Ready.', checks: ['README receipt'] });
  await bindAgentSession({ ...args, thread_id: 'claude-thread', harness: 'claude' });
  await saveAgentSession({ ...args, thread_id: 'claude-thread', status: 'idle' });
  // An fsmonitor hook holds the first git status of each round, the completion's, until the late
  // state below is saved; later calls pass. Its failure exit makes git scan the clean checkout normally.
  const hook = path.join(workspace, 'hold-status.mjs');
  await fs.writeFile(hook, `import fs from 'node:fs';
let first = false;
try { fs.writeFileSync(${JSON.stringify(started)}, '', { flag: 'wx' }); first = true; } catch {}
if (first) {
  for (let waited = 0; !fs.existsSync(${JSON.stringify(release)}) && waited < 20000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
}
process.exit(1);
`);
  const slash = value => value.replaceAll('\\', '/');
  await git(lane.feature.checkoutPath, 'config', 'core.fsmonitor', `"${slash(process.execPath)}" "${slash(hook)}"`);
  const raced = async (interject, refusal) => {
    await fs.rm(started, { force: true });
    await fs.rm(release, { force: true });
    const completing = setFeatureStatus({ ...args, status: 'done' });
    completing.catch(() => {});
    for (let attempt = 0; !(await fs.stat(started).catch(() => null)); attempt++) {
      assert.ok(attempt < 500, 'completion never reached its checkout snapshot');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await interject();
    await fs.writeFile(release, '');
    await assert.rejects(completing, refusal);
    const refused = await getFeatureContext(args);
    assert.equal(refused.feature.status, 'review');
    assert.deepEqual(refused.candidates.map(candidate => [candidate.id, candidate.status]), [[candidateId, 'ready']]);
    assert.equal(refused.timeline.some(event => event.kind === 'feature.done'), false);
  };
  await raced(() => registerWorkerGuard({ ...args, thread_id: 'claude-thread', guard_id: 'late-process' }),
    error => error.code === 'AGENT_BUSY' && error.details?.workerGuards === 1 && /worker process/.test(error.message));
  await clearWorkerGuards({ ...args, guard_id: 'late-process' });
  // A running status saved without a turn ID is busy to assertAgentIdle, so the write refuses it too.
  await raced(() => saveAgentSession({ ...args, thread_id: 'claude-thread', status: 'running' }),
    error => error.code === 'AGENT_BUSY' && /Wait for the feature agent to stop/.test(error.message));
  await saveAgentSession({ ...args, thread_id: 'claude-thread', status: 'idle' });
  assert.equal((await setFeatureStatus({ ...args, status: 'done' })).feature.status, 'done');
  assert.deepEqual((await getFeatureContext(args)).candidates.map(candidate => [candidate.id, candidate.status]), [[candidateId, 'accepted']]);
});

test('a queued check waits for a direct run in its clone and is judged once that run settles', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-direct-overlap-'));
  const release = path.join(workspace, 'release');
  let direct;
  t.after(async () => {
    await fs.writeFile(release, '');
    await direct?.catch(() => {});
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5 });
  });
  const queue = { workspace_path: workspace };
  const args = { ...queue, feature: 'overlap' };
  await initializeManagedProject({ ...queue, project_name: 'Overlap', description: 'Direct and queued checks share a clone.' });
  const repo = (await createFeature({ ...args, title: 'Overlap', outcome: 'Queued checks survive a direct run.', spec: '# Overlap\n\nThe README exists.' })).feature.checkoutPath;
  // The check leaves an untracked file in its clone until the release file exists (at most 20s), then removes it.
  await updateChecks({ ...args, checks: [{ key: 'transient', purpose: 'Hold a transient untracked file', argv: [process.execPath, '-e',
    `const fs = require('node:fs'); fs.readFileSync('README.md'); fs.writeFileSync('.transient', 'x'); const until = Date.now() + 20000;
     while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); fs.rmSync('.transient');`] }] });
  await createFeature({ ...queue, feature: 'other', title: 'Other', outcome: 'Unrelated lane.', spec: '# Other\n\nThe README exists.' });
  await updateChecks({ ...queue, feature: 'other', checks: [{ key: 'readme', purpose: 'Read the committed README', argv: [process.execPath, '-e', "require('node:fs').readFileSync('README.md')"] }] });
  await enqueueChecks({ ...queue, jobs: [{ key: 'overlap-transient', feature: 'overlap', check_key: 'transient' }, { key: 'other-readme', feature: 'other', check_key: 'readme' }] });

  direct = runChecks(args);
  for (let attempt = 0; !(await fs.stat(path.join(repo, '.transient')).catch(() => null)); attempt++) {
    assert.ok(attempt < 400, 'direct check did not start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const during = await drainCheckQueue(queue);
  const waiting = during.jobs.find(job => job.key === 'overlap-transient');
  assert.equal(waiting.status, 'queued');
  assert.deepEqual(waiting.attempts, []);
  assert.match(waiting.reason, /overlap/);
  assert.equal(during.jobs.find(job => job.key === 'other-readme').status, 'passed');
  assert.deepEqual(during.started, ['other-readme']);

  await fs.writeFile(release, '');
  assert.deepEqual((await direct).receipts.map(receipt => receipt.passed), [true]);
  const after = (await drainCheckQueue(queue)).jobs.find(job => job.key === 'overlap-transient');
  assert.equal(after.status, 'passed');
  assert.equal(after.attempts.length, 1);
  assert.equal((await readEvidence({ ...args, evidence_id: after.attempts[0].receiptId })).passed, true);

  // Real drift in an idle clone still goes stale without running its command.
  await enqueueChecks({ ...queue, jobs: [{ key: 'overlap-dirty', feature: 'overlap', check_key: 'transient' }] });
  await fs.writeFile(path.join(repo, 'stray.txt'), 'dirt');
  const dirty = (await drainCheckQueue(queue)).jobs.find(job => job.key === 'overlap-dirty');
  assert.equal(dirty.status, 'stale');
  assert.deepEqual(dirty.attempts, []);
  await fs.rm(path.join(repo, 'stray.txt'));
  await enqueueChecks({ ...queue, jobs: [{ key: 'overlap-moved', feature: 'overlap', check_key: 'transient' }] });
  await fs.writeFile(path.join(repo, 'next.txt'), 'next');
  await git(repo, 'add', 'next.txt');
  await git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Next');
  const moved = (await drainCheckQueue(queue)).jobs.find(job => job.key === 'overlap-moved');
  assert.equal(moved.status, 'stale');
  assert.deepEqual(moved.attempts, []);
});

test('checks execute in saved order and reordering changes the contract', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-order-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'order' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Order', description: 'Setup precedes dependent checks.' });
  const lane = await createFeature({ ...args, title: 'Order', outcome: 'Setup runs first.', spec: '# Order\n\nSetup precedes tests.' });
  const repo = lane.feature.checkoutPath;
  await fs.appendFile(path.join(repo, '.git', 'info', 'exclude'), '\n.prepared\n');
  const prepare = { key: 'z-prepare', purpose: 'Prepare ignored output', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('.prepared', 'ok')"] };
  const dependent = { key: 'a-test', purpose: 'Use prepared output', argv: [process.execPath, '-e', "require('node:fs').readFileSync('.prepared')"] };
  const saved = await updateChecks({ ...args, checks: [prepare, dependent] });
  assert.deepEqual(saved.checks.map(check => check.key), ['z-prepare', 'a-test']);
  const full = await runChecks(args);
  assert.deepEqual(full.receipts.map(receipt => [receipt.key, receipt.passed]), [['z-prepare', true], ['a-test', true]]);
  assert.equal(full.verification.ready, true);
  assert.deepEqual(full.verification.checks.map(check => check.key), ['z-prepare', 'a-test']);
  await fs.rm(path.join(repo, '.prepared'));
  const selected = await runChecks({ ...args, check_keys: ['a-test', 'z-prepare'] });
  assert.deepEqual(selected.receipts.map(receipt => [receipt.key, receipt.passed]), [['z-prepare', true], ['a-test', true]]);
  const unchanged = await updateChecks({ ...args, checks: [prepare, dependent] });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.contractHash, saved.contractHash);
  const reordered = await updateChecks({ ...args, checks: [dependent, prepare] });
  assert.equal(reordered.changed, true);
  assert.notEqual(reordered.contractHash, saved.contractHash);
  assert.deepEqual((await getFeatureContext(args)).verification.checks.map(check => [check.key, check.status]), [['a-test', 'missing'], ['z-prepare', 'missing']]);
  await fs.rm(path.join(repo, '.prepared'));
  const stopped = await runChecks(args);
  assert.deepEqual(stopped.receipts.map(receipt => [receipt.key, receipt.passed]), [['a-test', false]]);
  assert.deepEqual(stopped.completion.notRunCheckKeys, ['z-prepare']);
  assert.equal(stopped.verification.ready, false);
});

test('version-2 data migrates without turning historical claims into current proof', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-migration-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const args = { workspace_path: workspace, feature: 'legacy' };
  await initializeManagedProject({ workspace_path: workspace, project_name: 'Legacy', description: 'Preserve history.' });
  const lane = await createFeature({ ...args, title: 'Legacy', outcome: 'Preserve historical work.', spec: '# Legacy\n\nOriginal intent.' });
  const db = new DatabaseSync(path.join(workspace, '.theater', 'state.sqlite3'));
  const feature = db.prepare('SELECT * FROM features WHERE slug = ?').get('legacy');
  db.prepare("INSERT INTO evidence(id, feature_id, kind, summary, revision, passed, created_at) VALUES ('old-evidence', ?, 'test', 'Previously reported pass', ?, 1, ?)").run(feature.id, lane.feature.baseRevision, new Date().toISOString());
  db.prepare("INSERT INTO candidates(id, feature_id, revision, base_revision, summary, checks_json, status, created_at) VALUES ('old-candidate', ?, ?, ?, 'Old accepted candidate', '[]', 'accepted', ?)").run(feature.id, lane.feature.baseRevision, lane.feature.baseRevision, new Date().toISOString());
  db.prepare("UPDATE features SET status = 'done' WHERE id = ?").run(feature.id);
  for (const column of ['source', 'spec_revision', 'contract_hash', 'check_key', 'argv_json', 'exit_code', 'output', 'duration_ms']) db.exec(`ALTER TABLE evidence DROP COLUMN ${column}`);
  for (const column of ['spec_revision', 'contract_hash']) db.exec(`ALTER TABLE candidates DROP COLUMN ${column}`);
  db.exec("UPDATE meta SET value = '2' WHERE key = 'schema_version'");
  db.close();
  const context = await getFeatureContext(args);
  assert.equal(context.feature.status, 'active');
  assert.equal(context.candidates[0].status, 'superseded');
  assert.equal(context.evidence[0].source, 'reported');
  assert.equal(context.verification.ready, false);
  await fs.writeFile(path.join(workspace, '.theater', 'features', 'legacy', 'spec.md'), 'STALE PROJECTION');
  await getFeatureContext(args);
  assert.match(await fs.readFile(path.join(workspace, '.theater', 'features', 'legacy', 'spec.md'), 'utf8'), /Original intent/);
});
