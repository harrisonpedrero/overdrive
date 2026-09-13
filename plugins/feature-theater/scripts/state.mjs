import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TheaterError, contained, now, readJson } from './util.mjs';

const SCHEMA_VERSION = 2;

function schema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

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
      active_turn_id TEXT,
      agent_status TEXT NOT NULL DEFAULT 'not_started',
      compaction_pending INTEGER NOT NULL DEFAULT 0,
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
  if (currentVersion >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(root) {
  const file = contained(root, '.theater', 'state.sqlite3');
  const db = new DatabaseSync(file);
  schema(db);
  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (current && Number(current.value) > SCHEMA_VERSION) {
    db.close();
    throw new TheaterError('This workspace was created by a newer Feature Theater version.', 'NEWER_SCHEMA');
  }
  if (current) migrate(db, Number(current.value));
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
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
    focus: '',
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

export async function loadWorkspace(root) {
  const configFile = contained(root, 'theater.json');
  let config;
  try { config = await readJson(configFile); } catch (error) {
    if (error?.code === 'ENOENT') throw new TheaterError('Feature Theater is not initialized in this workspace.', 'NOT_INITIALIZED');
    throw error;
  }
  if (config?.formatVersion !== 1 || typeof config.workspaceId !== 'string' || typeof config.repository !== 'string') {
    throw new TheaterError('theater.json is invalid.', 'INVALID_STATE');
  }
  try { await fs.access(contained(root, '.theater', 'state.sqlite3')); } catch {
    throw new TheaterError('Feature Theater state database is missing.', 'INVALID_STATE');
  }
  const db = openDatabase(root);
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

export function featureBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM features WHERE slug = ?').get(slug);
  if (!row) throw new TheaterError(`Unknown feature: ${slug}`, 'FEATURE_NOT_FOUND');
  return normalizeFeature(row);
}

export function normalizeFeature(row) {
  return {
    ...row,
    priority: Number(row.priority),
    spec_revision: Number(row.spec_revision),
    compaction_pending: Boolean(row.compaction_pending),
  };
}

export function listFeatureRows(db, { includeArchived = false } = {}) {
  const rows = includeArchived
    ? db.prepare('SELECT * FROM features ORDER BY status = \'active\' DESC, priority DESC, updated_at DESC').all()
    : db.prepare("SELECT * FROM features WHERE status <> 'archived' ORDER BY status = 'active' DESC, priority DESC, updated_at DESC").all();
  return rows.map(normalizeFeature);
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
  try { return JSON.parse(value); } catch { return fallback; }
}
