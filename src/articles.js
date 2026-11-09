'use strict';
// منطق المقالات: الاستعلامات، دورة العمل (الحالات وانتقالاتها)، والنسخ المحفوظة.
const db = require('./db');
const { randomId } = require('./security');
const { parseBody, imageIds, slugify } = require('./content');
const { STATUS } = require('./defaults');

const SELECT = `
  SELECT a.*, u.display_name AS author_name, u.username AS author_username, u.is_guest AS author_is_guest,
         st.grade, st.section, st.consent_name_public, st.consent_photo_public,
         pm.public_id AS photo_pid,
         c.name AS category_name, c.slug AS category_slug,
         cm.public_id AS cover_pid, cm.width AS cover_w, cm.height AS cover_h,
         i.number AS issue_number, i.title AS issue_title
  FROM articles a
  JOIN users u ON u.id = a.author_id
  LEFT JOIN students st ON st.user_id = a.author_id
  LEFT JOIN media pm ON pm.id = st.photo_media_id
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN media cm ON cm.id = a.cover_media_id
  LEFT JOIN issues i ON i.id = a.issue_id`;

const PUBLIC = `a.status = 'published' AND a.published_at <= ?`;

function likeEscape(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }

async function listPublic({ category, q, sort = 'new', limit = 12, offset = 0, issueId, featured, risingPen, excludeId } = {}) {
  const where = [PUBLIC]; const p = [db.now()];
  if (category) { where.push('c.slug = ? AND c.is_visible = 1'); p.push(category); }
  if (issueId) { where.push('a.issue_id = ?'); p.push(issueId); }
  if (featured) where.push('a.featured = 1');
  if (risingPen) where.push('a.rising_pen = 1');
  if (excludeId) { where.push('a.id <> ?'); p.push(excludeId); }
  if (q) {
    const like = `%${likeEscape(q)}%`;
    where.push(`(a.title LIKE ? ESCAPE '\\' OR a.subtitle LIKE ? ESCAPE '\\' OR a.summary LIKE ? ESCAPE '\\' OR a.body_json LIKE ? ESCAPE '\\')`);
    p.push(like, like, like, like);
  }
  const order = sort === 'popular' ? 'a.views DESC, a.published_at DESC'
    : sort === 'home' ? 'a.home_order DESC, a.featured DESC, a.published_at DESC'
      : 'a.published_at DESC';
  const rows = await db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const total = (await db.one(`SELECT COUNT(*) n FROM articles a LEFT JOIN categories c ON c.id = a.category_id WHERE ${where.join(' AND ')}`, ...p)).n;
  return { rows, total };
}

const getPublic = async (pid) => await db.one(`${SELECT} WHERE a.public_id = ? AND ${PUBLIC}`, pid, db.now());
const getByPid = async (pid) => await db.one(`${SELECT} WHERE a.public_id = ?`, pid);
const getById = async (id) => await db.one(`${SELECT} WHERE a.id = ?`, id);
const isPublic = (a) => a && a.status === 'published' && a.published_at && a.published_at <= db.now();

async function mediaMap(article) {
  const rows = await db.all('SELECT public_id, width, height FROM media WHERE article_id = ?', article.id);
  const map = {};
  for (const r of rows) map[r.public_id] = r;
  return map;
}

/** يرفق أبعاد صور المقال (لازمة لعرضه) */
async function withMedia(a) { if (a) a._media = await mediaMap(a); return a; }

