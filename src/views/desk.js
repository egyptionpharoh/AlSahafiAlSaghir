'use strict';
const { html, raw } = require('../http');
const db = require('../db');
const { workPage, plainPage, csrfField, stamp, nib } = require('./layout');
const { fmtDateTime, fmtDate, gradeLabel } = require('../content');
const { articleBody, articleUrl } = require('./public');

const FILTERS = [
  ['all', 'كل مقالاتي', null],
  ['draft', 'المسودات', ['draft']],
  ['review', 'قيد المراجعة', ['submitted', 'in_review']],
  ['fix', 'تحتاج إلى تعديل', ['changes_requested']],
  ['approved', 'معتمدة', ['approved']],
  ['published', 'منشورة', ['published']],
  ['closed', 'مرفوضة أو مؤرشفة', ['rejected', 'archived']],
];

/** JSON داخل الصفحة بأمان (منع إغلاق وسم script) */
function jsonScript(id, obj) {
  const s = JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return raw(`<script type="application/json" id="${id}">${s}</script>`);
}

function deskNav(ctx, current) {
  const items = [['/desk', 'مقالاتي', 'home'], ['/desk/ideas', 'غرفة الأفكار', 'ideas'], ['/desk/profile', 'ملفي', 'profile']];
  return html`<nav class="worknav" aria-label="غرفة الطالب"><div class="worknav__in">
    ${items.map(([href, label, key]) => html`<a href="${href}" ${current === key ? raw('aria-current="page"') : ''}>${label}</a>`)}
  </div></nav>`;
}

function newArticleForm(ctx, { categoryId, title, label = 'اكتب مقالًا جديدًا', cls = 'btn btn--primary btn--big' } = {}) {
  return html`<form method="post" action="/desk/articles">${csrfField(ctx)}
    ${categoryId ? html`<input type="hidden" name="category_id" value="${categoryId}">` : ''}
    ${title ? html`<input type="hidden" name="title" value="${title}">` : ''}
    <button type="submit" class="${cls}">${label}</button></form>`;
}

function dashboard(ctx, { student, rows, counts, filter, prompts, notesByArticle }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pubCount = counts.published || 0;
  const cnt = (keys) => (keys ? keys.reduce((s, k) => s + (counts[k] || 0), 0) : total);
  return workPage(ctx, { title: 'مكتبي الصحفي', area: 'desk', nav: deskNav(ctx, 'home'), body: html`
  <section class="deskhead">
    <div>
      <p class="muted">${fmtDate(new Date().toISOString())}</p>
      <h1>أهلًا بك يا ${ctx.user.display_name}</h1>
      <p class="deskhead__grade">${gradeLabel(student.grade, student.section)}</p>
    </div>
    ${newArticleForm(ctx)}
  </section>

  <div class="deskgrid">
    <section aria-labelledby="mine-h">
      <h2 id="mine-h" class="sr">مقالاتي</h2>
      <nav class="tabs" aria-label="تصفية المقالات">
        ${FILTERS.map(([k, label, keys]) => html`<a href="/desk?f=${k}" ${filter === k ? raw('aria-current="page"') : ''}>${label}<span>${cnt(keys)}</span></a>`)}
      </nav>
      ${rows.length ? html`<ul class="mylist">${rows.map((a) => html`<li class="mylist__item">
        <div class="mylist__main">
          ${stamp(a.status)}
          <h3><a href="${['draft', 'changes_requested'].includes(a.status) ? `/desk/articles/${a.public_id}/edit` : `/desk/articles/${a.public_id}/preview`}">${a.title || 'مقال بلا عنوان'}</a></h3>
          <p class="muted">${a.category_name || 'بلا تصنيف'} — آخر تحديث ${fmtDateTime(a.updated_at)}${a.status === 'published' && a.published_at > db.now() ? html` — <b>يُنشر في ${fmtDateTime(a.published_at)}</b>` : ''}</p>
          ${notesByArticle[a.id] ? html`<p class="mylist__note"><b>ملاحظة التحرير:</b> ${notesByArticle[a.id]}</p>` : ''}
        </div>
        <div class="mylist__act">
          ${['draft', 'changes_requested'].includes(a.status) ? html`<a class="btn btn--small" href="/desk/articles/${a.public_id}/edit">${a.status === 'changes_requested' ? 'عدّل المقال' : 'تابع الكتابة'}</a>` : ''}
          <a class="btn btn--small btn--ghost" href="/desk/articles/${a.public_id}/preview">معاينة</a>
          ${a.status === 'published' && a.published_at <= db.now() ? html`<a class="btn btn--small btn--ghost" href="${articleUrl(a)}">في الجريدة</a>` : ''}
        </div>
      </li>`)}</ul>` : html`<div class="empty empty--desk">
        ${nib('empty__nib')}
        <h3>${filter === 'all' ? 'مكتبك جاهز لأول مقال' : 'لا توجد مقالات في هذا القسم'}</h3>
        <p>${filter === 'all' ? 'ابدأ بفكرة بسيطة من حولك: خبر من مدرستك، تجربة عشتها، أو سؤال يشغلك.' : ''}</p>
      </div>`}
    </section>

    <aside class="deskside">
      <section class="presscard" aria-labelledby="pc-h">
        <p class="presscard__top">${nib('presscard__nib')}<span>بطاقة صحفي</span></p>
        <h2 id="pc-h">${ctx.user.display_name}</h2>
        <p>${gradeLabel(student.grade, student.section)}</p>
        <dl>
          <div><dt>منشورة</dt><dd>${pubCount}</dd></div>
          <div><dt>قيد المراجعة</dt><dd>${(counts.submitted || 0) + (counts.in_review || 0)}</dd></div>
          <div><dt>كل المقالات</dt><dd>${total}</dd></div>
        </dl>
      </section>
      ${prompts.length ? html`<section class="ideas" aria-labelledby="ideas-h">
        <h2 id="ideas-h">أفكار تنتظر قلمك</h2>
        ${prompts.slice(0, 3).map((p) => html`<div class="idea"><b>${p.title}</b>${p.category_name ? html`<small>${p.category_name}</small>` : ''}</div>`)}
        <a href="/desk/ideas">كل الأفكار</a>
      </section>` : ''}
      <section class="tips">
        <h2>قبل أن ترسل مقالك</h2>
        <ul>
          <li>عنوان قصير واضح يجذب القارئ.</li>
          <li>مقدمة تجيب: ماذا حدث؟ أين؟ ومتى؟</li>
          <li>صور من تصويرك، مع وصف لكل صورة.</li>
          <li>اذكر مصدر أي معلومة نقلتها.</li>
        </ul>
      </section>
    </aside>
  </div>` });
}

