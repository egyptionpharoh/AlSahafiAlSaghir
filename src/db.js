'use strict';
// قاعدة البيانات: SQLite المدمجة في Node.js 22 (node:sqlite) — لا تحتاج تثبيت أي حزمة.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');
const { DEFAULT_SETTINGS } = require('./defaults');

let db;

function now() { return new Date().toISOString(); }

function open(file = config.dbFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  migrate();
  ensureDefaults();
  return db;
}

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`فشل تطبيق الترحيل ${f}: ${e.message}`);
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
    if (process.env.NODE_ENV !== 'test') console.log(`✓ migration applied: ${f}`);
  }
}

function ensureDefaults() {
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, JSON.stringify(v), now());
}

function get() { if (!db) open(); return db; }

function tx(fn) {
  const d = get();
  d.exec('BEGIN IMMEDIATE');
  try { const r = fn(d); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

function one(sql, ...p) { return get().prepare(sql).get(...p); }
function all(sql, ...p) { return get().prepare(sql).all(...p); }
function run(sql, ...p) { return get().prepare(sql).run(...p); }

// ===== الإعدادات =====
const settingsCache = new Map();
function setting(key) {
  if (settingsCache.has(key)) return settingsCache.get(key);
  const row = one('SELECT value_json FROM settings WHERE key = ?', key);
  const v = row ? JSON.parse(row.value_json) : structuredClone(DEFAULT_SETTINGS[key]);
  settingsCache.set(key, v);
  return v;
}
function setSetting(key, value, userId) {
  run(`INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  key, JSON.stringify(value), now(), userId || null);
  settingsCache.delete(key);
}

function close() { if (db) { db.close(); db = null; settingsCache.clear(); } }

module.exports = { open, get, tx, one, all, run, now, setting, setSetting, close };
