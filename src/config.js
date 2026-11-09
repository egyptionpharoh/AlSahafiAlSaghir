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

const dataDir = path.resolve(ROOT, env.DATA_DIR || './data');

const config = {
  root: ROOT,
  isProd,
  port: Number(env.PORT || 3000),
  host: env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1'),
  baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
  dataDir,
  dbFile: path.join(dataDir, 'app.db'),
  uploadsDir: path.resolve(ROOT, env.UPLOADS_DIR || path.join(dataDir, 'uploads')),
  backupsDir: path.resolve(ROOT, env.BACKUPS_DIR || './backups'),
  appSecret: env.APP_SECRET || '',
  trustProxy: bool(env.TRUST_PROXY, false),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  maxUploadBytes: Math.round(Number(env.MAX_UPLOAD_MB || 6) * 1024 * 1024),
  sessionIdleHours: Number(env.SESSION_IDLE_HOURS || 12),
  sessionMaxDays: Number(env.SESSION_MAX_DAYS || 7),
  fontsCdn: bool(env.FONTS_CDN, true),
};

if (isProd && (!config.appSecret || config.appSecret.length < 32)) {
  console.error('خطأ: يجب ضبط APP_SECRET بقيمة عشوائية طولها 32 حرفًا على الأقل في بيئة الإنتاج. راجع README.');
  process.exit(1);
}
if (!config.appSecret) {
  // في بيئة التطوير فقط: سر مؤقت يتغير مع كل تشغيل (يُستخدم لتجزئة عناوين IP فقط).
  config.appSecret = require('node:crypto').randomBytes(32).toString('hex');
}

module.exports = config;
