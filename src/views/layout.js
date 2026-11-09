'use strict';
const { html, raw } = require('../http');
const db = require('../db');
const config = require('../config');
const { fmtWeekday } = require('../content');
const { STATUS } = require('../defaults');

const ASSET_V = String(Date.now()).slice(-8); // يكسر التخزين المؤقت بعد كل تحديث للتطبيق

const fonts = () => config.fontsCdn ? html`
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Reem+Kufi:wght@500;600;700&display=swap">` : '';

/** شعار الجريدة: رأس قلم حبر يتحول سنّه إلى عمود صحيفة — هوية خاصة بالمبادرة، ليس شعارًا رسميًا */
function nib(cls = 'nib') {
  return raw(`<svg class="${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path d="M32 3 L50 24 C52 27 52 31 50 34 L36 56 L32 62 L28 56 L14 34 C12 31 12 27 14 24 Z" fill="currentColor"/>
    <path d="M32 24 L32 50" stroke="var(--nib-cut, #fff)" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="32" cy="24" r="4.2" fill="var(--nib-cut, #fff)"/>
    <rect x="20" y="36" width="7" height="2.2" rx="1.1" fill="var(--nib-cut, #fff)" opacity=".75"/>
    <rect x="37" y="36" width="7" height="2.2" rx="1.1" fill="var(--nib-cut, #fff)" opacity=".75"/>
    <rect x="22" y="41" width="5" height="2.2" rx="1.1" fill="var(--nib-cut, #fff)" opacity=".55"/>
    <rect x="37" y="41" width="5" height="2.2" rx="1.1" fill="var(--nib-cut, #fff)" opacity=".55"/>
  </svg>`);
}

function paperLogo(cls = 'nib') {
  const assets = db.setting('assets');
  if (assets.logo_paper) return html`<img class="${cls} ${cls}--img" src="/media/${assets.logo_paper}" alt="">`;
  return nib(cls);
}

function csrfField(ctx) { return html`<input type="hidden" name="_csrf" value="${ctx.csrf}">`; }

function stamp(status, extra = '') {
  const s = STATUS[status] || { label: status, tone: 'draft' };
  return html`<span class="stamp stamp--${s.tone} ${extra}">${s.label}</span>`;
}

function flashBox(ctx) {
  if (!ctx.flash) return '';
  const { type, msg } = ctx.flash;
  return html`<div class="flash flash--${type}" role="${type === 'error' ? 'alert' : 'status'}">${msg}</div>`;
}

function head({ title, description, canonical, image, robots }) {
  const identity = db.setting('identity');
  const full = title ? `${title} — ${identity.name}` : `${identity.name} | ${identity.tagline}`;
  const base = config.baseUrl;
  return html`<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${full}</title>
  <meta name="description" content="${description || identity.description}">
  <meta name="theme-color" content="#0E3A4A">
  ${robots ? html`<meta name="robots" content="${robots}">` : ''}
  ${canonical && base ? html`<link rel="canonical" href="${base + canonical}">` : ''}
  <meta property="og:title" content="${title || identity.name}">
  <meta property="og:description" content="${description || identity.tagline}">
  <meta property="og:site_name" content="${identity.name}">
  <meta property="og:locale" content="ar_OM">
  ${image && base ? html`<meta property="og:image" content="${base}/media/${image}">` : ''}
  <link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml">
  ${fonts()}
  <link rel="stylesheet" href="/static/css/app.css?v=${ASSET_V}">
  <script src="/static/js/app.js?v=${ASSET_V}" defer></script>
</head>`;
}

