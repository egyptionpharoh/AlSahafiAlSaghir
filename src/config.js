'use strict';
// قراءة الإعدادات من متغيرات البيئة (ومن ملف .env إن وُجد). لا توجد أي أسرار داخل الكود.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const isProd = (env.NODE_ENV || 'development') === 'production';
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

const onVercel = !!env.VERCEL;
// على Vercel لا يوجد قرص دائم؛ المجلد المؤقت /tmp هو الوحيد القابل للكتابة (لا تُحفظ فيه بيانات دائمة)
const dataDir = onVercel ? '/tmp/alsahafi' : path.resolve(ROOT, env.DATA_DIR || './data');
const tursoUrl = env.TURSO_DATABASE_URL || env.TURSO_URL || '';
const tursoToken = env.TURSO_AUTH_TOKEN || '';

const config = {
  root: ROOT,
  isProd,
  onVercel,
  tursoUrl,
  tursoToken,
  // مكان حفظ الصور: 'db' داخل قاعدة البيانات (إلزامي مع Turso/Vercel) أو 'disk' في مجلد uploads
  imageStore: (tursoUrl && tursoToken) || onVercel ? 'db' : (env.IMAGE_STORE === 'db' ? 'db' : 'disk'),
  port: Number(env.PORT || 3000),
  host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
  dataDir,
  dbFile: path.join(dataDir, 'app.db'),
  uploadsDir: path.resolve(ROOT, env.UPLOADS_DIR || path.join(dataDir, 'uploads')),
  backupsDir: path.resolve(ROOT, env.BACKUPS_DIR || './backups'),
  // إن لم يُضبط APP_SECRET على الاستضافة يُشتق سر ثابت من رمز Turso (يكفي لتجزئة عناوين IP)
  appSecret: env.APP_SECRET || (tursoToken ? require('node:crypto').createHash('sha256').update(`alsahafi:${tursoToken}`).digest('hex') : ''),
  trustProxy: bool(env.TRUST_PROXY, onVercel), // Vercel يمرر عنوان الزائر في X-Forwarded-For
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  // Vercel يرفض أي طلب أكبر من 4.5 ميغابايت، لذلك الحد هناك 4 ميغابايت (الصور تُضغط في المتصفح قبل الرفع)
  maxUploadBytes: Math.round(Math.min(Number(env.MAX_UPLOAD_MB || (onVercel ? 4 : 6)), onVercel ? 4 : 1e6) * 1024 * 1024),
  sessionIdleHours: Number(env.SESSION_IDLE_HOURS || 12),
  sessionMaxDays: Number(env.SESSION_MAX_DAYS || 7),
  fontsCdn: bool(env.FONTS_CDN, true),
};

config.problem = null;
if (isProd && (!config.appSecret || config.appSecret.length < 32)) {
  config.problem = 'يجب ضبط APP_SECRET بقيمة عشوائية طولها 32 حرفًا على الأقل (أو ربط قاعدة بيانات Turso) في بيئة الإنتاج. راجع README.';
  console.error('خطأ: ' + config.problem);
  // على Vercel لا نُنهي العملية (كان ذلك سبب FUNCTION_INVOCATION_FAILED)، بل تعرض الصفحة رسالة واضحة
  if (!onVercel) process.exit(1);
}
if (onVercel && !(tursoUrl && tursoToken)) {
  config.problem = 'قاعدة البيانات غير مربوطة: أضف قاعدة Turso من تبويب Storage في Vercel (المتغيران TURSO_DATABASE_URL و TURSO_AUTH_TOKEN) ثم أعد النشر.';
  console.error('خطأ: ' + config.problem);
}
if (!config.appSecret) {
  // في بيئة التطوير فقط: سر مؤقت يتغير مع كل تشغيل (يُستخدم لتجزئة عناوين IP فقط).
  config.appSecret = require('node:crypto').randomBytes(32).toString('hex');
}

module.exports = config;
