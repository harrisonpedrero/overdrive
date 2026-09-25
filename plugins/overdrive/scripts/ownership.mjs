import { assertCheckReservation, loadWorkspace, featureBySlug, meta, parseJson, readFeatureRow, recordEvent, transaction } from './state.mjs';
import { OverdriveError, now, resolveWorkspace, safeSlug, withWorkspaceLock } from './util.mjs';

export function ownerAlive(owner) {
  if (!owner?.pid) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export function agentOwner(db, featureId) {
  return parseJson(meta(db, `agent-owner:${featureId}`), null);
}

export function ownsAgent(db, featureId, token) {
  return !token || agentOwner(db, featureId)?.token === token;
}

// Releases a dead owner's lane. A turn that may still be live elsewhere (a known active turn or a
// turn request that may have been delivered) becomes 'uncertain', keeping any known turn ID, so
// the next controller reconciles it from the native session or a coordinator attestation instead
// of dispatching a duplicate. Everything else is 'disconnected'. SET reads the pre-update row.
const MAY_BE_LIVE = "thread_id IS NOT NULL AND (active_turn_id IS NOT NULL OR agent_status IN ('starting', 'uncertain'))";
const RELEASE_DEAD_OWNER = `UPDATE features SET
  agent_status = CASE WHEN thread_id IS NULL THEN 'not_started' WHEN ${MAY_BE_LIVE} THEN 'uncertain' ELSE 'disconnected' END,
  active_turn_id = CASE WHEN ${MAY_BE_LIVE} THEN active_turn_id ELSE NULL END
  WHERE id = ?`;

export function recoverAgentState(ctx, feature) {
  const owner = agentOwner(ctx.db, feature.id);
  if (!owner || ownerAlive(owner) || feature.agent_status === 'uncertain' || (!feature.active_turn_id && !['starting','compacting','waiting_for_user'].includes(feature.agent_status))) return feature;
  transaction(ctx.db, () => {
    if (agentOwner(ctx.db, feature.id)?.token !== owner.token) return;
    ctx.db.prepare(RELEASE_DEAD_OWNER).run(feature.id);
    ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND status = 'pending'").run(now(), feature.id);
    recordEvent(ctx.db, { featureId: feature.id, kind: 'agent.recovered', summary: 'The previous controller process ended. The checkout and task are preserved; a turn that may still be running stays uncertain until its native session or a coordinator attestation settles it.' });
  });
  // Listings recover unbound lanes too; lane operations already refused them before reaching here.
  return readFeatureRow(ctx.db, feature.slug);
}

// 'uncertain': a turn request had no confirmed outcome, so the turn may be running.
const BUSY_STATUSES = ['starting', 'uncertain', 'compacting', 'waiting_for_user'];
export const AGENT_BUSY_SQL = `(active_turn_id IS NOT NULL OR agent_status IN (${BUSY_STATUSES.map(status => `'${status}'`).join(', ')}))`;

// Set when a worker process was stopped without its process tree, so tools it launched may
// still be running; only a recorded coordinator attestation clears it.
export const descendantsKey = featureId => `agent-descendants:${featureId}`;
export const DESCENDANTS_CLEAR_SQL = "NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agent-descendants:' || features.id)";
export const workersKey = featureId => `agent-workers:${featureId}`;
export const WORKERS_CLEAR_SQL = "NOT EXISTS (SELECT 1 FROM meta WHERE key = 'agent-workers:' || features.id)";

export function unconfirmedDescendants(db, featureId) {
  return parseJson(meta(db, descendantsKey(featureId)), null);
}

export function agentBusy(row) {
  return Boolean(row.active_turn_id) || BUSY_STATUSES.includes(row.agent_status);
}

function claimAgentControl(ctx, row, token) {
  const previous = agentOwner(ctx.db, row.id);
  if (previous?.token !== token && agentBusy(row) && ownerAlive(previous)) {
    throw new OverdriveError('This feature is running in another coordinator session. Inspect it there or wait for its current turn to finish.', 'AGENT_OWNED');
  }
  if (previous?.token !== token && !ownerAlive(previous)) {
    ctx.db.prepare(RELEASE_DEAD_OWNER).run(row.id);
    ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND status = 'pending'").run(now(), row.id);
  }
  meta(ctx.db, `agent-owner:${row.id}`, JSON.stringify({ token, pid: process.pid }));
}

export async function withAgentControl(args, token, fn) {
  const root = await resolveWorkspace(args.workspace_path);
  const slug = safeSlug(args.feature);
  return withWorkspaceLock(root, `control-${slug}`, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      assertCheckReservation(ctx.db, row.id);
      claimAgentControl(ctx, row, token);
    } finally { ctx.db.close(); }
    return fn(root, slug);
  });
}

// An observer may take over a dead controller's session, but must leave a live owner's
// notifications and state writes with that controller.
export async function adoptAgentObservation(args, token) {
  const root = await resolveWorkspace(args.workspace_path);
  const slug = safeSlug(args.feature);
  return withWorkspaceLock(root, `control-${slug}`, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      const owner = agentOwner(ctx.db, row.id);
      if (owner?.token !== token && ownerAlive(owner)) return false;
      claimAgentControl(ctx, row, token);
      return true;
    } finally { ctx.db.close(); }
  });
}

// Holds the lane's control lock for a whole lifecycle stop, so no turn can be dispatched between
// stopping the worker and recording the new status. The lane is claimed only when a worker may be
// live and must be stopped here; an idle lane keeps its owner. fn receives the lane row, whether
// a worker may be live, and the live controller other than this one that owns an idle lane's
// session, if any: only that controller can know whether a process it launched is still running.
export async function withLaneStop(args, token, fn) {
  const root = await resolveWorkspace(args.workspace_path);
  const slug = safeSlug(args.feature);
  return withWorkspaceLock(root, `control-${slug}`, async () => {
    const ctx = await loadWorkspace(root);
    let row;
    let busy;
    let foreignOwner = null;
    try {
      row = featureBySlug(ctx.db, slug);
      busy = agentBusy(row);
      if (busy) claimAgentControl(ctx, row, token);
      else {
        const owner = agentOwner(ctx.db, row.id);
        if (row.thread_id && owner && owner.token !== token && ownerAlive(owner)) foreignOwner = { pid: owner.pid };
      }
    } finally { ctx.db.close(); }
    return fn(row, busy, foreignOwner);
  });
}