// ===== الواجهة العامة =====
function publicPage(ctx, { title, description, canonical, image, body, bodyClass = '' }) {
  const identity = db.setting('identity');
  const inst = db.setting('institution');
  const assets = db.setting('assets');
  const pub = db.setting('publishing');
  const cats = db.all('SELECT slug, name FROM categories WHERE is_visible = 1 ORDER BY sort_order, id');
  const issue = pub.current_issue_id ? db.one("SELECT number, title FROM issues WHERE id = ? AND status = 'published'", pub.current_issue_id) : null;
  const active = ctx.activeCategory || '';
  return html`${head({ title, description, canonical, image })}
<body class="pub ${bodyClass}">
<a class="skip" href="#main">تخطَّ إلى المحتوى</a>
<header class="masthead">
  <div class="masthead__inst wrap">
    <div class="inst-logos">
      ${assets.logo_ministry ? html`<img src="/media/${assets.logo_ministry}" alt="${inst.ministry}">` : ''}
      <span>${inst.ministry}</span>
      <span>${inst.directorate}</span>
      <span>${inst.school}</span>
      ${assets.logo_school ? html`<img src="/media/${assets.logo_school}" alt="${inst.school}">` : ''}
    </div>
  </div>
  <div class="masthead__main wrap">
    <a class="brand" href="/" aria-label="${identity.name} — الصفحة الرئيسية">
      ${paperLogo('brand__nib')}
      <span class="brand__name">${identity.name}</span>
    </a>
    <p class="brand__tagline">${identity.tagline}</p>
  </div>
  <div class="dateline wrap">
    <span>${fmtWeekday()}</span>
    <span class="dateline__kicker">${identity.kicker}</span>
    ${issue ? html`<a href="/issue/${issue.number}">العدد ${issue.number}: ${issue.title}</a>` : html`<a href="/issues">الأعداد</a>`}
  </div>
  <nav class="sections" aria-label="أقسام الجريدة">
    <div class="sections__scroll wrap">
      <a href="/" ${!active && ctx.url.pathname === '/' ? raw('aria-current="page"') : ''}>الرئيسية</a>
      ${cats.map((c) => html`<a href="/section/${c.slug}" ${active === c.slug ? raw('aria-current="page"') : ''}>${c.name}</a>`)}
      <a href="/issues">الأعداد</a>
      <a href="/about">عن المبادرة</a>
    </div>
  </nav>
  <div class="toolbar wrap">
    <form class="search" action="/search" method="get" role="search">
      <label class="sr" for="q">ابحث في الجريدة</label>
      <input id="q" name="q" type="search" placeholder="ابحث عن مقال أو كاتب أو موضوع" value="${ctx.query.q || ''}" maxlength="80">
      <button type="submit">بحث</button>
    </form>
    <div class="toolbar__links">
      <a href="/cover">الغلاف</a>
      ${ctx.user ? html`<a class="btn-mini" href="${ctx.user.role === 'student' ? '/desk' : '/newsroom'}">${ctx.user.role === 'student' ? 'مكتبي الصحفي' : 'غرفة التحرير'}</a>`
    : html`<a class="btn-mini" href="/login">دخول الكتّاب</a>`}
    </div>
  </div>
</header>
<main id="main" class="wrap">${flashBox(ctx)}${body}</main>
${footer()}
<div class="lightbox" hidden><button type="button" class="lightbox__close" aria-label="إغلاق">×</button><img alt=""></div>
</body></html>`;
}

function footer() {
  const identity = db.setting('identity');
  const inst = db.setting('institution');
  const team = db.setting('team');
  return html`<footer class="colophon">
  <div class="wrap colophon__grid">
    <div>
      <p class="colophon__name">${identity.name}</p>
      <p>${identity.description}</p>
    </div>
    <div>
      <p class="colophon__head">هيئة الإشراف والتحرير</p>
      <dl class="colophon__team">${team.map((m) => html`<div><dt>${m.title}</dt><dd>${m.name}</dd></div>`)}</dl>
    </div>
    <div>
      <p class="colophon__head">الجهة المصدرة</p>
      <p>${inst.ministry}<br>${inst.directorate}<br>${inst.school}</p>
    </div>
  </div>
  <div class="wrap colophon__base">
    <span>جميع المواد المنشورة من إعداد طلبة المدرسة، وتُنشر بعد مراجعة هيئة التحرير.</span>
    <a href="/about">عن المبادرة</a>
  </div>
</footer>`;
}

// ===== مساحات العمل (غرفة الطالب وغرفة التحرير) =====
function workPage(ctx, { title, body, area, nav = '', wide = false }) {
  const identity = db.setting('identity');
  const roleName = { student: 'طالب', editor: 'محرر', admin: 'مسؤول الجريدة' }[ctx.user.role];
  return html`${head({ title, robots: 'noindex, nofollow' })}
<body class="work work--${area}">
<a class="skip" href="#main">تخطَّ إلى المحتوى</a>
<header class="workbar">
  <div class="workbar__in">
    <a class="workbar__brand" href="${area === 'desk' ? '/desk' : '/newsroom'}">
      ${nib('workbar__nib')}
      <span><b>${identity.name}</b><small>${area === 'desk' ? 'مكتبي الصحفي' : 'غرفة التحرير'}</small></span>
    </a>
    <div class="workbar__user">
      <a href="/" class="workbar__link">الجريدة</a>
      <details class="menu">
        <summary><span class="avatar-dot" aria-hidden="true">${(ctx.user.display_name || '؟').replace(/^(أ|د|م)\.\s*/, '').trim().charAt(0)}</span><span class="menu__name">${ctx.user.display_name}</span></summary>
        <div class="menu__pop">
          <p class="menu__role">${roleName}</p>
          <a href="/account/password">تغيير كلمة المرور</a>
          ${area === 'desk' ? html`<a href="/desk/profile">ملفي وصورتي</a>` : ''}
          <form method="post" action="/logout">${csrfField(ctx)}<button type="submit">تسجيل الخروج</button></form>
        </div>
      </details>
    </div>
  </div>
  ${nav}
</header>
<main id="main" class="workmain ${wide ? 'workmain--wide' : ''}">${flashBox(ctx)}${body}</main>
<div class="lightbox" hidden><button type="button" class="lightbox__close" aria-label="إغلاق">×</button><img alt=""></div>
</body></html>`;
}

// صفحة بسيطة مستقلة (الدخول، الأخطاء)
function plainPage(ctx, { title, body }) {
  const identity = db.setting('identity');
  return html`${head({ title, robots: 'noindex' })}
<body class="plain">
<main id="main" class="plain__box">
  <a class="plain__brand" href="/">${paperLogo('plain__nib')}<span>${identity.name}</span></a>
  ${flashBox(ctx)}
  ${body}
</main>
</body></html>`;
}

module.exports = { publicPage, workPage, plainPage, csrfField, stamp, nib, paperLogo, flashBox };
