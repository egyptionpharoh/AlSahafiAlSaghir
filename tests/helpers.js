'use strict';
// أدوات الاختبار: تشغيل خادم حقيقي على مجلد بيانات مؤقت + عميل HTTP بكوكيز + صور اختبار.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix = 'ss-test-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// TEST_TURSO_MOCK=http://127.0.0.1:8787 → يشغّل الاختبارات نفسها على وضع Turso السحابي (عبر tests/mock-turso.js)
function tursoEnv(dataDir) {
  const mock = process.env.TEST_TURSO_MOCK;
  if (!mock) return {};
  fs.mkdirSync(dataDir, { recursive: true });
  return { TURSO_DATABASE_URL: `${mock}/db/${encodeURIComponent(path.join(dataDir, 'app.db'))}`, TURSO_AUTH_TOKEN: 'test-token' };
}

function startServer({ dataDir, port, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', DATA_DIR: dataDir, BACKUPS_DIR: path.join(dataDir, '..', path.basename(dataDir) + '-bk'), PORT: String(port), HOST: '127.0.0.1', FONTS_CDN: '0', ...tursoEnv(dataDir), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let started = false;
    const onData = (d) => {
      out += d.toString();
      if (!started && out.includes('يعمل الآن')) { started = true; resolve({ child, base: `http://127.0.0.1:${port}`, output: () => out }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server exited (${code}): ${out}`)));
    setTimeout(() => reject(new Error('server start timeout: ' + out)), 15000);
  });
}

function stopServer(s) {
  return new Promise((resolve) => {
    if (!s || s.child.exitCode !== null) return resolve();
    s.child.removeAllListeners('exit');
    s.child.on('exit', () => resolve());
    s.child.kill('SIGTERM');
  });
}

/** عميل بسيط يحتفظ بالكوكيز مثل المتصفح */
class Client {
  constructor(base) { this.base = base; this.jar = new Map(); }
  cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim();
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') this.jar.delete(k); else this.jar.set(k, v);
    }
  }
  async req(method, url, { form, json, body, headers = {}, follow = false } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.cookie = this.cookieHeader();
    let payload = body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; payload = JSON.stringify(json); }
    let res = await fetch(this.base + url, { method, headers: h, body: payload, redirect: 'manual' });
    this.store(res);
    const text = res.headers.get('content-type')?.startsWith('image/') ? null : await res.text();
    let out = { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
    if (follow && out.location && [301, 302, 303].includes(out.status)) return this.req('GET', out.location, { follow: true });
    return out;
  }
  get(url, o) { return this.req('GET', url, o); }
  post(url, form, o = {}) { return this.req('POST', url, { form, ...o }); }
  async csrfFrom(url) {
    const r = await this.get(url);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/) || r.text.match(/name="csrf" content="([^"]+)"/);
    if (!m) throw new Error(`no csrf on ${url} (status ${r.status})`);
    return m[1];
  }
  async login(username, password) {
    const page = await this.get('/login');
    const pre = page.text.match(/name="_pre" value="([^"]+)"/)[1];
    return this.post('/login', { _pre: pre, username, password });
  }
  async upload(url, buf, type = 'image/jpeg', csrf) {
    const h = { 'content-type': type, 'x-csrf-token': csrf, accept: 'application/json' };
    if (this.jar.size) h.cookie = this.cookieHeader();
    const res = await fetch(this.base + url, { method: 'POST', headers: h, body: buf, redirect: 'manual' });
    const t = await res.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    return { status: res.status, json: j, text: t };
  }
  async fetchRaw(url) {
    const h = {}; if (this.jar.size) h.cookie = this.cookieHeader();
    const res = await fetch(this.base + url, { headers: h, redirect: 'manual' });
    return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
  }
}

// ===== صور اختبار =====
const TINY_JPEG = Buffer.from('/9j/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAwAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCNAUogAAAAAAAAAAAAAAAAAAAAAH//2Q==', 'base64');

/** JPEG يحمل مقطع EXIF فيه نص «GPSLatitude» — يجب أن يزيله الخادم */
function jpegWithGps() {
  const payload = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPSLatitude=23.5880N;GPSLongitude=58.3829E;SECRET-LOCATION')]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([TINY_JPEG.slice(0, 2), seg, payload, TINY_JPEG.slice(2)]);
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** PNG ملون بتدرج بسيط (بدون أي مكتبة) — مع مقطع نصي يجب حذفه */
function makePng(w = 120, h = 80, [r1, g1, b1] = [14, 58, 74], [r2, g2, b2] = [201, 151, 63], { text } = {}) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      row[1 + x * 3] = Math.round(r1 + (r2 - r1) * t); row[2 + x * 3] = Math.round(g1 + (g2 - g1) * t); row[3 + x * 3] = Math.round(b1 + (b2 - b1) * t);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (text) parts.push(chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1')));
  parts.push(chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

module.exports = { ROOT, tmpDir, startServer, stopServer, Client, TINY_JPEG, jpegWithGps, makePng };
