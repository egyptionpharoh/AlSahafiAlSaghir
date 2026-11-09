'use strict';
const db = require('../db');
const config = require('../config');
const S = require('../security');
const V = require('../views/desk');
const { redirect, cookie, addCookie, HttpError } = require('../http');

const PRE = 'ss_pre';
const homeFor = (role) => (role === 'student' ? '/desk' : '/newsroom');
const safeNext = (n) => (typeof n === 'string' && /^\/(desk|newsroom)(\/[\w\-/?=&%.]*)?$/.test(n) ? n : '');

function preToken(ctx) {
  // رمز CSRF لنموذج الدخول قبل وجود جلسة (double-submit cookie)
  let t = ctx.cookies[PRE];
  if (!t || !/^[A-Za-z0-9_-]{20,}$/.test(t)) {
    t = S.randomId(24);
    addCookie(ctx.res, cookie(PRE, t, { maxAge: 3600, secure: config.cookieSecure, sameSite: 'Strict' }));
  }
  return t;
}

module.exports = (r) => {
  r.get('/login', async (ctx) => {
    if (ctx.user) return redirect(ctx.res, homeFor(ctx.user.role));
    return V.loginPage(ctx, { preToken: preToken(ctx), next: safeNext(ctx.query.next) });
  });

  r.post('/login', async (ctx) => {
    const b = ctx.body;
    if (!S.safeEqual(b._pre, ctx.cookies[PRE])) {
      ctx.setFlash('error', 'انتهت صلاحية الصفحة. حاول مرة أخرى.');
      return redirect(ctx.res, '/login');
    }
    const username = String(b.username || '').trim().slice(0, 60);
    const password = String(b.password || '');
    // حد مرتفع لكل عنوان IP (فصل كامل قد يدخل من شبكة المدرسة نفسها)، والحماية الأساسية هي قفل الحساب بعد 5 محاولات خاطئة
    const rl = S.rateLimit(`login:${ctx.ip}`, 150, 15 * 60_000);
    if (!rl.ok) {
      await S.audit(null, 'login.ratelimited', 'ip', null, { username }, ctx.ip);
      throw new HttpError(429, `محاولات دخول كثيرة. حاول بعد ${Math.ceil(rl.retryAfter / 60)} دقيقة.`);
    }
    const fail = (msg = 'اسم المستخدم أو كلمة المرور غير صحيحة.') => {
      ctx.flash = { type: 'error', msg };
      ctx.res.statusCode = 401;
      return V.loginPage(ctx, { preToken: preToken(ctx), username, next: safeNext(b.next) });
    };
    const u = await db.one('SELECT * FROM users WHERE username = ?', username);
    if (!u) { S.verifyPassword(password, S.DUMMY_HASH); return fail(); }
    if (u.locked_until && Date.parse(u.locked_until) > Date.now()) {
      S.verifyPassword(password, S.DUMMY_HASH);
      return fail('أُوقف الدخول إلى هذا الحساب مؤقتًا بعد محاولات خاطئة متكررة. حاول بعد 15 دقيقة أو اطلب من المشرف إعادة تعيين كلمة المرور.');
    }
    if (!S.verifyPassword(password, u.password_hash)) {
      const locked = await S.registerFailedLogin(u);
      await S.audit(u.id, locked ? 'login.locked' : 'login.failed', 'user', u.id, null, ctx.ip);
      return fail();
    }
    if (!u.is_active) return fail('هذا الحساب معطّل. تواصل مع مشرف الجريدة.');
    await db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', db.now(), u.id);
    const { token, expires } = await S.createSession(u.id, ctx.req);
    addCookie(ctx.res, cookie(S.COOKIE, token, { maxAge: (expires - Date.now()) / 1000, secure: config.cookieSecure, sameSite: 'Lax' }));
    addCookie(ctx.res, cookie(PRE, '', { maxAge: 0, secure: config.cookieSecure, sameSite: 'Strict' }));
    await S.audit(u.id, 'login', 'user', u.id, null, ctx.ip);
    if (u.must_change_password) return redirect(ctx.res, '/account/password');
    return redirect(ctx.res, safeNext(b.next) || homeFor(u.role));
  });

  r.post('/logout', async (ctx) => {
    await S.destroySession(ctx.cookies[S.COOKIE]);
    addCookie(ctx.res, cookie(S.COOKIE, '', { maxAge: 0, secure: config.cookieSecure }));
    return redirect(ctx.res, '/');
  });

  r.get('/account/password', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    return V.passwordPage(ctx, { forced: !!ctx.user.must_change_password });
  });

  r.post('/account/password', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const { current, password, confirm } = ctx.body;
    const u = await db.one('SELECT * FROM users WHERE id = ?', ctx.user.id);
    const again = (msg) => { ctx.flash = { type: 'error', msg }; ctx.res.statusCode = 400; return V.passwordPage(ctx, { forced: !!u.must_change_password }); };
    const rl = S.rateLimit(`pwchange:${u.id}`, 10, 15 * 60_000);
    if (!rl.ok) throw new HttpError(429, 'محاولات كثيرة. حاول لاحقًا.');
    if (!S.verifyPassword(current || '', u.password_hash)) return again('كلمة المرور الحالية غير صحيحة.');
    if (password !== confirm) return again('كلمتا المرور الجديدتان غير متطابقتين.');
    const p = S.passwordProblem(password, { role: u.role });
    if (p) return again(p);
    if (S.verifyPassword(password, u.password_hash)) return again('اختر كلمة مرور مختلفة عن الحالية.');
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?', S.hashPassword(password), db.now(), u.id);
    await S.destroyUserSessions(u.id, ctx.session.token_hash); // إنهاء الجلسات الأخرى
    await S.audit(u.id, 'password.change', 'user', u.id, null, ctx.ip);
    ctx.setFlash('ok', 'حُفظت كلمة المرور الجديدة.');
    return redirect(ctx.res, homeFor(u.role));
  });
};

module.exports.homeFor = homeFor;