function ideasPage(ctx, prompts) {
  return workPage(ctx, { title: 'غرفة الأفكار', area: 'desk', nav: deskNav(ctx, 'ideas'), body: html`
    <header class="pagehead"><h1>غرفة الأفكار</h1><p>موضوعات تقترحها هيئة التحرير. اختر فكرة وابدأ مقالك منها، أو اكتب في موضوع من اختيارك.</p></header>
    ${prompts.length ? html`<div class="ideagrid">${prompts.map((p) => html`<article class="ideacard">
      ${p.category_name ? html`<p class="kicker">${p.category_name}</p>` : ''}
      <h2>${p.title}</h2>
      ${p.body ? html`<p>${p.body}</p>` : ''}
      ${newArticleForm(ctx, { categoryId: p.category_id, title: p.title, label: 'ابدأ مقالًا بهذه الفكرة', cls: 'btn btn--small' })}
    </article>`)}</div>` : html`<div class="empty empty--desk"><h3>لا توجد أفكار مقترحة حاليًا</h3><p>يمكنك كتابة مقال في أي موضوع يهمك.</p>${newArticleForm(ctx)}</div>`}` });
}

/** المحرر — مشترك بين الطالب (mode=student) والمحرر (mode=editor) */
function editorPage(ctx, { article, blocks, media, categories, notes, mode, author }) {
  const cover = article.cover_pid ? { pid: article.cover_pid, w: article.cover_w, h: article.cover_h } : null;
  const isEditor = mode === 'editor';
  const data = {
    mode, pid: article.public_id, status: article.status,
    title: article.title, subtitle: article.subtitle, summary: article.summary,
    categoryId: article.category_id, cover, coverCaption: article.cover_caption,
    blocks, media,
    endpoints: isEditor
      ? { save: `/api/newsroom/articles/${article.public_id}`, upload: `/api/media?article=${article.public_id}` }
      : { save: `/api/desk/articles/${article.public_id}`, upload: `/api/media?article=${article.public_id}` },
    updatedAt: article.updated_at,
  };
  const back = isEditor ? `/newsroom/articles/${article.public_id}` : '/desk';
  return workPage(ctx, { title: `تحرير: ${article.title || 'مقال جديد'}`, area: isEditor ? 'newsroom' : 'desk', nav: isEditor ? '' : deskNav(ctx, 'home'), body: html`
  ${jsonScript('article-data', data)}
  <meta name="csrf" content="${ctx.csrf}">
  <div class="edbar" role="region" aria-label="أدوات الحفظ">
    <a class="edbar__back" href="${back}">رجوع</a>
    <span class="edbar__status" data-save-status aria-live="polite">${isEditor ? 'تعديل تحريري — احفظ يدويًا' : 'محفوظ'}</span>
    <div class="edbar__btns">
      <a class="btn btn--small btn--ghost" href="${isEditor ? `/newsroom/articles/${article.public_id}/preview` : `/desk/articles/${article.public_id}/preview`}" data-preview>معاينة</a>
      <button type="button" class="btn btn--small" data-save>حفظ</button>
    </div>
  </div>

  ${notes.length ? html`<section class="notes" aria-labelledby="notes-h">
    <h2 id="notes-h">ملاحظات هيئة التحرير</h2>
    ${notes.map((n) => html`<blockquote class="note"><p>${n.body}</p><footer>${n.author_name || 'هيئة التحرير'} — ${fmtDateTime(n.created_at)}</footer></blockquote>`)}
  </section>` : ''}

  ${isEditor ? html`<section class="notes notes--editor">
    <h2>تعديل تحريري</h2>
    <p>عدّل الأخطاء اللغوية والصياغة المحدودة فقط، دون تغيير مضمون الطالب أو نسبة كلام إليه لم يكتبه. النسخة الأصلية محفوظة في سجل النسخ.</p>
    <label class="field">سبب التعديل (يُحفظ في السجل) <input type="text" id="edit-note" maxlength="300" placeholder="مثال: تصحيح أخطاء إملائية في الفقرة الثانية" required></label>
  </section>` : ''}

  <form class="editor" id="editor" novalidate>
    <section class="authorcard" aria-label="بيانات الكاتب">
      ${author.photo_pid ? html`<img src="/media/${author.photo_pid}" alt="" width="56" height="56">` : html`<span class="byline__mono">${nib('byline__nibmono')}</span>`}
      <div><b>${author.display_name}</b><small>${gradeLabel(author.grade, author.section)}</small></div>
      <p class="muted">${isEditor ? 'بيانات الكاتب مرتبطة بحسابه ولا يمكن تغييرها من المحرر.' : 'تُملأ بيانات الكاتب تلقائيًا من حسابك.'}</p>
    </section>

    <div class="field">
      <label for="f-title">عنوان المقال</label>
      <input id="f-title" name="title" type="text" maxlength="140" autocomplete="off" placeholder="مثال: طلاب الصف السابع يزرعون حديقة المدرسة">
      <p class="hint">العنوان الصحفي قصير، فيه فعل، ويخبر القارئ بأهم ما في المقال.</p>
    </div>
    <div class="field">
      <label for="f-subtitle">عنوان فرعي <span class="opt">اختياري</span></label>
      <input id="f-subtitle" name="subtitle" type="text" maxlength="200" autocomplete="off">
    </div>
    <div class="field">
      <label for="f-category">التصنيف</label>
      <select id="f-category" name="category">
        <option value="">اختر تصنيفًا</option>
        ${categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}
      </select>
    </div>
    <div class="field">
      <label for="f-summary">المقدمة</label>
      <textarea id="f-summary" name="summary" rows="3" maxlength="600" placeholder="جملتان تلخصان المقال: ماذا؟ أين؟ متى؟ ولماذا يهم القارئ؟"></textarea>
      <p class="hint"><span data-count="f-summary">0</span> / 600</p>
    </div>

    <fieldset class="field coverfield">
      <legend>صورة الغلاف <span class="opt">اختياري</span></legend>
      <div class="coverfield__box" data-cover-box></div>
      <div class="coverfield__btns">
        <label class="btn btn--small btn--ghost filebtn">اختر صورة<input type="file" accept="image/*" data-cover-input hidden></label>
        <button type="button" class="btn btn--small btn--ghost" data-cover-remove hidden>إزالة الصورة</button>
      </div>
      <label class="field field--inline" for="f-covercap">وصف صورة الغلاف</label>
      <input id="f-covercap" type="text" maxlength="300" placeholder="ماذا تُظهر الصورة؟ ومن التقطها؟">
    </fieldset>

    <section class="field">
      <h2 class="field__h">نص المقال</h2>
      <p class="hint">اكتب فقرة في كل مربع. لتنسيق كلمة حددها ثم اضغط «عريض» أو «مائل». أضف الصور بين الفقرات من الأزرار أسفل النص.</p>
      <div class="blocks" data-blocks></div>
      <div class="addbar" role="toolbar" aria-label="إضافة إلى المقال">
        <button type="button" data-add="p">+ فقرة</button>
        <button type="button" data-add="h2">+ عنوان</button>
        <button type="button" data-add="h3">+ عنوان فرعي</button>
        <button type="button" data-add="quote">+ اقتباس</button>
        <button type="button" data-add="ul">+ قائمة</button>
        <label class="addbar__img">+ صورة<input type="file" accept="image/*" multiple data-add-image hidden></label>
      </div>
      <p class="hint" data-wordcount></p>
    </section>
  </form>

  ${!isEditor ? html`<section class="submitbox" aria-labelledby="sub-h">
    <h2 id="sub-h">إرسال المقال إلى هيئة التحرير</h2>
    <ul class="checklist" data-checklist></ul>
    <p>بعد الإرسال لن تستطيع التعديل إلا إذا أعادت هيئة التحرير المقال إليك. لا يُنشر المقال إلا بعد اعتماده.</p>
    <form method="post" action="/desk/articles/${article.public_id}/submit" data-submit-form>${csrfField(ctx)}
      <button type="submit" class="btn btn--primary">إرسال للمراجعة</button>
    </form>
    ${article.status === 'draft' ? html`<form method="post" action="/desk/articles/${article.public_id}/delete" data-confirm="هل تريد حذف هذه المسودة نهائيًا؟ لا يمكن التراجع.">${csrfField(ctx)}
      <button type="submit" class="btn btn--link btn--danger">حذف المسودة</button></form>` : ''}
  </section>` : html`<div class="submitbox"><button type="button" class="btn btn--primary" data-save>حفظ التعديل التحريري</button></div>`}
  <script src="/static/js/editor.js" defer></script>` });
}

