'use strict';
// غرفة الطالب: كل استعلام مقيَّد بـ author_id = المستخدم الحالي، فلا يصل طالب إلى عمل غيره.
const db = require('../db');
const A = require('../articles');
const V = require('../views/desk');
const { sanitizeBlocks, parseBody } = require('../content');
const { notFound, forbidden, bad, redirect, sendJson, HttpError } = require('../http');
const { deleteMedia } = require('./media');
const { STATUS } = require('../defaults');

const EDITABLE = ['draft', 'changes_requested'];

function requireStudent(ctx) {
  if (!ctx.user) { const e = new HttpError(401, 'سجّل الدخول أولًا.'); e.login = true; throw e; }
  if (ctx.user.role !== 'student') throw forbidden();
}

async function ownArticle(ctx) {
  const a = await A.getByPid(ctx.params.pid);
  if (!a || a.author_id !== ctx.user.id) throw notFound(); // 404 لمقالات الآخرين
  return a;
}

const EVENT_LABEL = { create: 'إنشاء المسودة', editor_edit: 'تعديل تحريري', ...Object.fromEntries(Object.entries(A.ACTIONS).map(([k, v]) => [k, v.label])) };

function readArticlePayload(b) {
  const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max);
  let blocks;
  try { blocks = sanitizeBlocks(b.blocks || []); } catch (e) { throw bad(e.message); }
  const categoryId = Number(b.categoryId) || null;
  return {
    title: str(b.title, 140), subtitle: str(b.subtitle, 200),
    summary: String(b.summary ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim().slice(0, 600),
    categoryId, cover: b.cover ? String(b.cover).slice(0, 40) : null, coverCaption: str(b.coverCaption, 300), blocks,
  };
}

/** حذف الصور التي رُفعت للمقال ثم لم تعد مستخدمة فيه */
async function pruneMedia(articleId) {
  const a = await db.one('SELECT * FROM articles WHERE id = ?', articleId);
  const used = new Set(parseBody(a.body_json).filter((b) => b.t === 'img').map((b) => b.m));
  const revCovers = new Set((await db.all('SELECT cover_media_id FROM article_revisions WHERE article_id = ?', articleId)).map((r) => r.cover_media_id));
  const revBodies = (await db.all('SELECT body_json FROM article_revisions WHERE article_id = ?', articleId)).map((r) => r.body_json).join('');
  for (const m of await db.all('SELECT * FROM media WHERE article_id = ?', articleId)) {
    const keep = m.id === a.cover_media_id || used.has(m.public_id) || revCovers.has(m.id) || revBodies.includes(`"${m.public_id}"`);
    if (!keep) await deleteMedia(m);
  }
}

