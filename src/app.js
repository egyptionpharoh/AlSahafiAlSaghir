'use strict';
// قلب التطبيق: ترويسات الأمان، الملفات الثابتة، الجلسات، حماية CSRF، التوجيه، ومعالجة الأخطاء.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const db = require('./db');
const S = require('./security');
const { html, Router, HttpError, parseCookies, parseForm, parseJson, cookie, addCookie, send, sendJson, redirect } = require('./http');
const { plainPage } = require('./views/layout');

const router = new Router();
require('./routes/public')(router);
require('./routes/media')(router);
require('./routes/auth')(router);
require('./routes/setup')(router);
require('./routes/desk')(router);
require('./routes/newsroom')(router);

const PUBLIC_DIR = path.join(config.root, 'public');
const STATIC_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

function securityHeaders(res) {
  const fontsCss = config.fontsCdn ? ' https://fonts.googleapis.com' : '';
  const fontsSrc = config.fontsCdn ? ' https://fonts.gstatic.com' : '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", `style-src 'self'${fontsCss}`, `font-src 'self'${fontsSrc}`,
    "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function serveStatic(req, res, pathname) {
  const rel = pathname.slice('/static/'.length);
  if (rel.includes('..') || rel.includes('\0')) return false;
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  const type = STATIC_TYPES[path.extname(file)];
  if (!type) return false;
  let stat; try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', config.isProd ? 'public, max-age=604800' : 'no-cache');
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') { res.end(); return true; }
  fs.createReadStream(file).pipe(res);
  return true;
}

function clientIp(req) {
  if (config.trustProxy) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || '';
}

function errorPage(ctx, status, message) {
  const titles = { 400: 'تعذر تنفيذ الطلب', 401: 'يلزم تسجيل الدخول', 403: 'غير مسموح', 404: 'الصفحة غير موجودة', 405: 'طريقة غير مسموحة', 409: 'تعذر تنفيذ الإجراء', 413: 'الملف كبير جدًا', 429: 'طلبات كثيرة', 500: 'حدث خطأ غير متوقع', 503: 'الخدمة غير متاحة' };
  return plainPage(ctx, { title: titles[status] || 'خطأ', body: html`
    <h1 class="plain__title">${titles[status] || 'خطأ'}</h1>
    <p>${message}</p>
    <p class="row"><a class="btn" href="/">الصفحة الرئيسية للجريدة</a>${ctx.user ? html` <a class="btn btn--ghost" href="${ctx.user.role === 'student' ? '/desk' : '/newsroom'}">${ctx.user.role === 'student' ? 'مكتبي' : 'غرفة التحرير'}</a>` : ''}</p>` });
}