function previewPage(ctx, { article, notes, events, mode }) {
  const isEditor = mode === 'editor';
  const nav = isEditor ? '' : deskNav(ctx, 'home');
  return workPage(ctx, { title: `معاينة: ${article.title}`, area: isEditor ? 'newsroom' : 'desk', nav, body: html`
    <div class="previewbar">
      <p>${stamp(article.status)} <span>معاينة — هكذا سيظهر المقال للقراء بعد نشره.</span></p>
      <div>
        ${!isEditor && ['draft', 'changes_requested'].includes(article.status) ? html`<a class="btn btn--small" href="/desk/articles/${article.public_id}/edit">رجوع للتحرير</a>` : ''}
        ${!isEditor && article.status === 'submitted' ? html`<form method="post" action="/desk/articles/${article.public_id}/withdraw" class="inline">${csrfField(ctx)}<button class="btn btn--small btn--ghost">سحب من المراجعة للتعديل</button></form>` : ''}
        <a class="btn btn--small btn--ghost" href="${isEditor ? `/newsroom/articles/${article.public_id}` : '/desk'}">رجوع</a>
      </div>
    </div>
    ${notes && notes.length ? html`<section class="notes"><h2>ملاحظات هيئة التحرير</h2>${notes.map((n) => html`<blockquote class="note"><p>${n.body}</p><footer>${fmtDateTime(n.created_at)}</footer></blockquote>`)}</section>` : ''}
    <div class="paperframe">${articleBody(article, { preview: true })}</div>
    ${events && events.length ? html`<section class="timeline"><h2>مسار المقال</h2><ol>${events.map((e) => html`<li><time>${fmtDateTime(e.created_at)}</time> ${e.label}</li>`)}</ol></section>` : ''}
  ` });
}

