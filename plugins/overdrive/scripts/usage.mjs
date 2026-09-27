import { now } from './util.mjs';
import { parseJson } from './state.mjs';

// Provider-reported worker usage. Only the allowlisted numeric counters below are ever kept: a
// snapshot is a cumulative total that replaces the previous one, and a turn's usage is the
// difference from a baseline the same session reported before the turn.
const CODEX_REQUIRED = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'].map(field => [field, field]);
const CODEX_OPTIONAL = [['cacheWriteInputTokens', 'cacheWriteInputTokens']];
const CLAUDE_TOKENS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
const CLAUDE_MAIN_LOOP = [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['cache_read_input_tokens', 'cacheReadInputTokens'], ['cache_creation_input_tokens', 'cacheCreationInputTokens']];
const LIVE_ENDS = new Set(['completed', 'failed', 'interrupted']);
const NOTES = {
  codex: 'Codex-reported thread token counts; inputTokens already include cachedInputTokens. Codex reports no cost and marks no final report, so a turn is at most partial.',
  claude: 'Claude Code-reported session totals including subagents; costUsd is a client-side estimate, not billing. mainLoop counts only the main agent loop, without subagents.',
};

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const tokenCount = value => Number.isSafeInteger(value) && value >= 0;

// The listed fields of source, renamed; null when a present field is not a token count, or when
// a required field is missing. Optional missing fields are left out, never filled with zero.
function pick(source, fields, required = true) {
  if (!plainObject(source)) return null;
  const counters = {};
  for (const [from, to] of fields) {
    if (source[from] === undefined && !required) continue;
    if (!tokenCount(source[from])) return null;
    counters[to] = source[from];
  }
  return counters;
}

export function addCounters(left, right) {
  const sum = { ...left };
  for (const [key, value] of Object.entries(right)) sum[key] = (sum[key] ?? 0) + value;
  return Object.values(sum).every(tokenCount) ? sum : null;
}

// tokenUsage.total of thread/tokenUsage/updated; `last` is one model call, never a whole turn.
export function codexUsageSnapshot(tokenUsage) {
  const totals = pick(tokenUsage?.total, CODEX_REQUIRED);
  const optional = pick(tokenUsage?.total, CODEX_OPTIONAL, false);
  return totals && optional && { ...totals, ...optional };
}

// The cumulative totals of a Claude result: the modelUsage token fields summed across models,
// whose names are dropped, and the top-level cost estimate. Only the full documented shape counts:
// an empty modelUsage (a crashed session reports zeros) or a partial entry yields no totals.
export function claudeUsageSnapshot(result) {
  const entries = plainObject(result?.modelUsage) ? Object.values(result.modelUsage) : [];
  const cost = result?.total_cost_usd;
  if (!entries.length || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  let totals = Object.fromEntries(CLAUDE_TOKENS.map(field => [field, 0]));
  for (const entry of entries) {
    const counts = pick(entry, CLAUDE_TOKENS.map(field => [field, field]));
    totals = counts && addCounters(totals, counts);
    if (!totals) return null;
  }
  return { ...totals, costUsd: cost };
}

// result.usage covers one response of the main loop only, so the turn's responses are added up.
export const claudeMainLoopUsage = result => pick(result?.usage, CLAUDE_MAIN_LOOP);

// Each counter of latest minus baseline; null when any counter went down or disappeared.
function difference(latest, baseline, zero = false) {
  const delta = {};
  for (const [key, value] of Object.entries(baseline)) {
    if (!(key in latest) || latest[key] < value) return null;
  }
  for (const [key, value] of Object.entries(latest)) {
    if (!(key in baseline) && !zero) continue;
    const start = zero ? 0 : baseline[key];
    delta[key] = key === 'costUsd' ? Math.round((value - start) * 1e6) / 1e6 : value - start;
  }
  return delta;
}

const sameCounters = (left, right) => Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key] === value);

const usageRow = (db, featureId, threadId, turnId) => db.prepare('SELECT * FROM agent_usage WHERE feature_id = ? AND thread_id = ? AND turn_id = ?').get(featureId, threadId, turnId);

