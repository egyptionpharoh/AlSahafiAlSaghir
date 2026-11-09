'use strict';
// قاعدة البيانات — واجهة واحدة غير متزامنة (async) لمحركين:
//  1) محلي: SQLite المدمجة في Node.js (node:sqlite) في ملف داخل DATA_DIR — للتشغيل على جهاز المدرسة. لا يحتاج أي تثبيت.
//  2) سحابي: Turso (SQLite سحابية عبر HTTP) — للنشر على Vercel، لأن Vercel لا يملك قرصًا دائمًا.
//     يُفعَّل تلقائيًا عند وجود TURSO_DATABASE_URL و TURSO_AUTH_TOKEN. نفس جمل SQL تعمل في المحركين.
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config');
const { DEFAULT_SETTINGS } = require('./defaults');

const als = new AsyncLocalStorage(); // سياق الطلب/المعاملة الحالية
let backend = null;
let opening = null;

function now() { return new Date().toISOString(); }

// ================= المحرك المحلي (node:sqlite) =================
function localBackend(file) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA foreign_keys = ON;');
  d.exec('PRAGMA busy_timeout = 5000;');
  d.exec('PRAGMA synchronous = NORMAL;');
  const norm = (p) => p.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
  const conn = {
    async all(sql, p) { return d.prepare(sql).all(...norm(p)); },
    async run(sql, p) { const r = d.prepare(sql).run(...norm(p)); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    async script(sql) { d.exec(sql); },
  };
  let chain = Promise.resolve(); // معاملات متتابعة (اتصال واحد)
  return {
    kind: 'local',
    ...conn,
    async batch(list) { const out = []; for (const [sql, p] of list) out.push(await conn.all(sql, p)); return out; },
    async tx(fn) {
      const prev = chain; let release;
      chain = new Promise((r) => { release = r; });
      await prev;
      try {
        d.exec('BEGIN IMMEDIATE');
        try { const r = await fn(conn); d.exec('COMMIT'); return r; }
        catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
      } finally { release(); }
    },
    close() { d.close(); },
  };
}

