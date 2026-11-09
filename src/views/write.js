'use strict';
// صفحات «اكتب للجريدة»: الكتابة المباشرة دون حساب، ثم الشكر، ثم متابعة الحالة.
const { html, raw } = require('../http');
const { publicPage } = require('./layout');
const { GRADE_NAMES, STATUS } = require('../defaults');
const { fmtDateTime } = require('../content');
const { articleUrl } = require('./public');

function writePage(ctx, { token, stamp, cats, values, errors, minWords, maxImages }) {
  const v = values || {};
  const imgs = v.images || [];
  return publicPage(ctx, { title: 'اكتب للجريدة', description: 'اكتب مقالك وأرفق صورك وأرسله إلى هيئة تحرير الجريدة المدرسية.', bodyClass: 'pub--write', body: html`
  <section class="write" aria-labelledby="write-h">
    <header class="write__head">
      <h1 id="write-h" class="write__title">اكتب للجريدة <span aria-hidden="true">✍️</span></h1>
      <p class="write__intro">اكتب مقالك هنا، وأرفق صورك إن أحببت، ثم اضغط <b>«أرسل مقالي»</b>. سيقرؤه فريق التحرير وينشره في الجريدة بعد مراجعته.</p>
    </header>

    ${errors && errors.length ? html`<div class="flash flash--error" role="alert"><b>لم يُرسل المقال بعد:</b><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}

    <form class="write__form" method="post" action="/write" data-write data-submit-form data-min-words="${minWords}" data-max-images="${maxImages}" data-token="${token}" novalidate>
      <input type="hidden" name="_w" value="${token}">
      <input type="hidden" name="stamp" value="${stamp}">
      <input type="hidden" name="images" value="${imgs.map((i) => `${i.pid}:${i.token}`).join(',')}" data-images-field>
      <div class="hp" aria-hidden="true"><label>اترك هذا الحقل فارغًا<input name="website" tabindex="-1" autocomplete="off"></label></div>

      <fieldset class="write__card">
        <legend class="write__step"><span>1</span> من أنت؟</legend>
        <div class="write__row">
          <label class="field write__grow">اسمك
            <input name="name" required minlength="3" maxlength="80" autocomplete="name" value="${v.name || ''}" placeholder="مثال: أحمد بن سالم">
          </label>
          <label class="field">صفك
            <select name="grade" required>
              <option value="">اختر</option>
              ${[5, 6, 7, 8, 9, 10, 11, 12].map((g) => html`<option value="${g}" ${v.grade === g ? raw('selected') : ''}>${GRADE_NAMES[g]}</option>`)}
            </select>
          </label>
          <label class="field write__small">الشعبة <span class="opt">اختياري</span>
            <input name="section" maxlength="10" value="${v.section || ''}" placeholder="مثل: 1">
          </label>
        </div>
      </fieldset>

      <fieldset class="write__card">
        <legend class="write__step"><span>2</span> مقالك</legend>
        <label class="field">نوع المقال
          <select name="category_id" required>
            <option value="">اختر</option>
            ${cats.map((c) => html`<option value="${c.id}" ${v.categoryId === c.id ? raw('selected') : ''}>${c.name}</option>`)}
          </select>
        </label>
        <label class="field">العنوان
          <input name="title" required minlength="4" maxlength="140" value="${v.title || ''}" placeholder="عنوان قصير يشد القارئ">
        </label>
        <label class="field">نص المقال
          <textarea name="body" rows="12" required data-body placeholder="ابدأ الكتابة هنا… اضغط Enter لتبدأ فقرة جديدة.">${v.body || ''}</textarea>
        </label>
        <p class="write__count" data-count aria-live="polite">اكتب ${minWords} كلمة على الأقل.</p>
      </fieldset>

      <fieldset class="write__card">
        <legend class="write__step"><span>3</span> صور مع المقال <span class="opt">اختياري — حتى ${maxImages} صور</span></legend>
        <p class="muted write__hint">الصورة الأولى تظهر في أعلى المقال. اكتب تحت كل صورة جملة قصيرة تشرحها.</p>
        <div class="write__pics" data-pics>
          ${imgs.map((i) => html`<figure class="pic" data-pic="${i.pid}">
            <img src="/media/${i.pid}?t=${i.token}" alt="">
            <button type="button" class="pic__x" data-remove aria-label="حذف الصورة">×</button>
            <input name="cap_${i.pid}" maxlength="300" value="${i.cap || ''}" placeholder="وصف الصورة">
          </figure>`)}
        </div>
        <label class="btn btn--ghost write__add" data-add>
          <span aria-hidden="true">📷</span> أضف صورة
          <input type="file" accept="image/jpeg,image/png,image/webp,image/*" multiple class="sr" data-file>
        </label>
        <p class="write__status" data-status aria-live="polite"></p>
        <noscript><p class="flash flash--warn">إرفاق الصور يحتاج تفعيل JavaScript في المتصفح. يمكنك إرسال النص وحده.</p></noscript>
      </fieldset>

      <div class="write__send">
        <p class="write__status" data-submit-status aria-live="assertive"></p>
        <button class="btn btn--primary btn--big btn--block" type="submit" data-submit>أرسل مقالي</button>
        <p class="muted">يُنشر مقالك بعد مراجعة فريق التحرير، ويظهر اسمك معه بعد موافقة مشرف الجريدة.</p>
      </div>
    </form>
  </section>
  <script src="/static/js/write.js" defer></script>` });
}

function donePage(ctx, a) {
  const link = `/write/status/${a.public_id}?k=${a.guest_key}`;
  return publicPage(ctx, { title: 'وصل مقالك', bodyClass: 'pub--write', body: html`
  <section class="write write--done">
    <div class="write__card write__done">
      <p class="write__big" aria-hidden="true">🎉</p>
      <h1 class="write__title">وصل مقالك!</h1>
      <p>شكرًا لك. وصل مقال <b>«${a.title}»</b> إلى فريق التحرير، وسيُنشر في الجريدة بعد مراجعته.</p>
      <p class="write__keep">احتفظ بهذا الرابط لتعرف متى يُنشر مقالك:</p>
      <p><a class="btn btn--ghost write__link" href="${link}">🔗 رابط متابعة مقالي</a></p>
      <p class="muted">افتح الرابط واحفظه في المفضلة، أو اطلب من معلمك أن يخبرك عند نشره.</p>
      <p class="row write__actions">
        <a class="btn btn--primary" href="/write">اكتب مقالًا آخر</a>
        <a class="btn btn--ghost" href="/">الصفحة الرئيسية للجريدة</a>
      </p>
    </div>
  </section>` });
}

const FRIENDLY = {
  submitted: 'وصل مقالك إلى فريق التحرير، وينتظر دوره في المراجعة.',
  in_review: 'يقرأ فريق التحرير مقالك الآن.',
  changes_requested: 'طلب فريق التحرير بعض التعديلات. اقرأ الملاحظة، ثم يمكنك إرسال نسخة معدّلة من صفحة «اكتب للجريدة».',
  approved: 'اعتُمد مقالك 👏 وسيُنشر قريبًا.',
  published: 'نُشر مقالك في الجريدة 🎉',
  rejected: 'لم يُقبل هذا المقال للنشر. اقرأ الملاحظة، وننتظر مقالك القادم.',
  archived: 'نُقل المقال إلى الأرشيف.',
  draft: 'المقال مسودة.',
};

function statusPage(ctx, { a, notes, isPublic }) {
  const st = STATUS[a.status] || { label: a.status, tone: 'draft' };
  return publicPage(ctx, { title: 'حالة مقالي', bodyClass: 'pub--write', body: html`
  <section class="write write--done">
    <div class="write__card">
      <p class="muted">حالة مقالك</p>
      <h1 class="write__title">${a.title}</h1>
      <p><span class="stamp stamp--${st.tone}">${st.label}</span></p>
      <p>${FRIENDLY[a.status] || ''}</p>
      ${notes.length ? html`<div class="flash flash--info"><b>ملاحظة فريق التحرير:</b>${notes.map((n) => html`<p>${n.body}</p><small class="muted">${fmtDateTime(n.created_at)}</small>`)}</div>` : ''}
      <p class="row write__actions">
        ${isPublic ? html`<a class="btn btn--primary" href="${articleUrl(a)}">اقرأ مقالك في الجريدة</a>` : ''}
        <a class="btn btn--ghost" href="/write">اكتب مقالًا جديدًا</a>
      </p>
    </div>
  </section>` });
}

module.exports = { writePage, donePage, statusPage };
