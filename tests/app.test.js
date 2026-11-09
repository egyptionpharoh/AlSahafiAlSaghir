'use strict';
// اختبارات شاملة تعمل على خادم حقيقي وقاعدة بيانات حقيقية في مجلد مؤقت.
//   node --test tests/
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const H = require('./helpers');

const DATA = H.tmpDir();
const PORT = 3900 + Math.floor(Math.random() * 90);
const ADMIN = { user: 'chief', pass: 'Chief-Editor-2026', name: 'أ. محمد بن عديم الجابري' };
let srv; let base;
const anon = () => new H.Client(base);
const dbq = (sql, ...p) => { const d = new DatabaseSync(path.join(DATA, 'app.db'), { readOnly: true }); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const state = {};
const TURSO = !!process.env.TEST_TURSO_MOCK; // نفس الاختبارات على وضع Turso السحابي (الصور داخل قاعدة البيانات)
/** محتوى الصورة المخزنة أينما كانت: مجلد uploads أو جدول media_data */
const stored = (key) => (key.startsWith('db/') ? Buffer.from(dbq('SELECT data FROM media_data WHERE storage_key = ?', key)[0].data) : fs.readFileSync(path.join(DATA, 'uploads', key)));

function cli(script, args = [], env = {}) {
  return execFileSync(process.execPath, [path.join(H.ROOT, 'scripts', script), ...args], { env: { ...process.env, NODE_ENV: 'test', DATA_DIR: DATA, BACKUPS_DIR: path.join(DATA, 'backups'), ...env }, encoding: 'utf8' });
}

async function newStudent(admin, name, grade) {
  const csrf = await admin.csrfFrom('/newsroom/students');
  const r = await admin.post('/newsroom/students', { _csrf: csrf, display_name: name, grade: String(grade), section: '2' });
  assert.equal(r.status, 200);
  const username = r.text.match(/اسم المستخدم<\/dt><dd dir="ltr">([^<]+)</)[1];
  const password = r.text.match(/كلمة المرور المؤقتة<\/dt><dd dir="ltr">([^<]+)</)[1];
  return { username, password, name };
}

async function studentSession(cred, newPass) {
  const c = anon();
  const r = await c.login(cred.username, cred.password);
  assert.equal(r.location, '/account/password', 'first login must force password change');
  const csrf = await c.csrfFrom('/account/password');
  const r2 = await c.post('/account/password', { _csrf: csrf, current: cred.password, password: newPass, confirm: newPass });
  assert.equal(r2.location, '/desk');
  return c;
}

const longText = 'زار طلاب الصف السابع مختبر العلوم صباح يوم الأحد، وأجروا تجربة لقياس سرعة ذوبان الملح في الماء بدرجات حرارة مختلفة، وسجلوا ملاحظاتهم في جداول منظمة، ثم ناقشوا النتائج مع معلمهم وتوصلوا إلى أن الحرارة تسرّع الذوبان بشكل واضح. وقال أحد الطلاب إن التجربة جعلت الدرس أقرب إلى الحياة اليومية.';

before(async () => {
  cli('create-admin.js', [], { ADMIN_NAME: ADMIN.name, ADMIN_USERNAME: ADMIN.user, ADMIN_PASSWORD: ADMIN.pass });
  srv = await H.startServer({ dataDir: DATA, port: PORT, env: { IMAGE_PROCESSOR: process.env.IMAGE_PROCESSOR || 'builtin' } });
  base = srv.base;
});
after(async () => { await H.stopServer(srv); });

describe('القارئ: الجريدة العامة', () => {
  it('الصفحة الرئيسية تعمل وتعرض حالة فارغة قبل النشر', async () => {
    const r = await anon().get('/');
    assert.equal(r.status, 200);
    assert.match(r.text, /الصحفي الصغير/);
    assert.match(r.text, /مدرسة طلحة بن عبيدالله/);
    assert.match(r.text, /لم يُنشر أي مقال بعد/);
  });
  it('ترويسات الأمان موجودة', async () => {
    const r = await anon().get('/');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  it('الأغلفة وصفحة «عن المبادرة» تعرض البيانات الرسمية', async () => {
    const c = anon();
    const front = await c.get('/cover');
    assert.equal(front.status, 200);
    assert.match(front.text, /أ\. حسين محمد سيد عبدالعال/);
    assert.match(front.text, /أ\. محمد بن عديم الجابري/);
    assert.doesNotMatch(front.text, /للمحررين: لم تُرفع بعد/, 'ملاحظة المحررين لا تظهر للقراء');
    const back = await c.get('/cover/back');
    assert.match(back.text, /هيئة الإشراف والتحرير/);
    assert.equal((await c.get('/about')).status, 200);
  });
});

describe('الصلاحيات قبل الدخول', () => {
  it('غرف العمل تحيل إلى صفحة الدخول', async () => {
    for (const u of ['/desk', '/newsroom', '/newsroom/students', '/desk/profile']) {
      const r = await anon().get(u);
      assert.equal(r.status, 303, u);
      assert.match(r.location, /^\/login\?next=/);
    }
  });
  it('واجهات API ترفض بلا جلسة', async () => {
    const r = await anon().req('PUT', '/api/desk/articles/abc', { json: {} });
    assert.equal(r.status, 401);
  });
});

describe('الدخول والحسابات', () => {
  it('المسؤول يدخل، وكلمة المرور مخزنة مجزأة لا نصًا صريحًا', async () => {
    state.admin = anon();
    const r = await state.admin.login(ADMIN.user, ADMIN.pass);
    assert.equal(r.status, 303); assert.equal(r.location, '/newsroom');
    const row = dbq('SELECT password_hash FROM users WHERE username = ?', ADMIN.user)[0];
    assert.match(row.password_hash, /^scrypt\$/);
    assert.ok(!row.password_hash.includes(ADMIN.pass));
  });
  it('كوكي الجلسة HttpOnly و SameSite', async () => {
    const c = anon();
    const page = await c.get('/login');
    const pre = page.text.match(/name="_pre" value="([^"]+)"/)[1];
    const res = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: c.cookieHeader() }, body: new URLSearchParams({ _pre: pre, username: ADMIN.user, password: ADMIN.pass }) });
    const sid = res.headers.getSetCookie().find((x) => x.startsWith('ss_sid='));
    assert.ok(sid); assert.match(sid, /HttpOnly/); assert.match(sid, /SameSite=Lax/);
  });
  it('كلمة مرور خاطئة تُرفض بنفس الرسالة لاسم موجود أو غير موجود', async () => {
    const a = await anon().login(ADMIN.user, 'wrong-password-1');
    const b = await anon().login('no-such-user', 'wrong-password-1');
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.match(a.text, /اسم المستخدم أو كلمة المرور غير صحيحة/);
    assert.match(b.text, /اسم المستخدم أو كلمة المرور غير صحيحة/);
  });
  it('إنشاء طالبين، وإلزام تغيير كلمة المرور المؤقتة عند أول دخول', async () => {
    state.cred1 = await newStudent(state.admin, 'سالم بن ناصر الحارثي', 7);
    state.cred2 = await newStudent(state.admin, 'فهد بن علي الكندي', 9);
    // قبل تغيير كلمة المرور: لا يمكن فتح المكتب
    const c = anon();
    await c.login(state.cred1.username, state.cred1.password);
    const blocked = await c.get('/desk');
    assert.equal(blocked.location, '/account/password');
    state.s1 = await studentSession(state.cred1, 'Salem-pen-2026');
    state.s2 = await studentSession(state.cred2, 'Fahad-pen-2026');
  });
  it('إضافة مجموعة طلبة دفعة واحدة مع رفض الأسطر الخاطئة', async () => {
    const csrf = await state.admin.csrfFrom('/newsroom/students');
    const r = await state.admin.post('/newsroom/students/bulk', { _csrf: csrf, lines: 'أحمد بن سعيد البلوشي، 5، 1\nيوسف خالد الهنائي, 12, 3\nخطأ، 30' });
    assert.equal(r.status, 200);
    assert.match(r.text, /أُنشئ 2 حساب/);
    assert.match(r.text, /أسطر لم تُنشأ/);
  });
  it('تسجيل الخروج ينهي الجلسة', async () => {
    const c = anon();
    await c.login(ADMIN.user, ADMIN.pass);
    const csrf = await c.csrfFrom('/newsroom');
    const r = await c.post('/logout', { _csrf: csrf });
    assert.equal(r.location, '/');
    assert.equal((await c.get('/newsroom')).status, 303);
  });
});

