'use strict';
const fs = require('node:fs');
const db = require('../db');
const A = require('../articles');
const V = require('../views/public');
const { notFound, send } = require('../http');
const { ipHash } = require('../security');

const PER = 12;
const seen = new Map(); // ip+article → وقت آخر قراءة (لعدّ القراءات بلا كوكيز تتبّع)
setInterval(() => { const t = Date.now() - 6 * 36e5; for (const [k, v] of seen) if (v < t) seen.delete(k); }, 10 * 60_000).unref();

const pageNum = (q) => Math.max(1, Math.min(500, parseInt(q.page, 10) || 1));

function visibleCats() {
  return db.all(`SELECT c.slug, c.name, (SELECT COUNT(*) FROM articles a WHERE a.category_id = c.id AND ${A.PUBLIC}) n
                 FROM categories c WHERE c.is_visible = 1 ORDER BY c.sort_order, c.id`, db.now());
}

function currentIssue() {
  const id = db.setting('publishing').current_issue_id;
  return id ? db.one("SELECT * FROM issues WHERE id = ? AND status = 'published'", id) : null;
}

module.exports = (r) => {
  r.get('/', (ctx) => {
    const lead = A.listPublic({ sort: 'home', limit: 1 }).rows[0];
    const ex = lead ? lead.id : 0;
    const latest = A.listPublic({ limit: 9, excludeId: ex }).rows;
    const shown = new Set([ex, ...latest.slice(0, 6).map((a) => a.id)]);
    const featured = A.listPublic({ featured: true, limit: 6 }).rows.filter((a) => a.id !== ex).slice(0, 3);
    const rising = A.listPublic({ risingPen: true, limit: 3 }).rows;
    const photo = db.all(`${A.SELECT} WHERE ${A.PUBLIC} AND a.cover_media_id IS NOT NULL ORDER BY a.published_at DESC LIMIT 12`, db.now())
      .filter((a) => !shown.has(a.id)).slice(0, 4);
    const popular = A.listPublic({ sort: 'popular', limit: 5 }).rows.filter((a) => a.views > 0);
    return V.home(ctx, { lead, latest: latest.slice(0, 6), featured, rising, photo, popular, issue: currentIssue(), cats: visibleCats().filter((c) => c.n > 0) });
  });

  r.get('/section/:slug', (ctx) => {
    const cat = db.one('SELECT * FROM categories WHERE slug = ? AND is_visible = 1', ctx.params.slug);
    if (!cat) throw notFound();
    ctx.activeCategory = cat.slug;
    const page = pageNum(ctx.query); const sort = ctx.query.sort === 'popular' ? 'popular' : 'new';
    const { rows, total } = A.listPublic({ category: cat.slug, sort, limit: PER, offset: (page - 1) * PER });
    return V.listing(ctx, { title: cat.name, intro: cat.description, rows, total, page, per: PER, base: `/section/${cat.slug}`, extra: {}, sort });
  });

  r.get('/search', (ctx) => {
    const q = String(ctx.query.q || '').trim().slice(0, 80);
    const cat = String(ctx.query.cat || '').slice(0, 60);
    const sort = ctx.query.sort === 'popular' ? 'popular' : 'new';
    const page = pageNum(ctx.query);
    const cats = db.all('SELECT slug, name FROM categories WHERE is_visible = 1 ORDER BY sort_order');
    const { rows, total } = (q || cat) ? A.listPublic({ q: q || undefined, category: cat || undefined, sort, limit: PER, offset: (page - 1) * PER }) : { rows: [], total: 0 };
    return V.searchPage(ctx, { q, cat, rows, total, page, per: PER, cats, sort });
  });

  const showArticle = (ctx) => {
    const a = A.getPublic(ctx.params.pid);
    if (!a) throw notFound();
    const staff = ctx.user && ctx.user.role !== 'student';
    if (!staff && ctx.user?.id !== a.author_id) {
      const key = `${ipHash(ctx.ip)}:${a.id}`;
      if (!seen.has(key)) { seen.set(key, Date.now()); db.run('UPDATE articles SET views = views + 1 WHERE id = ?', a.id); a.views += 1; }
    }
    const related = a.category_id ? A.listPublic({ category: a.category_slug, limit: 3, excludeId: a.id }).rows : [];
    const prev = db.one(`${A.SELECT} WHERE ${A.PUBLIC} AND a.published_at < ? ORDER BY a.published_at DESC LIMIT 1`, db.now(), a.published_at);
    const next = db.one(`${A.SELECT} WHERE ${A.PUBLIC} AND a.published_at > ? ORDER BY a.published_at ASC LIMIT 1`, db.now(), a.published_at);
    ctx.activeCategory = a.category_slug;
    return V.articlePage(ctx, a, { related, prev, next });
  };
  r.get('/article/:pid', showArticle);
  r.get('/article/:pid/:slug', showArticle);

  r.get('/issues', (ctx) => {
    const issues = db.all(`SELECT i.*, m.public_id cover_pid, (SELECT COUNT(*) FROM articles a WHERE a.issue_id = i.id AND ${A.PUBLIC}) n
      FROM issues i LEFT JOIN media m ON m.id = i.cover_media_id WHERE i.status = 'published' ORDER BY i.number DESC`, db.now());
    return V.issuesPage(ctx, issues);
  });

  r.get('/issue/:number', (ctx) => {
    const issue = db.one("SELECT * FROM issues WHERE number = ? AND status = 'published'", Number(ctx.params.number) || 0);
    if (!issue) throw notFound();
    return V.issuePage(ctx, issue, A.listPublic({ issueId: issue.id, limit: 60, sort: 'home' }).rows);
  });

  const issueFor = (ctx) => {
    const staff = ctx.user && ctx.user.role !== 'student';
    if (ctx.query.issue) {
      const i = db.one(`SELECT i.*, m.public_id cover_pid FROM issues i LEFT JOIN media m ON m.id = i.cover_media_id WHERE i.number = ? ${staff ? '' : "AND i.status = 'published'"}`, Number(ctx.query.issue) || 0);
      if (!i) throw notFound();
      return i;
    }
    const id = db.setting('publishing').current_issue_id;
    return id ? db.one(`SELECT i.*, m.public_id cover_pid FROM issues i LEFT JOIN media m ON m.id = i.cover_media_id WHERE i.id = ? AND i.status = 'published'`, id) : null;
  };

  r.get('/cover', (ctx) => {
    const issue = issueFor(ctx);
    const n = db.setting('cover').headline_count;
    let headlines = issue ? A.listPublic({ issueId: issue.id, limit: n, sort: 'home' }).rows : [];
    if (!headlines.length) headlines = A.listPublic({ sort: 'home', limit: n }).rows;
    return V.coverFront(ctx, { issue, headlines, staff: ctx.user && ctx.user.role !== 'student' });
  });
  r.get('/cover/back', (ctx) => V.coverBack(ctx, { issue: issueFor(ctx) }));
  r.get('/about', (ctx) => V.aboutPage(ctx));

  r.get('/robots.txt', (ctx) => send(ctx.res, 200, 'User-agent: *\nDisallow: /desk\nDisallow: /newsroom\nDisallow: /api\nDisallow: /login\n', 'text/plain; charset=utf-8'));
  // فحص صحة التطبيق لمنصات الاستضافة: قاعدة البيانات ومجلد الصور قابلان للكتابة
  r.get('/healthz', (ctx) => {
    try {
      db.one('SELECT 1 x');
      const dir = require('../config').uploadsDir;
      if (!fs.statSync(dir).isDirectory()) throw new Error('uploads is not a directory');
      fs.accessSync(dir, fs.constants.W_OK);
      return send(ctx.res, 200, 'ok', 'text/plain');
    } catch { return send(ctx.res, 503, 'storage unavailable', 'text/plain'); }
  });
};

module.exports.visibleCats = visibleCats;
