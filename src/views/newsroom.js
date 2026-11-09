'use strict';
const { html, raw } = require('../http');
const db = require('../db');
const config = require('../config');
const { workPage, csrfField, stamp } = require('./layout');
const { fmtDateTime, fmtDate, gradeLabel } = require('../content');
const { articleBody, articleUrl } = require('./public');
const { jsonScript } = require('./desk');
const { STATUS, GRADE_NAMES } = require('../defaults');
const { ACTIONS } = require('../articles');

const isAdmin = (ctx) => ctx.user.role === 'admin';

function sideNav(ctx, current) {
  const queue = ctx.queueCount || 0; // يُحسب في app.js لأعضاء التحرير
  const items = [
    ['/newsroom', 'لوحة المتابعة', 'dash'],
    ['/newsroom/articles?f=queue', 'بانتظار المراجعة', 'queue', queue],
    ['/newsroom/articles', 'كل المقالات', 'articles'],
    ['/newsroom/issues', 'الأعداد والغلاف', 'issues'],
    ['/newsroom/categories', 'التصنيفات', 'categories'],
    ['/newsroom/prompts', 'غرفة الأفكار', 'prompts'],
  ];
  if (isAdmin(ctx)) {
    items.push(['/newsroom/students', 'الطلبة والموافقات', 'students'], ['/newsroom/settings', 'إعدادات الجريدة', 'settings'],
      ['/newsroom/staff', 'فريق التحرير', 'staff'], ['/newsroom/audit', 'سجل العمليات', 'audit']);
  }
  return html`<nav class="worknav worknav--newsroom" aria-label="غرفة التحرير"><div class="worknav__in">
    ${items.map(([href, label, key, badge]) => html`<a href="${href}" ${current === key ? raw('aria-current="page"') : ''}>${label}${badge ? html`<span class="badge">${badge}</span>` : ''}</a>`)}
  </div></nav>`;
}

const page = (ctx, current, title, body, wide = true) => workPage(ctx, { title, area: 'newsroom', nav: sideNav(ctx, current), body, wide });

function bars(rows, labelKey, max) {
  const top = max || Math.max(1, ...rows.map((r) => r.n));
  return html`<table class="bars"><tbody>${rows.map((r) => html`<tr><th scope="row">${r[labelKey]}</th><td><span class="bars__bar" data-w="${Math.round((r.n / top) * 100)}"></span></td><td class="bars__n">${r.n}</td></tr>`)}</tbody></table>`;
}

// ===== لوحة المتابعة =====
function dashboard(ctx, s) {
  const tiles = [
    ['كل المقالات', s.total, '/newsroom/articles'],
    ['بانتظار المراجعة', s.queue, '/newsroom/articles?f=queue'],
    ['تحتاج إلى تعديل', s.status.changes_requested || 0, '/newsroom/articles?f=changes_requested'],
    ['معتمدة لم تُنشر', s.status.approved || 0, '/newsroom/articles?f=approved'],
    ['منشورة', s.status.published || 0, '/newsroom/articles?f=published'],
    ['طلبة شاركوا بمقال', s.writers, isAdmin(ctx) ? '/newsroom/students' : null],
  ];
  return page(ctx, 'dash', 'لوحة المتابعة', html`
  <header class="pagehead pagehead--row"><h1>لوحة المتابعة</h1><a class="btn btn--small btn--ghost" href="/cover">عرض الغلاف</a></header>
  <section class="tiles" aria-label="أرقام الجريدة">${tiles.map(([l, n, href]) => html`<${raw(href ? 'a' : 'div')} class="tile" ${href ? raw(`href="${href}"`) : ''}><b>${n}</b><span>${l}</span></${raw(href ? 'a' : 'div')}>`)}</section>
  <p class="hint">الأرقام محسوبة مباشرة من قاعدة البيانات. ${s.activeStudents} حساب طالب نشط.</p>
  <div class="dashgrid">
    <section class="panel"><h2>أحدث المقالات المرسلة</h2>
      ${s.recentQueue.length ? html`<ul class="qlist">${s.recentQueue.map((a) => html`<li><a href="/newsroom/articles/${a.public_id}"><b>${a.title || 'بلا عنوان'}</b><small>${a.author_name} — ${gradeLabel(a.grade)} — ${fmtDateTime(a.submitted_at)}</small></a>${stamp(a.status)}</li>`)}</ul>` : html`<p class="muted">لا توجد مقالات بانتظار المراجعة.</p>`}
    </section>
    <section class="panel"><h2>المقالات حسب الصف</h2>${s.byGrade.length ? bars(s.byGrade.map((r) => ({ ...r, label: gradeLabel(r.grade) })), 'label') : html`<p class="muted">لا توجد بيانات بعد.</p>`}</section>
    <section class="panel"><h2>المقالات حسب التصنيف</h2>${s.byCat.length ? bars(s.byCat, 'name') : html`<p class="muted">لا توجد بيانات بعد.</p>`}</section>
    <section class="panel"><h2>الأكثر قراءة</h2>
      ${s.top.length ? html`<ol class="ranked">${s.top.map((a) => html`<li><a href="${articleUrl(a)}">${a.title}</a><small>${a.views} قراءة</small></li>`)}</ol>` : html`<p class="muted">تظهر هنا بعد نشر المقالات وقراءتها. يُحسب للقارئ نفسه قراءة واحدة كل 6 ساعات، ولا تُحسب زيارات المحررين.</p>`}
    </section>
  </div>`);
}

