'use strict';
// كلمات المرور، الجلسات، رموز CSRF، وتحديد معدل الطلبات.
const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');

// ===== كلمات المرور (scrypt) =====
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password).normalize('NFKC'), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

// قيمة وهمية لمساواة زمن الاستجابة عند عدم وجود المستخدم (منع كشف أسماء المستخدمين)
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function passwordProblem(pw, { role } = {}) {
  const min = role === 'student' ? 8 : 10;
  if (typeof pw !== 'string' || pw.length < min) return `كلمة المرور يجب ألا تقل عن ${min} أحرف.`;
  if (pw.length > 200) return 'كلمة المرور طويلة جدًا.';
  if (!/[0-9]/.test(pw) || !/[^0-9]/.test(pw)) return 'استخدم أحرفًا وأرقامًا معًا في كلمة المرور.';
  return null;
}

// كلمة مرور مؤقتة سهلة القراءة للطلبة (تُغيَّر إلزاميًا عند أول دخول)
function tempPassword() {
  const c = 'bdfghjklmnprstvz', v = 'aeiou';
  const pick = (s) => s[crypto.randomInt(s.length)];
  const word = pick(c).toUpperCase() + pick(v) + pick(c) + pick(v) + pick(c);
  return `${word}-${crypto.randomInt(1000, 9999)}`;
}

// ===== أدوات عامة =====
const randomId = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ipHash = (ip) => crypto.createHmac('sha256', config.appSecret).update(String(ip || '')).digest('hex').slice(0, 24);

function safeEqual(a, b) {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

// ===== الجلسات =====
const COOKIE = config.cookieSecure ? '__Host-ss_sid' : 'ss_sid';

async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = new Date();
  const expires = new Date(t.getTime() + config.sessionMaxDays * 864e5);
  await db.run(`INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip_hash, user_agent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  sha256(token), userId, randomId(24), t.toISOString(), t.toISOString(), expires.toISOString(),
  ipHash(req.ip), String(req.headers['user-agent'] || '').slice(0, 200));
  return { token, expires };
}

async function loadSession(token) {
  if (!token || token.length > 100) return null;
  const s = await db.one(`SELECT s.*, u.username, u.role, u.display_name, u.is_active, u.must_change_password
                    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha256(token));
  if (!s) return null;
  const nowMs = Date.now();
  const idleLimit = config.sessionIdleHours * 36e5;
  if (!s.is_active || Date.parse(s.expires_at) < nowMs || nowMs - Date.parse(s.last_seen_at) > idleLimit) {
    await db.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    return null;
  }
  if (nowMs - Date.parse(s.last_seen_at) > 60_000) {
    await db.run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', new Date().toISOString(), s.token_hash);
  }
  return s;
}

async function destroySession(token) { if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)); }
async function destroyUserSessions(userId, exceptHash) {
  if (exceptHash) await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', userId, exceptHash);
  else await db.run('DELETE FROM sessions WHERE user_id = ?', userId);
}
async function purgeExpiredSessions() { await db.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString()); }

// ===== تحديد معدل الطلبات (في الذاكرة) =====
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  let b = buckets.get(key);
  if (!b || t > b.reset) { b = { count: 0, reset: t + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.reset - t) / 1000) };
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (t > b.reset) buckets.delete(k); }, 60_000).unref();

// ===== قفل الحساب بعد محاولات فاشلة =====
const MAX_FAILS = 5, LOCK_MINUTES = 15;
async function registerFailedLogin(user) {
  const fails = user.failed_logins + 1;
  const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
  await db.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
  return lock;
}

async function audit(actorId, action, targetType, targetId, details, ip) {
  await db.run('INSERT INTO audit_log (actor_id, action, target_type, target_id, details, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    actorId || null, action, targetType || null, targetId == null ? null : String(targetId),
    details ? JSON.stringify(details) : null, ip ? ipHash(ip) : null, db.now());
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, passwordProblem, tempPassword,
  randomId, sha256, ipHash, safeEqual,
  COOKIE, createSession, loadSession, destroySession, destroyUserSessions, purgeExpiredSessions,
  rateLimit, registerFailedLogin, audit,
};