// ================= المحرك السحابي (Turso عبر HTTP — بلا أي حزمة) =================
function tursoBackend(url, token) {
  let base = url.replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  const toArg = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
    if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
    if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
    return { type: 'text', value: String(v) };
  };
  const fromVal = (c) => {
    switch (c.type) {
      case 'null': return null;
      case 'integer': return Number(c.value);
      case 'float': return Number(c.value);
      case 'blob': return Buffer.from(c.base64 || '', 'base64');
      default: return c.value;
    }
  };
  const exec = (sql, p) => ({ type: 'execute', stmt: { sql, args: p.map(toArg) } });

  async function pipeline(requests, baton = null, target = base) {
    let res, lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await fetch(`${target}/v2/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ baton, requests }),
        });
        if (res.status >= 500 && !baton && attempt < 2) { lastErr = new Error(`Turso HTTP ${res.status}`); await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); continue; }
        break;
      } catch (e) { lastErr = e; if (baton || attempt === 2) throw e; await new Promise((r) => setTimeout(r, 150 * (attempt + 1))); }
    }
    if (!res) throw lastErr;
    const text = await res.text();
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    for (const r of body.results) {
      if (r.type === 'error') {
        const e = new Error(r.error && r.error.message ? r.error.message : 'Turso error');
        e.code = r.error && r.error.code;
        throw e;
      }
    }
    return body;
  }
  const rowsOf = (result) => {
    const cols = result.cols.map((c) => c.name);
    return result.rows.map((row) => { const o = {}; row.forEach((c, i) => { o[cols[i]] = fromVal(c); }); return o; });
  };
  const runOf = (result) => ({ changes: Number(result.affected_row_count || 0), lastInsertRowid: result.last_insert_rowid == null ? 0 : Number(result.last_insert_rowid) });
  const FK = exec('PRAGMA foreign_keys = ON', []);

  async function single(req) {
    const body = await pipeline([FK, req, { type: 'close' }]);
    return body.results[1].response.result;
  }

  return {
    kind: 'turso',
    async all(sql, p) { return rowsOf(await single(exec(sql, p))); },
    async run(sql, p) { return runOf(await single(exec(sql, p))); },
    async script(sql) { await pipeline([FK, { type: 'sequence', sql }, { type: 'close' }]); },
    async batch(list) {
      const body = await pipeline([FK, ...list.map(([sql, p]) => exec(sql, p)), { type: 'close' }]);
      return body.results.slice(1, 1 + list.length).map((r) => rowsOf(r.response.result));
    },
    async tx(fn) {
      // اتصال واحد مفتوح (baton) طوال المعاملة
      let first = await pipeline([FK, exec('BEGIN IMMEDIATE', [])]);
      let baton = first.baton; let target = first.base_url || base;
      const step = async (req) => {
        const b = await pipeline([req], baton, target);
        baton = b.baton; if (b.base_url) target = b.base_url;
        return b.results[0].response.result;
      };
      const conn = {
        async all(sql, p) { return rowsOf(await step(exec(sql, p))); },
        async run(sql, p) { return runOf(await step(exec(sql, p))); },
        async script(sql) { const b = await pipeline([{ type: 'sequence', sql }], baton, target); baton = b.baton; },
      };
      try {
        const r = await fn(conn);
        await pipeline([exec('COMMIT', []), { type: 'close' }], baton, target);
        return r;
      } catch (e) {
        try { await pipeline([exec('ROLLBACK', []), { type: 'close' }], baton, target); } catch {}
        throw e;
      } finally { first = null; }
    },
    close() {},
  };
}

// ================= الفتح والترحيل =================
function useTurso() { return !!(config.tursoUrl && config.tursoToken); }

async function open(file = config.dbFile) {
  if (backend) return backend;
  if (opening) return opening;
  opening = (async () => {
    const b = useTurso() ? tursoBackend(config.tursoUrl, config.tursoToken) : localBackend(file);
    await migrate(b);
    await ensureDefaults(b);
    backend = b;
    return b;
  })();
  try { return await opening; } finally { opening = null; }
}

function migrationFiles() { return require('./migrations/index.js'); }

async function migrate(b) {
  await b.run('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)', []);
  const files = migrationFiles();
  let applied = new Set((await b.all('SELECT name FROM schema_migrations', [])).map((r) => r.name));
  for (const f of files) {
    if (applied.has(f.name)) continue;
    if (b.kind === 'local') await b.script('PRAGMA foreign_keys = OFF;');
    try {
      const done = await b.tx(async (c) => {
        // فحص ثانٍ داخل المعاملة: قد تبدأ نسختان من التطبيق معًا على Vercel
        if ((await c.all('SELECT 1 x FROM schema_migrations WHERE name = ?', [f.name])).length) return false;
        await c.script(f.sql);
        await c.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [f.name, now()]);
        return true;
      });
      if (done && process.env.NODE_ENV !== 'test') console.log(`✓ migration applied: ${f.name}`);
    } catch (e) {
      throw new Error(`فشل تطبيق الترحيل ${f.name}: ${e.message}`);
    } finally {
      if (b.kind === 'local') await b.script('PRAGMA foreign_keys = ON;');
    }
    applied = new Set((await b.all('SELECT name FROM schema_migrations', [])).map((r) => r.name));
  }
}

async function ensureDefaults(b) {
  const t = now();
  await b.batch(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ['INSERT OR IGNORE INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)', [k, JSON.stringify(v), t]]));
}

async function get() { return backend || open(); }

// داخل db.tx تمر كل الاستعلامات عبر اتصال المعاملة نفسه
async function conn() { const s = als.getStore(); return (s && s.tx) || get(); }

async function one(sql, ...p) { const rows = await (await conn()).all(sql, p); return rows[0]; }
async function all(sql, ...p) { return (await conn()).all(sql, p); }
async function run(sql, ...p) { return (await conn()).run(sql, p); }

async function tx(fn) {
  const s = als.getStore();
  if (s && s.tx) return fn(); // معاملة متداخلة: نستمر في المعاملة الخارجية
  const b = await get();
  return b.tx((c) => als.run({ ...(s || {}), tx: c }, fn));
}

// ================= الإعدادات (تُحمَّل مرة لكل طلب ثم تُقرأ مباشرة) =================
const globalCache = new Map();

function cacheStore() { const s = als.getStore(); return (s && s.cache) || null; }

/** يحمّل الإعدادات والتصنيفات والعدد الحالي في طلب واحد إلى قاعدة البيانات */
async function preload() {
  const b = await get();
  const [settings, cats] = await b.batch([
    ['SELECT key, value_json FROM settings', []],
    ['SELECT slug, name FROM categories WHERE is_visible = 1 ORDER BY sort_order, id', []],
  ]);
  const map = new Map();
  for (const r of settings) { try { map.set(r.key, JSON.parse(r.value_json)); } catch {} }
  const pub = map.get('publishing') || DEFAULT_SETTINGS.publishing;
  const issue = pub.current_issue_id ? await one("SELECT number, title FROM issues WHERE id = ? AND status = 'published'", pub.current_issue_id) : null;
  return { settings: map, cats, issue: issue || null };
}

/** يشغّل fn داخل سياق طلب (مع ذاكرة إعدادات خاصة به) */
async function withRequest(fn) {
  await get();
  const cache = await preload();
  return als.run({ cache }, fn);
}

function setting(key) {
  const c = cacheStore();
  const map = c ? c.settings : globalCache;
  if (map.has(key)) return map.get(key);
  return structuredClone(DEFAULT_SETTINGS[key]);
}
function navCategories() { const c = cacheStore(); return c ? c.cats : []; }
function currentIssueNav() { const c = cacheStore(); return c ? c.issue : null; }

async function loadSettings() {
  for (const r of await all('SELECT key, value_json FROM settings')) { try { globalCache.set(r.key, JSON.parse(r.value_json)); } catch {} }
}

async function setSetting(key, value, userId) {
  await run(`INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  key, JSON.stringify(value), now(), userId || null);
  const c = cacheStore();
  (c ? c.settings : globalCache).set(key, structuredClone(value));
}

function close() { if (backend) { backend.close(); backend = null; globalCache.clear(); } }
function kind() { return backend ? backend.kind : (useTurso() ? 'turso' : 'local'); }

module.exports = { open, get, tx, one, all, run, now, setting, setSetting, loadSettings, navCategories, currentIssueNav, withRequest, close, kind };
