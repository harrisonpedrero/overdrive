import { assertCheckReservation, loadWorkspace, featureBySlug, meta, parseJson, readFeatureRow, recordEvent, transaction } from './state.mjs';
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

export async function withAgentControl(args, token, fn) {
  const root = await resolveWorkspace(args.workspace_path);
  const slug = safeSlug(args.feature);
  return withWorkspaceLock(root, `control-${slug}`, async () => {
    const ctx = await loadWorkspace(root);
    try {
      const row = featureBySlug(ctx.db, slug);
      assertCheckReservation(ctx.db, row.id);
      const previous = agentOwner(ctx.db, row.id);
      // 'uncertain': a turn request had no confirmed outcome, so the turn may be running.
      const busy = row.active_turn_id || ['starting', 'uncertain', 'compacting', 'waiting_for_user'].includes(row.agent_status);
      if (previous?.token !== token && busy && ownerAlive(previous)) {
        throw new TheaterError('This feature is running in another coordinator session. Inspect it there or wait for its current turn to finish.', 'AGENT_OWNED');
      }
      if (previous?.token !== token && !ownerAlive(previous)) {
        ctx.db.prepare(RELEASE_DEAD_OWNER).run(row.id);
        ctx.db.prepare("UPDATE pending_agent_requests SET status = 'orphaned', resolved_at = ? WHERE feature_id = ? AND status = 'pending'").run(now(), row.id);
      }
      meta(ctx.db, `agent-owner:${row.id}`, JSON.stringify({ token, pid: process.pid }));
    } finally { ctx.db.close(); }
    return fn(root, slug);
  });
}
