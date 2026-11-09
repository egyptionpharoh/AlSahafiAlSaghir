'use strict';
// إنشاء حساب «مسؤول الجريدة» الأول من المتصفح — بدل سطر الأوامر.
// يعمل فقط ما دام لا يوجد أي مسؤول، ويتطلب رابطًا سريًا لمرة واحدة يُطبع في نافذة التشغيل
// (ويُفتح تلقائيًا في المتصفح على جهاز المدرسة). بعد إنشاء المسؤول يتعطل هذا المسار نهائيًا.
const db = require('../db');
const config = require('../config');
const S = require('../security');
const { html, redirect, cookie, addCookie, notFound, bad } = require('../http');
const { plainPage } = require('../views/layout');

let token = null;
const hasAdmin = () => !!db.one("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1");

/** يعيد رابط الإعداد إن لم يوجد مسؤول بعد، وإلا null */
function setupUrl(base) {
  if (hasAdmin()) { token = null; return null; }
  if (!token) token = S.randomId(24);
  return `${base}/setup?key=${token}`;
}

function form(ctx, { key, name = '', username = '' }) {
  return plainPage(ctx, { title: 'إنشاء حساب مسؤول الجريدة', body: html`
    <h1 class="plain__title">مرحبًا بك في «الصحفي الصغير»</h1>
    <p>أنشئ حساب <b>مسؤول الجريدة</b>. هذه الصفحة تظهر مرة واحدة فقط، ثم تُغلق تلقائيًا.</p>
    <form method="post" action="/setup" class="stack">
      <input type="hidden" name="key" value="${key}">
      <label class="field">الاسم كما يظهر في غرفة التحرير<input name="name" required maxlength="80" value="${name}" placeholder="أ. حسين محمد سيد عبدالعال"></label>
      <label class="field">اسم المستخدم للدخول <span class="opt">حروف إنجليزية صغيرة وأرقام، بلا مسافات</span><input name="username" required maxlength="40" dir="ltr" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9._-]{3,40}" value="${username}" placeholder="hussein"></label>
      <label class="field">كلمة المرور <span class="opt">10 أحرف على الأقل، فيها حروف وأرقام</span><input name="password" type="password" required minlength="10" autocomplete="new-password" dir="ltr"></label>
      <label class="field">أعد كتابة كلمة المرور<input name="confirm" type="password" required minlength="10" autocomplete="new-password" dir="ltr"></label>
      <button class="btn btn--primary btn--block">إنشاء الحساب والدخول</button>
    </form>` });
}

module.exports = (r) => {
  r.get('/setup', (ctx) => {
    if (hasAdmin()) return redirect(ctx.res, '/login');
    if (!token || !S.safeEqual(ctx.query.key, token)) throw notFound();
    return form(ctx, { key: token });
  });

  r.post('/setup', (ctx) => {
    if (hasAdmin()) return redirect(ctx.res, '/login');
    const b = ctx.body;
    if (!token || !S.safeEqual(b.key, token)) throw notFound();
    const name = String(b.name || '').trim().slice(0, 80);
    const username = String(b.username || '').trim().toLowerCase().slice(0, 40);
    const again = (msg) => { ctx.flash = { type: 'error', msg }; ctx.res.statusCode = 400; return form(ctx, { key: token, name, username }); };
    if (name.length < 3) return again('اكتب الاسم (3 أحرف على الأقل).');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) return again('اسم المستخدم: حروف إنجليزية وأرقام فقط، بلا مسافات.');
    if (b.password !== b.confirm) return again('كلمتا المرور غير متطابقتين.');
    const p = S.passwordProblem(b.password, { role: 'admin' });
    if (p) return again(p);
    if (db.one('SELECT 1 FROM users WHERE username = ?', username)) throw bad('اسم المستخدم مستخدم.');
    const t = db.now();
    const res = db.run('INSERT INTO users (username, password_hash, role, display_name, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      username, S.hashPassword(b.password), 'admin', name, t, t);
    const id = Number(res.lastInsertRowid);
    token = null; // الرابط لا يعمل مرة أخرى
    S.audit(id, 'admin.create.setup', 'user', id, { username }, ctx.ip);
    const { token: sid, expires } = S.createSession(id, ctx.req);
    addCookie(ctx.res, cookie(S.COOKIE, sid, { maxAge: (expires - Date.now()) / 1000, secure: config.cookieSecure, sameSite: 'Lax' }));
    ctx.setFlash('ok', `أُنشئ حسابك. اسم المستخدم للدخول لاحقًا: ${username}. ابدأ بمراجعة إعدادات الجريدة ورفع الصور.`);
    return redirect(ctx.res, '/newsroom/settings');
  });
};

module.exports.setupUrl = setupUrl;
