'use strict';
// خادم يحاكي واجهة Turso HTTP (/v2/pipeline) فوق SQLite محلية — لاختبار وضع النشر السحابي دون إنترنت.
//   node tests/mock-turso.js 8787
// العنوان: http://127.0.0.1:8787/db/<مسار ملف قاعدة البيانات مُرمَّزًا>
process.removeAllListeners('warning');
const http = require('node:http');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const TOKEN = process.env.MOCK_TURSO_TOKEN || 'test-token';
const streams = new Map(); // baton → { db, timer }

function toVal(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}
function fromArg(a) {
  switch (a.type) {
    case 'null': return null;
    case 'integer': return Number(a.value);
    case 'float': return Number(a.value);
    case 'blob': return Buffer.from(a.base64, 'base64');
    case 'text': return a.value;
    default: throw new Error('bad arg type ' + a.type);
  }
}
function execute(db, stmt) {
  const st = db.prepare(stmt.sql);
  const args = (stmt.args || []).map(fromArg);
  const cols = st.columns ? st.columns() : [];
  if (cols.length) {
    const rows = st.all(...args);
    return { cols: cols.map((c) => ({ name: c.name, decltype: null })), rows: rows.map((r) => cols.map((c) => toVal(r[c.name]))), affected_row_count: 0, last_insert_rowid: null };
  }
  const r = st.run(...args);
  return { cols: [], rows: [], affected_row_count: Number(r.changes), last_insert_rowid: String(r.lastInsertRowid) };
}

const server = http.createServer((req, res) => {
  const m = req.url.match(/^\/db\/(.+)\/v2\/pipeline$/);
  if (req.method !== 'POST' || !m) { res.statusCode = 404; return res.end('not found'); }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.statusCode = 401; return res.end('unauthorized'); }
  const file = decodeURIComponent(m[1]);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.statusCode = 400; return res.end('bad json'); }
    let s = body.baton ? streams.get(body.baton) : null;
    if (body.baton && !s) { res.statusCode = 400; return res.end(JSON.stringify({ message: 'stream expired' })); }
    if (!s) { const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000'); s = { db }; }
    if (s.timer) clearTimeout(s.timer);
    const results = []; let closed = false;
    for (const r of body.requests) {
      try {
        if (r.type === 'execute') results.push({ type: 'ok', response: { type: 'execute', result: execute(s.db, r.stmt) } });
        else if (r.type === 'sequence') { s.db.exec(r.sql); results.push({ type: 'ok', response: { type: 'sequence' } }); }
        else if (r.type === 'close') { closed = true; results.push({ type: 'ok', response: { type: 'close' } }); }
        else results.push({ type: 'error', error: { message: 'unsupported ' + r.type } });
      } catch (e) { results.push({ type: 'error', error: { message: e.message, code: 'SQLITE_ERROR' } }); }
    }
    let baton = null;
    if (body.baton) streams.delete(body.baton);
    if (closed) { try { if (s.db.isTransaction) s.db.exec('ROLLBACK'); } catch {} s.db.close(); }
    else {
      baton = crypto.randomBytes(12).toString('hex');
      s.timer = setTimeout(() => { streams.delete(baton); try { s.db.close(); } catch {} }, 10_000);
      streams.set(baton, s);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ baton, base_url: null, results }));
  });
});

if (require.main === module) {
  const port = Number(process.argv[2] || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`mock turso on ${port}`));
}
module.exports = { server };
