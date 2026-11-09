'use strict';
// غرفة التحرير والإدارة. الصلاحيات تُفحص هنا في الخادم لكل طلب (لا مجرد إخفاء أزرار).
const db = require('../db');
const A = require('../articles');
const V = require('../views/newsroom');
const DV = require('../views/desk');
const S = require('../security');
const { parseBody } = require('../content');
const { notFound, forbidden, bad, redirect, sendJson, HttpError } = require('../http');
const { deleteMedia } = require('./media');
const { readArticlePayload, EVENT_LABEL } = require('./desk');
const { DEFAULT_SETTINGS } = require('../defaults');

function need(ctx, roles) {
  if (!ctx.user) { const e = new HttpError(401, 'سجّل الدخول أولًا.'); e.login = true; throw e; }
  if (!roles.includes(ctx.user.role)) throw forbidden();
}
const editor = (ctx) => need(ctx, ['editor', 'admin']);
const admin = (ctx) => need(ctx, ['admin']);

const article = async (pid) => { const a = await A.getByPid(pid); if (!a) throw notFound(); return a; };
const int = (v, d = 0) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Math.trunc(Number(v)) : d);
const str = (v, max) => String(v ?? '').trim().slice(0, max);

async function usernameFrom(name) {
  // توليد اسم مستخدم لاتيني بسيط وفريد: s + رقم عشوائي
  for (let i = 0; i < 20; i++) {
    const u = `s${S.randomId(4).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 3)}${Math.floor(1000 + Math.random() * 9000)}`;
    if (u.length >= 6 && !await db.one('SELECT 1 FROM users WHERE username = ?', u)) return u;
  }
  void name;
  throw new Error('تعذر توليد اسم مستخدم.');
}

