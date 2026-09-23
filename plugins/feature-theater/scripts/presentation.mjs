import { randomUUID, createHash } from 'node:crypto';
import { featureBySlug, listFeatureRows, loadWorkspace, meta, parseJson, workItems } from './state.mjs';
import { repositorySnapshot } from './git.mjs';
import { verificationStatus } from './verification.mjs';
import { recoverAgentState } from './ownership.mjs';
import { atomicWrite, contained, now, redactString, resolveWorkspace, safeSlug, TheaterError, writeJson } from './util.mjs';

export const STATE_SECTIONS = {
  features: 'Compare feature lifecycle, agent activity, work counts, and next actions without loading specifications.',
  work: 'Inspect one feature’s work and prerequisite relationships.',
  evidence: 'Inspect required checks, executed receipts, reported evidence, and candidate readiness.',
  activity: 'Read the selected feature’s recent visible activity.',
  handoff: 'Recover the selected checkpoint, next action, unresolved decisions, and pending requests.',
  spec: 'Read the selected feature’s current specification and recent revision reasons.',
};

function chooseComponents(value = ['features']) {
  if (!Array.isArray(value) || !value.length || value.length > 6 || new Set(value).size !== value.length || value.some(key => !Object.hasOwn(STATE_SECTIONS, key))) {
    throw new TheaterError(`Choose 1–6 distinct state sections: ${Object.keys(STATE_SECTIONS).join(', ')}.`, 'INVALID_INPUT');
  }
  return value;
}

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
  if (page > pages) throw new TheaterError(`This work graph has ${pages} page${pages === 1 ? '' : 's'}.`, 'INVALID_INPUT');
  if (pages === 1) return { scoped: work, view: { mode: 'all', page, pages } };
  return { scoped: graphPages(work)[page - 1], view: { mode: 'attention', page, pages } };
}