const UNSAFE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const FLASH = 'ss_flash';

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/static/')) {
    if (serveStatic(req, res, pathname)) return;
  }

  const cookies = parseCookies(req.headers.cookie);
  const ip = clientIp(req);
  req.ip = ip;
  const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), cookies, ip, params: {}, body: {}, user: null, session: null, csrf: '', flash: null };
  ctx.setFlash = (type, msg) => addCookie(res, cookie(FLASH, Buffer.from(JSON.stringify({ type, msg })).toString('base64url'), { maxAge: 60, secure: config.cookieSecure }));

  try {
    // رسالة الإشعار المؤقتة (تُقرأ مرة ثم تُحذف)
    if (cookies[FLASH]) {
      try { const f = JSON.parse(Buffer.from(cookies[FLASH], 'base64url').toString('utf8')); if (f && typeof f.msg === 'string') ctx.flash = { type: String(f.type), msg: f.msg.slice(0, 500) }; } catch {}
      addCookie(res, cookie(FLASH, '', { maxAge: 0, secure: config.cookieSecure }));
    }

    // الجلسة
    const session = S.loadSession(cookies[S.COOKIE]);
    if (session) {
      ctx.session = session;
      ctx.user = { id: session.user_id, username: session.username, role: session.role, display_name: session.display_name, must_change_password: session.must_change_password };
      ctx.csrf = session.csrf_token;
    }

    // تحديد معدل الطلبات العام
    // (يُحسب لكل مستخدم مسجل على حدة، لأن طلبة الفصل الواحد يخرجون غالبًا من عنوان IP واحد للمدرسة)
    const who = ctx.user ? `u${ctx.user.id}` : ip;
    if (UNSAFE.has(req.method)) {
      const rl = S.rateLimit(`w:${who}`, ctx.user ? 240 : 120, 60_000);
      if (!rl.ok) throw new HttpError(429, 'طلبات كثيرة في وقت قصير. انتظر دقيقة ثم حاول مجددًا.');
    } else {
      const rl = S.rateLimit(`r:${who}`, ctx.user ? 1500 : 4000, 60_000);
      if (!rl.ok) throw new HttpError(429, 'طلبات كثيرة في وقت قصير.');
    }

    const m = router.match(req.method, pathname);
    if (!m) throw new HttpError(404, 'لم نجد الصفحة التي تبحث عنها. ربما نُقلت أو أُلغي نشرها.');
    if (m.methodNotAllowed) throw new HttpError(405, 'طريقة الطلب غير مسموحة لهذا العنوان.');
    ctx.params = m.params;

    // إجبار تغيير كلمة المرور المؤقتة قبل استخدام مساحات العمل
    if (ctx.user && ctx.user.must_change_password && /^\/(desk|newsroom|api)(\/|$)/.test(pathname)) {
      if (pathname.startsWith('/api/')) throw new HttpError(403, 'غيّر كلمة المرور المؤقتة أولًا.');
      return redirect(res, '/account/password');
    }

    if (UNSAFE.has(req.method)) {
      // 1) التحقق من المصدر (Origin) عند وجوده
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        const host = req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host;
        let ok = false; try { ok = new URL(origin).host === host; } catch {}
        if (!ok) throw new HttpError(403, 'طلب من مصدر غير موثوق.');
      }
      // 2) قراءة الجسم
      const ct = String(req.headers['content-type'] || '');
      if (ct.startsWith('application/x-www-form-urlencoded')) ctx.body = await parseForm(req);
      else if (ct.startsWith('application/json')) ctx.body = await parseJson(req);
      // 3) رمز CSRF (نموذج الدخول له آلية مستقلة)
      if (pathname === '/logout' && !ctx.session) return redirect(res, '/');
      if (pathname !== '/login' && pathname !== '/setup') { // لهما حماية مستقلة (رمز ما قبل الجلسة / الرابط السري)
        if (!ctx.session) { const e = new HttpError(401, 'انتهت جلستك. سجّل الدخول من جديد.'); e.login = true; throw e; }
        const token = (ctx.body && ctx.body._csrf) || req.headers['x-csrf-token'];
        if (!S.safeEqual(token, ctx.csrf)) throw new HttpError(403, 'انتهت صلاحية الصفحة. حدّثها ثم حاول مرة أخرى.');
      }
    }

    for (const h of m.route.handlers) {
      const out = await h(ctx);
      if (ctx.streaming || res.writableEnded || res.headersSent) return;
      if (out !== undefined && out !== null) {
        send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out);
        return;
      }
    }
    if (!res.writableEnded && !res.headersSent) throw new HttpError(404, 'الصفحة غير موجودة.');
  } catch (err) {
    if (res.headersSent) { res.destroy(); return; }
    const status = err.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${req.method} ${pathname}:`, err && err.stack ? err.stack : err);
    const message = status >= 500 ? 'نعتذر، حدث خطأ في الخادم. أعد المحاولة بعد قليل.' : (err.userMessage || err.message || 'خطأ.');
    if (pathname.startsWith('/api/') || String(req.headers.accept || '').includes('application/json')) {
      sendJson(res, status, { error: message, problems: err.problems });
      return;
    }
    if (err.login && req.method === 'GET') return redirect(res, `/login?next=${encodeURIComponent(pathname + url.search)}`);
    if (status === 429 && err.status) res.setHeader('Retry-After', '60');
    send(res, status, errorPage(ctx, status, message));
  }
}

function start({ port = config.port, host = config.host } = {}) {
  db.open();
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  S.purgeExpiredSessions();
  setInterval(() => S.purgeExpiredSessions(), 6 * 36e5).unref();
  const server = require('node:http').createServer((req, res) => { handle(req, res); });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return new Promise((resolve) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`\n  الجريدة تعمل بالفعل في نافذة أخرى (المنفذ ${port} مشغول).`);
        console.error(`  افتح المتصفح على: http://localhost:${port}  — أو أغلق النافذة الأخرى ثم أعد التشغيل.\n`);
        process.exit(1);
      }
      throw e;
    });
    server.listen(port, host, () => resolve(server));
  });
}

module.exports = { start, handle };
