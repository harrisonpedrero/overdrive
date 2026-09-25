import { featureBySlug, loadWorkspace, workItems } from './state.mjs';
import { now, redactString, resolveWorkspace, safeSlug, OverdriveError } from './util.mjs';

function clip(value, max = 1500) {
  const text = redactString(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const GRAPH_LIMIT = 24;
const ATTENTION_STATES = ['running', 'blocked', 'failed', 'review', 'ready'];
const QUIET_STATES = ['planned', 'done', 'cancelled'];

// Packs every item exactly once into full 24-item pages: work needing action first, each placed beside
// its not-yet-shown direct prerequisites when they fit, then everything else; ties keep planned order.
function graphPages(work) {
  const byState = states => (a, b) => states.indexOf(a.status) - states.indexOf(b.status);
  const pages = [[]];
  const placed = new Set();
  const place = item => {
    if (pages.at(-1).length === GRAPH_LIMIT) pages.push([]);
    pages.at(-1).push(item);
    placed.add(item.item_key);
  };
  for (const item of work.filter(item => ATTENTION_STATES.includes(item.status)).sort(byState(ATTENTION_STATES))) {
    if (placed.has(item.item_key)) continue;
    if (pages.at(-1).length === GRAPH_LIMIT) pages.push([]);
    const room = GRAPH_LIMIT - pages.at(-1).length - 1;
    const context = work.filter(other => item.dependencies.includes(other.item_key) && !placed.has(other.item_key));
    for (const prerequisite of context.slice(0, room)) place(prerequisite);
    place(item);
  }
  for (const item of work.filter(item => !placed.has(item.item_key)).sort(byState(QUIET_STATES))) place(item);
  return pages;
}

function graphScope(work, work_items, page) {
  if (work_items) return { scoped: work.filter(item => work_items.includes(item.item_key)), view: { mode: 'selected', page: null, pages: null } };
  const pages = Math.max(1, Math.ceil(work.length / GRAPH_LIMIT));
  if (page > pages) throw new OverdriveError(`This work graph has ${pages} page${pages === 1 ? '' : 's'}.`, 'INVALID_INPUT');
  if (pages === 1) return { scoped: work, view: { mode: 'all', page, pages } };
  return { scoped: graphPages(work)[page - 1], view: { mode: 'attention', page, pages } };
}

// One feature's work, scoped to the selected items or page, in the shape renderWorkGraph reads.
export async function readWorkGraph({ workspace_path, feature, work_items, page = 1 }) {
  const ctx = await loadWorkspace(await resolveWorkspace(workspace_path));
  try {
    const row = featureBySlug(ctx.db, safeSlug(feature));
    const work = workItems(ctx.db, row.id);
    if (work_items?.some(key => !work.some(item => item.item_key === key))) throw new OverdriveError('A selected work item does not belong to this feature.', 'WORK_NOT_FOUND');
    const graph = graphScope(work, work_items, page);
    const shown = graph.scoped.map(item => ({ key: item.item_key, title: clip(item.title, 500), state: item.status, dependencies: item.dependencies, blocker: clip(item.blocker) }));
    const keys = new Set(shown.map(item => item.key));
    const states = new Map(work.map(item => [item.item_key, item.status]));
    const hidden = work.filter(item => !keys.has(item.item_key));
    const omitted = Object.fromEntries([...ATTENTION_STATES, ...QUIET_STATES]
      .map(state => [state, hidden.filter(item => item.status === state).length]).filter(([, count]) => count));
    const outside = [...new Set(shown.flatMap(item => item.dependencies))].filter(key => !keys.has(key)).sort();
    const view = { ...graph.view, total: work.length, shown: shown.length, omitted, outside: Object.fromEntries(outside.map(key => [key, states.get(key)])) };
    return { observedAt: now(), selected: { slug: row.slug, title: clip(row.title, 200), work: shown, view } };
  } finally { ctx.db.close(); }
}

function graphLabel(value, max = 100) {
  const text = clip(value, max).replace(/\s+/g, ' ').trim();
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    for (const part of word.match(/.{1,28}/gu) ?? ['']) {
      if (line && line.length + part.length + 1 > 28) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + part;
    }
  }
  if (line) lines.push(line);
  return lines.map(graphEscape).join('<br/>');
}

function graphEscape(value) {
  return value.replace(/[&<>"'#\u0060\\[\]{}|]/g, char => '#' + char.codePointAt(0) + ';');
}

// Work keys are exact identifiers: shown whole and unwrapped so they can be copied into updates.
function graphKey(value) {
  return graphEscape(String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 100));
}

export function renderWorkGraph(snapshot) {
  const work = snapshot.selected?.work;
  if (!work) throw new OverdriveError('Load the selected feature work before rendering its graph.', 'WORK_REQUIRED');
  if (work.length > GRAPH_LIMIT) throw new OverdriveError('This graph has more than 24 tasks. Select the relevant work_items for a readable subgraph.', 'GRAPH_TOO_LARGE', { items: work.map(({ key, title, state }) => ({ key, title, state })) });
  if (!work.length) return null;
  const view = snapshot.selected.view;
  const ids = new Map(work.map((item, index) => [item.key, 'n' + index]));
  const lines = ['flowchart TD'];
  for (const item of work) {
    const label = graphKey(item.key) + '<br/>' + graphLabel(item.title) + '<br/>' + graphLabel(item.state) + (item.blocker ? '<br/>' + graphLabel(item.blocker, 140) : '');
    lines.push('  ' + ids.get(item.key) + '["' + label + '"]');
  }
  if (view?.mode === 'attention') {
    // A page shows each prerequisite outside it once, linked to every dependent on the page.
    const outside = new Map();
    const edges = [];
    for (const item of work) {
      for (const dependency of item.dependencies) {
        if (ids.has(dependency)) { edges.push('  ' + ids.get(dependency) + ' --> ' + ids.get(item.key)); continue; }
        if (!outside.has(dependency)) {
          outside.set(dependency, 'o' + outside.size);
          const state = view.outside?.[dependency];
          lines.push('  ' + outside.get(dependency) + '["Outside view<br/>' + graphKey(dependency) + (state ? '<br/>' + graphLabel(state) : '') + '"]');
        }
        edges.push('  ' + outside.get(dependency) + ' -.-> ' + ids.get(item.key));
      }
    }
    lines.push(...edges);
  } else {
    const outsideLabel = key => view?.outside?.[key] ? key + ' (' + view.outside[key] + ')' : key;
    for (const item of work) {
      const outside = [];
      for (const dependency of item.dependencies) {
        if (ids.has(dependency)) lines.push('  ' + ids.get(dependency) + ' --> ' + ids.get(item.key));
        else outside.push(dependency);
      }
      if (outside.length) {
        const id = ids.get(item.key) + '_outside';
        lines.push('  ' + id + '["Outside view<br/>' + graphLabel(outside.map(outsideLabel).join(', '), 200) + '"]');
        lines.push('  ' + id + ' -.-> ' + ids.get(item.key));
      }
    }
  }
  if (view && view.total > view.shown) {
    const counts = [];
    for (const part of Object.entries(view.omitted).map(([state, count]) => count + ' ' + state)) {
      if (counts.length && counts.at(-1).length + part.length + 2 <= 28) counts[counts.length - 1] += ', ' + part;
      else counts.push(part);
    }
    const where = view.pages ? 'Page ' + view.page + ' of ' + view.pages : 'Selected work only';
    lines.push('  omitted["' + [(view.total - view.shown) + ' of ' + view.total + ' work items not shown', ...counts, where].map(text => graphLabel(text)).join('<br/>') + '"]');
  }
  return lines.join('\n');
}

export async function composeView(args) {
  if (args.work_items !== undefined && (!Array.isArray(args.work_items) || !args.work_items.length || args.work_items.length > 24 || new Set(args.work_items).size !== args.work_items.length || args.work_items.some(key => typeof key !== 'string'))) {
    throw new OverdriveError('work_items must contain 1–24 distinct work keys.', 'INVALID_INPUT');
  }
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.work_items !== undefined)) {
    throw new OverdriveError('page must be a positive integer and cannot be combined with work_items.', 'INVALID_INPUT');
  }
  const graph = await readWorkGraph({ workspace_path: args.workspace_path, feature: args.feature, work_items: args.work_items, page: args.page ?? 1 });
  const { selected } = graph;
  const mermaid = renderWorkGraph(graph);
  const fence = '```';
  return {
    observedAt: graph.observedAt, feature: selected.slug, title: selected.title, format: 'mermaid',
    omittedWorkItems: selected.view.total - selected.view.shown, view: selected.view,
    mermaid, markdown: mermaid ? fence + 'mermaid\n' + mermaid + '\n' + fence : 'No work items are planned for this feature.',
    next: 'Render markdown directly in the reply. Mention the feature, observation time, and any omitted work. A partial view is not the whole graph: request the next page or exact work_items for another slice. Pages are live snapshots of the current order, so after work status changes start again at page 1. Steering and all other interaction stay in the existing conversation.',
  };
}
