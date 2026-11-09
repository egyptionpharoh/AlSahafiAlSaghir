'use strict';
// أدوات HTTP: قوالب HTML آمنة (هروب تلقائي)، موجّه الطلبات، قراءة الطلبات، الكوكيز.
const querystring = require('node:querystring');

// ===== القوالب الآمنة =====
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s ?? ''));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
function renderVal(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(renderVal).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}
/** كل القيم المُدرجة تُهرَّب تلقائيًا إلا ما يُغلَّف بـ raw() أو يُنتَج من html`` */
function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += renderVal(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// ===== الأخطاء =====
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; this.userMessage = message; }
}
const notFound = () => new HttpError(404, 'الصفحة غير موجودة.');
const forbidden = () => new HttpError(403, 'لا تملك صلاحية الوصول إلى هذه الصفحة.');
const bad = (m) => new HttpError(400, m);

// ===== الموجّه =====
class Router {
  constructor() { this.routes = []; }
  add(method, pattern, ...handlers) {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, handlers });
  }
  get(p, ...h) { this.add('GET', p, ...h); }
  post(p, ...h) { this.add('POST', p, ...h); }
  put(p, ...h) { this.add('PUT', p, ...h); }
  delete(p, ...h) { this.add('DELETE', p, ...h); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; } });
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

// ===== قراءة جسم الطلب =====
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) { reject(new HttpError(413, 'حجم البيانات المرسلة أكبر من المسموح.')); req.resume(); return; }
    const chunks = []; let size = 0; let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'حجم البيانات المرسلة أكبر من المسموح.')); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function parseForm(req) {
  const buf = await readBody(req, 512 * 1024);
  const parsed = querystring.parse(buf.toString('utf8'));
  const out = {};
  for (const [k, v] of Object.entries(parsed)) out[k] = Array.isArray(v) ? v : String(v);
  return out;
}

async function parseJson(req, limit = 1024 * 1024) {
  const buf = await readBody(req, limit);
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { throw bad('بيانات غير صالحة.'); }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* تجاهل */ }
  }
  return out;
}

function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge)}`;
  return c;
}

function addCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : [c]);
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  if (res.headersSent) return;
  const b = body instanceof Raw ? body.s : body;
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  res.end(res.req && res.req.method === 'HEAD' ? undefined : b);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8');
function redirect(res, to, status = 303) { res.statusCode = status; res.setHeader('Location', to); res.setHeader('Cache-Control', 'no-store'); res.end(); }

module.exports = { Raw, raw, esc, html, HttpError, notFound, forbidden, bad, Router, readBody, parseForm, parseJson, parseCookies, cookie, addCookie, send, sendJson, redirect };