describe('غرفة الطالب: كتابة مقال كامل', () => {
  it('لوحة الطالب تعرض اسمه وصفه', async () => {
    const r = await state.s1.get('/desk');
    assert.equal(r.status, 200);
    assert.match(r.text, /سالم بن ناصر الحارثي/);
    assert.match(r.text, /الصف السابع/);
    assert.match(r.text, /اكتب مقالًا جديدًا/);
  });
  it('إنشاء مسودة جديدة', async () => {
    const csrf = await state.s1.csrfFrom('/desk');
    const r = await state.s1.post('/desk/articles', { _csrf: csrf });
    assert.equal(r.status, 303);
    state.pid = r.location.match(/\/desk\/articles\/([^/]+)\/edit/)[1];
    const ed = await state.s1.get(r.location);
    assert.equal(ed.status, 200);
    assert.match(ed.text, /article-data/);
    state.csrf1 = ed.text.match(/name="csrf" content="([^"]+)"/)[1];
  });
  it('رفع الصورة الشخصية (مع إزالة بيانات الموقع)', async () => {
    const r = await state.s1.upload('/api/profile-photo', H.jpegWithGps(), 'image/jpeg', state.csrf1);
    assert.equal(r.status, 201, r.text);
    state.profilePid = r.json.pid;
    const row = dbq('SELECT storage_key FROM media WHERE public_id = ?', r.json.pid)[0];
    const file = stored(row.storage_key);
    assert.ok(!file.includes('GPSLatitude'), 'بيانات الموقع يجب أن تُحذف');
    assert.equal(file[0], 0xff); assert.equal(file[1], 0xd8);
  });
  it('رفع صورة الغلاف وعدة صور داخل المقال', async () => {
    const cover = await state.s1.upload(`/api/media?article=${state.pid}&kind=cover`, H.makePng(300, 200, undefined, undefined, { text: 'camera-serial-123' }), 'image/png', state.csrf1);
    assert.equal(cover.status, 201, cover.text);
    state.coverPid = cover.json.pid;
    assert.equal(cover.json.w, 300);
    const storedRow = dbq('SELECT storage_key FROM media WHERE public_id = ?', cover.json.pid)[0];
    assert.ok(!stored(storedRow.storage_key).includes('camera-serial'), 'المقاطع النصية في PNG تُحذف');
    state.inline = [];
    for (let i = 0; i < 3; i++) {
      const r = await state.s1.upload(`/api/media?article=${state.pid}&kind=inline`, i % 2 ? H.TINY_JPEG : H.makePng(160, 120, [40, 90, 60], [240, 230, 200]), i % 2 ? 'image/jpeg' : 'image/png', state.csrf1);
      assert.equal(r.status, 201, r.text);
      state.inline.push(r.json.pid);
    }
  });
  it('حفظ المسودة مع الصور وأوصافها', async () => {
    const r = await state.s1.req('PUT', `/api/desk/articles/${state.pid}`, { headers: { 'x-csrf-token': state.csrf1 }, json: {
      title: 'تجربة الذوبان في مختبر العلوم', subtitle: 'الحرارة تسرّع الذوبان', summary: 'أجرى طلاب الصف السابع تجربة علمية لقياس سرعة الذوبان.',
      categoryId: dbq("SELECT id FROM categories WHERE slug = 'science'")[0].id, cover: state.coverPid, coverCaption: 'الطلاب في المختبر',
      blocks: [
        { t: 'p', text: longText }, { t: 'img', m: state.inline[0], cap: 'أدوات التجربة' },
        { t: 'h2', text: 'ماذا تعلمنا؟' }, { t: 'ul', items: ['الحرارة تؤثر', 'التسجيل الدقيق مهم'] },
        { t: 'img', m: state.inline[1], cap: '' }, { t: 'quote', text: 'العلم **متعة** حين نجربه' },
      ],
    } });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.ok(body.problems.some((p) => /وصفًا لكل صورة/.test(p)), 'يجب التنبيه للصورة بلا وصف');
  });
  it('لا يمكن الإرسال قبل استيفاء الشروط', async () => {
    const r = await state.s1.post(`/desk/articles/${state.pid}/submit`, { _csrf: state.csrf1 });
    assert.equal(r.location, `/desk/articles/${state.pid}/edit`);
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'draft');
  });
  it('تعديل المقال (إضافة الوصف الناقص) ثم المعاينة', async () => {
    const r = await state.s1.req('PUT', `/api/desk/articles/${state.pid}`, { headers: { 'x-csrf-token': state.csrf1 }, json: {
      title: 'تجربة الذوبان في مختبر العلوم', subtitle: 'الحرارة تسرّع الذوبان', summary: 'أجرى طلاب الصف السابع تجربة علمية لقياس سرعة الذوبان.',
      categoryId: dbq("SELECT id FROM categories WHERE slug = 'science'")[0].id, cover: state.coverPid, coverCaption: 'الطلاب في المختبر',
      blocks: [
        { t: 'p', text: longText }, { t: 'img', m: state.inline[0], cap: 'أدوات التجربة' },
        { t: 'h2', text: 'ماذا تعلمنا؟' }, { t: 'ul', items: ['الحرارة تؤثر', 'التسجيل الدقيق مهم'] },
        { t: 'img', m: state.inline[1], cap: 'تسجيل النتائج' }, { t: 'quote', text: 'العلم **متعة** حين نجربه' },
        { t: 'p', text: '<script>alert("xss")</script><img src=x onerror=alert(1)> نص عادي' },
      ],
    } });
    assert.equal(JSON.parse(r.text).problems.length, 0);
    const pv = await state.s1.get(`/desk/articles/${state.pid}/preview`);
    assert.equal(pv.status, 200);
    assert.match(pv.text, /<strong>متعة<\/strong>/);
    assert.match(pv.text, /تسجيل النتائج/);
    assert.doesNotMatch(pv.text, /<script>alert/);
    assert.doesNotMatch(pv.text, /<img src=x/);
    assert.match(pv.text, /&lt;script&gt;/);
  });
  it('الصورة الثالثة غير المستخدمة تُحذف عند الإرسال', async () => {
    const r = await state.s1.post(`/desk/articles/${state.pid}/submit`, { _csrf: state.csrf1 });
    assert.equal(r.location, '/desk?f=review');
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'submitted');
    assert.equal(dbq('SELECT COUNT(*) n FROM media WHERE public_id = ?', state.inline[2])[0].n, 0);
    assert.equal(dbq('SELECT COUNT(*) n FROM article_revisions r JOIN articles a ON a.id = r.article_id WHERE a.public_id = ?', state.pid)[0].n, 1, 'نسخة أصلية محفوظة عند الإرسال');
  });
  it('بعد الإرسال لا يستطيع الطالب التعديل أو رفع صور', async () => {
    const r = await state.s1.req('PUT', `/api/desk/articles/${state.pid}`, { headers: { 'x-csrf-token': state.csrf1 }, json: { title: 'تغيير' } });
    assert.equal(r.status, 409);
    const u = await state.s1.upload(`/api/media?article=${state.pid}&kind=inline`, H.TINY_JPEG, 'image/jpeg', state.csrf1);
    assert.equal(u.status, 409);
  });
});

