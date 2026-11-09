'use strict';
// «اكتب للجريدة»: الطالب يكتب ويرفق صورًا ويرسل دون حساب، ثم يراجع المعلم وينشر.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers');

const DATA = H.tmpDir('ss-write-');
const PORT = 4100 + Math.floor(Math.random() * 90);
const ADMIN = { user: 'chief', pass: 'Chief-Editor-2026', name: 'أ. حسين' };
let srv;
const anon = () => new H.Client(srv.base);
const dbq = (sql, ...p) => { const d = new DatabaseSync(path.join(DATA, 'app.db'), { readOnly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const state = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BODY = 'في صباح يوم الأحد نظمت مدرستنا يومًا رياضيًا مفتوحًا شارك فيه طلاب الصفوف من الخامس إلى الثاني عشر.\nتنافست الفرق في كرة القدم والجري والقفز، وشجع الطلاب زملاءهم بحماس كبير، وقدم المعلمون الجوائز للفائزين في نهاية اليوم، وشكر مدير المدرسة الجميع على روحهم الرياضية العالية.';

async function openForm(c) {
  const r = await c.get('/write');
  assert.equal(r.status, 200);
  return {
    token: r.text.match(/name="_w" value="([^"]+)"/)[1],
    stamp: r.text.match(/name="stamp" value="([^"]+)"/)[1],
    cat: r.text.match(/<select name="category_id"[^>]*>\s*<option value="">اختر<\/option>\s*<option value="(\d+)"/)[1],
    html: r.text,
  };
}
async function uploadAs(c, token, buf, type = 'image/png') {
  const res = await fetch(srv.base + '/api/write/media', { method: 'POST', headers: { 'content-type': type, 'x-write-token': token, accept: 'application/json', cookie: c.cookieHeader() }, body: buf });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  execFileSync(process.execPath, [path.join(H.ROOT, 'scripts', 'create-admin.js')], { env: { ...process.env, NODE_ENV: 'test', DATA_DIR: DATA, ADMIN_NAME: ADMIN.name, ADMIN_USERNAME: ADMIN.user, ADMIN_PASSWORD: ADMIN.pass } });
  srv = await H.startServer({ dataDir: DATA, port: PORT, env: { IMAGE_PROCESSOR: 'builtin', WRITE_MIN_SECONDS: '1' } });
});
after(async () => { await H.stopServer(srv); });

