import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkoutPath } from './git.mjs';
import { OverdriveError, contained, ensureManagedPath, now, readJson, STATE_DIR, CONFIG_FILE } from './util.mjs';

const SCHEMA_VERSION = 7;
export const CHECK_QUEUE_META = 'checks:queue';
// Every lane is bound to the root its database was opened from, never to a recorded absolute path.
const databaseRoots = new WeakMap();

// A direct check whose command was not confirmed stopped first records this marker in the lane's
// database, so the clone stays reserved even if its interrupted queue job cannot be written.
// Resolving that job with execution_stopped clears it.
export const uncertainCheckKey = featureId => `checks-uncertain:${featureId}`;

export function assertCheckReservation(db, featureId, receiptId = null) {
  const marker = parseJson(meta(db, uncertainCheckKey(featureId)), null);
  if (marker) throw new OverdriveError(`Verification job ${marker.jobKey} reserves this clone because its check command may still be running. Confirm it and its children stopped, then resolve the job with execution_stopped.`, 'CHECK_EXECUTION_RESERVED');
  const raw = meta(db, CHECK_QUEUE_META);
  if (!raw) return;
  const queue = JSON.parse(raw);
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw new OverdriveError('Unsupported verification queue state.', 'INVALID_STATE');
  const reserved = queue.jobs.find(job => job.featureId === featureId && ['running', 'interrupted'].includes(job.status)
    && !(job.status === 'running' && receiptId && job.attempts.at(-1)?.receiptId === receiptId));
  if (reserved) throw new OverdriveError(`Verification job ${reserved.key} reserves this clone. Inspect the queue and resolve uncertain execution before reusing it.`, 'CHECK_EXECUTION_RESERVED');
}

// Records a directly run check whose command may still be running as an interrupted queue job, so
// the clone stays reserved exactly as for an interrupted queued check until the coordinator confirms
// execution stopped. The caller holds the verification-queue lock.
export function reserveInterruptedCheck(db, job) {
  const raw = meta(db, CHECK_QUEUE_META);
  const queue = raw ? JSON.parse(raw) : { version: 1, runner: null, jobs: [] };
  if (queue.version !== 1 || !Array.isArray(queue.jobs)) throw new OverdriveError('Unsupported verification queue state.', 'INVALID_STATE');
  queue.jobs.push(job);
  meta(db, CHECK_QUEUE_META, JSON.stringify(queue));
}