// A previous turn's totals start the next turn only when its end was observed live; a Claude
// session's totals carry over only after a clean exit that followed an accepted final result.
const carriesOver = (harness, previous) => Boolean(previous?.totals_json) && (harness === 'claude' ? previous.final === 1 : LIVE_ENDS.has(previous.ended));

// fresh: the session was created for this turn, so its totals start at zero. Otherwise the
// previous turn's totals are copied as they stand now, so a later report to it changes no delta.
export function startTurnUsage(db, { featureId, threadId, turnId, harness, fresh }) {
  const previous = db.prepare('SELECT turn_id, totals_json, ended, final FROM agent_usage WHERE feature_id = ? AND thread_id = ? AND turn_id <> ? ORDER BY rowid DESC LIMIT 1').get(featureId, threadId, turnId);
  const baseline = fresh ? 'zero' : carriesOver(harness, previous) ? 'previous' : 'unknown';
  const carried = baseline === 'previous' ? previous : null;
  db.prepare('INSERT OR IGNORE INTO agent_usage(feature_id, thread_id, turn_id, harness, baseline, baseline_json, previous_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(featureId, threadId, turnId, harness, baseline, carried?.totals_json ?? null, carried?.turn_id ?? null, now());
}

// totals null: the report was malformed or not about this session, so it is only counted. A
// report below the turn's latest (out of order, zeroed by a failure, or reset) keeps the latest.
// sessionTotals, from a Claude worker: 'new' (zero baseline) or 'unverified' (resumed totals unproven).
export function recordTurnUsage(db, { featureId, threadId, turnId, harness, activeTurnId, totals, mainLoop, sessionTotals }) {
  if (!usageRow(db, featureId, threadId, turnId)) {
    if (turnId !== activeTurnId) return { ignored: true };
    startTurnUsage(db, { featureId, threadId, turnId, harness, fresh: false });
  }
  const key = [featureId, threadId, turnId];
  if (sessionTotals === 'new' || sessionTotals === 'unverified') {
    db.prepare('UPDATE agent_usage SET baseline = ?, baseline_json = NULL, previous_turn_id = NULL WHERE feature_id = ? AND thread_id = ? AND turn_id = ?').run(sessionTotals === 'new' ? 'zero' : 'unverified', ...key);
  }
  if (mainLoop !== undefined) db.prepare('UPDATE agent_usage SET main_loop_json = ? WHERE feature_id = ? AND thread_id = ? AND turn_id = ?').run(mainLoop ? JSON.stringify(mainLoop) : null, ...key);
  const latest = parseJson(usageRow(db, ...key).totals_json, null);
  if (totals && latest && sameCounters(totals, latest)) return { recorded: false };
  if (!totals || (latest && !difference(totals, latest))) {
    db.prepare('UPDATE agent_usage SET rejected = rejected + 1 WHERE feature_id = ? AND thread_id = ? AND turn_id = ?').run(...key);
    return { recorded: false, rejected: true };
  }
  db.prepare('UPDATE agent_usage SET totals_json = ?, observed_at = ? WHERE feature_id = ? AND thread_id = ? AND turn_id = ?').run(JSON.stringify(totals), now(), ...key);
  return { recorded: true };
}

// ended: the turn's status as its completion reported it, or 'reconciled' when the end was only
// learned afterwards and reports may be missing. final: the backend showed that the turn's last
// report came after all of its work. The first end recorded stands.
export function endTurnUsage(db, { featureId, threadId, turnId, ended, final }) {
  db.prepare('UPDATE agent_usage SET ended = ?, final = ? WHERE feature_id = ? AND thread_id = ? AND turn_id = ? AND ended IS NULL').run(ended, final ? 1 : 0, featureId, threadId, turnId);
}

function assess(row, state, totals, baseline, delta, baselineMoved) {
  if (!totals) return ['unknown', 'no_usage_reported'];
  if (!baseline) return ['unknown', 'baseline_unknown'];
  if (baselineMoved) return ['unknown', 'baseline_moved'];
  if (!delta) return ['unknown', 'counters_reset'];
  if (state === 'running') return ['partial', 'turn_running'];
  if (state === 'ended') return ['partial', 'turn_end_unobserved'];
  if (state !== 'completed') return ['partial', `turn_${state}`];
  if (row.rejected) return ['partial', 'snapshot_rejected'];
  if (!row.final) return ['partial', 'final_unconfirmed'];
  return ['complete', null];
}

function turnView(row, rows, activeTurnId) {
  const state = LIVE_ENDS.has(row.ended) ? row.ended : row.turn_id === activeTurnId ? 'running' : 'ended';
  const totals = parseJson(row.totals_json, null);
  const baseline = row.baseline === 'zero' ? {} : parseJson(row.baseline_json, null);
  const delta = totals && baseline ? difference(totals, baseline, row.baseline === 'zero') : null;
  // The previous turn was reported to after this one started, so the delta may include its tail.
  const baselineMoved = row.baseline === 'previous' && rows.find(candidate => candidate.turn_id === row.previous_turn_id)?.totals_json !== row.baseline_json;
  const [quality, reason] = assess(row, state, totals, baseline, delta, baselineMoved);
  return {
    turnId: row.turn_id, state, quality, reason, delta: quality === 'unknown' ? null : delta, observedAt: row.observed_at ?? null,
    ...(row.harness === 'claude' ? { mainLoop: parseJson(row.main_loop_json, null) } : {}),
  };
}

// Codex totalTokens already include cachedInputTokens; Claude's cache fields are separate from inputTokens.
const deltaTokens = delta => delta.totalTokens ?? CLAUDE_TOKENS.reduce((sum, field) => sum + (delta[field] ?? 0), 0);

// A lane's worker spend, or without featureId the workspace's: the turns started, how many of them
// have a credible delta (measuredTurns), and those non-overlapping deltas summed. A turn with an
// unknown, moved or reset baseline adds nothing, and each sum is left out until a turn is measured.
export function workerSpend(db, featureId = null) {
  const rows = db.prepare('SELECT * FROM agent_usage WHERE ? IS NULL OR feature_id = ? ORDER BY rowid').all(featureId, featureId);
  if (!rows.length) return null;
  const spend = { turns: rows.length, measuredTurns: 0 };
  let tokens = 0;
  let costUsd = null;
  for (const session of Map.groupBy(rows, row => `${row.feature_id}\n${row.thread_id}`).values()) {
    for (const row of session) {
      const { delta } = turnView(row, session, null);
      if (!delta) continue;
      spend.measuredTurns += 1;
      tokens += deltaTokens(delta);
      if (typeof delta.costUsd === 'number') costUsd = (costUsd ?? 0) + delta.costUsd;
    }
  }
  if (spend.measuredTurns) spend.tokensObserved = tokens;
  if (costUsd !== null) spend.claudeCostEstimateUsdObserved = Math.round(costUsd * 1e4) / 1e4;
  return spend;
}

const cumulativeScope = row => (row.harness === 'codex' ? 'codex_thread' : row.baseline === 'unverified' ? 'claude_worker_process' : 'claude_session');

// The usage of the lane's bound session: its active turn, else its latest, and the latest totals.
export function agentUsage(db, feature) {
  if (!feature.thread_id) return null;
  const rows = db.prepare('SELECT * FROM agent_usage WHERE feature_id = ? AND thread_id = ? ORDER BY rowid').all(feature.id, feature.thread_id);
  const active = feature.active_turn_id ?? null;
  const row = active ? rows.find(candidate => candidate.turn_id === active) : rows.at(-1);
  const latest = rows.findLast(candidate => candidate.totals_json);
  const harness = row?.harness ?? feature.thread_harness ?? null;
  const turn = row ? turnView(row, rows, active)
    : active ? { turnId: active, state: 'running', quality: 'unknown', reason: 'no_usage_reported', delta: null, observedAt: null, ...(harness === 'claude' ? { mainLoop: null } : {}) }
      : null;
  return {
    harness,
    threadId: feature.thread_id,
    note: NOTES[harness] ?? null,
    turn,
    cumulative: latest ? { scope: cumulativeScope(latest), turnId: latest.turn_id, totals: parseJson(latest.totals_json, null), observedAt: latest.observed_at } : null,
  };
}