module.exports = (r) => {
  r.get('/desk', async (ctx) => {
    requireStudent(ctx);
    const student = await db.one('SELECT * FROM students WHERE user_id = ?', ctx.user.id) || { grade: null };
    const filter = V.FILTERS.find((f) => f[0] === ctx.query.f) ? ctx.query.f : 'all';
    const statuses = V.FILTERS.find((f) => f[0] === filter)[2];
    const rows = statuses
      ? await db.all(`${A.SELECT} WHERE a.author_id = ? AND a.status IN (${statuses.map(() => '?').join(',')}) ORDER BY a.updated_at DESC`, ctx.user.id, ...statuses)
      : await db.all(`${A.SELECT} WHERE a.author_id = ? ORDER BY a.updated_at DESC`, ctx.user.id);
    const notesByArticle = {};
    for (const a of rows.filter((x) => ['changes_requested', 'rejected'].includes(x.status))) {
      const n = await db.one('SELECT body FROM editorial_notes WHERE article_id = ? AND visible_to_student = 1 ORDER BY id DESC LIMIT 1', a.id);
      if (n) notesByArticle[a.id] = n.body.length > 220 ? n.body.slice(0, 220) + '…' : n.body;
    }
    const prompts = await db.all('SELECT p.*, c.name category_name FROM writing_prompts p LEFT JOIN categories c ON c.id = p.category_id WHERE p.is_active = 1 ORDER BY p.id DESC');
    return V.dashboard(ctx, { student, rows, counts: await A.counts(ctx.user.id), filter, prompts, notesByArticle });
  });

  r.get('/desk/ideas', async (ctx) => {
    requireStudent(ctx);
    const prompts = await db.all('SELECT p.*, c.name category_name FROM writing_prompts p LEFT JOIN categories c ON c.id = p.category_id WHERE p.is_active = 1 ORDER BY p.id DESC');
    return V.ideasPage(ctx, prompts);
  });

  r.post('/desk/articles', async (ctx) => {
    requireStudent(ctx);
    const drafts = (await db.one("SELECT COUNT(*) n FROM articles WHERE author_id = ? AND status = 'draft'", ctx.user.id)).n;
    if (drafts >= 25) { ctx.setFlash('error', 'لديك 25 مسودة. أكمل بعضها أو احذف ما لا تحتاجه قبل إنشاء مسودة جديدة.'); return redirect(ctx.res, '/desk?f=draft'); }
    const categoryId = Number(ctx.body.category_id) || null;
    const cat = categoryId ? await db.one('SELECT id FROM categories WHERE id = ?', categoryId) : null;
    const pid = await A.createDraft(ctx.user.id, { categoryId: cat ? cat.id : null, title: String(ctx.body.title || '').slice(0, 140) });
    return redirect(ctx.res, `/desk/articles/${pid}/edit`);
  });

  r.get('/desk/articles/:pid/edit', async (ctx) => {
    requireStudent(ctx);
    const a = await ownArticle(ctx);
    if (!EDITABLE.includes(a.status)) {
      ctx.setFlash('info', `المقال «${STATUS[a.status].label}» ولا يمكن تعديله الآن.`);
      return redirect(ctx.res, `/desk/articles/${a.public_id}/preview`);
    }
    const media = {};
    for (const m of await db.all('SELECT public_id, width, height FROM media WHERE article_id = ?', a.id)) media[m.public_id] = { w: m.width, h: m.height };
    const notes = a.status === 'changes_requested'
      ? await db.all('SELECT n.*, u.display_name author_name FROM editorial_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.article_id = ? AND n.visible_to_student = 1 ORDER BY n.id DESC LIMIT 5', a.id)
      : [];
    const author = await db.one('SELECT u.display_name, s.grade, s.section, m.public_id photo_pid FROM users u JOIN students s ON s.user_id = u.id LEFT JOIN media m ON m.id = s.photo_media_id WHERE u.id = ?', ctx.user.id);
    const categories = await db.all('SELECT id, name FROM categories WHERE is_visible = 1 OR id = ? ORDER BY sort_order', a.category_id || 0);
    return V.editorPage(ctx, { article: a, blocks: parseBody(a.body_json), media, categories, notes, mode: 'student', author });
  });

  r.put('/api/desk/articles/:pid', async (ctx) => {
    requireStudent(ctx);
    const a = await ownArticle(ctx);
    if (!EDITABLE.includes(a.status)) throw new HttpError(409, 'أُرسل المقال للمراجعة ولا يمكن تعديله الآن.');
    const data = readArticlePayload(ctx.body);
    await A.saveContent(a, data);
    const fresh = await db.one('SELECT updated_at FROM articles WHERE id = ?', a.id);
    return sendJson(ctx.res, 200, { ok: true, updatedAt: fresh.updated_at, problems: A.submissionProblems(await db.one('SELECT * FROM articles WHERE id = ?', a.id)) });
  });

  r.post('/desk/articles/:pid/submit', async (ctx) => {
    requireStudent(ctx);
    const a = await ownArticle(ctx);
    try {
      await A.transition(await db.one('SELECT * FROM articles WHERE id = ?', a.id), 'submit', ctx.user);
    } catch (e) {
      ctx.setFlash('error', e.message);
      return redirect(ctx.res, `/desk/articles/${a.public_id}/edit`);
    }
    await pruneMedia(a.id);
    ctx.setFlash('ok', 'أُرسل مقالك إلى هيئة التحرير. ستجد حالته وملاحظات المحررين هنا في مكتبك.');
    return redirect(ctx.res, '/desk?f=review');
  });

  r.post('/desk/articles/:pid/withdraw', async (ctx) => {
    requireStudent(ctx);
    const a = await ownArticle(ctx);
    try { await A.transition(await db.one('SELECT * FROM articles WHERE id = ?', a.id), 'withdraw', ctx.user); } catch (e) { ctx.setFlash('error', e.message); return redirect(ctx.res, `/desk/articles/${a.public_id}/preview`); }
    ctx.setFlash('ok', 'سُحب المقال وعاد مسودة. يمكنك تعديله ثم إرساله من جديد.');
    return redirect(ctx.res, `/desk/articles/${a.public_id}/edit`);
  });

  r.post('/desk/articles/:pid/delete', async (ctx) => {
    requireStudent(ctx);
    const a = await ownArticle(ctx);
    if (a.status !== 'draft' || a.submitted_at) { ctx.setFlash('error', 'يمكن حذف المسودات التي لم تُرسل من قبل فقط.'); return redirect(ctx.res, '/desk'); }
    for (const m of await db.all('SELECT * FROM media WHERE article_id = ?', a.id)) await deleteMedia(m);
    await db.run('DELETE FROM articles WHERE id = ?', a.id);
    ctx.setFlash('ok', 'حُذفت المسودة.');
    return redirect(ctx.res, '/desk');
  });

  r.get('/desk/articles/:pid/preview', async (ctx) => {
    requireStudent(ctx);
    const a = await ownArticle(ctx);
    const notes = ['changes_requested', 'rejected'].includes(a.status)
      ? await db.all('SELECT * FROM editorial_notes WHERE article_id = ? AND visible_to_student = 1 ORDER BY id DESC LIMIT 5', a.id) : [];
    const events = (await db.all('SELECT action, created_at FROM article_events WHERE article_id = ? ORDER BY id', a.id))
      .map((e) => ({ ...e, label: EVENT_LABEL[e.action] || e.action }));
    await A.withMedia(a);
    return V.previewPage(ctx, { article: a, notes, events, mode: 'student' });
  });

  r.get('/desk/profile', async (ctx) => {
    requireStudent(ctx);
    const student = await db.one('SELECT s.*, m.public_id photo_pid FROM students s LEFT JOIN media m ON m.id = s.photo_media_id WHERE s.user_id = ?', ctx.user.id);
    return V.profilePage(ctx, { student, photoPid: student.photo_pid, pubSettings: db.setting('publishing') });
  });
};

module.exports.readArticlePayload = readArticlePayload;
module.exports.pruneMedia = pruneMedia;
module.exports.EVENT_LABEL = EVENT_LABEL;
module.exports.requireStudent = requireStudent;