describe('العزل بين الطلبة والقراء', () => {
  it('المقال المرسل غير منشور لا يظهر للعامة', async () => {
    assert.equal((await anon().get(`/article/${state.pid}`)).status, 404);
    const home = await anon().get('/');
    assert.doesNotMatch(home.text, /تجربة الذوبان/);
    const s = await anon().get('/search?q=' + encodeURIComponent('الذوبان'));
    assert.doesNotMatch(s.text, /تجربة الذوبان في مختبر/);
  });
  it('صور المقال غير المنشور غير متاحة للعامة (404)', async () => {
    for (const pid of [state.coverPid, state.inline[0], state.profilePid]) {
      assert.equal((await anon().fetchRaw(`/media/${pid}`)).status, 404, pid);
    }
    assert.equal((await state.s1.fetchRaw(`/media/${state.coverPid}`)).status, 200, 'الكاتب يرى صوره');
  });
  it('طالب آخر لا يصل إلى المقال بتغيير المعرّف في الرابط', async () => {
    const s2 = state.s2;
    assert.equal((await s2.get(`/desk/articles/${state.pid}/edit`)).status, 404);
    assert.equal((await s2.get(`/desk/articles/${state.pid}/preview`)).status, 404);
    const csrf = await s2.csrfFrom('/desk');
    assert.equal((await s2.req('PUT', `/api/desk/articles/${state.pid}`, { headers: { 'x-csrf-token': csrf }, json: { title: 'x' } })).status, 404);
    assert.equal((await s2.upload(`/api/media?article=${state.pid}&kind=inline`, H.TINY_JPEG, 'image/jpeg', csrf)).status, 404);
    assert.equal((await s2.fetchRaw(`/media/${state.coverPid}`)).status, 404);
    assert.equal((await s2.fetchRaw(`/media/${state.profilePid}`)).status, 404);
    const desk = await s2.get('/desk');
    assert.doesNotMatch(desk.text, /تجربة الذوبان/);
  });
  it('الطالب لا يدخل غرفة التحرير', async () => {
    assert.equal((await state.s1.get('/newsroom')).status, 403);
    assert.equal((await state.s1.get(`/newsroom/articles/${state.pid}`)).status, 403);
    const csrf = await state.s1.csrfFrom('/desk');
    const r = await state.s1.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'publish' });
    assert.equal(r.status, 403);
  });
});