function schema(db) {
  // The busy timeout comes first so another controller process holding a lock is waited for.
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      outcome TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('planned','active','paused','blocked','review','done','archived')),
      priority INTEGER NOT NULL DEFAULT 0,
      base_revision TEXT NOT NULL,
      branch TEXT NOT NULL,
      checkout_path TEXT NOT NULL,
      spec_revision INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      blocker TEXT NOT NULL DEFAULT '',
      thread_id TEXT,
      thread_harness TEXT,
      active_turn_id TEXT,
      agent_status TEXT NOT NULL DEFAULT 'not_started',
      compaction_pending INTEGER NOT NULL DEFAULT 0,
      semantic_generation INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS spec_revisions (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      content TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(feature_id, revision)
    );

    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'build' CHECK (kind IN ('scope','design','build','review','validate','repair','integrate')),
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ready','running','blocked','review','done','failed','cancelled')),
      priority INTEGER NOT NULL DEFAULT 0,
      owner TEXT,
      acceptance TEXT NOT NULL DEFAULT '',
      result_revision TEXT,
      result_summary TEXT NOT NULL DEFAULT '',
      blocker TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(feature_id, item_key)
    );

    CREATE TABLE IF NOT EXISTS work_dependencies (
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      PRIMARY KEY(work_item_id, depends_on_id),
      CHECK(work_item_id <> depends_on_id)
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      head_revision TEXT,
      dirty_summary TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL,
      next_action TEXT NOT NULL,
      unresolved_json TEXT NOT NULL DEFAULT '[]',
      semantic_generation INTEGER,
      checkout_fingerprint_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      command TEXT,
      artifact TEXT,
      revision TEXT,
      passed INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      base_revision TEXT NOT NULL,
      summary TEXT NOT NULL,
      checks_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','accepted','rejected','superseded')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT REFERENCES features(id) ON DELETE CASCADE,
      work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_agent_requests (
      request_id TEXT NOT NULL,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      method TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','orphaned')),
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY(feature_id, request_id)
    );

    CREATE INDEX IF NOT EXISTS events_feature_created ON events(feature_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS work_items_feature_status ON work_items(feature_id, status);
  `);
}

function migrate(db, currentVersion) {
  if (currentVersion >= SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (currentVersion < 2) db.exec(`
      ALTER TABLE pending_agent_requests RENAME TO pending_agent_requests_v1;
      CREATE TABLE pending_agent_requests (
        request_id TEXT NOT NULL,
        feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        method TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','orphaned')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        PRIMARY KEY(feature_id, request_id)
      );
      INSERT INTO pending_agent_requests(request_id, feature_id, thread_id, turn_id, method, summary, payload_json, status, created_at, resolved_at)
      SELECT request_id, feature_id, thread_id, turn_id, method, summary, payload_json, status, created_at, resolved_at
      FROM pending_agent_requests_v1;
      DROP TABLE pending_agent_requests_v1;
    `);
    const additions = {
      features: { thread_harness: 'TEXT', semantic_generation: 'INTEGER NOT NULL DEFAULT 0' },
      checkpoints: { semantic_generation: 'INTEGER', checkout_fingerprint_json: 'TEXT' },
      evidence: {
        source: "TEXT NOT NULL DEFAULT 'reported'", spec_revision: 'INTEGER NOT NULL DEFAULT -1',
        contract_hash: "TEXT NOT NULL DEFAULT ''", check_key: 'TEXT', argv_json: 'TEXT',
        exit_code: 'INTEGER', output: "TEXT NOT NULL DEFAULT ''", duration_ms: 'INTEGER',
      },
      candidates: { spec_revision: 'INTEGER NOT NULL DEFAULT -1', contract_hash: "TEXT NOT NULL DEFAULT ''" },
    };
    for (const [table, columns] of Object.entries(additions)) {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
      for (const [name, declaration] of Object.entries(columns)) {
        if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      }
    }
    // These backfills repair schemas before 4; later upgrades only add columns.
    if (currentVersion < 4) {
      // Native sessions saved before ownership was recorded keep a backend only when that is
      // provable: schemas before 3 predate Claude workers, and only Codex emits native requests.
      // Anything else stays unknown and must be replaced explicitly rather than guessed.
      db.prepare(`UPDATE features SET thread_harness = 'codex'
        WHERE thread_id IS NOT NULL AND thread_harness IS NULL AND (? < 3 OR EXISTS (
          SELECT 1 FROM pending_agent_requests WHERE feature_id = features.id AND thread_id = features.thread_id
        ))`).run(currentVersion);
      db.exec(`
        UPDATE features SET status = 'active' WHERE status IN ('done','review') AND id IN (
          SELECT feature_id FROM candidates WHERE contract_hash = '' AND status IN ('ready','accepted')
        );
        UPDATE candidates SET status = 'superseded' WHERE contract_hash = '' AND status IN ('ready','accepted');
      `);
    }
    // Artifact paths recorded before the state directory was renamed.
    if (currentVersion < 7) {
      db.exec(String.raw`UPDATE evidence SET artifact = replace(replace(artifact, '.theater/', '.overdrive/'), '.theater\', '.overdrive\') WHERE artifact LIKE '%.theater%'`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(root) {
  const file = contained(root, STATE_DIR, 'state.sqlite3');
  const db = new DatabaseSync(file);
  databaseRoots.set(db, path.resolve(root));
  // A damaged or foreign file fails here; the handle is released so the file can be repaired.
  try {
    schema(db);
    const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (current && Number(current.value) > SCHEMA_VERSION) {
      throw new OverdriveError('This workspace was created by a newer OVERDRIVE version.', 'NEWER_SCHEMA');
    }
    migrate(db, current ? Number(current.value) : 2);
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export function initializeDatabase(root, config) {
  const db = openDatabase(root);
  const stamp = now();
  const values = {
    workspace_id: config.workspaceId,
    repository: config.repository,
    repository_kind: config.repositoryKind,
    default_revision: config.defaultRevision,
    default_branch: config.defaultBranch ?? '',
    created_at: stamp,
    updated_at: stamp,
  };
  const insert = db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [key, value] of Object.entries(values)) insert.run(key, String(value));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  return db;
}

export async function readWorkspaceConfig(root) {
  const configFile = await ensureManagedPath(root, contained(root, CONFIG_FILE));
  let config;
  try { config = await readJson(configFile); } catch (error) {
    if (error?.code === 'ENOENT') throw new OverdriveError('OVERDRIVE is not initialized in this workspace.', 'NOT_INITIALIZED');
    throw error;
  }
  if (config?.formatVersion !== 1 || typeof config.workspaceId !== 'string' || typeof config.repository !== 'string') {
    throw new OverdriveError('overdrive.json is invalid.', 'INVALID_STATE');
  }
  return config;
}

export async function loadWorkspace(root) {
  const config = await readWorkspaceConfig(root);
  const databaseFile = await ensureManagedPath(root, contained(root, STATE_DIR, 'state.sqlite3'));
  try { await fs.access(databaseFile); } catch {
    throw new OverdriveError('OVERDRIVE state database is missing.', 'INVALID_STATE');
  }
  const db = openDatabase(root);
  if (meta(db, 'workspace_id') !== config.workspaceId) {
    db.close();
    throw new OverdriveError('Workspace configuration and database identities disagree.', 'INVALID_STATE');
  }
  return { root, config, db };
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function meta(db, key, value = undefined) {
  if (value !== undefined) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, String(value));
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('updated_at', now());
    return String(value);
  }
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function linkedComponent(root, target) {
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) return cursor; }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  return null;
}

// A copied or moved workspace keeps its predecessor's absolute checkout paths; report them instead of following them.
function checkoutLocation(root, row) {
  const expected = checkoutPath(root, row.slug);
  if (!samePath(row.checkout_path, expected)) return { expected, recorded: row.checkout_path, bound: false, reason: 'recorded_elsewhere' };
  const link = linkedComponent(root, expected);
  if (link) return { expected, recorded: row.checkout_path, bound: false, reason: 'linked_path', link };
  return { expected, recorded: row.checkout_path, bound: true };
}

export function assertBoundCheckout(feature) {
  const location = feature.checkout_location;
  if (!location || location.bound) return feature;
  const detail = location.reason === 'linked_path'
    ? `its managed path passes through a symlink or junction (${location.link})`
    : `it was registered at ${location.recorded}`;
  throw new OverdriveError(
    `Feature ${feature.slug} is not bound to this workspace: ${detail}, not ${location.expected}. Refusing to inspect, verify or run a worker outside this workspace.`,
    'CHECKOUT_LOCATION_MISMATCH',
    { feature: feature.slug, expectedCheckout: location.expected, recordedCheckout: location.recorded, recovery: 'This control workspace appears to be a copy or relocation of another. Operate the lane from the workspace that owns its checkout, or create a new lane here; recorded paths are never rewritten automatically.' },
  );
}

export function readFeatureRow(db, slug) {
  const row = db.prepare('SELECT * FROM features WHERE slug = ?').get(slug);
  if (!row) throw new OverdriveError(`Unknown feature: ${slug}`, 'FEATURE_NOT_FOUND');
  return normalizeFeature(row, databaseRoots.get(db));
}

export function featureBySlug(db, slug) {
  return assertBoundCheckout(readFeatureRow(db, slug));
}

function normalizeFeature(row, root = undefined) {
  const feature = {
    ...row,
    priority: Number(row.priority),
    spec_revision: Number(row.spec_revision),
    compaction_pending: Boolean(row.compaction_pending),
  };
  if (root) {
    feature.checkout_location = checkoutLocation(root, row);
    // Only the path under the current root is ever exposed as the lane's checkout.
    feature.checkout_path = feature.checkout_location.expected;
  }
  return feature;
}

export function listFeatureRows(db, { includeArchived = false } = {}) {
  const rows = includeArchived
    ? db.prepare("SELECT * FROM features ORDER BY status = 'active' DESC, priority DESC, updated_at DESC").all()
    : db.prepare("SELECT * FROM features WHERE status <> 'archived' ORDER BY status = 'active' DESC, priority DESC, updated_at DESC").all();
  const root = databaseRoots.get(db);
  return rows.map(row => normalizeFeature(row, root));
}

export function workItems(db, featureId) {
  const dependencies = db.prepare(`
    SELECT wi.item_key, dep.item_key AS depends_on
    FROM work_dependencies wd
    JOIN work_items wi ON wi.id = wd.work_item_id
    JOIN work_items dep ON dep.id = wd.depends_on_id
    WHERE wi.feature_id = ?
    ORDER BY wi.item_key, dep.item_key
  `).all(featureId);
  const byKey = new Map();
  for (const row of dependencies) {
    if (!byKey.has(row.item_key)) byKey.set(row.item_key, []);
    byKey.get(row.item_key).push(row.depends_on);
  }
  return db.prepare('SELECT * FROM work_items WHERE feature_id = ? ORDER BY priority DESC, created_at, item_key').all(featureId)
    .map(row => ({ ...row, priority: Number(row.priority), dependencies: byKey.get(row.item_key) ?? [] }));
}

export function recordEvent(db, { featureId = null, workItemId = null, kind, summary, details = {} }) {
  const stamp = now();
  const result = db.prepare(`
    INSERT INTO events(feature_id, work_item_id, kind, summary, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(featureId, workItemId, kind, summary, JSON.stringify(details ?? {}), stamp);
  return { id: Number(result.lastInsertRowid), created_at: stamp };
}

// The runtime marks each candidate whose checks it derived from executed receipts, in the
// candidate's own transaction. Authorship is never inferred from check text.
export const candidateChecksKey = candidateId => `candidate-checks:${candidateId}`;

// One string per receipt; checks never run are absent and optional failures stay labelled.
export const receiptCheckText = receipt => `${receipt.key}${receipt.required ? '' : ' (optional)'}: ${receipt.status} · receipt ${receipt.receiptId}${receipt.reused ? ' · reused' : ''}`;

// Verification snapshots each contract's per-check bindings (and reuse policy) under this key.
export const contractSnapshotKey = (featureId, contract) => `verification-contract:${featureId}:${contract}`;

// Verified checks are rebuilt only from the marker's receipt references, validated against the
// candidate's own contract snapshot: every entry names a distinct check of that contract with its
// required flag, every required check is present and passed, and each receipt is an executed receipt of
// the candidate's feature, revision, key and outcome that was eligible under verificationStatus's
// semantics: a direct receipt ran under that exact contract; a reused one ran under the same spec
// revision with an identical check binding, and a passing reuse also needs that contract's
// reuse_same_revision policy. A snapshot lacking those policies fails closed; saved strings are never
// trusted. Returns null for an unmarked (legacy) candidate and checks: null for an inconsistent marker.
export function markedCandidateChecks(db, candidateId) {
  const raw = typeof candidateId === 'string' ? meta(db, candidateChecksKey(candidateId)) : undefined;
  if (raw === undefined) return null;
  const marker = parseJson(raw, null);
  const candidate = db.prepare('SELECT feature_id, revision, contract_hash, spec_revision FROM candidates WHERE id = ?').get(candidateId);
  if (!candidate?.contract_hash) return { checks: null };
  const receipt = db.prepare("SELECT passed, contract_hash, spec_revision FROM evidence WHERE id = ? AND feature_id = ? AND source = 'executed' AND check_key = ? AND revision = ?");
  const snapshot = contract => {
    const saved = parseJson(meta(db, contractSnapshotKey(candidate.feature_id, contract)), null);
    return saved?.version === 1 && saved.checks && typeof saved.checks === 'object' ? saved : null;
  };
  const current = snapshot(candidate.contract_hash);
  const binding = key => Object.hasOwn(current?.checks ?? {}, key) && /^[a-f0-9]{64}$/.test(current.checks[key] ?? '') ? current.checks[key] : null;
  const eligible = entry => {
    const row = receipt.get(entry.receiptId, candidate.feature_id, entry.key, candidate.revision);
    if (!row || row.passed !== (entry.status === 'passed' ? 1 : 0)) return false;
    if (!entry.reused) return row.contract_hash === candidate.contract_hash;
    if (row.contract_hash === candidate.contract_hash || row.spec_revision !== candidate.spec_revision) return false;
    const original = snapshot(row.contract_hash);
    return Object.hasOwn(original?.checks ?? {}, entry.key) && original.checks[entry.key] === binding(entry.key)
      && (entry.status === 'failed' || current.reuse.includes(entry.key));
  };
  const receipts = marker?.version === 1 && marker.source === 'executed-receipts' && Array.isArray(marker.receipts) ? marker.receipts : [];
  const keys = receipts.map(entry => entry?.key);
  const valid = Array.isArray(current?.required) && Array.isArray(current.reuse) && current.required.length > 0
    && new Set(keys).size === keys.length && current.required.every(key => keys.includes(key))
    && receipts.every(entry => typeof entry?.key === 'string' && binding(entry.key) && typeof entry.receiptId === 'string'
      && ['passed', 'failed'].includes(entry.status) && entry.required === current.required.includes(entry.key)
      && typeof entry.reused === 'boolean' && (!entry.required || entry.status === 'passed') && eligible(entry));
  return { checks: valid ? receipts.map(receiptCheckText) : null };
}

// Splits saved check strings against the marker: verified checks always come from the marker, and saved
// strings that differ from it are only unverified claims.
export function bindCandidateChecks(db, candidateId, saved) {
  const entries = (Array.isArray(saved) ? saved : saved === undefined ? [] : [saved]).map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry));
  const marked = markedCandidateChecks(db, candidateId);
  if (!marked) return { checks: [], unverifiedChecks: entries, checkProvenance: 'legacy-caller-reported' };
  const checks = marked.checks ?? [];
  const exact = Boolean(marked.checks) && entries.length === checks.length && entries.every((entry, index) => entry === checks[index]);
  return { checks, unverifiedChecks: exact ? [] : entries.filter(entry => !checks.includes(entry)), checkProvenance: exact ? 'executed-receipts' : 'marker-mismatch' };
}

export const candidateRecordedSummary = (revision, checkCount, noteCount) =>
  `Recorded candidate ${revision.slice(0, 12)} with ${checkCount} executed check receipt(s)${noteCount ? `; ${noteCount} unverified caller note(s)` : ''}.`;

// Events are immutable history, projected on read. A candidate.recorded event whose candidate lacks the
// marker predates receipt provenance; a marked one is shown as recorded only when its checks match the
// marker and its summary is exactly the one rebuilt from the candidate revision, verified check count and
// the event's own note count. Otherwise saved check strings are only unverified claims, and a marked
// event's summary is rebuilt from the candidate record instead of echoing altered text.
const LEGACY_CANDIDATE_SUMMARY = / with (\d+) check\(s\)\.$/;
export function projectCandidateEvent(db, event) {
  if (event.kind !== 'candidate.recorded') return event;
  const { checks: saved, ...details } = event.details ?? {};
  const bound = bindCandidateChecks(db, details.candidateId, saved);
  if (bound.checkProvenance === 'legacy-caller-reported') {
    const summary = LEGACY_CANDIDATE_SUMMARY.test(event.summary)
      ? event.summary.replace(LEGACY_CANDIDATE_SUMMARY, ' with $1 caller-reported check claim(s), not verified as executed.')
      : `${event.summary} (caller-reported checks, not verified as executed)`;
    return { ...event, summary, details: { ...details, ...bound } };
  }
  const revision = db.prepare('SELECT revision FROM candidates WHERE id = ?').get(details.candidateId)?.revision;
  const notes = details.unverifiedNotes;
  if (bound.checkProvenance === 'executed-receipts' && revision && Array.isArray(notes)
    && event.summary === candidateRecordedSummary(revision, bound.checks.length, notes.length)) return event;
  const summary = `Candidate ${revision ? revision.slice(0, 12) : details.candidateId} event does not match its receipt record; ${bound.checks.length} executed check receipt(s) verified.`;
  return { ...event, summary, details: { ...details, ...bound, checkProvenance: 'marker-mismatch' } };
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