// ===== قائمة المقالات =====
const NR_FILTERS = [['all', 'الكل'], ['queue', 'بانتظار المراجعة'], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])];
function articlesList(ctx, { rows, f, q, grade, cat, cats, total }) {
  return page(ctx, f === 'queue' ? 'queue' : 'articles', 'المقالات', html`
  <header class="pagehead"><h1>${f === 'queue' ? 'بانتظار المراجعة' : 'المقالات'}</h1></header>
  <nav class="tabs tabs--wrap" aria-label="حالة المقال">${NR_FILTERS.map(([k, l]) => html`<a href="/newsroom/articles?f=${k}" ${f === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
  <form class="filters" method="get">
    <input type="hidden" name="f" value="${f}">
    <label>بحث <input type="search" name="q" value="${q}" placeholder="عنوان أو اسم طالب"></label>
    <label>الصف <select name="grade"><option value="">الكل</option>${Object.entries(GRADE_NAMES).filter(([g]) => g >= 5).map(([g, n]) => html`<option value="${g}" ${String(grade) === g ? raw('selected') : ''}>${n}</option>`)}</select></label>
    <label>التصنيف <select name="cat"><option value="">الكل</option>${cats.map((c) => html`<option value="${c.id}" ${String(cat) === String(c.id) ? raw('selected') : ''}>${c.name}</option>`)}</select></label>
    <button class="btn btn--small">تصفية</button>
  </form>
  <p class="muted">${total} مقال</p>
  ${rows.length ? html`<div class="tablewrap"><table class="table">
    <thead><tr><th>المقال</th><th>الكاتب</th><th>التصنيف</th><th>الحالة</th><th>آخر تحديث</th></tr></thead>
    <tbody>${rows.map((a) => html`<tr>
      <td><a href="/newsroom/articles/${a.public_id}"><b>${a.title || 'بلا عنوان'}</b></a>${a.featured ? html` <span class="pill">مميز</span>` : ''}${a.rising_pen ? html` <span class="pill">قلم واعد</span>` : ''}</td>
      <td>${a.author_name}<small class="block muted">${gradeLabel(a.grade, a.section)}</small></td>
      <td>${a.category_name || '—'}</td>
      <td>${stamp(a.status)}${a.status === 'published' && a.published_at > db.now() ? html`<small class="block">مجدول: ${fmtDateTime(a.published_at)}</small>` : ''}</td>
      <td>${fmtDateTime(a.updated_at)}</td>
    </tr>`)}</tbody></table></div>` : html`<p class="empty">لا توجد مقالات مطابقة.</p>`}`);
}

// ===== صفحة مراجعة المقال =====
function review(ctx, { a, notes, events, revisions, issues, cats, warnings }) {
  const avail = Object.entries(ACTIONS).filter(([, d]) => d.by === 'editor' && d.from.includes(a.status));
  const scheduled = a.status === 'published' && a.published_at > db.now();
  const canEdit = ['submitted', 'in_review', 'approved', 'published'].includes(a.status);
  const actionForm = ([key, d]) => {
    const danger = ['reject', 'unpublish', 'archive'].includes(key);
    if (key === 'publish') {
      return html`<form method="post" action="/newsroom/articles/${a.public_id}/action" class="actform actform--publish">${csrfField(ctx)}
        <input type="hidden" name="action" value="publish">
        <button class="btn btn--primary btn--block">نشر الآن</button>
        <details><summary>جدولة النشر في موعد لاحق</summary>
          <label class="field">موعد النشر (بتوقيت مسقط)<input type="datetime-local" name="publish_at"></label>
          <button class="btn btn--small" name="schedule" value="1">جدولة النشر</button>
        </details>
      </form>`;
    }
    return html`<form method="post" action="/newsroom/articles/${a.public_id}/action" class="actform" ${danger ? raw(`data-confirm="تأكيد: ${d.label}؟"`) : ''}>${csrfField(ctx)}
      <input type="hidden" name="action" value="${key}">
      ${d.note ? html`<label class="field">${key === 'reject' ? 'سبب الرفض (يظهر للطالب)' : 'ملاحظاتك للطالب (تظهر في مكتبه)'}<textarea name="note" rows="4" required maxlength="4000"></textarea></label>` : ''}
      <button class="btn btn--block ${key === 'approve' ? 'btn--primary' : danger ? 'btn--ghost btn--danger' : 'btn--ghost'}">${d.label}</button>
    </form>`;
  };
  return page(ctx, a.status === 'submitted' || a.status === 'in_review' ? 'queue' : 'articles', `مراجعة: ${a.title}`, html`
  <header class="pagehead pagehead--row">
    <div><p class="muted"><a href="/newsroom/articles">المقالات</a></p><h1>${a.title || 'بلا عنوان'}</h1></div>
    <div class="row">${stamp(a.status, 'stamp--big')}${scheduled ? html`<span class="pill">يُنشر في ${fmtDateTime(a.published_at)}</span>` : ''}</div>
  </header>
  ${warnings.length ? html`<div class="flash flash--warn"><ul>${warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
  <div class="reviewgrid">
    <section class="paperframe" aria-label="معاينة تحريرية">${articleBody(a, { preview: true })}</section>
    <aside class="reviewside">
      <section class="panel"><h2>قرار التحرير</h2>
        ${avail.length ? avail.map(actionForm) : html`<p class="muted">${a.status === 'draft' || a.status === 'changes_requested' ? 'المقال عند الطالب الآن. ستتمكن من مراجعته بعد أن يرسله.' : 'لا توجد إجراءات متاحة لهذه الحالة.'}</p>`}
        ${canEdit ? html`<a class="btn btn--ghost btn--block" href="/newsroom/articles/${a.public_id}/edit">تعديل تحريري محدود</a>` : ''}
      </section>
      <section class="panel"><h2>الكاتب</h2>
        <p><b>${a.author_name}</b><br>${gradeLabel(a.grade, a.section)}</p>
        <ul class="consents">
          <li class="${a.consent_name_public ? 'ok' : 'no'}">نشر الاسم: ${a.consent_name_public ? 'موافقة مسجلة' : 'لا توجد موافقة مسجلة'}</li>
          <li class="${a.consent_photo_public ? 'ok' : 'no'}">نشر الصورة: ${a.consent_photo_public ? 'موافقة مسجلة' : 'لا توجد موافقة مسجلة'}</li>
        </ul>
        ${isAdmin(ctx) ? html`<a href="/newsroom/students/${a.author_id}">ملف الطالب والموافقات</a>` : ''}
      </section>
      <section class="panel"><h2>مكان المقال في الجريدة</h2>
        <form method="post" action="/newsroom/articles/${a.public_id}/placement" class="stack">${csrfField(ctx)}
          <label class="field">التصنيف<select name="category_id"><option value="">بلا تصنيف</option>${cats.map((c) => html`<option value="${c.id}" ${a.category_id === c.id ? raw('selected') : ''}>${c.name}</option>`)}</select></label>
          <label class="field">العدد<select name="issue_id"><option value="">خارج الأعداد</option>${issues.map((i) => html`<option value="${i.id}" ${a.issue_id === i.id ? raw('selected') : ''}>العدد ${i.number}: ${i.title}</option>`)}</select></label>
          <label class="check"><input type="checkbox" name="featured" value="1" ${a.featured ? raw('checked') : ''}> من مختارات هيئة التحرير</label>
          <label class="check"><input type="checkbox" name="rising_pen" value="1" ${a.rising_pen ? raw('checked') : ''}> ركن «أقلام واعدة»</label>
          <label class="field">أولوية الظهور في الرئيسية<input type="number" name="home_order" value="${a.home_order}" min="0" max="999"><small class="hint">الرقم الأعلى يظهر أولًا، والأعلى بين المنشورة يصبح المقال الرئيسي.</small></label>
          <button class="btn btn--small">حفظ</button>
        </form>
      </section>
      <section class="panel"><h2>ملاحظات تحريرية</h2>
        ${notes.length ? html`<ul class="notelist">${notes.map((n) => html`<li><p>${n.body}</p><small>${n.author_name || ''} — ${fmtDateTime(n.created_at)} — ${n.visible_to_student ? 'يراها الطالب' : 'داخلية'}</small></li>`)}</ul>` : html`<p class="muted">لا توجد ملاحظات.</p>`}
        <form method="post" action="/newsroom/articles/${a.public_id}/note" class="stack">${csrfField(ctx)}
          <label class="field">إضافة ملاحظة<textarea name="body" rows="3" required maxlength="4000"></textarea></label>
          <label class="check"><input type="checkbox" name="visible" value="1" checked> يراها الطالب في مكتبه</label>
          <button class="btn btn--small btn--ghost">إضافة</button>
        </form>
      </section>
      <section class="panel"><h2>النسخ المحفوظة</h2>
        ${revisions.length ? html`<ul class="revlist">${revisions.map((r) => html`<li><a href="/newsroom/articles/${a.public_id}/revisions/${r.revision_no}">النسخة ${r.revision_no}</a> — ${r.reason === 'submit' ? 'نص الطالب عند الإرسال' : 'تعديل تحريري'}${r.note ? html`: ${r.note}` : ''}<small class="block muted">${r.by_name || ''} — ${fmtDateTime(r.created_at)}</small></li>`)}</ul>` : html`<p class="muted">تُحفظ نسخة كاملة عند كل إرسال وكل تعديل تحريري.</p>`}
      </section>
      <section class="panel"><h2>سجل المقال</h2>
        <ol class="events">${events.map((e) => html`<li><time>${fmtDateTime(e.created_at)}</time> <b>${e.label}</b> — ${e.actor_name || 'النظام'}${e.note ? html`<small class="block">${e.note}</small>` : ''}</li>`)}</ol>
        <p class="hint">أُنشئ ${fmtDateTime(a.created_at)}${a.submitted_at ? ` · أُرسل ${fmtDateTime(a.submitted_at)}` : ''}${a.approved_at ? ` · اعتُمد ${fmtDateTime(a.approved_at)}` : ''}${a.published_at ? ` · نُشر ${fmtDateTime(a.published_at)}` : ''}</p>
      </section>
      ${isAdmin(ctx) ? html`<section class="panel panel--danger"><h2>حذف المقال</h2>
        <p class="hint">للمحتوى المخالف فقط. يحذف المقال وصوره ونسخه نهائيًا. يُسجَّل الحذف في سجل العمليات.</p>
        <form method="post" action="/newsroom/articles/${a.public_id}/delete" data-confirm="سيُحذف المقال وكل صوره نهائيًا. متأكد؟" class="stack">${csrfField(ctx)}
          <label class="field">سبب الحذف<input name="reason" required maxlength="300"></label>
          <button class="btn btn--small btn--danger">حذف نهائي</button>
        </form>
      </section>` : ''}
    </aside>
  </div>`);
}

function revisionPage(ctx, a, rev) {
  return page(ctx, 'articles', `النسخة ${rev.revision_no}`, html`
    <header class="pagehead"><p class="muted"><a href="/newsroom/articles/${a.public_id}">رجوع إلى المراجعة</a></p>
      <h1>النسخة ${rev.revision_no} — ${rev.reason === 'submit' ? 'نص الطالب كما أرسله' : 'بعد تعديل تحريري'}</h1>
      <p class="muted">${fmtDateTime(rev.created_at)}${rev.note ? ` — ${rev.note}` : ''}</p></header>
    <div class="paperframe">${articleBody({ ...a, title: rev.title, subtitle: rev.subtitle, summary: rev.summary, body_json: rev.body_json, cover_pid: rev.cover_pid, cover_w: rev.cover_w, cover_h: rev.cover_h, cover_caption: rev.cover_caption }, { preview: true })}</div>`, false);
}

// ===== الطلبة =====
function studentsList(ctx, { rows, q, grade, total }) {
  return page(ctx, 'students', 'الطلبة', html`
  <header class="pagehead pagehead--row"><h1>الطلبة والموافقات</h1></header>
  <div class="twocol">
    <section class="panel"><h2>إضافة طالب</h2>
      <form method="post" action="/newsroom/students" class="stack">${csrfField(ctx)}
        <label class="field">اسم الطالب كما يظهر في التوقيع<input name="display_name" required maxlength="80"></label>
        <div class="row">
          <label class="field">الصف<select name="grade" required>${Object.entries(GRADE_NAMES).filter(([g]) => g >= 5).map(([g, n]) => html`<option value="${g}">${n}</option>`)}</select></label>
          <label class="field">الشعبة<input name="section" maxlength="10" placeholder="مثال: 3"></label>
        </div>
        <label class="field">اسم المستخدم <span class="opt">اختياري — يُولَّد تلقائيًا</span><input name="username" maxlength="40" dir="ltr" pattern="[A-Za-z0-9._-]{3,40}"></label>
        <button class="btn btn--primary">إنشاء الحساب</button>
      </form>
    </section>
    <section class="panel"><h2>إضافة مجموعة طلبة</h2>
      <form method="post" action="/newsroom/students/bulk" class="stack">${csrfField(ctx)}
        <label class="field">سطر لكل طالب بالصيغة: الاسم، الصف، الشعبة
          <textarea name="lines" rows="6" required placeholder="أحمد بن سالم البلوشي، 7، 2&#10;يوسف بن خالد الهنائي، 9، 1"></textarea></label>
        <p class="hint">الصف رقم من 5 إلى 12. تظهر بطاقات الدخول للطباعة مرة واحدة بعد الإنشاء.</p>
        <button class="btn">إنشاء الحسابات</button>
      </form>
    </section>
  </div>
  <form class="filters" method="get">
    <label>بحث <input type="search" name="q" value="${q}" placeholder="اسم أو اسم مستخدم"></label>
    <label>الصف <select name="grade"><option value="">الكل</option>${Object.entries(GRADE_NAMES).filter(([g]) => g >= 5).map(([g, n]) => html`<option value="${g}" ${String(grade) === g ? raw('selected') : ''}>${n}</option>`)}</select></label>
    <button class="btn btn--small">تصفية</button>
  </form>
  <p class="muted">${total} طالب</p>
  ${rows.length ? html`<div class="tablewrap"><table class="table">
    <thead><tr><th>الطالب</th><th>اسم المستخدم</th><th>الصف</th><th>الموافقات</th><th>المقالات</th><th>الحساب</th></tr></thead>
    <tbody>${rows.map((s) => html`<tr>
      <td><a href="/newsroom/students/${s.id}"><b>${s.display_name}</b></a></td>
      <td dir="ltr">${s.username}</td>
      <td>${gradeLabel(s.grade, s.section)}</td>
      <td><span class="pill ${s.consent_name_public ? 'pill--ok' : ''}">الاسم ${s.consent_name_public ? '✓' : '—'}</span> <span class="pill ${s.consent_photo_public ? 'pill--ok' : ''}">الصورة ${s.consent_photo_public ? '✓' : '—'}</span></td>
      <td>${s.n_articles} (${s.n_published} منشور)</td>
      <td>${s.is_active ? 'نشط' : html`<b class="danger">معطّل</b>`}${s.must_change_password ? html`<small class="block muted">لم يغيّر كلمة المرور المؤقتة</small>` : ''}</td>
    </tr>`)}</tbody></table></div>` : html`<p class="empty">لا يوجد طلبة بعد. أضف أول طالب من النموذج أعلاه.</p>`}`);
}

function studentDetail(ctx, { s, articles, consentBy }) {
  return page(ctx, 'students', s.display_name, html`
  <header class="pagehead"><p class="muted"><a href="/newsroom/students">الطلبة</a></p><h1>${s.display_name}</h1><p>${gradeLabel(s.grade, s.section)} — <span dir="ltr">${s.username}</span></p></header>
  <div class="twocol">
    <section class="panel"><h2>البيانات الأساسية</h2>
      <form method="post" action="/newsroom/students/${s.id}" class="stack">${csrfField(ctx)}
        <label class="field">الاسم<input name="display_name" value="${s.display_name}" required maxlength="80"></label>
        <div class="row">
          <label class="field">الصف<select name="grade">${Object.entries(GRADE_NAMES).filter(([g]) => g >= 5).map(([g, n]) => html`<option value="${g}" ${String(s.grade) === g ? raw('selected') : ''}>${n}</option>`)}</select></label>
          <label class="field">الشعبة<input name="section" value="${s.section || ''}" maxlength="10"></label>
        </div>
        <label class="check"><input type="checkbox" name="is_active" value="1" ${s.is_active ? raw('checked') : ''}> الحساب نشط</label>
        <button class="btn btn--small">حفظ البيانات</button>
      </form>
      <hr>
      <form method="post" action="/newsroom/students/${s.id}/reset-password" data-confirm="ستُلغى كلمة المرور الحالية وتُنشأ كلمة مؤقتة جديدة. متابعة؟">${csrfField(ctx)}
        <button class="btn btn--small btn--ghost">إعادة تعيين كلمة المرور</button>
      </form>
    </section>
    <section class="panel"><h2>موافقات النشر</h2>
      <p class="hint">سجّل الموافقة فقط بعد استلام موافقة ولي الأمر أو المدرسة وفق السياسات المعمول بها.</p>
      <form method="post" action="/newsroom/students/${s.id}/consent" class="stack">${csrfField(ctx)}
        <label class="check"><input type="checkbox" name="consent_name_public" value="1" ${s.consent_name_public ? raw('checked') : ''}> الموافقة على نشر اسم الطالب في توقيع مقالاته</label>
        <label class="check"><input type="checkbox" name="consent_photo_public" value="1" ${s.consent_photo_public ? raw('checked') : ''}> الموافقة على نشر صورته الشخصية</label>
        <label class="field">مرجع الموافقة <span class="opt">مثال: نموذج موافقة ولي الأمر رقم ... بتاريخ ...</span><input name="consent_note" value="${s.consent_note || ''}" maxlength="300"></label>
        ${s.consent_recorded_at ? html`<p class="hint">آخر تسجيل: ${fmtDateTime(s.consent_recorded_at)}${consentBy ? ` بواسطة ${consentBy}` : ''}</p>` : ''}
        <button class="btn btn--small">حفظ الموافقات</button>
      </form>
      <h3>الصورة الشخصية</h3>
      ${s.photo_pid ? html`<img class="avatar-lg" src="/media/${s.photo_pid}" alt="" width="120" height="120">
        <form method="post" action="/newsroom/students/${s.id}/photo/remove" data-confirm="إزالة صورة الطالب؟">${csrfField(ctx)}<button class="btn btn--small btn--ghost btn--danger">إزالة الصورة</button></form>` : html`<p class="muted">لم يرفع الطالب صورة.</p>`}
    </section>
  </div>
  <section class="panel"><h2>مقالات الطالب</h2>
    ${articles.length ? html`<ul class="qlist">${articles.map((a) => html`<li><a href="/newsroom/articles/${a.public_id}"><b>${a.title || 'بلا عنوان'}</b><small>آخر تحديث ${fmtDateTime(a.updated_at)}</small></a>${stamp(a.status)}</li>`)}</ul>` : html`<p class="muted">لا توجد مقالات.</p>`}
  </section>`);
}

function credentials(ctx, created, title = 'بطاقات الدخول') {
  const base = config.baseUrl || '';
  return page(ctx, 'students', title, html`
  <header class="pagehead pagehead--row noprint"><div><h1>${title}</h1>
    <p class="flash flash--warn">تظهر كلمات المرور المؤقتة هذه مرة واحدة فقط ولا تُحفظ في النظام. اطبعها أو انسخها الآن وسلّمها لكل طالب يدًا بيد.</p></div>
    <button type="button" class="btn" data-print>طباعة البطاقات</button></header>
  ${created.errors && created.errors.length ? html`<div class="flash flash--error noprint"><p>أسطر لم تُنشأ:</p><ul>${created.errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
  <div class="slips">${created.items.map((c) => html`<article class="slip">
    <p class="slip__brand">${db.setting('identity').name} — بطاقة دخول المكتب الصحفي</p>
    <p class="slip__name">${c.name}${c.grade ? html` <small>${gradeLabel(c.grade, c.section)}</small>` : ''}</p>
    <dl><div><dt>اسم المستخدم</dt><dd dir="ltr">${c.username}</dd></div><div><dt>كلمة المرور المؤقتة</dt><dd dir="ltr">${c.password}</dd></div></dl>
    <p class="slip__hint">ادخل من ${base ? html`<span dir="ltr">${base.replace(/^https?:\/\//, '')}/login</span>` : 'صفحة «دخول الكتّاب»'}، وستُطلب منك كلمة مرور جديدة عند أول دخول.</p>
  </article>`)}</div>
  <p class="noprint"><a href="/newsroom/students">رجوع إلى قائمة الطلبة</a></p>`);
}

// ===== التصنيفات =====
function categoriesPage(ctx, cats) {
  return page(ctx, 'categories', 'التصنيفات', html`
  <header class="pagehead"><h1>التصنيفات</h1><p>رتّب أبواب الجريدة وغيّر أسماءها أو أخفها دون تعديل الكود. التصنيف المخفي لا يظهر في شريط الأقسام.</p></header>
  <div class="tablewrap"><table class="table table--form"><thead><tr><th>الاسم</th><th>الرابط (slug)</th><th>الوصف</th><th>الترتيب</th><th>ظاهر</th><th>مقالات</th><th></th></tr></thead><tbody>
  ${cats.map((c) => html`<tr><td colspan="7"><form method="post" action="/newsroom/categories/${c.id}" class="catrow">${csrfField(ctx)}
    <input name="name" value="${c.name}" required maxlength="60" aria-label="الاسم">
    <input name="slug" value="${c.slug}" required maxlength="60" dir="ltr" pattern="[a-z0-9-]+" aria-label="الرابط">
    <input name="description" value="${c.description || ''}" maxlength="200" aria-label="الوصف">
    <input name="sort_order" type="number" value="${c.sort_order}" aria-label="الترتيب">
    <label class="check"><input type="checkbox" name="is_visible" value="1" ${c.is_visible ? raw('checked') : ''}><span class="sr">ظاهر</span></label>
    <span class="muted">${c.n}</span>
    <button class="btn btn--small">حفظ</button>
  </form></td></tr>`)}
  </tbody></table></div>
  <section class="panel"><h2>إضافة تصنيف</h2>
    <form method="post" action="/newsroom/categories" class="catrow">${csrfField(ctx)}
      <input name="name" required maxlength="60" placeholder="اسم التصنيف">
      <input name="slug" required maxlength="60" dir="ltr" pattern="[a-z0-9-]+" placeholder="english-slug">
      <input name="description" maxlength="200" placeholder="وصف قصير">
      <input name="sort_order" type="number" value="${(cats.length + 1) * 10}">
      <button class="btn btn--small btn--primary">إضافة</button>
    </form>
    <p class="hint">الرابط حروف إنجليزية صغيرة وأرقام وشرطات، ويظهر في عنوان صفحة القسم.</p>
  </section>`);
}

// ===== الأعداد =====
function issuesPage(ctx, { issues, current }) {
  return page(ctx, 'issues', 'الأعداد', html`
  <header class="pagehead"><h1>الأعداد والغلاف</h1><p>العدد يجمع مقالات حول موضوع واحد. العدد «الحالي» يظهر على الغلاف الأمامي وفي الصفحة الرئيسية.</p></header>
  <div class="twocol">
    <section class="panel"><h2>إنشاء عدد جديد</h2>
      <form method="post" action="/newsroom/issues" class="stack">${csrfField(ctx)}
        <div class="row"><label class="field">رقم العدد<input type="number" name="number" min="1" required value="${(issues[0] ? issues[0].number : 0) + 1}"></label>
        <label class="field">عنوان العدد<input name="title" required maxlength="100" placeholder="مثال: عدد البيئة والاستدامة"></label></div>
        <label class="field">موضوع العدد / عبارة الغلاف<input name="theme" maxlength="160"></label>
        <button class="btn btn--primary">إنشاء العدد</button>
      </form>
    </section>
    <section class="panel"><h2>الغلاف</h2>
      <p>صور المدرسة والمشرف ومدير المدرسة تُرفع من <a href="/newsroom/settings#assets">إعدادات الجريدة</a>، وصورة غلاف كل عدد من صفحة العدد.</p>
      <p><a class="btn btn--small btn--ghost" href="/cover">الغلاف الأمامي</a> <a class="btn btn--small btn--ghost" href="/cover/back">الغلاف الخلفي</a></p>
    </section>
  </div>
  ${issues.length ? html`<div class="tablewrap"><table class="table"><thead><tr><th>العدد</th><th>العنوان</th><th>الحالة</th><th>المقالات</th><th></th></tr></thead><tbody>
    ${issues.map((i) => html`<tr><td>${i.number}</td><td><a href="/newsroom/issues/${i.id}"><b>${i.title}</b></a>${current === i.id ? html` <span class="pill pill--ok">العدد الحالي</span>` : ''}</td><td>${i.status === 'published' ? 'صادر' : 'قيد الإعداد'}</td><td>${i.n}</td><td><a href="/newsroom/issues/${i.id}">إدارة</a></td></tr>`)}
  </tbody></table></div>` : html`<p class="empty">لم تُنشأ أعداد بعد.</p>`}`);
}

function issueEdit(ctx, { i, articles, current }) {
  return page(ctx, 'issues', `العدد ${i.number}`, html`
  <meta name="csrf" content="${ctx.csrf}">
  <header class="pagehead"><p class="muted"><a href="/newsroom/issues">الأعداد</a></p><h1>العدد ${i.number}: ${i.title}</h1></header>
  <div class="twocol">
    <section class="panel"><h2>بيانات العدد</h2>
      <form method="post" action="/newsroom/issues/${i.id}" class="stack">${csrfField(ctx)}
        <div class="row"><label class="field">رقم العدد<input type="number" name="number" min="1" required value="${i.number}"></label>
        <label class="field">العنوان<input name="title" required maxlength="100" value="${i.title}"></label></div>
        <label class="field">موضوع العدد / عبارة الغلاف<input name="theme" maxlength="160" value="${i.theme || ''}"></label>
        <label class="field">افتتاحية العدد <span class="opt">تظهر في الصفحة الرئيسية وصفحة العدد. افصل الفقرات بسطر فارغ.</span><textarea name="intro" rows="7" maxlength="5000">${i.intro || ''}</textarea></label>
        <label class="field">الحالة<select name="status"><option value="draft">قيد الإعداد (لا يظهر للقراء)</option><option value="published" ${i.status === 'published' ? raw('selected') : ''}>صادر</option></select></label>
        <label class="check"><input type="checkbox" name="current" value="1" ${current === i.id ? raw('checked') : ''}> اجعله العدد الحالي (يظهر على الغلاف)</label>
        <button class="btn btn--primary">حفظ العدد</button>
      </form>
    </section>
    <section class="panel"><h2>صورة غلاف العدد</h2>
      <div class="assetbox" data-photo-frame>${i.cover_pid ? html`<img src="/media/${i.cover_pid}" alt="">` : html`<span class="muted">لا توجد صورة — سيُستخدم في الغلاف صورة المدرسة إن وُجدت.</span>`}</div>
      <label class="btn btn--small filebtn">${i.cover_pid ? 'استبدال الصورة' : 'رفع صورة'}<input type="file" accept="image/*" data-upload="issue" data-target="/api/issue-cover?issue=${i.id}" hidden></label>
      <p class="hint" data-upload-status></p>
      <hr>
      <form method="post" action="/newsroom/issues/${i.id}/delete" data-confirm="حذف العدد؟ لن تُحذف مقالاته بل تبقى في الأرشيف.">${csrfField(ctx)}<button class="btn btn--small btn--ghost btn--danger">حذف العدد</button></form>
    </section>
  </div>
  <section class="panel"><h2>مقالات العدد</h2>
    <p class="hint">أضف المقالات إلى العدد من صفحة مراجعة كل مقال (قسم «مكان المقال في الجريدة»).</p>
    ${articles.length ? html`<ul class="qlist">${articles.map((a) => html`<li><a href="/newsroom/articles/${a.public_id}"><b>${a.title}</b><small>${a.author_name}</small></a>${stamp(a.status)}</li>`)}</ul>` : html`<p class="muted">لا توجد مقالات في هذا العدد بعد.</p>`}
  </section>
  <script src="/static/js/media.js" defer></script>`);
}

// ===== الإعدادات =====
const ASSET_SLOTS = [
  ['photo_school', 'صورة المدرسة', 'تظهر في الغلاف الأمامي والخلفي'],
  ['photo_principal', 'صورة مدير المدرسة ورئيس التحرير', 'تظهر في الغلاف الأمامي'],
  ['photo_supervisor', 'صورة المعلم المشرف العام', 'تظهر في الغلاف الأمامي'],
  ['logo_paper', 'شعار الجريدة', 'اختياري — يحل محل رمز القلم في الترويسة'],
  ['logo_ministry', 'شعار الوزارة', 'ارفع الملف الرسمي فقط'],
  ['logo_school', 'شعار المدرسة', 'ارفع الملف الرسمي فقط'],
];

function settingsPage(ctx, s) {
  const teamRows = [...s.team, ...Array(Math.max(0, 5 - s.team.length)).fill({ title: '', name: '', slot: '' })];
  const check = (name, on, label) => html`<label class="check"><input type="checkbox" name="${name}" value="1" ${on ? raw('checked') : ''}> ${label}</label>`;
  return page(ctx, 'settings', 'إعدادات الجريدة', html`
  <meta name="csrf" content="${ctx.csrf}">
  <header class="pagehead"><h1>إعدادات الجريدة</h1></header>
  <section class="panel" id="assets"><h2>الصور والشعارات</h2>
    <p class="hint">لا يضم التطبيق أي شعار رسمي. ارفع الملفات الأصلية المعتمدة فقط. الصور المرفوعة هنا عامة لأنها تظهر في الغلاف.</p>
    <div class="assets">${ASSET_SLOTS.map(([key, label, hint]) => html`<div class="asset">
      <div class="assetbox" data-photo-frame>${s.assets[key] ? html`<img src="/media/${s.assets[key]}" alt="">` : html`<span class="muted">لم تُرفع</span>`}</div>
      <b>${label}</b><small class="hint">${hint}</small>
      <label class="btn btn--small filebtn">${s.assets[key] ? 'استبدال' : 'رفع'}<input type="file" accept="image/*" data-upload="site" data-target="/api/site-asset?slot=${key}" hidden></label>
      ${s.assets[key] ? html`<form method="post" action="/newsroom/settings/asset-remove">${csrfField(ctx)}<input type="hidden" name="slot" value="${key}"><button class="btn btn--link btn--danger">إزالة</button></form>` : ''}
      <p class="hint" data-upload-status></p>
    </div>`)}</div>
  </section>
  <form method="post" action="/newsroom/settings" class="settings">${csrfField(ctx)}
    <section class="panel"><h2>هوية الجريدة</h2>
      <label class="field">اسم الجريدة<input name="identity.name" value="${s.identity.name}" required maxlength="60"></label>
      <label class="field">الشعار التحفيزي<input name="identity.tagline" value="${s.identity.tagline}" maxlength="120"></label>
      <label class="field">عبارة الترويسة<input name="identity.kicker" value="${s.identity.kicker}" maxlength="80"></label>
      <label class="field">الوصف التعريفي<textarea name="identity.description" rows="3" maxlength="600">${s.identity.description}</textarea></label>
    </section>
    <section class="panel"><h2>الجهة التعليمية</h2>
      <label class="field">الوزارة<input name="institution.ministry" value="${s.institution.ministry}" maxlength="120"></label>
      <label class="field">المديرية<input name="institution.directorate" value="${s.institution.directorate}" maxlength="160"></label>
      <label class="field">المدرسة<input name="institution.school" value="${s.institution.school}" maxlength="160"></label>
    </section>
    <section class="panel"><h2>هيئة الإشراف والتحرير</h2>
      <p class="hint">بالترتيب الذي يظهر في التذييل والغلاف الخلفي. الأسطر الفارغة تُتجاهل. «موضع الصورة» يربط الاسم بصورته في الغلاف الأمامي.</p>
      ${teamRows.map((m, idx) => html`<div class="row teamrow">
        <label class="field">الصفة<input name="team.${idx}.title" value="${m.title}" maxlength="100"></label>
        <label class="field">الاسم<input name="team.${idx}.name" value="${m.name}" maxlength="100"></label>
        <label class="field">موضع الصورة<select name="team.${idx}.slot"><option value="">—</option><option value="principal" ${m.slot === 'principal' ? raw('selected') : ''}>مدير المدرسة</option><option value="supervisor" ${m.slot === 'supervisor' ? raw('selected') : ''}>المشرف العام</option></select></label>
      </div>`)}
    </section>
    <section class="panel"><h2>صفحة «عن المبادرة»</h2>
      <label class="field">العنوان<input name="about.title" value="${s.about.title}" maxlength="80"></label>
      <label class="field">النص <span class="opt">افصل الفقرات بسطر فارغ</span><textarea name="about.body" rows="7" maxlength="5000">${s.about.body}</textarea></label>
      <label class="field">الأهداف <span class="opt">هدف في كل سطر</span><textarea name="about.goals" rows="5" maxlength="3000">${s.about.goals.join('\n')}</textarea></label>
    </section>
    <section class="panel"><h2>الغلاف الأمامي</h2>
      ${check('cover.show_school_photo', s.cover.show_school_photo, 'إظهار صورة المدرسة (إن لم يكن للعدد صورة خاصة)')}
      ${check('cover.show_principal', s.cover.show_principal, 'إظهار مدير المدرسة ورئيس التحرير')}
      ${check('cover.show_supervisor', s.cover.show_supervisor, 'إظهار المعلم المشرف العام')}
      ${check('cover.show_headlines', s.cover.show_headlines, 'إظهار عناوين المقالات على الغلاف')}
      <label class="field">عدد العناوين على الغلاف<input type="number" name="cover.headline_count" min="0" max="6" value="${s.cover.headline_count}"></label>
    </section>
    <section class="panel"><h2>الغلاف الخلفي</h2>
      <label class="field">الرسالة<textarea name="back_cover.message" rows="3" maxlength="600">${s.back_cover.message}</textarea></label>
      <label class="field">دعوة المشاركة<textarea name="back_cover.invitation" rows="3" maxlength="600">${s.back_cover.invitation}</textarea></label>
      ${check('back_cover.show_goals', s.back_cover.show_goals, 'إظهار أهداف المبادرة')}
      ${check('back_cover.show_team', s.back_cover.show_team, 'إظهار هيئة الإشراف والتحرير')}
    </section>
    <section class="panel"><h2>النشر والخصوصية</h2>
      ${check('publishing.require_name_consent', s.publishing.require_name_consent, 'لا يُنشر اسم الطالب ولا صورته إلا بموافقة مسجلة (موصى به)')}
      ${check('publishing.show_views', s.publishing.show_views, 'إظهار عدد القراءات للقراء')}
    </section>
    <div class="savebar"><button class="btn btn--primary">حفظ الإعدادات</button></div>
  </form>
  <script src="/static/js/media.js" defer></script>`);
}

// ===== غرفة الأفكار =====
function promptsPage(ctx, { prompts, cats }) {
  return page(ctx, 'prompts', 'غرفة الأفكار', html`
  <header class="pagehead"><h1>غرفة الأفكار</h1><p>موضوعات مقترحة تظهر للطلبة في مكاتبهم ليبدؤوا منها مقالاتهم.</p></header>
  <section class="panel"><h2>إضافة فكرة</h2>
    <form method="post" action="/newsroom/prompts" class="stack">${csrfField(ctx)}
      <label class="field">الفكرة<input name="title" required maxlength="140" placeholder="مثال: حاور عامل المقصف عن يومه في المدرسة"></label>
      <label class="field">توضيح للطالب<textarea name="body" rows="2" maxlength="600"></textarea></label>
      <label class="field">التصنيف المقترح<select name="category_id"><option value="">—</option>${cats.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></label>
      <button class="btn btn--primary">إضافة</button>
    </form>
  </section>
  ${prompts.length ? html`<ul class="qlist">${prompts.map((p) => html`<li><div><b>${p.title}</b><small>${p.category_name || ''} ${p.is_active ? '' : '— مخفية'}</small></div>
    <div class="row"><form method="post" action="/newsroom/prompts/${p.id}/toggle">${csrfField(ctx)}<button class="btn btn--small btn--ghost">${p.is_active ? 'إخفاء' : 'إظهار'}</button></form>
    <form method="post" action="/newsroom/prompts/${p.id}/delete" data-confirm="حذف الفكرة؟">${csrfField(ctx)}<button class="btn btn--small btn--ghost btn--danger">حذف</button></form></div></li>`)}</ul>` : ''}`);
}

// ===== فريق التحرير =====
function staffPage(ctx, rows) {
  return page(ctx, 'staff', 'فريق التحرير', html`
  <header class="pagehead"><h1>فريق التحرير</h1><p><b>المحرر</b> يراجع المقالات وينشرها ويدير الأعداد والتصنيفات. <b>مسؤول الجريدة</b> يملك إضافة إلى ذلك إدارة الطلبة والموافقات والإعدادات والفريق.</p></header>
  <section class="panel"><h2>إضافة عضو</h2>
    <form method="post" action="/newsroom/staff" class="row">${csrfField(ctx)}
      <label class="field">الاسم<input name="display_name" required maxlength="80"></label>
      <label class="field">اسم المستخدم<input name="username" required maxlength="40" dir="ltr" pattern="[A-Za-z0-9._-]{3,40}"></label>
      <label class="field">الدور<select name="role"><option value="editor">محرر</option><option value="admin">مسؤول الجريدة</option></select></label>
      <button class="btn btn--primary">إضافة</button>
    </form>
  </section>
  <div class="tablewrap"><table class="table"><thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>آخر دخول</th><th></th></tr></thead><tbody>
  ${rows.map((u) => html`<tr><td>${u.display_name}</td><td dir="ltr">${u.username}</td><td>${u.role === 'admin' ? 'مسؤول الجريدة' : 'محرر'}${u.is_active ? '' : html` <b class="danger">معطّل</b>`}</td><td>${u.last_login_at ? fmtDateTime(u.last_login_at) : '—'}</td>
    <td>${u.id !== ctx.user.id ? html`<div class="row">
      <form method="post" action="/newsroom/staff/${u.id}/reset-password" data-confirm="إنشاء كلمة مرور مؤقتة جديدة؟">${csrfField(ctx)}<button class="btn btn--small btn--ghost">كلمة مرور جديدة</button></form>
      <form method="post" action="/newsroom/staff/${u.id}/toggle">${csrfField(ctx)}<button class="btn btn--small btn--ghost">${u.is_active ? 'تعطيل' : 'تفعيل'}</button></form></div>` : html`<span class="muted">أنت</span>`}</td></tr>`)}
  </tbody></table></div>`);
}

function auditPage(ctx, rows) {
  return page(ctx, 'audit', 'سجل العمليات', html`
  <header class="pagehead"><h1>سجل العمليات</h1><p>آخر 300 عملية حساسة: الدخول، إدارة الحسابات، الموافقات، النشر، الحذف، الإعدادات.</p></header>
  <div class="tablewrap"><table class="table"><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>الهدف</th><th>تفاصيل</th></tr></thead><tbody>
  ${rows.map((r) => html`<tr><td>${fmtDateTime(r.created_at)}</td><td>${r.actor_name || '—'}</td><td>${r.action}</td><td>${r.target_type || ''} ${r.target_id || ''}</td><td><small dir="auto">${r.details || ''}</small></td></tr>`)}
  </tbody></table></div>`);
}

module.exports = { dashboard, articlesList, review, revisionPage, studentsList, studentDetail, credentials, categoriesPage, issuesPage, issueEdit, settingsPage, promptsPage, staffPage, auditPage, ASSET_SLOTS };
