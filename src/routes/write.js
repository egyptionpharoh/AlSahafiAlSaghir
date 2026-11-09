'use strict';
// «اكتب للجريدة»: يكتب الطالب مقاله ويرفق صوره ويرسله مباشرة — بلا حساب ولا كلمة مرور.
// يصل المقال إلى غرفة التحرير بحالة «مرسل للمراجعة»، ولا يُنشر إلا بعد اعتماد المعلم.
// الحماية بقدر ما يناسب جريدة مدرسية: رمز للنموذج (بدل CSRF)، حقل فخ للبرامج الآلية، حد أدنى لزمن الكتابة،
// حدود لعدد الإرسالات والصور وحجمها، وفحص الصور الحقيقي في الخادم.
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const S = require('../security');
const A = require('../articles');
const images = require('../images');
const V = require('../views/write');
const { slugify } = require('../content');
const { HttpError, bad, notFound, sendJson, readBody, redirect, cookie, addCookie } = require('../http');

const WCOOKIE = 'ss_w';
const MAX_IMAGES = 6;
const MIN_WORDS = 40;
const MIN_SECONDS = Number(process.env.WRITE_MIN_SECONDS ?? 8); // أقل زمن معقول بين فتح الصفحة والإرسال (يصد الإرسال الآلي)

const sign = (v) => crypto.createHmac('sha256', config.appSecret).update(`write:${v}`).digest('base64url').slice(0, 22);

/** رمز النموذج: يُحفظ في كوكي ويُرسل مع النموذج، فلا يقبل الخادم إرسالًا من موقع آخر */
function formToken(ctx) {
  let t = ctx.cookies[WCOOKIE];
  if (!t || !/^[A-Za-z0-9_-]{20,40}$/.test(t)) {
    t = S.randomId(18);
    addCookie(ctx.res, cookie(WCOOKIE, t, { maxAge: 6 * 3600, secure: config.cookieSecure, sameSite: 'Strict' }));
  }
  return t;
}
const checkToken = (ctx, given) => S.safeEqual(given, ctx.cookies[WCOOKIE]);

function stampNow() { const t = String(Date.now()); return `${t}.${sign(t)}`; }
function stampAge(v) {
  const [t, sig] = String(v || '').split('.');
  if (!t || !S.safeEqual(sig, sign(t))) return -1;
  return (Date.now() - Number(t)) / 1000;
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const wordsOf = (s) => String(s || '').split(/\s+/).filter(Boolean).length;

async function categories() { return db.all('SELECT id, name FROM categories WHERE is_visible = 1 ORDER BY sort_order, id'); }

/** صور النموذج: "pid:token" مفصولة بفواصل، بترتيب الطالب */
function parseImages(b) {
  const list = String(b.images || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, MAX_IMAGES);
  const out = [];
  for (const item of list) {
    const [pid, token] = item.split(':');
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(pid || '') || !/^[A-Za-z0-9_-]{16,40}$/.test(token || '')) continue;
    out.push({ pid, token, cap: clean(b[`cap_${pid}`], 300) });
  }
  return out;
}

/** حذف الصور التي رُفعت ولم يُرسل مقالها خلال يوم */
async function pruneUnclaimed() {
  const old = new Date(Date.now() - 864e5).toISOString();
  const rows = await db.all('SELECT id, storage_key FROM media WHERE claim_token IS NOT NULL AND article_id IS NULL AND created_at < ? LIMIT 50', old);
  for (const r of rows) { await db.run('DELETE FROM media WHERE id = ?', r.id); await images.removeFile(r.storage_key); }
}

