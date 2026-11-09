'use strict';
// تقديم الصور وفق الصلاحيات + استقبال الصور المرفوعة.
// الصور مخزّنة خارج المجلد العام، ولا يصل إليها أحد إلا عبر هذا المسار بعد فحص الصلاحية.
const db = require('../db');
const config = require('../config');
const images = require('../images');
const A = require('../articles');
const { notFound, forbidden, bad, sendJson, readBody, HttpError, redirect } = require('../http');
const S = require('../security');
const { randomId, rateLimit, audit } = S;

const isStaff = (u) => u && (u.role === 'editor' || u.role === 'admin');

async function isMediaPublic(m) {
  switch (m.kind) {
    case 'site': return Object.values(db.setting('assets')).includes(m.public_id);
    case 'issue': return !!await db.one("SELECT 1 FROM issues WHERE cover_media_id = ? AND status = 'published'", m.id);
    case 'cover': case 'inline': {
      const a = m.article_id ? await db.one('SELECT * FROM articles WHERE id = ?', m.article_id) : null;
      if (!A.isPublic(a)) return false;
      return a.cover_media_id === m.id || a.body_json.includes(`"${m.public_id}"`);
    }
    case 'profile': {
      const s = await db.one('SELECT * FROM students WHERE photo_media_id = ?', m.id);
      if (!s || !s.consent_photo_public) return false;
      if (db.setting('publishing').require_name_consent && !s.consent_name_public) return false;
      return !!await db.one(`SELECT 1 FROM articles a WHERE a.author_id = ? AND ${A.PUBLIC} LIMIT 1`, s.user_id, db.now());
    }
    default: return false;
  }
}

async function canSeePrivate(m, user) {
  if (!user) return false;
  if (isStaff(user)) return true;
  if (m.owner_id === user.id) return true;
  if (m.article_id) { const a = await db.one('SELECT author_id FROM articles WHERE id = ?', m.article_id); return a && a.author_id === user.id; }
  return false;
}

async function deleteMedia(row) {
  if (!row) return;
  await db.run('DELETE FROM media WHERE id = ?', row.id);
  await images.removeFile(row.storage_key);
}