async function createDraft(authorId, { categoryId = null, title = '' } = {}) {
  const t = db.now();
  const pid = randomId(8);
  const r = await db.run(`INSERT INTO articles (public_id, author_id, category_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    pid, authorId, categoryId, title, t, t);
  await logEvent(Number(r.lastInsertRowid), authorId, 'create', null, 'draft');
  return pid;
}

/** يحفظ محتوى المقال (من الطالب أو من المحرر). يتحقق من أن الصور تخص هذا المقال. */
async function saveContent(article, data) {
  const blocks = data.blocks;
  const allowed = new Set((await db.all('SELECT public_id FROM media WHERE article_id = ? AND kind = ?', article.id, 'inline')).map((r) => r.public_id));
  const filtered = blocks.filter((b) => b.t !== 'img' || allowed.has(b.m));
  let coverId = null;
  if (data.cover) {
    const m = await db.one('SELECT id FROM media WHERE public_id = ? AND article_id = ? AND kind = ?', data.cover, article.id, 'cover');
    coverId = m ? m.id : null;
  }
  const categoryOk = data.categoryId ? await db.one('SELECT id FROM categories WHERE id = ?', data.categoryId) : null;
  await db.run(`UPDATE articles SET title = ?, subtitle = ?, summary = ?, body_json = ?, cover_media_id = ?, cover_caption = ?,
            category_id = ?, slug = ?, updated_at = ? WHERE id = ?`,
  data.title, data.subtitle, data.summary, JSON.stringify(filtered), coverId, data.coverCaption,
  categoryOk ? categoryOk.id : null, slugify(data.title), db.now(), article.id);
  return filtered;
}

async function snapshot(articleId, reason, actorId, note) {
  const a = await db.one('SELECT * FROM articles WHERE id = ?', articleId);
  const n = ((await db.one('SELECT MAX(revision_no) n FROM article_revisions WHERE article_id = ?', articleId)).n || 0) + 1;
  await db.run(`INSERT INTO article_revisions (article_id, revision_no, reason, note, title, subtitle, summary, body_json, cover_media_id, cover_caption, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  articleId, n, reason, note || null, a.title, a.subtitle, a.summary, a.body_json, a.cover_media_id, a.cover_caption, actorId, db.now());
  return n;
}

async function logEvent(articleId, actorId, action, from, to, note) {
  await db.run('INSERT INTO article_events (article_id, actor_id, action, from_status, to_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    articleId, actorId, action, from, to, note || null, db.now());
}

/** متطلبات المقال قبل الإرسال */
function submissionProblems(a) {
  const problems = [];
  const blocks = parseBody(a.body_json);
  if (!a.title || a.title.trim().length < 4) problems.push('اكتب عنوانًا للمقال (4 أحرف على الأقل).');
  if (!a.category_id) problems.push('اختر تصنيفًا للمقال.');
  const words = blocks.map((b) => (b.items ? b.items.join(' ') : b.text || '')).join(' ').split(/\s+/).filter(Boolean).length;
  if (words < 40) problems.push(`المقال قصير (${words} كلمة). اكتب 40 كلمة على الأقل.`);
  const ids = imageIds(blocks);
  const capMissing = blocks.filter((b) => b.t === 'img' && !b.cap).length;
  if (capMissing) problems.push(`أضف وصفًا لكل صورة داخل المقال (${capMissing} بلا وصف).`);
  void ids;
  return problems;
}

// ===== دورة العمل =====
// كل إجراء: الحالات المسموح بها، الحالة الجديدة، من يملك تنفيذه، وهل الملاحظة إلزامية
const ACTIONS = {
  submit:          { from: ['draft', 'changes_requested'], to: 'submitted', by: 'author', label: 'إرسال للمراجعة' },
  withdraw:        { from: ['submitted'], to: 'draft', by: 'author', label: 'سحب من المراجعة' },
  start_review:    { from: ['submitted'], to: 'in_review', by: 'editor', label: 'بدء المراجعة' },
  request_changes: { from: ['submitted', 'in_review', 'approved'], to: 'changes_requested', by: 'editor', note: true, label: 'إعادة للطالب للتعديل' },
  approve:         { from: ['submitted', 'in_review'], to: 'approved', by: 'editor', label: 'اعتماد المقال' },
  reject:          { from: ['submitted', 'in_review'], to: 'rejected', by: 'editor', note: true, label: 'رفض المقال' },
  publish:         { from: ['approved'], to: 'published', by: 'editor', label: 'نشر المقال' },
  unpublish:       { from: ['published'], to: 'approved', by: 'editor', label: 'إلغاء النشر' },
  archive:         { from: ['published', 'approved', 'rejected'], to: 'archived', by: 'editor', label: 'أرشفة' },
  restore:         { from: ['archived'], to: 'approved', by: 'editor', label: 'استعادة من الأرشيف' },
};

async function transition(article, action, actor, { note, publishAt } = {}) {
  const def = ACTIONS[action];
  if (!def) throw Object.assign(new Error('إجراء غير معروف.'), { status: 400 });
  if (!def.from.includes(article.status)) throw Object.assign(new Error(`لا يمكن «${def.label}» لمقال حالته «${STATUS[article.status].label}».`), { status: 409 });
  if (def.by === 'author' && actor.id !== article.author_id) throw Object.assign(new Error('غير مسموح.'), { status: 403 });
  if (def.by === 'editor' && !['editor', 'admin'].includes(actor.role)) throw Object.assign(new Error('غير مسموح.'), { status: 403 });
  if (def.note && !(note && note.trim())) throw Object.assign(new Error('اكتب ملاحظة توضح السبب للطالب.'), { status: 400 });
  if (action === 'submit') {
    const p = submissionProblems(article);
    if (p.length) throw Object.assign(new Error(p.join(' ')), { status: 400, problems: p });
  }

  const t = db.now();
  return await db.tx(async () => {
    const sets = { status: def.to, updated_at: t };
    if (action === 'submit') sets.submitted_at = t;
    if (action === 'approve') sets.approved_at = t;
    if (action === 'publish') {
      let when = t;
      if (publishAt) {
        const d = new Date(publishAt);
        if (Number.isNaN(d.getTime())) throw Object.assign(new Error('موعد النشر غير صالح.'), { status: 400 });
        if (d.getTime() > Date.now()) when = d.toISOString();
      }
      sets.published_at = when;
      if (!article.approved_at) sets.approved_at = t;
    }
    if (action === 'unpublish') sets.unpublished_at = t;
    if (action === 'archive') sets.archived_at = t;
    const keys = Object.keys(sets);
    await db.run(`UPDATE articles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND status = ?`,
      ...keys.map((k) => sets[k]), article.id, article.status);
    if (action === 'submit') await snapshot(article.id, 'submit', actor.id);
    if (def.note && note) {
      await db.run('INSERT INTO editorial_notes (article_id, author_id, body, visible_to_student, created_at) VALUES (?, ?, ?, 1, ?)', article.id, actor.id, note.trim().slice(0, 4000), t);
    }
    await logEvent(article.id, actor.id, action, article.status, def.to, note ? note.trim().slice(0, 500) : (sets.published_at && sets.published_at > t ? `مجدول: ${sets.published_at}` : null));
    return def.to;
  });
}

async function counts(authorId) {
  const rows = await db.all('SELECT status, COUNT(*) n FROM articles WHERE author_id = ? GROUP BY status', authorId);
  const out = {}; for (const r of rows) out[r.status] = r.n; return out;
}

module.exports = { SELECT, PUBLIC, withMedia, listPublic, getPublic, getByPid, getById, isPublic, mediaMap, createDraft, saveContent, snapshot, logEvent, submissionProblems, transition, ACTIONS, counts };
