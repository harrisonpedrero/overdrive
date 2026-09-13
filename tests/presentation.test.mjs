import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeManagedProject, createFeature, planWork } from '../plugins/feature-theater/scripts/workspace.mjs';
import { composeView, snapshotState, renderWorkGraph } from '../plugins/feature-theater/scripts/presentation.mjs';

test('work graphs preserve dependencies and state without embedded controls or unrelated context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'theater-view-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const args = { workspace_path: root, feature: 'alpha' };
  await initializeManagedProject({ workspace_path: root, project_name: 'Views', description: 'Inspect states.' });
  await createFeature({ ...args, title: 'Alpha', outcome: 'Inspect alpha.', spec: '# Alpha\n\nALPHA_ONLY' });
  await createFeature({ workspace_path: root, feature: 'beta', title: 'Beta', outcome: 'Inspect beta.', spec: '# Beta\n\nBETA_PRIVATE_CONTEXT' });
  await planWork({ ...args, items: [
    { key: 'contract', title: 'Define contract' },
    { key: 'api', title: 'Build API', dependencies: ['contract'] },
    { key: 'ui', title: 'Build UI', dependencies: ['contract'] },
    { key: 'verify', title: 'Verify complete flow', dependencies: ['api', 'ui'] },
  ] });
  const overview = await snapshotState({ workspace_path: root });
  assert.equal(overview.selected, null);
  assert.doesNotMatch(JSON.stringify(overview), /ALPHA_ONLY|BETA_PRIVATE_CONTEXT/);
  const scoped = await snapshotState({ ...args, components: ['work'] });
  assert.doesNotMatch(JSON.stringify(scoped), /ALPHA_ONLY|BETA_PRIVATE_CONTEXT/);
  const graph = renderWorkGraph(scoped);
  const ids = new Map(scoped.selected.work.map((item, index) => [item.key, 'n' + index]));
  for (const [from, to] of [['contract', 'api'], ['contract', 'ui'], ['api', 'verify'], ['ui', 'verify']]) {
    assert.ok(graph.includes(ids.get(from) + ' --> ' + ids.get(to)));
  }
  assert.equal(graph.split('-->').length - 1, 4);
  assert.match(graph, /<br\/>ready/);
  assert.match(graph, /<br\/>planned/);
  scoped.selected.work[0].title = '" ]\nclick n0 href "bad" \u0060\u0060\u0060 <img src=x>';
  scoped.selected.work[0].state = 'blocked';
  scoped.selected.work[0].blocker = 'Need a schema decision';
  const escaped = renderWorkGraph(scoped);
  assert.doesNotMatch(escaped, /\u0060\u0060\u0060|<img|\nclick/);
  assert.match(escaped, /blocked/);
  assert.match(escaped, /Need a schema decision/);
  assert.doesNotMatch(escaped, /<button|<textarea|sendFollowUpMessage|<script/);
  const rendered = await composeView(args);
  assert.equal(await fs.readFile(rendered.graphPath, 'utf8'), rendered.mermaid + '\n');
  assert.match(rendered.markdown, /^\u0060\u0060\u0060mermaid\nflowchart TD/);
  assert.equal(rendered.fragmentPath, undefined);
  const focused = await composeView({ ...args, work_items: ['api'] });
  assert.equal(focused.omittedWorkItems, 3);
  assert.match(focused.mermaid, /Outside view<br\/>contract/);
  assert.match(focused.mermaid, /n0_outside -\.-> n0/);
  await assert.rejects(composeView({ ...args, work_items: ['unknown'] }), error => error.code === 'WORK_NOT_FOUND');
  await assert.rejects(composeView({ ...args, components: ['handoff'] }), error => error.code === 'UNSUPPORTED_VIEW');
  const empty = await composeView({ workspace_path: root, feature: 'beta' });
  assert.equal(empty.mermaid, null);
  assert.equal(empty.graphPath, null);
});