describe('اكتب للجريدة (بلا حساب)', () => {
  it('الرئيسية تدعو للكتابة، والصفحة تعمل باتجاه عربي', async () => {
    const home = await anon().get('/');
    assert.match(home.text, /href="\/write"/);
    const c = anon();
    const f = await openForm(c);
    assert.match(f.html, /<html lang="ar" dir="rtl">/);
    assert.match(f.html, /أرسل مقالي/);
    assert.ok(c.jar.has('ss_w'), 'رمز النموذج في كوكي');
  });

  it('رفع الصور يتطلب رمز الصفحة، والصورة غير المرسلة لا يراها إلا صاحبها', async () => {
    const c = anon(); state.c = c;
    const f = await openForm(c); state.f = f;
    const bad = await fetch(srv.base + '/api/write/media', { method: 'POST', headers: { 'content-type': 'image/png' }, body: H.makePng() });
    assert.equal(bad.status, 403);
    const notImg = await uploadAs(c, f.token, Buffer.from('<?php echo 1; ?> just text here....'), 'image/png');
    assert.equal(notImg.status, 400);
    const a = await uploadAs(c, f.token, H.makePng(200, 150));
    const b = await uploadAs(c, f.token, H.jpegWithGps(), 'image/jpeg');
    assert.equal(a.status, 201); assert.equal(b.status, 201);
    state.imgs = [a.json, b.json];
    assert.equal((await anon().fetchRaw(`/media/${a.json.pid}`)).status, 404, 'لا تُعرض للعامة قبل النشر');
    assert.equal((await anon().fetchRaw(`/media/${a.json.pid}?t=${a.json.token}`)).status, 200, 'يراها صاحبها بالرمز');
  });

  it('النقص في البيانات يعيد النموذج برسائل واضحة ويحتفظ بما كُتب', async () => {
    await sleep(1100);
    const { c, f } = state;
    const r = await c.post('/write', { _w: f.token, stamp: f.stamp, name: 'سالم', grade: '7', category_id: '', title: 'يوم', body: 'قصير جدًا', images: '' });
    assert.equal(r.status, 400);
    assert.match(r.text, /اختر نوع المقال/);
    assert.match(r.text, /المقال قصير/);
    assert.match(r.text, /value="سالم"/);
  });

  it('الإرسال الآلي يُرفض: حقل الفخ أو رمز مفقود', async () => {
    const { c, f } = state;
    const trap = await c.post('/write', { _w: f.token, stamp: f.stamp, website: 'http://spam', name: 'سالم علي', grade: '7', category_id: f.cat, title: 'عنوان المقال', body: BODY });
    assert.equal(trap.status, 400);
    const other = anon();
    const noTok = await other.post('/write', { _w: f.token, stamp: f.stamp, name: 'سالم علي', grade: '7', category_id: f.cat, title: 'عنوان المقال', body: BODY });
    assert.equal(noTok.status, 303);
    assert.equal(noTok.location, '/write');
    assert.equal(dbq("SELECT COUNT(*) n FROM articles")[0].n, 0);
  });

  it('مقال كامل مع صورتين يصل لغرفة التحرير «مرسل للمراجعة»', async () => {
    const { c, f, imgs } = state;
    const r = await c.post('/write', {
      _w: f.token, stamp: f.stamp, name: 'سالم بن علي', grade: '7', section: '2', category_id: f.cat, title: 'يومنا الرياضي المفتوح', body: BODY,
      images: imgs.map((i) => `${i.pid}:${i.token}`).join(','), [`cap_${imgs[0].pid}`]: 'انطلاق سباق الجري', [`cap_${imgs[1].pid}`]: 'تتويج الفائزين',
    });
    assert.equal(r.status, 303);
    const m = r.location.match(/^\/write\/done\/([\w-]+)\?k=([\w-]+)$/);
    assert.ok(m, r.location);
    state.pid = m[1]; state.key = m[2];
    const done = await c.get(r.location);
    assert.match(done.text, /وصل مقالك/);
    const a = dbq('SELECT * FROM articles WHERE public_id = ?', state.pid)[0];
    assert.equal(a.status, 'submitted');
    assert.ok(a.cover_media_id, 'الصورة الأولى غلاف المقال');
    assert.equal(a.cover_caption, 'انطلاق سباق الجري');
    const blocks = JSON.parse(a.body_json);
    assert.equal(blocks.filter((x) => x.t === 'p').length, 2, 'كل سطر فقرة');
    assert.deepEqual(blocks.filter((x) => x.t === 'img').map((x) => x.cap), ['تتويج الفائزين']);
    const u = dbq('SELECT * FROM users WHERE id = ?', a.author_id)[0];
    assert.equal(u.is_guest, 1); assert.equal(u.is_active, 0); assert.equal(u.display_name, 'سالم بن علي');
    assert.equal(dbq('SELECT COUNT(*) n FROM media WHERE article_id = ? AND claim_token IS NULL', a.id)[0].n, 2);
    assert.equal(dbq('SELECT COUNT(*) n FROM article_revisions WHERE article_id = ?', a.id)[0].n, 1, 'النص الأصلي محفوظ');
  });

  it('رابط المتابعة يعمل بالرمز السري فقط', async () => {
    const ok = await anon().get(`/write/status/${state.pid}?k=${state.key}`);
    assert.equal(ok.status, 200);
    assert.match(ok.text, /مرسل للمراجعة/);
    assert.equal((await anon().get(`/write/status/${state.pid}?k=wrong-key-123456`)).status, 404);
    assert.equal((await anon().get(`/article/${state.pid}`)).status, 404, 'لا يُنشر قبل المراجعة');
  });

  it('المعلم يراجع ويعتمد وينشر، فيظهر المقال وصوره للقراء', async () => {
    const ed = anon();
    await ed.login(ADMIN.user, ADMIN.pass);
    const q = await ed.get('/newsroom/articles?f=queue');
    assert.match(q.text, /يومنا الرياضي المفتوح/);
    const rv = await ed.get(`/newsroom/articles/${state.pid}`);
    assert.equal(rv.status, 200);
    assert.match(rv.text, /أُرسل هذا المقال من صفحة «اكتب للجريدة»/);
    const csrf = rv.text.match(/name="_csrf" value="([^"]+)"/)[1];
    for (const action of ['approve', 'publish']) {
      const r = await ed.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action });
      assert.equal(r.status, 303);
    }
    const pub = await anon().get(`/article/${state.pid}`);
    assert.equal(pub.status, 200);
    assert.match(pub.text, /يومنا الرياضي المفتوح/);
    assert.match(pub.text, /طالب من الصف السابع/, 'بلا اسم حتى تسجيل الموافقة');
    for (const i of state.imgs) assert.equal((await anon().fetchRaw(`/media/${i.pid}`)).status, 200);
    const st = await anon().get(`/write/status/${state.pid}?k=${state.key}`);
    assert.match(st.text, /اقرأ مقالك في الجريدة/);
  });

  it('حساب الكاتب الضيف لا يمكن الدخول به', async () => {
    const u = dbq('SELECT username FROM users WHERE is_guest = 1')[0];
    const r = await anon().login(u.username, 'anything-123');
    assert.equal(r.status, 401);
  });
});