describe('الحماية من الطلبات المزوّرة', () => {
  it('طلب بلا رمز CSRF يُرفض', async () => {
    const r = await state.s1.post('/desk/articles', {});
    assert.equal(r.status, 403);
    const j = await state.s1.req('PUT', `/api/desk/articles/${state.pid}`, { json: { title: 'x' } });
    assert.equal(j.status, 403);
  });
  it('طلب من مصدر خارجي يُرفض حتى مع الرمز', async () => {
    const csrf = await state.s1.csrfFrom('/desk');
    const r = await state.s1.post('/desk/articles', { _csrf: csrf }, { headers: { origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
  });
});

describe('رفع الملفات: التحقق من النوع الحقيقي', () => {
  let pid2; let csrf;
  before(async () => {
    csrf = await state.s2.csrfFrom('/desk');
    const r = await state.s2.post('/desk/articles', { _csrf: csrf });
    pid2 = r.location.match(/articles\/([^/]+)\//)[1];
  });
  it('ملف نصي بامتداد صورة يُرفض', async () => {
    const r = await state.s2.upload(`/api/media?article=${pid2}&kind=inline`, Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg', csrf);
    assert.equal(r.status, 400); assert.match(r.json.error, /نوع الملف غير مسموح/);
  });
  it('ملف تنفيذي يُرفض', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]);
    assert.equal((await state.s2.upload(`/api/media?article=${pid2}&kind=inline`, exe, 'application/octet-stream', csrf)).status, 400);
  });
  it('SVG يُرفض (قد يحمل أكوادًا)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal((await state.s2.upload(`/api/media?article=${pid2}&kind=inline`, svg, 'image/svg+xml', csrf)).status, 400);
  });
  it('صورة مقطوعة/تالفة تُرفض', async () => {
    const r = await state.s2.upload(`/api/media?article=${pid2}&kind=inline`, H.makePng().slice(0, 60), 'image/png', csrf);
    assert.equal(r.status, 400);
  });
  it('ملف أكبر من الحد المسموح يُرفض', async () => {
    const big = Buffer.concat([H.TINY_JPEG.slice(0, 20), Buffer.alloc(7 * 1024 * 1024)]);
    const r = await state.s2.upload(`/api/media?article=${pid2}&kind=inline`, big, 'image/jpeg', csrf);
    assert.equal(r.status, 413);
  });
  it('لم يُسجَّل أي ملف مرفوض في قاعدة البيانات', () => {
    assert.equal(dbq('SELECT COUNT(*) n FROM media m JOIN articles a ON a.id = m.article_id WHERE a.public_id = ?', pid2)[0].n, 0);
  });
});

describe('غرفة التحرير: المراجعة والنشر', () => {
  it('المقال يظهر في قائمة المراجعة ولوحة المتابعة', async () => {
    const q = await state.admin.get('/newsroom/articles?f=queue');
    assert.match(q.text, /تجربة الذوبان في مختبر العلوم/);
    const d = await state.admin.get('/newsroom');
    assert.match(d.text, /<b>1<\/b><span>بانتظار المراجعة/);
  });
  it('صفحة المراجعة تنبه لغياب موافقة نشر الاسم', async () => {
    const r = await state.admin.get(`/newsroom/articles/${state.pid}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /لا توجد موافقة مسجلة على نشر اسم الطالب/);
  });
  it('إعادة المقال للطالب بملاحظات (الملاحظة إلزامية)', async () => {
    const csrf = await state.admin.csrfFrom(`/newsroom/articles/${state.pid}`);
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'start_review' });
    const noNote = await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'request_changes', note: '' });
    assert.equal(noNote.status, 303);
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'in_review');
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'request_changes', note: 'أحسنت! أضف رأي معلم العلوم في الفقرة الأخيرة.' });
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'changes_requested');
  });
  it('الطالب يرى الملاحظة ويعدّل ويعيد الإرسال', async () => {
    const desk = await state.s1.get('/desk?f=fix');
    assert.match(desk.text, /أضف رأي معلم العلوم/);
    const ed = await state.s1.get(`/desk/articles/${state.pid}/edit`);
    assert.equal(ed.status, 200);
    assert.match(ed.text, /ملاحظات هيئة التحرير/);
    const csrf = ed.text.match(/name="csrf" content="([^"]+)"/)[1];
    const cur = JSON.parse(ed.text.match(/<script type="application\/json" id="article-data">([\s\S]*?)<\/script>/)[1]);
    cur.blocks.push({ t: 'p', text: 'وقال معلم العلوم إن التجربة نجحت لأن الطلاب التزموا بخطوات السلامة.' });
    const r = await state.s1.req('PUT', `/api/desk/articles/${state.pid}`, { headers: { 'x-csrf-token': csrf }, json: { ...cur, cover: cur.cover.pid } });
    assert.equal(r.status, 200, r.text);
    const sub = await state.s1.post(`/desk/articles/${state.pid}/submit`, { _csrf: csrf });
    assert.equal(sub.location, '/desk?f=review');
    assert.equal(dbq('SELECT COUNT(*) n FROM article_revisions r JOIN articles a ON a.id = r.article_id WHERE a.public_id = ?', state.pid)[0].n, 2);
  });
  it('تعديل تحريري محدود يحفظ النسخة ويتطلب سببًا', async () => {
    const ed = await state.admin.get(`/newsroom/articles/${state.pid}/edit`);
    const csrf = ed.text.match(/name="csrf" content="([^"]+)"/)[1];
    const cur = JSON.parse(ed.text.match(/id="article-data">([\s\S]*?)<\/script>/)[1]);
    const noNote = await state.admin.req('PUT', `/api/newsroom/articles/${state.pid}`, { headers: { 'x-csrf-token': csrf }, json: { ...cur, cover: cur.cover.pid } });
    assert.equal(noNote.status, 400);
    cur.title = 'تجربة الذوبان في مختبر العلوم بالمدرسة';
    const ok = await state.admin.req('PUT', `/api/newsroom/articles/${state.pid}`, { headers: { 'x-csrf-token': csrf }, json: { ...cur, cover: cur.cover.pid, editNote: 'توضيح العنوان' } });
    assert.equal(ok.status, 200, ok.text);
    const revs = dbq('SELECT r.reason, r.title FROM article_revisions r JOIN articles a ON a.id = r.article_id WHERE a.public_id = ? ORDER BY revision_no', state.pid);
    assert.equal(revs.length, 3);
    assert.equal(revs[1].title, 'تجربة الذوبان في مختبر العلوم', 'نص الطالب الأصلي محفوظ');
    assert.equal(revs[2].reason, 'editor_edit');
  });
  it('لا يمكن النشر قبل الاعتماد، ثم اعتماد ونشر', async () => {
    const csrf = await state.admin.csrfFrom(`/newsroom/articles/${state.pid}`);
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'publish' });
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'submitted');
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'approve' });
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'approved');
    assert.equal((await anon().get(`/article/${state.pid}`)).status, 404, 'المعتمد غير المنشور لا يظهر');
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'publish' });
    const row = dbq('SELECT status, submitted_at, approved_at, published_at, created_at, updated_at FROM articles WHERE public_id = ?', state.pid)[0];
    assert.equal(row.status, 'published');
    for (const k of ['created_at', 'updated_at', 'submitted_at', 'approved_at', 'published_at']) assert.ok(row[k], k);
  });
  it('سجل انتقالات الحالة كامل مع منفّذيها', () => {
    const ev = dbq('SELECT action, actor_id FROM article_events e JOIN articles a ON a.id = e.article_id WHERE a.public_id = ? ORDER BY e.id', state.pid).map((e) => e.action);
    assert.deepEqual(ev, ['create', 'submit', 'start_review', 'request_changes', 'submit', 'editor_edit', 'approve', 'publish']);
  });
});

describe('القارئ: المقال المنشور', () => {
  it('المقال يظهر في الرئيسية والقسم والبحث', async () => {
    const c = anon();
    assert.match((await c.get('/')).text, /تجربة الذوبان في مختبر العلوم بالمدرسة/);
    assert.match((await c.get('/section/science')).text, /تجربة الذوبان/);
    assert.match((await c.get('/search?q=' + encodeURIComponent('الذوبان'))).text, /تجربة الذوبان/);
    assert.match((await c.get('/search?cat=science')).text, /تجربة الذوبان/);
    assert.doesNotMatch((await c.get('/search?cat=sports-health')).text, /تجربة الذوبان/);
  });
  it('صفحة المقال: توقيع بلا اسم قبل الموافقة، وبلا صورة الطالب', async () => {
    const r = await anon().get(`/article/${state.pid}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /بقلم طالب من الصف السابع/);
    assert.doesNotMatch(r.text, /سالم بن ناصر الحارثي/);
    assert.doesNotMatch(r.text, new RegExp(state.profilePid));
    assert.equal((await anon().fetchRaw(`/media/${state.profilePid}`)).status, 404);
    assert.doesNotMatch(r.text, new RegExp(state.cred1.username), 'اسم المستخدم لا يُعرض للقراء');
  });
  it('تسجيل الموافقات يُظهر الاسم والصورة الدائرية', async () => {
    const sid = dbq('SELECT id FROM users WHERE username = ?', state.cred1.username)[0].id;
    const csrf = await state.admin.csrfFrom(`/newsroom/students/${sid}`);
    await state.admin.post(`/newsroom/students/${sid}/consent`, { _csrf: csrf, consent_name_public: '1', consent_photo_public: '1', consent_note: 'نموذج موافقة ولي الأمر 14' });
    const r = await anon().get(`/article/${state.pid}`);
    assert.match(r.text, /بقلم الطالب: سالم بن ناصر الحارثي/);
    assert.match(r.text, new RegExp(`/media/${state.profilePid}`));
    const img = await anon().fetchRaw(`/media/${state.profilePid}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal(dbq('SELECT consent_note FROM students WHERE user_id = ?', sid)[0].consent_note, 'نموذج موافقة ولي الأمر 14');
  });
  it('صور المقال المنشور متاحة، والصور غير المستخدمة ليست متاحة', async () => {
    assert.equal((await anon().fetchRaw(`/media/${state.coverPid}`)).status, 200);
    assert.equal((await anon().fetchRaw(`/media/${state.inline[0]}`)).status, 200);
    assert.equal((await anon().fetchRaw(`/media/${state.inline[2]}`)).status, 404);
  });
  it('رابط ثابت، أدوات المشاركة والطباعة، وعدّ القراءات مرة واحدة للقارئ', async () => {
    const c = anon();
    const r = await c.get(`/article/${state.pid}/any-slug`);
    assert.equal(r.status, 200);
    assert.match(r.text, /data-share/); assert.match(r.text, /data-print/);
    await c.get(`/article/${state.pid}`);
    await state.admin.get(`/article/${state.pid}`);
    await state.s1.get(`/article/${state.pid}`);
    // كل الطلبات من 127.0.0.1: تُحسب قراءة واحدة فقط، ولا تُحسب زيارات المحرر أو الكاتب نفسه
    assert.equal(dbq('SELECT views FROM articles WHERE public_id = ?', state.pid)[0].views, 1);
  });
});

describe('دورة النشر المتقدمة', () => {
  it('إلغاء النشر يخفي المقال وصوره فورًا، ثم الأرشفة والاستعادة', async () => {
    const csrf = await state.admin.csrfFrom(`/newsroom/articles/${state.pid}`);
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'unpublish' });
    assert.equal((await anon().get(`/article/${state.pid}`)).status, 404);
    assert.equal((await anon().fetchRaw(`/media/${state.coverPid}`)).status, 404);
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'archive' });
    assert.equal(dbq('SELECT status FROM articles WHERE public_id = ?', state.pid)[0].status, 'archived');
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'restore' });
    await state.admin.post(`/newsroom/articles/${state.pid}/action`, { _csrf: csrf, action: 'publish' });
    assert.equal((await anon().get(`/article/${state.pid}`)).status, 200);
  });
  it('جدولة النشر: لا يظهر المقال قبل موعده', async () => {
    const csrf = await state.s2.csrfFrom('/desk');
    const r = await state.s2.post('/desk/articles', { _csrf: csrf });
    const pid = r.location.match(/articles\/([^/]+)\//)[1];
    await state.s2.req('PUT', `/api/desk/articles/${pid}`, { headers: { 'x-csrf-token': csrf }, json: { title: 'مقال مجدول للنشر', categoryId: dbq("SELECT id FROM categories WHERE slug = 'culture'")[0].id, blocks: [{ t: 'p', text: longText }] } });
    await state.s2.post(`/desk/articles/${pid}/submit`, { _csrf: csrf });
    const ac = await state.admin.csrfFrom(`/newsroom/articles/${pid}`);
    await state.admin.post(`/newsroom/articles/${pid}/action`, { _csrf: ac, action: 'approve' });
    await state.admin.post(`/newsroom/articles/${pid}/action`, { _csrf: ac, action: 'publish', schedule: '1', publish_at: '2099-01-01T08:00' });
    const row = dbq('SELECT status, published_at FROM articles WHERE public_id = ?', pid)[0];
    assert.equal(row.status, 'published'); assert.equal(row.published_at, '2099-01-01T04:00:00.000Z');
    assert.equal((await anon().get(`/article/${pid}`)).status, 404);
    state.scheduledPid = pid;
  });
  it('رفض مقال مع سبب يظهر للطالب', async () => {
    const csrf = await state.s2.csrfFrom('/desk');
    const r = await state.s2.post('/desk/articles', { _csrf: csrf });
    const pid = r.location.match(/articles\/([^/]+)\//)[1];
    await state.s2.req('PUT', `/api/desk/articles/${pid}`, { headers: { 'x-csrf-token': csrf }, json: { title: 'مقال سيرفض', categoryId: 1, blocks: [{ t: 'p', text: longText }] } });
    await state.s2.post(`/desk/articles/${pid}/submit`, { _csrf: csrf });
    const ac = await state.admin.csrfFrom(`/newsroom/articles/${pid}`);
    await state.admin.post(`/newsroom/articles/${pid}/action`, { _csrf: ac, action: 'reject', note: 'المقال منقول من مصدر دون ذكره.' });
    const pv = await state.s2.get(`/desk/articles/${pid}/preview`);
    assert.match(pv.text, /منقول من مصدر دون ذكره/);
    state.rejectedPid = pid;
  });
  it('حذف المحتوى المخالف (للمسؤول فقط) يحذف الصور أيضًا ويُسجَّل', async () => {
    const ac = await state.admin.csrfFrom(`/newsroom/articles/${state.rejectedPid}`);
    const r = await state.admin.post(`/newsroom/articles/${state.rejectedPid}/delete`, { _csrf: ac, reason: 'محتوى منقول' });
    assert.equal(r.location, '/newsroom/articles');
    assert.equal(dbq('SELECT COUNT(*) n FROM articles WHERE public_id = ?', state.rejectedPid)[0].n, 0);
    assert.ok(dbq("SELECT 1 FROM audit_log WHERE action = 'article.delete'").length);
  });
});

describe('المحرر مقابل المسؤول', () => {
  it('المحرر يراجع لكن لا يدير الطلبة أو الإعدادات', async () => {
    const csrf = await state.admin.csrfFrom('/newsroom/staff');
    const r = await state.admin.post('/newsroom/staff', { _csrf: csrf, display_name: 'محرر اللغة العربية', username: 'arabic.editor', role: 'editor' });
    const pass = r.text.match(/كلمة المرور المؤقتة<\/dt><dd dir="ltr">([^<]+)</)[1];
    const ed = anon();
    await ed.login('arabic.editor', pass);
    const c1 = await ed.csrfFrom('/account/password');
    await ed.post('/account/password', { _csrf: c1, current: pass, password: 'Editor-Arabic-2026', confirm: 'Editor-Arabic-2026' });
    assert.equal((await ed.get('/newsroom')).status, 200);
    assert.equal((await ed.get('/newsroom/articles')).status, 200);
    assert.equal((await ed.get('/newsroom/categories')).status, 200);
    for (const u of ['/newsroom/students', '/newsroom/settings', '/newsroom/staff', '/newsroom/audit']) assert.equal((await ed.get(u)).status, 403, u);
    const csrf2 = await ed.csrfFrom('/newsroom');
    assert.equal((await ed.upload('/api/site-asset?slot=photo_school', H.TINY_JPEG, 'image/jpeg', csrf2)).status, 403);
  });
});

describe('إدارة الجريدة', () => {
  it('إدارة التصنيفات: إضافة وإخفاء وإعادة تسمية', async () => {
    const csrf = await state.admin.csrfFrom('/newsroom/categories');
    await state.admin.post('/newsroom/categories', { _csrf: csrf, name: 'رحلات مدرسية', slug: 'trips', description: '', sort_order: '130' });
    const cat = dbq("SELECT * FROM categories WHERE slug = 'trips'")[0];
    assert.ok(cat);
    assert.match((await anon().get('/')).text, /\/section\/trips/);
    await state.admin.post(`/newsroom/categories/${cat.id}`, { _csrf: csrf, name: 'رحلات وزيارات', slug: 'trips', description: 'x', sort_order: '5' });
    assert.doesNotMatch((await anon().get('/')).text, /\/section\/trips/, 'غير ظاهر بعد إلغاء التحديد');
    assert.equal((await anon().get('/section/trips')).status, 404);
  });
  it('تعديل الإعدادات ورفع صورة المدرسة وصورتي الغلاف', async () => {
    const csrf = await state.admin.csrfFrom('/newsroom/settings');
    const page = await state.admin.get('/newsroom/settings');
    const form = { _csrf: csrf };
    const dec = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const m of page.text.matchAll(/<input([^>]*)>/g)) {
      const name = (m[1].match(/name="([a-z_]+\.[a-z0-9_.]+)"/) || [])[1];
      if (!name || /type="checkbox"/.test(m[1])) continue;
      form[name] = dec((m[1].match(/value="([^"]*)"/) || [, ''])[1]);
    }
    for (const m of page.text.matchAll(/<textarea[^>]*name="([a-z_]+\.[a-z0-9_.]+)"[^>]*>([^<]*)<\/textarea>/g)) form[m[1]] = dec(m[2]);
    for (const m of page.text.matchAll(/<select name="(team\.\d\.slot)">([\s\S]*?)<\/select>/g)) { const s = m[2].match(/value="(\w*)" selected/); form[m[1]] = s ? s[1] : ''; }
    form['identity.tagline'] = 'من أقلامنا تبدأ الحكاية — اختبار';
    form['publishing.require_name_consent'] = '1'; form['cover.show_headlines'] = '1'; form['cover.show_principal'] = '1'; form['cover.show_supervisor'] = '1'; form['cover.show_school_photo'] = '1';
    await state.admin.post('/newsroom/settings', form);
    assert.match((await anon().get('/')).text, /من أقلامنا تبدأ الحكاية — اختبار/);
    assert.match((await anon().get('/cover')).text, /أ\. حسين محمد سيد عبدالعال/, 'الفريق محفوظ بعد الحفظ');
    for (const slot of ['photo_school', 'photo_principal', 'photo_supervisor']) {
      const r = await state.admin.upload(`/api/site-asset?slot=${slot}`, H.makePng(400, 300), 'image/png', csrf);
      assert.equal(r.status, 201, r.text);
      state[slot] = r.json.pid;
    }
    const cover = await anon().get('/cover');
    for (const slot of ['photo_school', 'photo_principal', 'photo_supervisor']) assert.match(cover.text, new RegExp(state[slot]));
    assert.equal((await anon().fetchRaw(`/media/${state.photo_school}`)).status, 200);
  });
  it('الأعداد: إنشاء عدد وجعله الحالي وإسناد مقال إليه', async () => {
    const csrf = await state.admin.csrfFrom('/newsroom/issues');
    const r = await state.admin.post('/newsroom/issues', { _csrf: csrf, number: '1', title: 'العدد الأول', theme: 'أقلام تكتشف العالم' });
    const id = r.location.match(/issues\/(\d+)/)[1];
    await state.admin.post(`/newsroom/issues/${id}`, { _csrf: csrf, number: '1', title: 'العدد الأول', theme: 'أقلام تكتشف العالم', intro: 'افتتاحية العدد الأول.', status: 'published', current: '1' });
    const art = dbq('SELECT category_id FROM articles WHERE public_id = ?', state.pid)[0];
    await state.admin.post(`/newsroom/articles/${state.pid}/placement`, { _csrf: csrf, category_id: String(art.category_id), issue_id: id, featured: '1', home_order: '10' });
    const cover = await anon().get('/cover');
    assert.match(cover.text, /العدد 1/); assert.match(cover.text, /تجربة الذوبان/);
    assert.match((await anon().get('/issue/1')).text, /تجربة الذوبان/);
    assert.match((await anon().get('/')).text, /افتتاحية العدد 1/);
  });
  it('إعادة تعيين كلمة مرور طالب وتعطيل حساب', async () => {
    const sid = dbq('SELECT id FROM users WHERE username = ?', state.cred2.username)[0].id;
    const csrf = await state.admin.csrfFrom(`/newsroom/students/${sid}`);
    const r = await state.admin.post(`/newsroom/students/${sid}/reset-password`, { _csrf: csrf });
    assert.match(r.text, /كلمة مرور مؤقتة جديدة/);
    assert.equal((await state.s2.get('/desk')).status, 303, 'جلسات الطالب القديمة أُنهيت');
    await state.admin.post(`/newsroom/students/${sid}`, { _csrf: csrf, display_name: 'فهد بن علي الكندي', grade: '9', section: '2' });
    const temp = r.text.match(/كلمة المرور المؤقتة<\/dt><dd dir="ltr">([^<]+)</)[1];
    const l = await anon().login(state.cred2.username, temp);
    assert.equal(l.status, 401); assert.match(l.text, /معطّل/);
  });
});

describe('الحماية من تخمين كلمات المرور', () => {
  it('يُقفل الحساب مؤقتًا بعد 5 محاولات خاطئة', async () => {
    for (let i = 0; i < 5; i++) await anon().login(state.cred1.username, 'bad-pass-' + i);
    const r = await anon().login(state.cred1.username, 'Salem-pen-2026');
    assert.equal(r.status, 401);
    assert.match(r.text, /أُوقف الدخول إلى هذا الحساب مؤقتًا/);
  });
});

describe('الأخطاء لا تكشف تفاصيل داخلية', () => {
  it('صفحة 404 عربية بلا تفاصيل تقنية', async () => {
    const r = await anon().get('/no/such/page');
    assert.equal(r.status, 404);
    assert.match(r.text, /الصفحة غير موجودة/);
    assert.doesNotMatch(r.text, /at .*\.js:\d+/);
  });
  it('لا تظهر أي أسرار أو مسارات في الصفحات', async () => {
    const pages = await Promise.all(['/', '/cover', '/login', `/article/${state.pid}`].map((u) => anon().get(u)));
    for (const p of pages) { assert.doesNotMatch(p.text, /APP_SECRET|scrypt\$|\/tmp\//); }
  });
  it('فشل التخزين: رفع صورة يعطي خطأ مفهومًا بلا تسريب، ويُبلغ فحص الصحة بالمشكلة', { skip: TURSO && 'خاص بالتخزين على القرص' }, async () => {
    const up = path.join(DATA, 'uploads');
    const moved = up + '-moved';
    fs.renameSync(up, moved);
    fs.writeFileSync(up, 'not a directory');
    try {
      const admin = state.admin;
      const ac = await admin.csrfFrom('/newsroom/settings');
      const r = await admin.upload('/api/site-asset?slot=logo_paper', H.TINY_JPEG, 'image/jpeg', ac);
      assert.equal(r.status, 500);
      assert.match(r.json.error, /حدث خطأ في الخادم/);
      assert.doesNotMatch(r.text, /ENOTDIR|EEXIST|uploads/);
      const before = dbq("SELECT COUNT(*) n FROM media WHERE kind = 'site'")[0].n;
      assert.equal(before, 3, 'لا سجل يتيم في قاعدة البيانات');
      assert.equal((await anon().get('/healthz')).status, 503);
    } finally {
      fs.rmSync(up); fs.renameSync(moved, up);
    }
    assert.equal((await anon().get('/healthz')).status, 200);
  });
});

describe('الاستمرارية والنسخ الاحتياطي', () => {
  it('البيانات والصور تبقى بعد إعادة تشغيل الخادم', async () => {
    await H.stopServer(srv);
    srv = await H.startServer({ dataDir: DATA, port: PORT, env: { IMAGE_PROCESSOR: process.env.IMAGE_PROCESSOR || 'builtin' } });
    const r = await anon().get(`/article/${state.pid}`);
    assert.equal(r.status, 200);
    assert.equal((await anon().fetchRaw(`/media/${state.coverPid}`)).status, 200);
    assert.equal((await anon().fetchRaw(`/media/${state.inline[1]}`)).status, 200);
  });
  it('نسخة احتياطية ثم استعادة بعد حذف بيانات', { skip: TURSO && 'النسخ الاحتياطي بالأوامر للنسخة المحلية فقط' }, async () => {
    const out = cli('backup.js');
    const dir = out.match(/في: (.+)/)[1].trim();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.upload_files >= 6);
    // محاكاة كارثة: حذف المقال وصوره
    await H.stopServer(srv);
    const d = new DatabaseSync(path.join(DATA, 'app.db'));
    d.exec('PRAGMA foreign_keys = ON'); d.prepare('DELETE FROM articles WHERE public_id = ?').run(state.pid); d.close();
    fs.rmSync(path.join(DATA, 'uploads'), { recursive: true });
    cli('restore.js', ['--from', dir, '--yes']);
    srv = await H.startServer({ dataDir: DATA, port: PORT, env: { IMAGE_PROCESSOR: process.env.IMAGE_PROCESSOR || 'builtin' } });
    assert.equal((await anon().get(`/article/${state.pid}`)).status, 200);
    assert.equal((await anon().fetchRaw(`/media/${state.coverPid}`)).status, 200);
  });
});

describe('إنشاء المسؤول الأول من المتصفح', () => {
  it('الرابط السري مطلوب، ويعمل مرة واحدة فقط، ولا يعمل بعد وجود مسؤول', async () => {
    const data = H.tmpDir();
    const port = PORT + 100;
    const s = await H.startServer({ dataDir: data, port });
    try {
      for (let i = 0; i < 50 && !/setup\?key=/.test(s.output()); i++) await new Promise((r) => setTimeout(r, 50));
      const link = s.output().match(/http:\/\/localhost:\d+(\/setup\?key=[\w-]+)/)[1];
      const c = new H.Client(s.base);
      assert.equal((await c.get('/setup')).status, 404, 'بلا مفتاح');
      assert.equal((await c.get('/setup?key=wrong-key-wrong-key')).status, 404, 'مفتاح خاطئ');
      const key = link.split('key=')[1];
      assert.equal((await c.get(link)).status, 200);
      const weak = await c.post('/setup', { key, name: 'أ. حسين', username: 'hussein', password: 'short1', confirm: 'short1' });
      assert.equal(weak.status, 400);
      const ok = await c.post('/setup', { key, name: 'أ. حسين محمد سيد عبدالعال', username: 'hussein', password: 'Sahafi-2026x', confirm: 'Sahafi-2026x' });
      assert.equal(ok.location, '/newsroom/settings');
      assert.equal((await c.get('/newsroom/settings')).status, 200, 'دخل مباشرة كمسؤول');
      const again = await new H.Client(s.base).post('/setup', { key, name: 'مهاجم', username: 'evil', password: 'Evil-pass-2026', confirm: 'Evil-pass-2026' });
      assert.equal(again.location, '/login', 'الرابط لا يعمل بعد إنشاء المسؤول');
      assert.equal((await new H.Client(s.base).login('evil', 'Evil-pass-2026')).status, 401);
    } finally { await H.stopServer(s); }
  });
});