module.exports = (r) => {
  r.get('/write', async (ctx) => {
    return V.writePage(ctx, { token: formToken(ctx), stamp: stampNow(), cats: await categories(), values: {}, errors: [], minWords: MIN_WORDS, maxImages: MAX_IMAGES });
  });

  // رفع صورة واحدة قبل الإرسال (يُرجع رمزًا سريًا يربطها بالمقال عند الإرسال)
  r.post('/api/write/media', async (ctx) => {
    if (!checkToken(ctx, ctx.req.headers['x-write-token'])) throw new HttpError(403, 'انتهت صلاحية الصفحة. حدّثها ثم حاول مرة أخرى.');
    const ct = String(ctx.req.headers['content-type'] || '');
    if (!/^(image\/|application\/octet-stream)/.test(ct)) throw bad('أرسل ملف صورة.');
    const rl = S.rateLimit(`wupload:${ctx.ip}`, 120, 10 * 60_000); // شبكة المدرسة قد تجمع فصلًا كاملًا خلف عنوان واحد
    if (!rl.ok) throw new HttpError(429, 'رُفعت صور كثيرة في وقت قصير. انتظر قليلًا ثم حاول مجددًا.');
    const buf = await readBody(ctx.req, config.maxUploadBytes + 1024);
    const img = await images.processImage(buf, 'inline');
    const key = await images.storeFile(img.buf, img.ext);
    const pid = S.randomId(12);
    const claim = S.randomId(18);
    try {
      await db.run(`INSERT INTO media (public_id, owner_id, kind, article_id, mime, ext, width, height, bytes, storage_key, created_at, claim_token)
              VALUES (?, NULL, 'inline', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`, pid, img.mime, img.ext, img.width, img.height, img.buf.length, key, db.now(), claim);
    } catch (e) { await images.removeFile(key); throw e; }
    return sendJson(ctx.res, 201, { pid, token: claim, w: img.width, h: img.height });
  });

  r.post('/write', async (ctx) => {
    const b = ctx.body;
    if (!checkToken(ctx, b._w)) {
      ctx.setFlash('error', 'انتهت صلاحية الصفحة. لم يُرسل المقال؛ انسخ نصك احتياطًا ثم حدّث الصفحة وأعد الإرسال.');
      return redirect(ctx.res, '/write');
    }
    const values = {
      name: clean(b.name, 80), grade: Number(b.grade) || 0, section: clean(b.section, 10),
      categoryId: Number(b.category_id) || 0, title: clean(b.title, 140),
      body: String(b.body ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim().slice(0, 20000),
      images: parseImages(b),
    };
    const cats = await categories();
    const again = (errors) => {
      ctx.res.statusCode = 400;
      return V.writePage(ctx, { token: formToken(ctx), stamp: b.stamp && stampAge(b.stamp) >= 0 ? b.stamp : stampNow(), cats, values, errors, minWords: MIN_WORDS, maxImages: MAX_IMAGES });
    };

    // برامج الإرسال الآلي: الحقل المخفي ممتلئ أو الإرسال أسرع من أي كتابة حقيقية
    const age = stampAge(b.stamp);
    if (b.website || age < 0) return again(['حدث خطأ في الصفحة. حدّثها ثم أعد الإرسال.']);
    if (age < MIN_SECONDS) return again(['تمهّل قليلًا وراجع مقالك قبل الإرسال 🙂']);

    const errors = [];
    if (values.name.length < 3) errors.push('اكتب اسمك (3 أحرف على الأقل).');
    if (values.grade < 5 || values.grade > 12) errors.push('اختر صفك.');
    if (!cats.some((c) => c.id === values.categoryId)) errors.push('اختر نوع المقال.');
    if (values.title.length < 4) errors.push('اكتب عنوانًا للمقال (4 أحرف على الأقل).');
    const words = wordsOf(values.body);
    if (words < MIN_WORDS) errors.push(`المقال قصير (${words} كلمة). اكتب ${MIN_WORDS} كلمة على الأقل.`);
    if (errors.length) return again(errors);

    const rl = S.rateLimit(`write:${ctx.ip}`, 40, 60 * 60_000);
    if (!rl.ok) return again(['أُرسلت مقالات كثيرة من هذا الجهاز خلال ساعة. انتظر قليلًا ثم أعد المحاولة.']);

    // الصور المرفوعة فعلًا لهذه الصفحة (رمز سري لكل صورة)
    const media = [];
    for (const im of values.images) {
      const m = await db.one('SELECT id, public_id FROM media WHERE public_id = ? AND claim_token = ? AND article_id IS NULL', im.pid, im.token);
      if (m) media.push({ ...m, cap: im.cap });
    }

    const paragraphs = values.body.split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const blocks = paragraphs.map((text) => ({ t: 'p', text }));
    const [cover, ...inline] = media;
    for (const m of inline) blocks.push({ t: 'img', m: m.public_id, cap: m.cap });

    const t = db.now();
    const pid = S.randomId(8);
    const guestKey = S.randomId(18);
    await db.tx(async () => {
      const u = await db.run(`INSERT INTO users (username, password_hash, role, display_name, is_active, must_change_password, is_guest, created_at, updated_at)
                              VALUES (?, ?, 'student', ?, 0, 0, 1, ?, ?)`,
      `guest-${S.randomId(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}${crypto.randomInt(100, 999)}`, S.hashPassword(S.randomId(24)), values.name, t, t);
      const uid = Number(u.lastInsertRowid);
      await db.run('INSERT INTO students (user_id, grade, section) VALUES (?, ?, ?)', uid, values.grade, values.section || null);
      const a = await db.run(`INSERT INTO articles (public_id, author_id, category_id, title, body_json, cover_caption, status, created_at, updated_at, submitted_at, guest_key, slug)
                              VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`,
      pid, uid, values.categoryId, values.title, JSON.stringify(blocks), cover ? cover.cap : '', t, t, t, guestKey, slugify(values.title));
      const aid = Number(a.lastInsertRowid);
      for (const m of media) {
        await db.run('UPDATE media SET article_id = ?, owner_id = ?, kind = ?, claim_token = NULL WHERE id = ?', aid, uid, m === cover ? 'cover' : 'inline', m.id);
      }
      if (cover) await db.run('UPDATE articles SET cover_media_id = ? WHERE id = ?', cover.id, aid);
      await A.logEvent(aid, uid, 'create', null, 'draft', 'كُتب من صفحة «اكتب للجريدة»');
      await A.snapshot(aid, 'submit', uid);
      await A.logEvent(aid, uid, 'submit', 'draft', 'submitted');
    });
    await S.audit(null, 'article.guest_submit', 'article', pid, { title: values.title, grade: values.grade }, ctx.ip);
    pruneUnclaimed().catch(() => {});
    return redirect(ctx.res, `/write/done/${pid}?k=${guestKey}`);
  });

  // بعد الإرسال مباشرة: شكر + رابط المتابعة
  r.get('/write/done/:pid', async (ctx) => {
    const a = await db.one('SELECT public_id, title, guest_key, status FROM articles WHERE public_id = ?', ctx.params.pid);
    if (!a || !a.guest_key || !S.safeEqual(ctx.query.k, a.guest_key)) throw notFound();
    return V.donePage(ctx, a);
  });

  // متابعة حالة المقال بالرابط السري
  r.get('/write/status/:pid', async (ctx) => {
    const a = await A.getByPid(ctx.params.pid);
    if (!a || !a.guest_key || !S.safeEqual(ctx.query.k, a.guest_key)) throw notFound();
    const notes = ['changes_requested', 'rejected'].includes(a.status)
      ? await db.all('SELECT body, created_at FROM editorial_notes WHERE article_id = ? AND visible_to_student = 1 ORDER BY id DESC LIMIT 3', a.id) : [];
    return V.statusPage(ctx, { a, notes, isPublic: A.isPublic(a) });
  });
};

module.exports.pruneUnclaimed = pruneUnclaimed;