function profilePage(ctx, { student, photoPid, pubSettings }) {
  return workPage(ctx, { title: 'ملفي', area: 'desk', nav: deskNav(ctx, 'profile'), body: html`
  <meta name="csrf" content="${ctx.csrf}">
  <header class="pagehead"><h1>ملفي الصحفي</h1></header>
  <div class="profile">
    <section class="profile__photo">
      <div class="profile__frame" data-photo-frame>${photoPid ? html`<img src="/media/${photoPid}" alt="صورتي" width="180" height="180">` : html`<span class="profile__empty">لا توجد صورة</span>`}</div>
      <label class="btn btn--small filebtn">${photoPid ? 'استبدال الصورة' : 'رفع صورة شخصية'}<input type="file" accept="image/*" data-upload="profile" data-target="/api/profile-photo" hidden></label>
      ${photoPid ? html`<form method="post" action="/desk/profile/photo/remove">${csrfField(ctx)}<button class="btn btn--link btn--danger">إزالة الصورة</button></form>` : ''}
      <p class="hint" data-upload-status></p>
    </section>
    <section class="profile__info">
      <dl class="facts">
        <div><dt>الاسم</dt><dd>${ctx.user.display_name}</dd></div>
        <div><dt>الصف</dt><dd>${gradeLabel(student.grade, student.section)}</dd></div>
        <div><dt>اسم المستخدم</dt><dd dir="ltr">${ctx.user.username}</dd></div>
      </dl>
      <p class="hint">لتصحيح الاسم أو الصف تواصل مع مشرف الجريدة.</p>
      <div class="consentbox">
        <h2>ماذا يظهر للقراء؟</h2>
        <ul>
          <li>اسمك في توقيع المقال: ${!pubSettings.require_name_consent || student.consent_name_public ? html`<b>يظهر</b>` : html`<b>لا يظهر</b> — يُكتب بدلًا منه «طالب من ${gradeLabel(student.grade)}» حتى تسجل المدرسة موافقة ولي أمرك.`}</li>
          <li>صورتك الشخصية: ${student.consent_photo_public && (!pubSettings.require_name_consent || student.consent_name_public) ? html`<b>تظهر</b> بجوار اسمك في مقالاتك المنشورة.` : html`<b>لا تظهر</b> للقراء حتى تسجل المدرسة موافقة ولي أمرك.`}</li>
          <li>لا يظهر للقراء أبدًا: اسم المستخدم، أو أي بيانات اتصال.</li>
        </ul>
      </div>
    </section>
  </div>
  <script src="/static/js/media.js" defer></script>` });
}

