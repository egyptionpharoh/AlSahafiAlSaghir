'use strict';
// اختبارات وضع الإنتاج واستقلال المشروع.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const H = require('./helpers');

describe('وضع الإنتاج', () => {
  it('يرفض التشغيل دون APP_SECRET قوي', () => {
    const r = spawnSync(process.execPath, ['server.js'], { cwd: H.ROOT, env: { ...process.env, NODE_ENV: 'production', APP_SECRET: '', DATA_DIR: H.tmpDir(), PORT: '3999' }, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /APP_SECRET/);
  });

  it('يعمل بإعدادات الإنتاج: كوكي آمن، HSTS، وتخزين مؤقت للملفات الثابتة', async () => {
    const data = H.tmpDir();
    const port = 3800 + Math.floor(Math.random() * 90);
    const env = { NODE_ENV: 'production', APP_SECRET: 'x'.repeat(16) + require('node:crypto').randomBytes(16).toString('hex'), BASE_URL: 'https://paper.example.om' };
    spawnSync(process.execPath, ['scripts/create-admin.js'], { cwd: H.ROOT, env: { ...process.env, ...env, DATA_DIR: data, ADMIN_NAME: 'مسؤول', ADMIN_USERNAME: 'chief', ADMIN_PASSWORD: 'Chief-Editor-2026' } });
    const srv = await H.startServer({ dataDir: data, port, env });
    try {
      const home = await fetch(srv.base + '/');
      assert.equal(home.status, 200);
      assert.match(home.headers.get('strict-transport-security'), /max-age=/);
      const html = await home.text();
      assert.match(html, /<link rel="stylesheet" href="\/static\/css\/app\.css/);
      const css = await fetch(srv.base + '/static/css/app.css');
      assert.match(css.headers.get('cache-control'), /max-age=604800/);
      // الدخول: كوكي __Host- مع Secure
      const c = new H.Client(srv.base);
      const page = await c.get('/login');
      const pre = page.text.match(/name="_pre" value="([^"]+)"/)[1];
      const res = await fetch(srv.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c.cookieHeader() }, body: new URLSearchParams({ _pre: pre, username: 'chief', password: 'Chief-Editor-2026' }) });
      const sid = res.headers.getSetCookie().find((x) => x.startsWith('__Host-ss_sid='));
      assert.ok(sid, 'cookie prefix __Host-');
      assert.match(sid, /Secure/); assert.match(sid, /HttpOnly/);
      // الخطأ الداخلي لا يعرض تفاصيل
      const nf = await fetch(srv.base + '/static/../server.js');
      assert.notEqual(nf.status, 200);
      // الروابط القانونية تستخدم BASE_URL
      assert.doesNotMatch(html, /localhost|127\.0\.0\.1/);
    } finally { await H.stopServer(srv); }
  });
});

describe('استقلال المشروع', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', 'data', 'backups', '.git', 'tests'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|css|sql|json|html)$/.test(e.name)) files.push(p); } };
  walk(H.ROOT);
  it('لا يوجد أي ارتباط بمشروع MusiTeacher أو بمسارات جهاز محددة', () => {
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(t, /musiteacher/i, f);
      assert.doesNotMatch(t, /[A-Z]:\\\\|\/home\/|\/Users\//, f);
    }
  });
  it('لا توجد اعتماديات خارجية إلزامية', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  });
  it('لا توجد أسرار أو كلمات مرور ثابتة في الكود', () => {
    for (const f of files) {
      const t = fs.readFileSync(f, 'utf8');
      assert.doesNotMatch(t, /APP_SECRET\s*[:=]\s*['"][^'"]{8,}/, f);
      assert.doesNotMatch(t, /password\s*[:=]\s*['"][^'"]{6,}['"]/i, f);
    }
  });
});
