import { assertCheckReservation, loadWorkspace, featureBySlug, meta, parseJson, recordEvent, transaction } from './state.mjs';
import { TheaterError, now, resolveWorkspace, safeSlug, withWorkspaceLock } from './util.mjs';

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

export function recoverAgentState(ctx, feature) {
  const owner = agentOwner(ctx.db, feature.id);
  if (!owner || ownerAlive(owner) || (!feature.active_turn_id && !['starting','compacting','waiting_for_user'].includes(feature.agent_status))) return feature;
  transaction(ctx.db, () => {
    if (agentOwner(ctx.db, feature.id)?.token !== owner.token) return;
    ctx.db.prepare("UPDATE features SET active_turn_id = NULL, agent_status = 'disconnected' WHERE id = ?").run(feature.id);
    ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND status = 'pending'").run(now(), feature.id);
    recordEvent(ctx.db, { featureId: feature.id, kind: 'agent.recovered', summary: 'The previous controller process ended. The checkout and task are preserved; resume from current state.' });
  });
  return featureBySlug(ctx.db, feature.slug);
}

export async function withAgentControl(args, token, fn) {
  const root = await resolveWorkspace(args.workspace_path);
  const slug = safeSlug(args.feature);
  return withWorkspaceLock(root, `control-${slug}`, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      assertCheckReservation(ctx.db, row.id);
      const previous = agentOwner(ctx.db, row.id);
      const busy = row.active_turn_id || ['starting', 'compacting', 'waiting_for_user'].includes(row.agent_status);
      if (previous?.token !== token && busy && ownerAlive(previous)) {
        throw new TheaterError('This feature is running in another coordinator session. Inspect it there or wait for its current turn to finish.', 'AGENT_OWNED');
      }
      if (previous?.token !== token && !ownerAlive(previous)) {
        ctx.db.prepare("UPDATE features SET active_turn_id = NULL, agent_status = CASE WHEN thread_id IS NULL THEN 'not_started' ELSE 'disconnected' END WHERE id = ?").run(row.id);
        ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND status = 'pending'").run(now(), row.id);
      }
      meta(ctx.db, `agent-owner:${row.id}`, JSON.stringify({ token, pid: process.pid }));
    } finally { ctx.db.close(); }
    return fn(root, slug);
  });
}
