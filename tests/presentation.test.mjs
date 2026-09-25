import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeManagedProject, createFeature, updateWork } from '../plugins/overdrive/scripts/workspace.mjs';
import { composeView, readWorkGraph, renderWorkGraph } from '../plugins/overdrive/scripts/presentation.mjs';

test('work graphs preserve dependencies and state without embedded controls or unrelated context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-view-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const args = { workspace_path: root, feature: 'alpha' };
  await initializeManagedProject({ workspace_path: root, project_name: 'Views', description: 'Inspect states.' });
  await createFeature({ ...args, title: 'Alpha', outcome: 'Inspect alpha.', spec: '# Alpha\n\nALPHA_ONLY' });
  await createFeature({ workspace_path: root, feature: 'beta', title: 'Beta', outcome: 'Inspect beta.', spec: '# Beta\n\nBETA_PRIVATE_CONTEXT' });
  await updateWork({ ...args, items: [
    { key: 'contract', title: 'Define contract' },
    { key: 'api', title: 'Build API', depends_on: ['contract'] },
    { key: 'ui', title: 'Build UI', depends_on: ['contract'] },
    { key: 'verify', title: 'Verify complete flow', depends_on: ['api', 'ui'] },
  ] });
  const scoped = await readWorkGraph(args);
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
  assert.match(rendered.markdown, /^\u0060\u0060\u0060mermaid\nflowchart TD/);
  assert.equal(rendered.fragmentPath, undefined);
  const focused = await composeView({ ...args, work_items: ['api'] });
  assert.equal(focused.omittedWorkItems, 3);
  assert.match(focused.mermaid, /n0\["api<br\/>Build API<br\/>/);
  assert.match(focused.mermaid, /Outside view<br\/>contract/);
  assert.match(focused.mermaid, /n0_outside -\.-> n0/);
  await assert.rejects(composeView({ ...args, work_items: ['unknown'] }), error => error.code === 'WORK_NOT_FOUND');
  const empty = await composeView({ workspace_path: root, feature: 'beta' });
  assert.equal(empty.mermaid, null);
  await assert.rejects(fs.stat(path.join(root, '.overdrive', 'views')), error => error.code === 'ENOENT');
});

test('large graph pages keep a shared prerequisite beside its blocked dependents and cover every item once', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'overdrive-view-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const args = { workspace_path: root, feature: 'wide' };
  await initializeManagedProject({ workspace_path: root, project_name: 'Views', description: 'Inspect pages.' });
  await createFeature({ ...args, title: 'Wide', outcome: 'Inspect wide graphs.', spec: '# Wide' });
  const dependents = Array.from({ length: 24 }, (_, index) => 'part-' + String(index + 1).padStart(2, '0'));
  await updateWork({ ...args, items: [{ key: 'contract', title: 'Define contract' }, ...dependents.map(key => ({ key, title: 'Build ' + key, depends_on: ['contract'] }))] });
  await updateWork({ ...args, items: dependents.map(key => ({ key, status: 'blocked', blocker: 'Waiting on contract' })) });
  const first = await composeView(args);
  const second = await composeView({ ...args, page: 2 });
  const keys = view => view.mermaid.match(/^ {2}n\d+\["[^<]+/gm).map(line => line.split('["')[1]);
  const contractState = (await readWorkGraph(args)).selected.work.find(item => item.key === 'contract').state;
  assert.deepEqual([first.view.page, first.view.pages, first.view.shown, second.view.shown], [1, 2, 24, 1]);
  assert.ok(first.mermaid.includes('  n0["contract<br/>Define contract<br/>' + contractState + '"]\n'));
  assert.match(first.mermaid, /n0 --> n1\n/);
  assert.match(first.mermaid, /n1\["part-01<br\/>Build part-01<br\/>blocked<br\/>Waiting on contract"\]/);
  assert.equal(first.mermaid.split('-->').length - 1, 23);
  assert.doesNotMatch(first.mermaid, /Outside view/);
  assert.deepEqual(first.view.omitted, { blocked: 1 });
  assert.match(first.mermaid, /1 of 25 work items not shown<br\/>1 blocked<br\/>Page 1 of 2/);
  const all = [...keys(first), ...keys(second)];
  assert.equal(all.length, 25);
  assert.deepEqual(new Set(all), new Set(['contract', ...dependents]));
  assert.deepEqual(second.view.outside, { contract: contractState });
  assert.deepEqual(second.view.omitted, { blocked: 23, [contractState]: 1 });
  assert.ok(second.mermaid.includes('  o0["Outside view<br/>contract<br/>' + contractState + '"]\n  o0 -.-> n0\n'));
  assert.equal(second.mermaid.split('Outside view').length - 1, 1);
  assert.deepEqual((await composeView(args)).view, first.view);
  await assert.rejects(composeView({ ...args, page: 3 }), error => error.code === 'INVALID_INPUT');
});

test('graph key labels cannot inject Mermaid', () => {
  const hostile = 'x"]\nclick n0 href "bad" \u0060\u0060\u0060 <img src=x> [z]';
  const work = [{ key: hostile, title: 'Hostile', state: 'blocked', dependencies: [hostile + '-dep'] }];
  const outside = { [hostile + '-dep']: 'ready' };
  const selected = renderWorkGraph({ selected: { work, view: { mode: 'selected', outside } } });
  assert.doesNotMatch(selected, /\u0060\u0060\u0060|<img|\nclick|x"\]|\[z\]/);
  assert.equal(selected.split('\n').length, 4);
  const mermaid = renderWorkGraph({ selected: { work, view: { mode: 'attention', outside } } });
  assert.doesNotMatch(mermaid, /\u0060\u0060\u0060|<img|\nclick|x"\]|\[z\]/);
  assert.equal(mermaid.split('\n').length, 4);
  assert.match(mermaid, /Outside view<br\/>x#34;#93; click n0 href #34;bad#34; #96;#96;#96; #60;img src=x#62; #91;z#93;-dep<br\/>ready/);
});