async function createStudent(actor, { name, grade, section, username }, ip) {
  name = str(name, 80); section = str(section, 10);
  grade = int(grade);
  if (name.length < 3) throw bad(`الاسم «${name}» قصير جدًا.`);
  if (grade < 5 || grade > 12) throw bad(`الصف يجب أن يكون من 5 إلى 12 (${name}).`);
  username = str(username, 40).toLowerCase();
  if (username) {
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('اسم المستخدم: حروف إنجليزية وأرقام فقط (3 أحرف على الأقل).');
    if (await db.one('SELECT 1 FROM users WHERE username = ?', username)) throw bad(`اسم المستخدم «${username}» مستخدم من قبل.`);
  } else username = await usernameFrom(name);
  const password = S.tempPassword();
  const t = db.now();
  const id = await db.tx(async () => {
    const r = await db.run('INSERT INTO users (username, password_hash, role, display_name, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      username, S.hashPassword(password), 'student', name, t, t);
    const uid = Number(r.lastInsertRowid);
    await db.run('INSERT INTO students (user_id, grade, section) VALUES (?, ?, ?)', uid, grade, section || null);
    return uid;
  });
  await S.audit(actor.id, 'student.create', 'user', id, { username }, ip);
  return { name, grade, section, username, password };
}

async function stats() {
  const status = {};
  for (const r of await db.all('SELECT status, COUNT(*) n FROM articles GROUP BY status')) status[r.status] = r.n;
  return {
    status,
    total: Object.values(status).reduce((a, b) => a + b, 0),
    queue: (status.submitted || 0) + (status.in_review || 0),
    writers: (await db.one("SELECT COUNT(DISTINCT author_id) n FROM articles WHERE status <> 'draft' OR submitted_at IS NOT NULL")).n,
    activeStudents: (await db.one("SELECT COUNT(*) n FROM users WHERE role = 'student' AND is_active = 1")).n,
    byGrade: await db.all("SELECT s.grade, COUNT(*) n FROM articles a JOIN students s ON s.user_id = a.author_id WHERE a.status NOT IN ('draft') GROUP BY s.grade ORDER BY s.grade"),
    byCat: await db.all("SELECT c.name, COUNT(*) n FROM articles a JOIN categories c ON c.id = a.category_id WHERE a.status NOT IN ('draft') GROUP BY c.id ORDER BY n DESC"),
    top: await db.all(`${A.SELECT} WHERE ${A.PUBLIC} AND a.views > 0 ORDER BY a.views DESC LIMIT 5`, db.now()),
    recentQueue: await db.all(`${A.SELECT} WHERE a.status IN ('submitted','in_review') ORDER BY a.submitted_at ASC LIMIT 8`),
  };
}

module.exports = (r) => {
  r.get('/newsroom', async (ctx) => { editor(ctx); return V.dashboard(ctx, await stats()); });

  // ===== المقالات =====
  r.get('/newsroom/articles', async (ctx) => {
    editor(ctx);
    const f = String(ctx.query.f || 'all'); const q = str(ctx.query.q, 80);
    const grade = int(ctx.query.grade, 0); const cat = int(ctx.query.cat, 0);
    const where = ['1=1']; const p = [];
    if (f === 'queue') where.push("a.status IN ('submitted','in_review')");
    else if (f !== 'all') { where.push('a.status = ?'); p.push(f); }
    if (q) { where.push("(a.title LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')"); const l = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`; p.push(l, l); }
    if (grade) { where.push('st.grade = ?'); p.push(grade); }
    if (cat) { where.push('a.category_id = ?'); p.push(cat); }
    const order = f === 'queue' ? 'a.submitted_at ASC' : 'a.updated_at DESC';
    const rows = await db.all(`${A.SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`, ...p);
    return V.articlesList(ctx, { rows, f, q, grade, cat, cats: await db.all('SELECT id, name FROM categories ORDER BY sort_order'), total: rows.length });
  });

  r.get('/newsroom/articles/:pid', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    const notes = await db.all('SELECT n.*, u.display_name author_name FROM editorial_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.article_id = ? ORDER BY n.id DESC', a.id);
    const events = (await db.all('SELECT e.*, u.display_name actor_name FROM article_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.article_id = ? ORDER BY e.id', a.id))
      .map((e) => ({ ...e, label: EVENT_LABEL[e.action] || e.action }));
    const revisions = await db.all('SELECT r.*, u.display_name by_name FROM article_revisions r LEFT JOIN users u ON u.id = r.created_by WHERE r.article_id = ? ORDER BY r.revision_no DESC', a.id);
    const pub = db.setting('publishing');
    const warnings = [];
    if (pub.require_name_consent && !a.consent_name_public) warnings.push('لا توجد موافقة مسجلة على نشر اسم الطالب: سيظهر التوقيع بصيغة «بقلم طالب من الصف ...» دون اسمه أو صورته.');
    if (a.photo_pid && !a.consent_photo_public) warnings.push('للطالب صورة شخصية، لكنها لن تظهر للقراء لعدم وجود موافقة مسجلة.');
    if (a.author_is_guest) warnings.push(`أُرسل هذا المقال من صفحة «اكتب للجريدة» دون حساب، باسم «${a.author_name}» (${a.grade ? `الصف ${a.grade}` : ''}${a.section ? ` / ${a.section}` : ''}). لا يستطيع كاتبه تعديله بنفسه: صحّح ما يلزم بـ«تعديل تحريري محدود»، وإن أعدته للتعديل أو رفضته فستظهر ملاحظتك له في رابط المتابعة.`);
    const blocks = parseBody(a.body_json);
    if (blocks.some((b) => b.t === 'img' && !b.cap)) warnings.push('بعض صور المقال بلا وصف.');
    if (a.cover_pid && !a.cover_caption) warnings.push('صورة الغلاف بلا وصف.');
    await A.withMedia(a);
    return V.review(ctx, { a, notes, events, revisions, issues: await db.all('SELECT id, number, title FROM issues ORDER BY number DESC'), cats: await db.all('SELECT id, name FROM categories ORDER BY sort_order'), warnings });
  });

  r.get('/newsroom/articles/:pid/preview', async (ctx) => {
    editor(ctx);
    return DV.previewPage(ctx, { article: await A.withMedia(await article(ctx.params.pid)), mode: 'editor' });
  });

  r.post('/newsroom/articles/:pid/action', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    const action = String(ctx.body.action || '');
    if (!A.ACTIONS[action] || A.ACTIONS[action].by !== 'editor') throw bad('إجراء غير معروف.');
    let publishAt = null;
    if (action === 'publish' && ctx.body.schedule && ctx.body.publish_at) {
      // القيمة من datetime-local بتوقيت مسقط (UTC+4)
      publishAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(ctx.body.publish_at) ? `${ctx.body.publish_at}:00+04:00` : 'invalid';
    }
    try {
      await A.transition(await db.one('SELECT * FROM articles WHERE id = ?', a.id), action, ctx.user, { note: ctx.body.note, publishAt });
    } catch (e) {
      ctx.setFlash('error', e.message);
      return redirect(ctx.res, `/newsroom/articles/${a.public_id}`);
    }
    await S.audit(ctx.user.id, `article.${action}`, 'article', a.public_id, { title: a.title }, ctx.ip);
    const msg = { publish: publishAt ? 'جُدول نشر المقال.' : 'نُشر المقال في الجريدة.', approve: 'اعتُمد المقال. يمكنك نشره الآن أو لاحقًا.', request_changes: 'أُعيد المقال إلى الطالب مع ملاحظاتك.', reject: 'رُفض المقال وأُبلغ الطالب بالسبب.', unpublish: 'أُلغي نشر المقال، وهو الآن معتمد غير منشور.', archive: 'أُرشف المقال.', restore: 'استُعيد المقال من الأرشيف.', start_review: 'بدأت مراجعة المقال.' };
    ctx.setFlash('ok', msg[action] || 'تم.');
    return redirect(ctx.res, `/newsroom/articles/${a.public_id}`);
  });

  r.post('/newsroom/articles/:pid/placement', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    const cat = int(ctx.body.category_id) ? await db.one('SELECT id FROM categories WHERE id = ?', int(ctx.body.category_id)) : null;
    const issue = int(ctx.body.issue_id) ? await db.one('SELECT id FROM issues WHERE id = ?', int(ctx.body.issue_id)) : null;
    await db.run('UPDATE articles SET category_id = ?, issue_id = ?, featured = ?, rising_pen = ?, home_order = ? WHERE id = ?',
      cat ? cat.id : null, issue ? issue.id : null, ctx.body.featured ? 1 : 0, ctx.body.rising_pen ? 1 : 0, Math.max(0, Math.min(999, int(ctx.body.home_order))), a.id);
    await A.logEvent(a.id, ctx.user.id, 'placement', a.status, a.status, null);
    ctx.setFlash('ok', 'حُفظ مكان المقال.');
    return redirect(ctx.res, `/newsroom/articles/${a.public_id}`);
  });

  r.post('/newsroom/articles/:pid/note', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    const body = str(ctx.body.body, 4000);
    if (!body) throw bad('اكتب نص الملاحظة.');
    await db.run('INSERT INTO editorial_notes (article_id, author_id, body, visible_to_student, created_at) VALUES (?, ?, ?, ?, ?)', a.id, ctx.user.id, body, ctx.body.visible ? 1 : 0, db.now());
    ctx.setFlash('ok', 'أُضيفت الملاحظة.');
    return redirect(ctx.res, `/newsroom/articles/${a.public_id}`);
  });

  r.get('/newsroom/articles/:pid/revisions/:no', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    const rev = await db.one('SELECT r.*, m.public_id cover_pid, m.width cover_w, m.height cover_h FROM article_revisions r LEFT JOIN media m ON m.id = r.cover_media_id WHERE r.article_id = ? AND r.revision_no = ?', a.id, int(ctx.params.no));
    if (!rev) throw notFound();
    await A.withMedia(a);
    return V.revisionPage(ctx, a, rev);
  });

  // التعديل التحريري المحدود — يحفظ نسخة قبل التعديل وبعده
  const EDITOR_EDITABLE = ['submitted', 'in_review', 'approved', 'published'];
  r.get('/newsroom/articles/:pid/edit', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    if (!EDITOR_EDITABLE.includes(a.status)) { ctx.setFlash('error', 'لا يمكن التعديل التحريري في هذه الحالة.'); return redirect(ctx.res, `/newsroom/articles/${a.public_id}`); }
    const media = {};
    for (const m of await db.all('SELECT public_id, width, height FROM media WHERE article_id = ?', a.id)) media[m.public_id] = { w: m.width, h: m.height };
    const author = await db.one('SELECT u.display_name, s.grade, s.section, m.public_id photo_pid FROM users u LEFT JOIN students s ON s.user_id = u.id LEFT JOIN media m ON m.id = s.photo_media_id WHERE u.id = ?', a.author_id);
    return DV.editorPage(ctx, { article: a, blocks: parseBody(a.body_json), media, categories: await db.all('SELECT id, name FROM categories ORDER BY sort_order'), notes: [], mode: 'editor', author });
  });

  r.put('/api/newsroom/articles/:pid', async (ctx) => {
    editor(ctx);
    const a = await article(ctx.params.pid);
    if (!EDITOR_EDITABLE.includes(a.status)) throw new HttpError(409, 'لا يمكن التعديل التحريري في هذه الحالة.');
    const note = str(ctx.body.editNote, 300);
    if (note.length < 3) throw bad('اكتب سبب التعديل التحريري قبل الحفظ.');
    const data = readArticlePayload(ctx.body);
    await db.tx(async () => {
      if (!await db.one('SELECT 1 FROM article_revisions WHERE article_id = ?', a.id)) await A.snapshot(a.id, 'submit', a.author_id, 'النص الأصلي قبل أول تعديل تحريري');
      await A.saveContent(a, data);
      await A.snapshot(a.id, 'editor_edit', ctx.user.id, note);
      await A.logEvent(a.id, ctx.user.id, 'editor_edit', a.status, a.status, note);
    });
    await S.audit(ctx.user.id, 'article.editor_edit', 'article', a.public_id, { note }, ctx.ip);
    return sendJson(ctx.res, 200, { ok: true, updatedAt: db.now() });
  });

  r.post('/newsroom/articles/:pid/delete', async (ctx) => {
    admin(ctx);
    const a = await article(ctx.params.pid);
    const reason = str(ctx.body.reason, 300);
    if (!reason) throw bad('اكتب سبب الحذف.');
    const media = await db.all('SELECT * FROM media WHERE article_id = ?', a.id);
    await db.run('DELETE FROM articles WHERE id = ?', a.id);
    for (const m of media) await deleteMedia(m);
    await S.audit(ctx.user.id, 'article.delete', 'article', a.public_id, { title: a.title, author: a.author_username, reason }, ctx.ip);
    ctx.setFlash('ok', 'حُذف المقال نهائيًا.');
    return redirect(ctx.res, '/newsroom/articles');
  });

  // ===== الطلبة =====
  r.get('/newsroom/students', async (ctx) => {
    admin(ctx);
    const q = str(ctx.query.q, 60); const grade = int(ctx.query.grade, 0);
    const where = ["u.role = 'student'"]; const p = [];
    if (q) { const l = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`; where.push("(u.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')"); p.push(l, l); }
    if (grade) { where.push('s.grade = ?'); p.push(grade); }
    const rows = await db.all(`SELECT u.*, s.grade, s.section, s.consent_name_public, s.consent_photo_public,
      (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id) n_articles,
      (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id AND a.status = 'published') n_published
      FROM users u JOIN students s ON s.user_id = u.id WHERE ${where.join(' AND ')} ORDER BY s.grade, s.section, u.display_name LIMIT 1000`, ...p);
    return V.studentsList(ctx, { rows, q, grade, total: rows.length });
  });

  r.post('/newsroom/students', async (ctx) => {
    admin(ctx);
    let c;
    try { c = await createStudent(ctx.user, { name: ctx.body.display_name, grade: ctx.body.grade, section: ctx.body.section, username: ctx.body.username }, ctx.ip); }
    catch (e) { if (e.status === 400) { ctx.setFlash('error', e.message); return redirect(ctx.res, '/newsroom/students'); } throw e; }
    return V.credentials(ctx, { items: [c] }, 'تم إنشاء حساب الطالب');
  });

  r.post('/newsroom/students/bulk', async (ctx) => {
    admin(ctx);
    const lines = String(ctx.body.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
    if (!lines.length) throw bad('أدخل سطرًا واحدًا على الأقل.');
    const items = []; const errors = [];
    for (const line of lines) {
      const parts = line.split(/[,،\t;]/).map((x) => x.trim());
      const grade = int(String(parts[1] || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
      try { items.push(await createStudent(ctx.user, { name: parts[0], grade, section: parts[2] }, ctx.ip)); }
      catch (e) { errors.push(`${line} — ${e.message}`); }
    }
    return V.credentials(ctx, { items, errors }, `أُنشئ ${items.length} حساب`);
  });

  const studentRow = async (id) => {
    const s = await db.one(`SELECT u.*, s.grade, s.section, s.consent_name_public, s.consent_photo_public, s.consent_note, s.consent_recorded_by, s.consent_recorded_at, m.public_id photo_pid, s.photo_media_id
      FROM users u JOIN students s ON s.user_id = u.id LEFT JOIN media m ON m.id = s.photo_media_id WHERE u.id = ?`, id);
    if (!s) throw notFound();
    return s;
  };

  r.get('/newsroom/students/:id', async (ctx) => {
    admin(ctx);
    const s = await studentRow(int(ctx.params.id));
    const articles = await db.all('SELECT public_id, title, status, updated_at FROM articles WHERE author_id = ? ORDER BY updated_at DESC', s.id);
    const by = s.consent_recorded_by ? await db.one('SELECT display_name FROM users WHERE id = ?', s.consent_recorded_by) : null;
    return V.studentDetail(ctx, { s, articles, consentBy: by && by.display_name });
  });

  r.post('/newsroom/students/:id', async (ctx) => {
    admin(ctx);
    const s = await studentRow(int(ctx.params.id));
    const name = str(ctx.body.display_name, 80); const grade = int(ctx.body.grade);
    if (name.length < 3 || grade < 5 || grade > 12) throw bad('تحقق من الاسم والصف.');
    const active = ctx.body.is_active ? 1 : 0;
    await db.tx(async () => {
      await db.run('UPDATE users SET display_name = ?, is_active = ?, updated_at = ? WHERE id = ?', name, active, db.now(), s.id);
      await db.run('UPDATE students SET grade = ?, section = ? WHERE user_id = ?', grade, str(ctx.body.section, 10) || null, s.id);
    });
    if (!active) await S.destroyUserSessions(s.id);
    await S.audit(ctx.user.id, 'student.update', 'user', s.id, { name, grade, active }, ctx.ip);
    ctx.setFlash('ok', 'حُفظت بيانات الطالب.');
    return redirect(ctx.res, `/newsroom/students/${s.id}`);
  });

  r.post('/newsroom/students/:id/consent', async (ctx) => {
    admin(ctx);
    const s = await studentRow(int(ctx.params.id));
    const nameC = ctx.body.consent_name_public ? 1 : 0; const photoC = ctx.body.consent_photo_public ? 1 : 0;
    await db.run('UPDATE students SET consent_name_public = ?, consent_photo_public = ?, consent_note = ?, consent_recorded_by = ?, consent_recorded_at = ? WHERE user_id = ?',
      nameC, photoC, str(ctx.body.consent_note, 300) || null, ctx.user.id, db.now(), s.id);
    await S.audit(ctx.user.id, 'student.consent', 'user', s.id, { name: nameC, photo: photoC, note: str(ctx.body.consent_note, 300) }, ctx.ip);
    ctx.setFlash('ok', 'حُفظت الموافقات.');
    return redirect(ctx.res, `/newsroom/students/${s.id}`);
  });

  r.post('/newsroom/students/:id/reset-password', async (ctx) => {
    admin(ctx);
    const s = await studentRow(int(ctx.params.id));
    const password = S.tempPassword();
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', S.hashPassword(password), db.now(), s.id);
    await S.destroyUserSessions(s.id);
    await S.audit(ctx.user.id, 'student.reset_password', 'user', s.id, null, ctx.ip);
    return V.credentials(ctx, { items: [{ name: s.display_name, grade: s.grade, section: s.section, username: s.username, password }] }, 'كلمة مرور مؤقتة جديدة');
  });

  r.post('/newsroom/students/:id/photo/remove', async (ctx) => {
    admin(ctx);
    const s = await studentRow(int(ctx.params.id));
    const m = s.photo_media_id ? await db.one('SELECT * FROM media WHERE id = ?', s.photo_media_id) : null;
    await db.run('UPDATE students SET photo_media_id = NULL WHERE user_id = ?', s.id);
    await deleteMedia(m);
    await S.audit(ctx.user.id, 'student.photo_remove', 'user', s.id, null, ctx.ip);
    ctx.setFlash('ok', 'أُزيلت صورة الطالب.');
    return redirect(ctx.res, `/newsroom/students/${s.id}`);
  });

  // ===== التصنيفات =====
  r.get('/newsroom/categories', async (ctx) => {
    editor(ctx);
    return V.categoriesPage(ctx, await db.all('SELECT c.*, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id) n FROM categories c ORDER BY c.sort_order, c.id'));
  });
  const catData = (b) => {
    const name = str(b.name, 60); const slug = str(b.slug, 60).toLowerCase();
    if (name.length < 2) throw bad('اكتب اسم التصنيف.');
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw bad('الرابط: حروف إنجليزية صغيرة وأرقام وشرطات فقط.');
    return { name, slug, description: str(b.description, 200), sort: int(b.sort_order), visible: b.is_visible ? 1 : 0 };
  };
  r.post('/newsroom/categories', async (ctx) => {
    editor(ctx);
    const c = catData(ctx.body);
    if (await db.one('SELECT 1 FROM categories WHERE slug = ?', c.slug)) throw bad('هذا الرابط مستخدم لتصنيف آخر.');
    await db.run('INSERT INTO categories (name, slug, description, sort_order, is_visible) VALUES (?, ?, ?, ?, 1)', c.name, c.slug, c.description, c.sort);
    ctx.setFlash('ok', 'أُضيف التصنيف.');
    return redirect(ctx.res, '/newsroom/categories');
  });
  r.post('/newsroom/categories/:id', async (ctx) => {
    editor(ctx);
    const id = int(ctx.params.id);
    if (!await db.one('SELECT 1 FROM categories WHERE id = ?', id)) throw notFound();
    const c = catData(ctx.body);
    if (await db.one('SELECT 1 FROM categories WHERE slug = ? AND id <> ?', c.slug, id)) throw bad('هذا الرابط مستخدم لتصنيف آخر.');
    await db.run('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ?, is_visible = ? WHERE id = ?', c.name, c.slug, c.description, c.sort, c.visible, id);
    ctx.setFlash('ok', 'حُفظ التصنيف.');
    return redirect(ctx.res, '/newsroom/categories');
  });

  // ===== الأعداد =====
  r.get('/newsroom/issues', async (ctx) => {
    editor(ctx);
    const issues = await db.all('SELECT i.*, (SELECT COUNT(*) FROM articles a WHERE a.issue_id = i.id) n FROM issues i ORDER BY i.number DESC');
    return V.issuesPage(ctx, { issues, current: db.setting('publishing').current_issue_id });
  });
  r.post('/newsroom/issues', async (ctx) => {
    editor(ctx);
    const number = int(ctx.body.number); const title = str(ctx.body.title, 100);
    if (number < 1 || !title) throw bad('اكتب رقم العدد وعنوانه.');
    if (await db.one('SELECT 1 FROM issues WHERE number = ?', number)) throw bad('يوجد عدد بهذا الرقم.');
    const r2 = await db.run('INSERT INTO issues (number, title, theme, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', number, title, str(ctx.body.theme, 160), db.now(), db.now());
    await S.audit(ctx.user.id, 'issue.create', 'issue', number, { title }, ctx.ip);
    return redirect(ctx.res, `/newsroom/issues/${r2.lastInsertRowid}`);
  });
  r.get('/newsroom/issues/:id', async (ctx) => {
    editor(ctx);
    const i = await db.one('SELECT i.*, m.public_id cover_pid FROM issues i LEFT JOIN media m ON m.id = i.cover_media_id WHERE i.id = ?', int(ctx.params.id));
    if (!i) throw notFound();
    const articles = await db.all(`${A.SELECT} WHERE a.issue_id = ? ORDER BY a.home_order DESC, a.published_at DESC`, i.id);
    return V.issueEdit(ctx, { i, articles, current: db.setting('publishing').current_issue_id });
  });
  r.post('/newsroom/issues/:id', async (ctx) => {
    editor(ctx);
    const i = await db.one('SELECT * FROM issues WHERE id = ?', int(ctx.params.id));
    if (!i) throw notFound();
    const number = int(ctx.body.number); const title = str(ctx.body.title, 100);
    if (number < 1 || !title) throw bad('اكتب رقم العدد وعنوانه.');
    if (await db.one('SELECT 1 FROM issues WHERE number = ? AND id <> ?', number, i.id)) throw bad('يوجد عدد آخر بهذا الرقم.');
    const status = ctx.body.status === 'published' ? 'published' : 'draft';
    await db.run('UPDATE issues SET number = ?, title = ?, theme = ?, intro = ?, status = ?, published_at = COALESCE(published_at, ?), updated_at = ? WHERE id = ?',
      number, title, str(ctx.body.theme, 160), String(ctx.body.intro || '').replace(/\r\n?/g, '\n').trim().slice(0, 5000), status, status === 'published' ? db.now() : null, db.now(), i.id);
    const pub = { ...db.setting('publishing') };
    if (ctx.body.current) pub.current_issue_id = i.id;
    else if (pub.current_issue_id === i.id) pub.current_issue_id = null;
    await db.setSetting('publishing', pub, ctx.user.id);
    await S.audit(ctx.user.id, 'issue.update', 'issue', number, { status, current: !!ctx.body.current }, ctx.ip);
    ctx.setFlash('ok', status === 'draft' && ctx.body.current ? 'حُفظ العدد. تنبيه: لن يظهر على الغلاف حتى تجعل حالته «صادر».' : 'حُفظ العدد.');
    return redirect(ctx.res, `/newsroom/issues/${i.id}`);
  });
  r.post('/newsroom/issues/:id/delete', async (ctx) => {
    editor(ctx);
    const i = await db.one('SELECT * FROM issues WHERE id = ?', int(ctx.params.id));
    if (!i) throw notFound();
    await db.run('DELETE FROM issues WHERE id = ?', i.id);
    if (i.cover_media_id) await deleteMedia(await db.one('SELECT * FROM media WHERE id = ?', i.cover_media_id));
    const pub = { ...db.setting('publishing') };
    if (pub.current_issue_id === i.id) { pub.current_issue_id = null; await db.setSetting('publishing', pub, ctx.user.id); }
    await S.audit(ctx.user.id, 'issue.delete', 'issue', i.number, null, ctx.ip);
    ctx.setFlash('ok', 'حُذف العدد. مقالاته باقية في الجريدة.');
    return redirect(ctx.res, '/newsroom/issues');
  });

  // ===== غرفة الأفكار =====
  r.get('/newsroom/prompts', async (ctx) => {
    editor(ctx);
    return V.promptsPage(ctx, { prompts: await db.all('SELECT p.*, c.name category_name FROM writing_prompts p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC'), cats: await db.all('SELECT id, name FROM categories ORDER BY sort_order') });
  });
  r.post('/newsroom/prompts', async (ctx) => {
    editor(ctx);
    const title = str(ctx.body.title, 140);
    if (title.length < 4) throw bad('اكتب الفكرة.');
    const cat = int(ctx.body.category_id) ? await db.one('SELECT id FROM categories WHERE id = ?', int(ctx.body.category_id)) : null;
    await db.run('INSERT INTO writing_prompts (title, body, category_id, created_at) VALUES (?, ?, ?, ?)', title, str(ctx.body.body, 600), cat ? cat.id : null, db.now());
    ctx.setFlash('ok', 'أُضيفت الفكرة وتظهر الآن للطلبة.');
    return redirect(ctx.res, '/newsroom/prompts');
  });
  r.post('/newsroom/prompts/:id/toggle', async (ctx) => { editor(ctx); await db.run('UPDATE writing_prompts SET is_active = 1 - is_active WHERE id = ?', int(ctx.params.id)); return redirect(ctx.res, '/newsroom/prompts'); });
  r.post('/newsroom/prompts/:id/delete', async (ctx) => { editor(ctx); await db.run('DELETE FROM writing_prompts WHERE id = ?', int(ctx.params.id)); return redirect(ctx.res, '/newsroom/prompts'); });

  // ===== الإعدادات =====
  r.get('/newsroom/settings', async (ctx) => {
    admin(ctx);
    const s = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) s[k] = db.setting(k);
    return V.settingsPage(ctx, s);
  });
  r.post('/newsroom/settings', async (ctx) => {
    admin(ctx);
    const b = ctx.body;
    const t = (k, max) => str(b[k], max);
    const identity = { name: t('identity.name', 60) || DEFAULT_SETTINGS.identity.name, tagline: t('identity.tagline', 120), kicker: t('identity.kicker', 80), description: t('identity.description', 600) };
    const institution = { ministry: t('institution.ministry', 120), directorate: t('institution.directorate', 160), school: t('institution.school', 160) };
    const team = [];
    for (let i = 0; i < 10; i++) {
      const title = t(`team.${i}.title`, 100); const name = t(`team.${i}.name`, 100);
      const slot = ['principal', 'supervisor'].includes(b[`team.${i}.slot`]) ? b[`team.${i}.slot`] : '';
      if (title || name) team.push({ title, name, slot });
    }
    const about = { title: t('about.title', 80) || 'عن المبادرة', body: String(b['about.body'] || '').replace(/\r\n?/g, '\n').trim().slice(0, 5000), goals: String(b['about.goals'] || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 12) };
    const cover = { show_school_photo: !!b['cover.show_school_photo'], show_principal: !!b['cover.show_principal'], show_supervisor: !!b['cover.show_supervisor'], show_headlines: !!b['cover.show_headlines'], headline_count: Math.max(0, Math.min(6, int(b['cover.headline_count'], 4))) };
    const back_cover = { message: t('back_cover.message', 600), invitation: t('back_cover.invitation', 600), show_goals: !!b['back_cover.show_goals'], show_team: !!b['back_cover.show_team'] };
    const publishing = { ...db.setting('publishing'), require_name_consent: !!b['publishing.require_name_consent'], show_views: !!b['publishing.show_views'] };
    await db.tx(async () => {
      for (const [k, v] of Object.entries({ identity, institution, team, about, cover, back_cover, publishing })) await db.setSetting(k, v, ctx.user.id);
    });
    await S.audit(ctx.user.id, 'settings.update', 'settings', null, { require_name_consent: publishing.require_name_consent }, ctx.ip);
    ctx.setFlash('ok', 'حُفظت الإعدادات.');
    return redirect(ctx.res, '/newsroom/settings');
  });

  // ===== فريق التحرير =====
  r.get('/newsroom/staff', async (ctx) => { admin(ctx); return V.staffPage(ctx, await db.all("SELECT * FROM users WHERE role IN ('editor','admin') ORDER BY role, display_name")); });
  r.post('/newsroom/staff', async (ctx) => {
    admin(ctx);
    const name = str(ctx.body.display_name, 80); const username = str(ctx.body.username, 40).toLowerCase();
    const role = ctx.body.role === 'admin' ? 'admin' : 'editor';
    if (name.length < 3) throw bad('اكتب الاسم.');
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('اسم المستخدم: حروف إنجليزية وأرقام فقط.');
    if (await db.one('SELECT 1 FROM users WHERE username = ?', username)) throw bad('اسم المستخدم مستخدم من قبل.');
    const password = S.tempPassword() + S.randomId(2).replace(/[^a-z0-9]/gi, 'x');
    const r2 = await db.run('INSERT INTO users (username, password_hash, role, display_name, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)', username, S.hashPassword(password), role, name, db.now(), db.now());
    await S.audit(ctx.user.id, 'staff.create', 'user', Number(r2.lastInsertRowid), { username, role }, ctx.ip);
    return V.credentials(ctx, { items: [{ name, username, password }] }, 'حساب عضو التحرير');
  });
  const staffRow = async (ctx) => {
    const u = await db.one("SELECT * FROM users WHERE id = ? AND role IN ('editor','admin')", int(ctx.params.id));
    if (!u) throw notFound();
    if (u.id === ctx.user.id) throw bad('لا يمكنك تنفيذ هذا الإجراء على حسابك.');
    return u;
  };
  r.post('/newsroom/staff/:id/toggle', async (ctx) => {
    admin(ctx);
    const u = await staffRow(ctx);
    if (u.is_active && u.role === 'admin' && (await db.one("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND is_active = 1")).n <= 1) throw bad('لا يمكن تعطيل آخر مسؤول.');
    await db.run('UPDATE users SET is_active = ? WHERE id = ?', u.is_active ? 0 : 1, u.id);
    if (u.is_active) await S.destroyUserSessions(u.id);
    await S.audit(ctx.user.id, u.is_active ? 'staff.disable' : 'staff.enable', 'user', u.id, null, ctx.ip);
    return redirect(ctx.res, '/newsroom/staff');
  });
  r.post('/newsroom/staff/:id/reset-password', async (ctx) => {
    admin(ctx);
    const u = await staffRow(ctx);
    const password = S.tempPassword() + S.randomId(2).replace(/[^a-z0-9]/gi, 'x');
    await db.run('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', S.hashPassword(password), u.id);
    await S.destroyUserSessions(u.id);
    await S.audit(ctx.user.id, 'staff.reset_password', 'user', u.id, null, ctx.ip);
    return V.credentials(ctx, { items: [{ name: u.display_name, username: u.username, password }] }, 'كلمة مرور مؤقتة جديدة');
  });

  r.get('/newsroom/audit', async (ctx) => {
    admin(ctx);
    return V.auditPage(ctx, await db.all('SELECT l.*, u.display_name actor_name FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id ORDER BY l.id DESC LIMIT 300'));
  });
};

module.exports.createStudent = createStudent;