function loginPage(ctx, { preToken, username = '', next = '' }) {
  return plainPage(ctx, { title: 'دخول الكتّاب والمحررين', body: html`
    <h1 class="plain__title">دخول الكتّاب والمحررين</h1>
    <form method="post" action="/login" class="stack">
      <input type="hidden" name="_pre" value="${preToken}">
      <input type="hidden" name="next" value="${next}">
      <label class="field">اسم المستخدم <input name="username" autocomplete="username" required maxlength="60" value="${username}" dir="ltr" autocapitalize="none" spellcheck="false"></label>
      <label class="field">كلمة المرور <input name="password" type="password" autocomplete="current-password" required maxlength="200" dir="ltr"></label>
      <button type="submit" class="btn btn--primary btn--block">دخول</button>
    </form>
    <p class="hint">لا تملك حسابًا؟ يُنشئ مشرف الجريدة حسابات الطلبة. نسيت كلمة المرور؟ اطلب من المشرف إعادة تعيينها.</p>
    <p><a href="/">العودة إلى الجريدة</a></p>` });
}

function passwordPage(ctx, { forced }) {
  return plainPage(ctx, { title: 'تغيير كلمة المرور', body: html`
    <h1 class="plain__title">${forced ? 'اختر كلمة مرور خاصة بك' : 'تغيير كلمة المرور'}</h1>
    ${forced ? html`<p>هذه أول مرة تدخل فيها بكلمة المرور المؤقتة. اختر كلمة مرور جديدة لا يعرفها غيرك.</p>` : ''}
    <form method="post" action="/account/password" class="stack">${csrfField(ctx)}
      <label class="field">كلمة المرور الحالية <input name="current" type="password" autocomplete="current-password" required dir="ltr"></label>
      <label class="field">كلمة المرور الجديدة <input name="password" type="password" autocomplete="new-password" required minlength="8" dir="ltr"></label>
      <label class="field">أعد كتابة كلمة المرور الجديدة <input name="confirm" type="password" autocomplete="new-password" required minlength="8" dir="ltr"></label>
      <p class="hint">${ctx.user.role === 'student' ? '8 أحرف على الأقل' : '10 أحرف على الأقل'}، وتحتوي على أحرف وأرقام.</p>
      <button type="submit" class="btn btn--primary btn--block">حفظ كلمة المرور</button>
    </form>
    ${!forced ? html`<p><a href="${ctx.user.role === 'student' ? '/desk' : '/newsroom'}">رجوع</a></p>` : html`<form method="post" action="/logout">${csrfField(ctx)}<button class="btn btn--link">تسجيل الخروج</button></form>`}` });
}

module.exports = { dashboard, ideasPage, editorPage, previewPage, profilePage, loginPage, passwordPage, FILTERS, jsonScript };