async function receive(ctx, kind, { ownerId, articleId = null }) {
  const ct = String(ctx.req.headers['content-type'] || '');
  if (!/^(image\/|application\/octet-stream)/.test(ct)) throw bad('أرسل ملف صورة.');
  const rl = rateLimit(`upload:${ctx.user.id}`, 80, 10 * 60_000);
  if (!rl.ok) throw new HttpError(429, 'رفعت صورًا كثيرة خلال وقت قصير. انتظر قليلًا ثم حاول مجددًا.');
  const buf = await readBody(ctx.req, config.maxUploadBytes + 1024);
  const img = await images.processImage(buf, kind);
  const key = await images.storeFile(img.buf, img.ext);
  const pid = randomId(12);
  try {
    await db.run(`INSERT INTO media (public_id, owner_id, kind, article_id, mime, ext, width, height, bytes, storage_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, ownerId, kind, articleId, img.mime, img.ext, img.width, img.height, img.buf.length, key, db.now());
  } catch (e) { await images.removeFile(key); throw e; }
  return await db.one('SELECT * FROM media WHERE public_id = ?', pid);
}

module.exports = (r) => {
  r.get('/media/:pid', async (ctx) => {
    const pid = ctx.params.pid.replace(/\.(jpg|png|webp)$/, '');
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(pid)) throw notFound();
    const m = await db.one('SELECT * FROM media WHERE public_id = ?', pid);
    if (!m) throw notFound();
    const pub = await isMediaPublic(m);
    // صورة مرفوعة من «اكتب للجريدة» ولم يُرسل مقالها بعد: يراها صاحبها فقط بالرمز السري
    const claimed = !pub && m.claim_token && !m.article_id && S.safeEqual(ctx.query.t, m.claim_token);
    if (!pub && !claimed && !await canSeePrivate(m, ctx.user)) throw notFound(); // 404 لا 403: لا نكشف وجود الملف
    const res = ctx.res;
    const etag = `"${m.public_id}"`;
    if (ctx.req.headers['if-none-match'] === etag) {
      res.statusCode = 304; res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', pub ? 'public, max-age=3600' : 'private, no-store');
      return res.end();
    }
    const data = await images.readFile(m.storage_key);
    if (!data) throw notFound();
    res.setHeader('Content-Type', m.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
    // الصورة لا تتغير أبدًا لنفس المعرّف؛ الصور العامة تُخزَّن مؤقتًا ساعة في المتصفح وشبكة Vercel لتخفيف الحمل
    res.setHeader('Cache-Control', pub ? 'public, max-age=3600, s-maxage=3600' : 'private, no-store');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Length', data.length);
    res.statusCode = 200;
    if (ctx.req.method === 'HEAD') return res.end();
    res.end(data);
    return undefined;
  });

  // صور المقال: الغلاف أو صور داخل النص
  r.post('/api/media', async (ctx) => {
    if (!ctx.user) throw forbidden();
    const kind = ctx.query.kind === 'cover' ? 'cover' : 'inline';
    const a = await db.one('SELECT * FROM articles WHERE public_id = ?', String(ctx.query.article || ''));
    if (!a) throw notFound();
    if (ctx.user.role === 'student') {
      if (a.author_id !== ctx.user.id) throw notFound();
      if (!['draft', 'changes_requested'].includes(a.status)) throw new HttpError(409, 'لا يمكن تعديل المقال في حالته الحالية.');
    } else if (!isStaff(ctx.user)) throw forbidden();
    const n = (await db.one('SELECT COUNT(*) n FROM media WHERE article_id = ?', a.id)).n;
    if (n >= 40) throw bad('وصل المقال إلى الحد الأقصى من الصور (40). احذف صورًا غير مستخدمة.');
    const m = await receive(ctx, kind, { ownerId: ctx.user.id, articleId: a.id });
    await db.run('UPDATE articles SET updated_at = ? WHERE id = ?', db.now(), a.id);
    return sendJson(ctx.res, 201, { pid: m.public_id, w: m.width, h: m.height });
  });

  // الصورة الشخصية للطالب
  r.post('/api/profile-photo', async (ctx) => {
    if (!ctx.user || ctx.user.role !== 'student') throw forbidden();
    const m = await receive(ctx, 'profile', { ownerId: ctx.user.id });
    const old = await db.one('SELECT m.* FROM students s JOIN media m ON m.id = s.photo_media_id WHERE s.user_id = ?', ctx.user.id);
    await db.run('UPDATE students SET photo_media_id = ? WHERE user_id = ?', m.id, ctx.user.id);
    await deleteMedia(old);
    return sendJson(ctx.res, 201, { pid: m.public_id, w: m.width, h: m.height });
  });

  r.post('/desk/profile/photo/remove', async (ctx) => {
    if (!ctx.user || ctx.user.role !== 'student') throw forbidden();
    const old = await db.one('SELECT m.* FROM students s JOIN media m ON m.id = s.photo_media_id WHERE s.user_id = ?', ctx.user.id);
    await db.run('UPDATE students SET photo_media_id = NULL WHERE user_id = ?', ctx.user.id);
    await deleteMedia(old);
    ctx.setFlash('ok', 'أُزيلت الصورة.');
    return redirect(ctx.res, '/desk/profile');
  });

  // صور وشعارات الجريدة (مسؤول الجريدة فقط)
  const SLOTS = new Set(['logo_ministry', 'logo_school', 'logo_paper', 'photo_school', 'photo_supervisor', 'photo_principal']);
  r.post('/api/site-asset', async (ctx) => {
    if (!ctx.user || ctx.user.role !== 'admin') throw forbidden();
    const slot = String(ctx.query.slot || '');
    if (!SLOTS.has(slot)) throw bad('موضع غير معروف.');
    const m = await receive(ctx, 'site', { ownerId: ctx.user.id });
    const assets = { ...db.setting('assets') };
    const oldPid = assets[slot];
    assets[slot] = m.public_id;
    await db.setSetting('assets', assets, ctx.user.id);
    if (oldPid && !Object.values(assets).includes(oldPid)) await deleteMedia(await db.one('SELECT * FROM media WHERE public_id = ?', oldPid));
    await audit(ctx.user.id, 'asset.upload', 'setting', slot, null, ctx.ip);
    return sendJson(ctx.res, 201, { pid: m.public_id, w: m.width, h: m.height });
  });

  r.post('/newsroom/settings/asset-remove', async (ctx) => {
    if (!ctx.user || ctx.user.role !== 'admin') throw forbidden();
    const slot = String(ctx.body.slot || '');
    if (!SLOTS.has(slot)) throw bad('موضع غير معروف.');
    const assets = { ...db.setting('assets') };
    const oldPid = assets[slot];
    assets[slot] = null;
    await db.setSetting('assets', assets, ctx.user.id);
    if (oldPid && !Object.values(assets).includes(oldPid)) await deleteMedia(await db.one('SELECT * FROM media WHERE public_id = ?', oldPid));
    await audit(ctx.user.id, 'asset.remove', 'setting', slot, null, ctx.ip);
    ctx.setFlash('ok', 'أُزيلت الصورة.');
    return redirect(ctx.res, '/newsroom/settings#assets');
  });

  r.post('/api/issue-cover', async (ctx) => {
    if (!isStaff(ctx.user)) throw forbidden();
    const issue = await db.one('SELECT * FROM issues WHERE id = ?', Number(ctx.query.issue) || 0);
    if (!issue) throw notFound();
    const m = await receive(ctx, 'issue', { ownerId: ctx.user.id });
    await db.run('UPDATE issues SET cover_media_id = ?, updated_at = ? WHERE id = ?', m.id, db.now(), issue.id);
    if (issue.cover_media_id) await deleteMedia(await db.one('SELECT * FROM media WHERE id = ?', issue.cover_media_id));
    return sendJson(ctx.res, 201, { pid: m.public_id, w: m.width, h: m.height });
  });
};

module.exports.deleteMedia = deleteMedia;
module.exports.isMediaPublic = isMediaPublic;
