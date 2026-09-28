import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkoutPath, labPath } from './git.mjs';
import { OverdriveError, contained, ensureManagedPath, now, readJson, STATE_DIR, CONFIG_FILE } from './util.mjs';

const SCHEMA_VERSION = 11;
// Every lane is bound to the root its database was opened from, never to a recorded absolute path.
const databaseRoots = new WeakMap();

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
      kind TEXT NOT NULL DEFAULT 'feature',
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

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      delivered_how TEXT
    );

    CREATE TABLE IF NOT EXISTS lab_runs (
      id TEXT PRIMARY KEY,
      suite TEXT,
      target TEXT,
      revision TEXT,
      lab_revision TEXT,
      lanes_json TEXT,
      mutant TEXT,
      argv_json TEXT,
      cwd TEXT,
      exit_code INTEGER,
      status TEXT,
      output TEXT,
      duration_ms INTEGER,
      artifacts_json TEXT,
      created_by TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      feature TEXT,
      title TEXT,
      body TEXT,
      severity TEXT,
      status TEXT,
      repro_suite TEXT,
      found_revision TEXT,
      found_run TEXT,
      resolved_revision TEXT,
      resolved_run TEXT,
      note TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_usage (
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      baseline TEXT NOT NULL CHECK (baseline IN ('zero','previous','unknown','unverified')),
      baseline_json TEXT,
      previous_turn_id TEXT,
      totals_json TEXT,
      main_loop_json TEXT,
      observed_at TEXT,
      rejected INTEGER NOT NULL DEFAULT 0,
      ended TEXT,
      final INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(feature_id, thread_id, turn_id)
    );

    CREATE INDEX IF NOT EXISTS events_feature_created ON events(feature_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS work_items_feature_status ON work_items(feature_id, status);
    CREATE INDEX IF NOT EXISTS messages_to_status ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS lab_runs_target_created ON lab_runs(target, created_at);
    CREATE INDEX IF NOT EXISTS findings_feature_status ON findings(feature, status);
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
      features: { thread_harness: 'TEXT', semantic_generation: 'INTEGER NOT NULL DEFAULT 0', kind: "TEXT NOT NULL DEFAULT 'feature'" },
      checkpoints: { semantic_generation: 'INTEGER', checkout_fingerprint_json: 'TEXT' },
      evidence: {
        source: "TEXT NOT NULL DEFAULT 'reported'", spec_revision: 'INTEGER NOT NULL DEFAULT -1',
        contract_hash: "TEXT NOT NULL DEFAULT ''", check_key: 'TEXT', argv_json: 'TEXT',
        exit_code: 'INTEGER', output: "TEXT NOT NULL DEFAULT ''", duration_ms: 'INTEGER',
      },
      candidates: { spec_revision: 'INTEGER NOT NULL DEFAULT -1', contract_hash: "TEXT NOT NULL DEFAULT ''" },
      // Runs recorded before membership was kept stay NULL, which means unknown.
      lab_runs: { lanes_json: 'TEXT', mutant: 'TEXT' },
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
// A QA agent works in the lab rather than in a clone of its own.
function checkoutLocation(root, row) {
  const expected = row.kind === 'qa' ? labPath(root) : checkoutPath(root, row.slug);
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
  };
  if (root) {
    feature.checkout_location = checkoutLocation(root, row);
    // Only the path under the current root is ever exposed as the lane's checkout.
    feature.checkout_path = feature.checkout_location.expected;
  }
  return feature;
}

export function listFeatureRows(db, { includeArchived = false, includeDone = true } = {}) {
  const hidden = [...(includeArchived ? [] : ['archived']), ...(includeDone ? [] : ['done'])];
  const rows = db.prepare("SELECT * FROM features WHERE status NOT IN (SELECT value FROM json_each(?)) ORDER BY status = 'active' DESC, priority DESC, updated_at DESC")
    .all(JSON.stringify(hidden));
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

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}
