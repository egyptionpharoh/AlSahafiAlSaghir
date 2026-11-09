'use strict';
const { html, raw } = require('../http');
const db = require('../db');
const config = require('../config');
const { publicPage, nib, paperLogo } = require('./layout');
const { fmtDate, byline, renderBody, parseBody, readingLabel, gradeLabel } = require('../content');

const pub = () => db.setting('publishing');
const articleUrl = (a) => `/article/${a.public_id}${a.slug ? '/' + encodeURIComponent(a.slug) : ''}`;

function coverImg(a, sizes = '(max-width: 700px) 100vw, 50vw', eager = false) {
  if (!a.cover_pid) return '';
  return html`<img src="/media/${a.cover_pid}" width="${a.cover_w}" height="${a.cover_h}" alt="${a.cover_caption || a.title}" ${eager ? '' : raw('loading="lazy"')} decoding="async" sizes="${sizes}">`;
}

function card(a, variant = 'std') {
  const by = byline(a, pub());
  return html`<article class="card card--${variant} ${a.cover_pid ? '' : 'card--noimg'}">
    ${a.cover_pid ? html`<a class="card__img" href="${articleUrl(a)}" tabindex="-1" aria-hidden="true">${coverImg(a)}</a>` : ''}
    <div class="card__body">
      ${a.category_name ? html`<a class="kicker" href="/section/${a.category_slug}">${a.category_name}</a>` : ''}
      <h3 class="card__title"><a href="${articleUrl(a)}">${a.title}</a></h3>
      ${variant !== 'mini' && a.summary ? html`<p class="card__sum">${a.summary}</p>` : ''}
      <p class="card__by"><span>${by.text}</span>${by.name ? html`<span class="muted">${by.grade}</span>` : ''}<time datetime="${a.published_at}">${fmtDate(a.published_at)}</time></p>
    </div>
  </article>`;
}

/** دعوة الطلبة للكتابة (تختفي لأعضاء التحرير) */
function writeCta(ctx) {
  if (ctx.user && ctx.user.role !== 'student') return '';
  return html`<aside class="write-cta"><p>✍️ عندك خبر أو فكرة أو قصة من مدرستك؟ اكتبها وأرسلها للجريدة الآن.</p><a class="btn btn--primary" href="/write">اكتب للجريدة</a></aside>`;
}

function empty(title, text) {
  return html`<section class="empty"><div class="empty__mark">${nib('empty__nib')}</div><h2>${title}</h2><p>${text}</p></section>`;
}

function pager(base, page, total, per, extra = {}) {
  const pages = Math.ceil(total / per);
  if (pages <= 1) return '';
  const link = (p) => { const q = new URLSearchParams({ ...extra, page: p }); return `${base}?${q}`; };
  return html`<nav class="pager" aria-label="التنقل بين الصفحات">
    ${page > 1 ? html`<a href="${link(page - 1)}">الأحدث</a>` : html`<span></span>`}
    <span>صفحة ${page} من ${pages}</span>
    ${page < pages ? html`<a href="${link(page + 1)}">الأقدم</a>` : html`<span></span>`}
  </nav>`;
}