export async function snapshotState({ workspace_path, feature, components, include_archived = false, work_items, graph_page }) {
  const chosen = chooseComponents(components);
  const root = await resolveWorkspace(workspace_path);
  const ctx = await loadWorkspace(root);
  try {
    for (const row of listFeatureRows(ctx.db, { includeArchived: include_archived })) recoverAgentState(ctx, row);
    const databaseVersion = ctx.db.prepare('PRAGMA data_version').get().data_version;
    const start = Number(ctx.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id);
    const focus = meta(ctx.db, 'focus') || null;
    const snapshot = {
      schemaVersion: 1, id: `snapshot-${randomUUID()}`, observedAt: now(), components: chosen,
      workspace: { id: ctx.config.workspaceId, path: root, focus, repository: ctx.config.repository, managedProject: ctx.config.managedProject?.name ?? null },
      stateVersion: start, changedDuringRead: false, features: [], selected: null, omissions: {},
    };
    ctx.db.exec('BEGIN');
    try {
      if (chosen.includes('features')) {
        const rows = listFeatureRows(ctx.db, { includeArchived: include_archived });
        snapshot.omissions.features = Math.max(0, rows.length - 50);
        snapshot.features = rows.slice(0, 50).map(row => {
          const work = workItems(ctx.db, row.id);
          return {
            slug: row.slug, title: clip(row.title, 200), state: row.status, focused: row.slug === focus,
            agent: { state: row.agent_status, threadId: row.thread_id, activeTurnId: row.active_turn_id },
            progress: { total: work.length, done: work.filter(item => item.status === 'done').length, cancelled: work.filter(item => item.status === 'cancelled').length, running: work.filter(item => item.status === 'running').length, blocked: work.filter(item => ['blocked','failed'].includes(item.status)).length },
            nextAction: clip(row.next_action), blocker: clip(row.blocker), updatedAt: row.updated_at,
          };
        });
      }
      if (chosen.some(key => key !== 'features')) {
        const slug = feature ? safeSlug(feature) : focus;
        if (!slug) throw new TheaterError('Select a feature for these components.', 'FEATURE_REQUIRED');
        const row = featureBySlug(ctx.db, slug);
        const selected = { slug, title: clip(row.title, 200), state: row.status, specRevision: row.spec_revision, checkoutPath: row.checkout_path, agent: { state: row.agent_status, threadId: row.thread_id, activeTurnId: row.active_turn_id }, compactionPending: row.compaction_pending };
        if (chosen.includes('work')) {
          const work = workItems(ctx.db, row.id);
          if (work_items?.some(key => !work.some(item => item.item_key === key))) throw new TheaterError('A selected work item does not belong to this feature.', 'WORK_NOT_FOUND');
          const graph = graph_page === undefined ? null : graphScope(work, work_items, graph_page);
          const scoped = graph ? graph.scoped : work_items ? work.filter(item => work_items.includes(item.item_key)) : work;
          selected.work = scoped.slice(0, 100).map(item => ({ key: item.item_key, title: clip(item.title, 500), state: item.status, kind: item.kind, dependencies: item.dependencies, acceptance: clip(item.acceptance), result: clip(item.result_summary), blocker: clip(item.blocker) }));
          snapshot.omissions.work = Math.max(0, work.length - selected.work.length);
          if (graph) {
            const shown = new Set(selected.work.map(item => item.key));
            const states = new Map(work.map(item => [item.item_key, item.status]));
            const hidden = work.filter(item => !shown.has(item.item_key));
            const omitted = Object.fromEntries([...ATTENTION_STATES, ...QUIET_STATES]
              .map(state => [state, hidden.filter(item => item.status === state).length]).filter(([, count]) => count));
            const outside = [...new Set(selected.work.flatMap(item => item.dependencies))].filter(key => !shown.has(key)).sort();
            selected.view = { ...graph.view, total: work.length, shown: selected.work.length, omitted, outside: Object.fromEntries(outside.map(key => [key, states.get(key)])) };
          }
        }
        if (chosen.includes('evidence')) {
          selected.evidence = ctx.db.prepare('SELECT id, source, kind, passed, summary, revision, created_at FROM evidence WHERE feature_id = ? ORDER BY rowid DESC LIMIT 12').all(row.id)
            .map(item => ({ ...item, summary: clip(item.summary), passed: item.passed === null ? null : Boolean(item.passed) }));
          selected.candidate = ctx.db.prepare('SELECT id, revision, status, summary, spec_revision FROM candidates WHERE feature_id = ? ORDER BY rowid DESC LIMIT 1').get(row.id) ?? null;
          if (selected.candidate) selected.candidate.summary = clip(selected.candidate.summary);
        }
        if (chosen.includes('activity')) {
          selected.activity = ctx.db.prepare('SELECT id, kind, summary, created_at FROM events WHERE feature_id = ? ORDER BY id DESC LIMIT 15').all(row.id)
            .map(item => ({ ...item, summary: clip(item.summary, 1200) }));
        }
        if (chosen.includes('handoff')) {
          const checkpoint = ctx.db.prepare('SELECT summary, next_action, unresolved_json, head_revision, created_at FROM checkpoints WHERE feature_id = ? ORDER BY rowid DESC LIMIT 1').get(row.id);
          selected.handoff = { summary: clip(checkpoint?.summary || row.summary, 4000), nextAction: clip(row.next_action || checkpoint?.next_action), unresolved: parseJson(checkpoint?.unresolved_json, []).map(value => clip(value)), checkpointAt: checkpoint?.created_at ?? null, checkpointRevision: checkpoint?.head_revision ?? null, blocker: clip(row.blocker) };
          selected.requests = ctx.db.prepare("SELECT request_id, summary, method, created_at FROM pending_agent_requests WHERE feature_id = ? AND status = 'pending'").all(row.id).map(item => ({ ...item, summary: clip(item.summary) }));
        }
        if (chosen.includes('spec')) {
          selected.spec = ctx.db.prepare('SELECT revision, content, rationale FROM spec_revisions WHERE feature_id = ? ORDER BY revision DESC LIMIT 1').get(row.id) ?? null;
          if (selected.spec) selected.spec.content = clip(selected.spec.content, 30_000);
          selected.revisions = ctx.db.prepare('SELECT revision, rationale, created_at FROM spec_revisions WHERE feature_id = ? ORDER BY revision DESC LIMIT 6').all(row.id).map(item => ({ ...item, rationale: clip(item.rationale) }));
        }
        snapshot.selected = selected;
      }
      ctx.db.exec('COMMIT');
    } catch (error) { ctx.db.exec('ROLLBACK'); throw error; }
    if (snapshot.selected) {
      const row = featureBySlug(ctx.db, snapshot.selected.slug);
      try { snapshot.selected.git = await repositorySnapshot(row.checkout_path, row.base_revision); }
      catch (error) { snapshot.selected.git = { unavailable: error.message }; }
      if (chosen.includes('evidence')) {
        const verification = verificationStatus(ctx, row, snapshot.selected.git.head);
        snapshot.selected.verification = { ...verification, checks: verification.checks.map(({ argv, ...check }) => ({ ...check, command: clip(JSON.stringify(argv), 2000) })) };
      }
    }
    const end = Number(ctx.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM events').get().id);
    snapshot.changedDuringRead = start !== end || databaseVersion !== ctx.db.prepare('PRAGMA data_version').get().data_version;
    snapshot.digest = createHash('sha256').update(JSON.stringify({ features: snapshot.features, selected: snapshot.selected, stateVersion: start })).digest('hex').slice(0, 16);
    return snapshot;
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
  if (!work) throw new TheaterError('Load the selected feature work before rendering its graph.', 'WORK_REQUIRED');
  if (work.length > GRAPH_LIMIT) throw new TheaterError('This graph has more than 24 tasks. Select the relevant work_items for a readable subgraph.', 'GRAPH_TOO_LARGE', { items: work.map(({ key, title, state }) => ({ key, title, state })) });
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
  if (args.components && (args.components.length !== 1 || args.components[0] !== 'work')) {
    throw new TheaterError('The work graph is the only built-in visual. Read other state with theater_state and answer in the conversation.', 'UNSUPPORTED_VIEW');
  }
  if (args.work_items !== undefined && (!Array.isArray(args.work_items) || !args.work_items.length || args.work_items.length > 24 || new Set(args.work_items).size !== args.work_items.length || args.work_items.some(key => typeof key !== 'string'))) {
    throw new TheaterError('work_items must contain 1–24 distinct work keys.', 'INVALID_INPUT');
  }
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.work_items !== undefined)) {
    throw new TheaterError('page must be a positive integer and cannot be combined with work_items.', 'INVALID_INPUT');
  }
  const snapshot = await snapshotState({ workspace_path: args.workspace_path, feature: args.feature, work_items: args.work_items, graph_page: args.page ?? 1, components: ['work'] });
  const base = contained(snapshot.workspace.path, '.theater', 'views', snapshot.id);
  const mermaid = renderWorkGraph(snapshot);
  const snapshotPath = base + '.json';
  const graphPath = mermaid ? base + '.mmd' : null;
  await writeJson(snapshot.workspace.path, snapshotPath, snapshot);
  if (graphPath) await atomicWrite(snapshot.workspace.path, graphPath, mermaid + '\n');
  const fence = '```';
  return {
    snapshotId: snapshot.id, observedAt: snapshot.observedAt, changedDuringRead: snapshot.changedDuringRead,
    feature: snapshot.selected.slug, title: snapshot.selected.title, format: 'mermaid',
    omittedWorkItems: snapshot.omissions.work || 0, view: snapshot.selected.view, graphPath, snapshotPath,
    mermaid, markdown: mermaid ? fence + 'mermaid\n' + mermaid + '\n' + fence : 'No work items are planned for this feature.',
    next: 'Render markdown directly in the reply. Mention the feature, observation time, and any omitted work; re-read if changedDuringRead. A partial view is not the whole graph: request the next page or exact work_items for another slice. Pages are live snapshots of the current order, so after work status changes start again at page 1. Steering and all other interaction stay in the existing conversation.',
  };
}