// ===== الصفحة الرئيسية =====
function home(ctx, { lead, latest, featured, rising, photo, popular, issue, cats }) {
  const about = db.setting('about');
  if (!lead) {
    return publicPage(ctx, { body: html`
      ${writeCta(ctx)}
      ${empty('الجريدة تستعد لعددها الأول', 'لم يُنشر أي مقال بعد. حين تعتمد هيئة التحرير أول مقالات الطلبة ستظهر هنا.')}
      ${aboutStrip(about)}` });
  }
  const leadBy = byline(lead, pub());
  return publicPage(ctx, { body: html`
  ${writeCta(ctx)}
  <section class="lead ${lead.cover_pid ? '' : 'lead--noimg'}" aria-labelledby="lead-title">
    ${lead.cover_pid ? html`<a class="lead__img" href="${articleUrl(lead)}" tabindex="-1" aria-hidden="true">${coverImg(lead, '(max-width: 900px) 100vw, 60vw', true)}</a>` : ''}
    <div class="lead__text">
      ${lead.category_name ? html`<a class="kicker" href="/section/${lead.category_slug}">${lead.category_name}</a>` : ''}
      <h2 id="lead-title" class="lead__title"><a href="${articleUrl(lead)}">${lead.title}</a></h2>
      ${lead.subtitle ? html`<p class="lead__sub">${lead.subtitle}</p>` : ''}
      ${lead.summary ? html`<p class="lead__sum">${lead.summary}</p>` : ''}
      <p class="byline">${leadBy.photo ? html`<img class="byline__photo" src="/media/${leadBy.photo}" alt="" width="44" height="44">` : ''}<span><b>${leadBy.text}</b>${leadBy.name ? html`<small>${leadBy.grade}</small>` : ''}</span></p>
    </div>
  </section>

  ${issue && issue.intro ? html`<section class="editorial">
    <h2 class="rubric">افتتاحية العدد ${issue.number}</h2>
    <div class="editorial__body">${issue.intro.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</div>
    <p class="editorial__sign">أسرة التحرير</p>
  </section>` : ''}

  <div class="front">
    <section class="front__main" aria-labelledby="latest-h">
      <h2 id="latest-h" class="rubric">أحدث ما نُشر</h2>
      <div class="grid grid--latest">${latest.map((a, i) => card(a, i < 2 ? 'wide' : 'std'))}</div>
    </section>
    <aside class="front__side">
      ${popular.length ? html`<section aria-labelledby="pop-h">
        <h2 id="pop-h" class="rubric">الأكثر قراءة</h2>
        <ol class="ranked">${popular.map((a) => html`<li><a href="${articleUrl(a)}">${a.title}</a><small>${byline(a, pub()).text}</small></li>`)}</ol>
      </section>` : ''}
      <section aria-labelledby="cats-h">
        <h2 id="cats-h" class="rubric">أبواب الجريدة</h2>
        <ul class="catlist">${cats.map((c) => html`<li><a href="/section/${c.slug}">${c.name}</a><span>${c.n}</span></li>`)}</ul>
      </section>
    </aside>
  </div>

  ${featured.length ? html`<section class="band" aria-labelledby="feat-h">
    <h2 id="feat-h" class="rubric">مختارات هيئة التحرير</h2>
    <div class="grid grid--3">${featured.map((a) => card(a))}</div>
  </section>` : ''}

  ${rising.length ? html`<section class="rising" aria-labelledby="rise-h">
    <div class="rising__head">${nib('rising__nib')}<div><h2 id="rise-h">أقلام واعدة</h2><p>كتابات لفتت انتباه هيئة التحرير بلغتها وأفكارها.</p></div></div>
    <div class="grid grid--3">${rising.map((a) => card(a, 'mini'))}</div>
  </section>` : ''}

  ${photo.length ? html`<section aria-labelledby="photo-h">
    <h2 id="photo-h" class="rubric">مشاركات مصوّرة</h2>
    <div class="photostrip">${photo.map((a) => html`<a class="photostrip__item" href="${articleUrl(a)}">${coverImg(a, '(max-width: 700px) 80vw, 25vw')}<span>${a.title}</span></a>`)}</div>
  </section>` : ''}

  ${aboutStrip(about)}
  ` });
}

function aboutStrip(about) {
  return html`<section class="aboutstrip">
    <h2>${about.title}</h2>
    <p>${about.body.split(/\n{2,}/)[0]}</p>
    <a href="/about">تعرّف على المبادرة وأهدافها</a>
  </section>`;
}

// ===== قوائم: القسم / البحث =====
function listing(ctx, { title, intro, rows, total, page, per, base, extra, sort, showSort = true }) {
  return publicPage(ctx, { title, body: html`
  <header class="pagehead">
    <h1>${title}</h1>
    ${intro ? html`<p>${intro}</p>` : ''}
    ${showSort ? html`<nav class="sorter" aria-label="ترتيب المقالات">
      <a href="${base}?${new URLSearchParams({ ...extra, sort: 'new' })}" ${sort !== 'popular' ? raw('aria-current="true"') : ''}>الأحدث</a>
      <a href="${base}?${new URLSearchParams({ ...extra, sort: 'popular' })}" ${sort === 'popular' ? raw('aria-current="true"') : ''}>الأكثر قراءة</a>
    </nav>` : ''}
  </header>
  ${rows.length ? html`<div class="grid grid--3">${rows.map((a) => card(a))}</div>` : empty('لا توجد مقالات هنا بعد', 'جرّب قسمًا آخر أو ابحث بكلمة مختلفة.')}
  ${pager(base, page, total, per, { ...extra, sort })}` });
}

function searchPage(ctx, { q, cat, rows, total, page, per, cats, sort }) {
  return publicPage(ctx, { title: q ? `نتائج البحث: ${q}` : 'البحث', body: html`
  <header class="pagehead">
    <h1>${q ? html`نتائج البحث عن «${q}»` : 'البحث في الجريدة'}</h1>
    <form class="filters" method="get" action="/search">
      <label>كلمة البحث <input type="search" name="q" value="${q}" maxlength="80"></label>
      <label>القسم
        <select name="cat"><option value="">كل الأقسام</option>${cats.map((c) => html`<option value="${c.slug}" ${c.slug === cat ? raw('selected') : ''}>${c.name}</option>`)}</select>
      </label>
      <label>الترتيب
        <select name="sort"><option value="new">الأحدث</option><option value="popular" ${sort === 'popular' ? raw('selected') : ''}>الأكثر قراءة</option></select>
      </label>
      <button type="submit" class="btn">عرض النتائج</button>
    </form>
    ${q || cat ? html`<p class="muted">${total} نتيجة</p>` : ''}
  </header>
  ${rows.length ? html`<div class="grid grid--3">${rows.map((a) => card(a))}</div>` : (q || cat ? empty('لا توجد نتائج مطابقة', 'جرّب كلمة أقصر أو قسمًا آخر.') : '')}
  ${pager('/search', page, total, per, { q, cat, sort })}` });
}

// ===== صفحة المقال =====
function articleBody(a, { preview = false } = {}) {
  const by = byline(a, pub());
  const blocks = parseBody(a.body_json);
  const mediaMap = a._media || {}; // تُحمَّل في المسار عبر A.withMedia
  const date = a.published_at || a.updated_at;
  const identity = db.setting('identity');
  return html`<article class="story ${preview ? 'story--preview' : ''}" itemscope itemtype="https://schema.org/NewsArticle">
    <header class="story__head">
      <p class="story__crumbs">${a.category_name ? (preview ? html`<span class="kicker">${a.category_name}</span>` : html`<a class="kicker" href="/section/${a.category_slug}">${a.category_name}</a>`) : html`<span class="kicker">بلا تصنيف</span>`}${a.issue_number ? html`<span class="muted">العدد ${a.issue_number}</span>` : ''}</p>
      <h1 class="story__title" itemprop="headline">${a.title || 'بلا عنوان'}</h1>
      ${a.subtitle ? html`<p class="story__sub">${a.subtitle}</p>` : ''}
      ${a.summary ? html`<p class="story__lede" itemprop="description">${a.summary}</p>` : ''}
      <div class="byline byline--story">
        ${by.photo ? html`<img class="byline__photo" src="/media/${by.photo}" alt="صورة الكاتب" width="64" height="64">` : html`<span class="byline__mono" aria-hidden="true">${nib('byline__nibmono')}</span>`}
        <div>
          <p class="byline__name" itemprop="author">${by.text}</p>
          <p class="byline__meta">${by.name ? html`<span>${by.grade}</span>` : ''}<time datetime="${date}" itemprop="datePublished">${fmtDate(date)}</time><span>${readingLabel(blocks)}</span></p>
        </div>
      </div>
    </header>
    ${a.cover_pid ? html`<figure class="story__cover">
      <a href="/media/${a.cover_pid}" data-lightbox>${coverImg(a, '(max-width: 900px) 100vw, 900px', true)}</a>
      ${a.cover_caption ? html`<figcaption>${a.cover_caption}</figcaption>` : ''}
    </figure>` : ''}
    <div class="story__body" itemprop="articleBody">${renderBody(blocks, mediaMap)}</div>
    <footer class="story__sign">
      <p class="story__signname">${by.name ? html`${by.name}<small>${by.grade}</small>` : by.text}</p>
      <p class="muted">${a.category_name || ''} — ${fmtDate(date)} — ${identity.name}</p>
    </footer>
  </article>`;
}

function articlePage(ctx, a, { related, prev, next }) {
  const url = articleUrl(a);
  return publicPage(ctx, {
    title: a.title, description: a.summary || a.subtitle, canonical: url, image: a.cover_pid, bodyClass: 'is-article', body: html`
    <div class="storywrap">
      ${articleBody(a)}
      <div class="storytools" data-share-title="${a.title}">
        <button type="button" class="btn btn--ghost" data-share>مشاركة الرابط</button>
        <button type="button" class="btn btn--ghost" data-print>طباعة المقال</button>
        ${pub().show_views && a.views ? html`<span class="muted">عدد القراءات: ${a.views}</span>` : ''}
      </div>
      <nav class="prevnext" aria-label="التنقل بين المقالات">
        ${next ? html`<a class="prevnext__a" href="${articleUrl(next)}"><small>المقال الأحدث</small>${next.title}</a>` : html`<span></span>`}
        ${prev ? html`<a class="prevnext__a prevnext__a--old" href="${articleUrl(prev)}"><small>المقال الأقدم</small>${prev.title}</a>` : html`<span></span>`}
      </nav>
      ${related.length ? html`<section class="related" aria-labelledby="rel-h">
        <h2 id="rel-h" class="rubric">من القسم نفسه</h2>
        <div class="grid grid--3">${related.map((r) => card(r, 'mini'))}</div>
      </section>` : ''}
    </div>` });
}

// ===== الأعداد =====
function issuesPage(ctx, issues) {
  return publicPage(ctx, { title: 'أعداد الجريدة', body: html`
    <header class="pagehead"><h1>أعداد الجريدة</h1><p>كل عدد يجمع مقالات طلابية حول موضوع واحد، ويبقى متاحًا في الأرشيف.</p></header>
    ${issues.length ? html`<div class="issues">${issues.map((i) => html`<a class="issuecard" href="/issue/${i.number}">
      <span class="issuecard__img">${i.cover_pid ? html`<img src="/media/${i.cover_pid}" alt="" loading="lazy">` : html`<span class="issuecard__num">${i.number}</span>`}</span>
      <span class="issuecard__t"><small>العدد ${i.number}${i.published_at ? ` — ${fmtDate(i.published_at)}` : ''}</small><b>${i.title}</b>${i.theme ? html`<span>${i.theme}</span>` : ''}<em>${i.n} مقال</em></span>
    </a>`)}</div>` : empty('لم تصدر أعداد بعد', 'تُعرض المقالات المنشورة في الصفحة الرئيسية إلى أن يصدر العدد الأول.')}` });
}

function issuePage(ctx, issue, rows) {
  return publicPage(ctx, { title: `العدد ${issue.number}: ${issue.title}`, body: html`
    <header class="pagehead pagehead--issue">
      <p class="kicker">العدد ${issue.number}${issue.published_at ? ` — ${fmtDate(issue.published_at)}` : ''}</p>
      <h1>${issue.title}</h1>
      ${issue.theme ? html`<p class="lead__sub">${issue.theme}</p>` : ''}
      <p><a class="btn btn--ghost" href="/cover?issue=${issue.number}">غلاف العدد</a></p>
    </header>
    ${issue.intro ? html`<section class="editorial"><h2 class="rubric">افتتاحية العدد</h2><div class="editorial__body">${issue.intro.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</div><p class="editorial__sign">أسرة التحرير</p></section>` : ''}
    ${rows.length ? html`<div class="grid grid--3">${rows.map((a) => card(a))}</div>` : empty('لا توجد مقالات منشورة في هذا العدد بعد', '')}` });
}

// ===== الغلاف الأمامي =====
function portrait(slot, member, assets) {
  const pid = assets[`photo_${slot}`];
  const initial = (member.name || '').replace(/^(أ|د|م)\.\s*/, '').trim().charAt(0);
  return html`<figure class="cv-person">
    ${pid ? html`<img src="/media/${pid}" alt="${member.name}" width="160" height="160">` : html`<span class="cv-person__mono" aria-hidden="true">${initial}</span>`}
    <figcaption><b>${member.name}</b><small>${member.title}</small></figcaption>
  </figure>`;
}

function coverFront(ctx, { issue, headlines, staff }) {
  const identity = db.setting('identity');
  const inst = db.setting('institution');
  const assets = db.setting('assets');
  const cov = db.setting('cover');
  const team = db.setting('team');
  const bySlot = (s) => team.find((m) => m.slot === s);
  const heroPid = (issue && issue.cover_pid) || (cov.show_school_photo ? assets.photo_school : null);
  const date = issue && issue.published_at ? fmtDate(issue.published_at) : fmtDate(new Date().toISOString());
  const missing = staff ? [
    !assets.photo_school && 'صورة المدرسة', !assets.photo_supervisor && 'صورة المعلم المشرف', !assets.photo_principal && 'صورة مدير المدرسة',
  ].filter(Boolean) : [];
  return publicPage(ctx, { title: issue ? `غلاف العدد ${issue.number}` : 'الغلاف', bodyClass: 'is-cover', body: html`
  ${missing.length ? html`<p class="flash flash--info noprint">للمحررين: لم تُرفع بعد ${missing.join('، ')}. ارفعها من <a href="/newsroom/settings#assets">إعدادات الجريدة</a>. (هذه الملاحظة لا تظهر للقراء)</p>` : ''}
  <div class="covertools noprint"><a class="btn btn--ghost" href="/cover/back${issue ? `?issue=${issue.number}` : ''}">الغلاف الخلفي</a><button type="button" class="btn btn--ghost" data-print>طباعة / حفظ PDF</button></div>
  <section class="cover" aria-label="الغلاف الأمامي">
    <div class="cover__inst">
      ${assets.logo_ministry ? html`<img src="/media/${assets.logo_ministry}" alt="">` : ''}
      <p><span>${inst.ministry}</span><span>${inst.directorate}</span><span>${inst.school}</span></p>
      ${assets.logo_school ? html`<img src="/media/${assets.logo_school}" alt="">` : ''}
    </div>
    <header class="cover__mast">
      ${paperLogo('cover__nib')}
      <h1 class="cover__title">${identity.name}</h1>
      <p class="cover__kicker">${identity.kicker}</p>
    </header>
    <div class="cover__issue">
      <span>${issue ? `العدد ${issue.number}` : 'إصدار مستمر'}</span>
      <span>${date}</span>
      ${issue && issue.theme ? html`<span>${issue.theme}</span>` : ''}
    </div>
    <div class="cover__hero ${heroPid ? '' : 'cover__hero--type'}">
      ${heroPid ? html`<img src="/media/${heroPid}" alt="${issue && issue.cover_pid ? issue.title : inst.school}">`
    : html`<p class="cover__motto" aria-hidden="true">${identity.tagline}</p>`}
      ${issue ? html`<p class="cover__theme"><b>${issue.title}</b></p>` : ''}
    </div>
    ${cov.show_headlines && headlines.length ? html`<ol class="cover__lines">${headlines.map((a) => html`<li><a href="${articleUrl(a)}"><small>${a.category_name || ''}</small>${a.title}</a></li>`)}</ol>` : ''}
    <footer class="cover__people">
      ${cov.show_principal && bySlot('principal') ? portrait('principal', bySlot('principal'), assets) : ''}
      <p class="cover__slogan">${identity.tagline}</p>
      ${cov.show_supervisor && bySlot('supervisor') ? portrait('supervisor', bySlot('supervisor'), assets) : ''}
    </footer>
  </section>` });
}

function coverBack(ctx, { issue }) {
  const identity = db.setting('identity');
  const inst = db.setting('institution');
  const about = db.setting('about');
  const back = db.setting('back_cover');
  const team = db.setting('team');
  const assets = db.setting('assets');
  const url = config.baseUrl || '';
  return publicPage(ctx, { title: 'الغلاف الخلفي', bodyClass: 'is-cover', body: html`
  <div class="covertools noprint"><a class="btn btn--ghost" href="/cover${issue ? `?issue=${issue.number}` : ''}">الغلاف الأمامي</a><button type="button" class="btn btn--ghost" data-print>طباعة / حفظ PDF</button></div>
  <section class="cover cover--back" aria-label="الغلاف الخلفي">
    <div class="back__quote">
      ${nib('back__nib')}
      <p>${back.message}</p>
    </div>
    ${back.show_goals ? html`<div class="back__goals"><h2>لماذا «${identity.name}»؟</h2><ul>${about.goals.map((g) => html`<li>${g}</li>`)}</ul></div>` : ''}
    ${back.show_team ? html`<div class="back__team"><h2>هيئة الإشراف والتحرير</h2>
      <dl>${team.map((m) => html`<div><dt>${m.title}</dt><dd>${m.name}</dd></div>`)}</dl></div>` : ''}
    <div class="back__invite"><h2>اكتب معنا في العدد القادم</h2><p>${back.invitation}</p></div>
    <footer class="back__foot">
      ${assets.photo_school ? html`<img class="back__school" src="/media/${assets.photo_school}" alt="${inst.school}">` : ''}
      <p><b>${inst.school}</b><span>${inst.directorate}</span><span>${inst.ministry}</span>${url ? html`<span class="back__url" dir="ltr">${url.replace(/^https?:\/\//, '')}</span>` : ''}</p>
      <p class="back__brand">${paperLogo('back__brandnib')}<span>${identity.name}</span></p>
    </footer>
  </section>` });
}

function aboutPage(ctx) {
  const about = db.setting('about');
  const team = db.setting('team');
  const inst = db.setting('institution');
  const identity = db.setting('identity');
  return publicPage(ctx, { title: about.title, body: html`
  <article class="story story--about">
    <header class="story__head"><h1 class="story__title">${about.title}</h1><p class="story__lede">${identity.description}</p></header>
    <div class="story__body">
      ${about.body.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}
      <h2>أهداف المبادرة</h2>
      <ul>${about.goals.map((g) => html`<li>${g}</li>`)}</ul>
      <h2>كيف يُنشر المقال؟</h2>
      <ol>
        <li>يكتب الطالب مقاله في مكتبه الصحفي ويرفق صوره.</li>
        <li>يرسله إلى هيئة التحرير للمراجعة.</li>
        <li>تراجع الهيئة النص والصور، وقد تعيده إلى الطالب بملاحظات لتحسينه.</li>
        <li>بعد الاعتماد يُنشر المقال في الجريدة باسم كاتبه.</li>
      </ol>
      <h2>هيئة الإشراف والتحرير</h2>
      <dl class="teamlist">${team.map((m) => html`<div><dt>${m.title}</dt><dd>${m.name}</dd></div>`)}</dl>
      <p class="muted">${inst.school} — ${inst.directorate} — ${inst.ministry}</p>
    </div>
  </article>` });
}

module.exports = { home, listing, searchPage, articlePage, articleBody, issuesPage, issuePage, coverFront, coverBack, aboutPage, card, articleUrl, empty, gradeLabel };
