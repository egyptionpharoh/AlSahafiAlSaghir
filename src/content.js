'use strict';
// محتوى المقال يُخزَّن كـ«كتل» منظَّمة (JSON) لا كـ HTML حر،
// ثم يُحوَّل إلى HTML آمن عند العرض. هذا يمنع حقن الأكواد (XSS) من الأساس.
const { html, raw, esc } = require('./http');
const { GRADE_NAMES } = require('./defaults');

const BLOCK_TYPES = new Set(['p', 'h2', 'h3', 'quote', 'ul', 'ol', 'img']);
const LIMITS = { blocks: 200, text: 6000, items: 60, item: 1500, caption: 300 };

const clean = (s, max) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);

/** يتحقق من الكتل ويعيد نسخة نظيفة. يرمي خطأ عند البنية غير الصالحة. */
function sanitizeBlocks(input) {
  if (!Array.isArray(input)) throw new Error('صيغة المحتوى غير صالحة.');
  if (input.length > LIMITS.blocks) throw new Error('المقال طويل جدًا (عدد الأجزاء كبير).');
  const out = [];
  for (const b of input) {
    if (!b || typeof b !== 'object' || !BLOCK_TYPES.has(b.t)) continue;
    if (b.t === 'img') {
      const m = String(b.m || '');
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(m)) continue;
      out.push({ t: 'img', m, cap: clean(b.cap, LIMITS.caption).replace(/\n/g, ' ').trim() });
    } else if (b.t === 'ul' || b.t === 'ol') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, LIMITS.items).map((x) => clean(x, LIMITS.item).trim()).filter(Boolean);
      out.push({ t: b.t, items });
    } else {
      out.push({ t: b.t, text: clean(b.text, LIMITS.text) });
    }
  }
  return out;
}

function parseBody(json) { try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }

/** التنسيق داخل الفقرة: **عريض** و *مائل* — بعد الهروب الكامل للنص */
function inline(text) {
  let s = esc(text);
  s = s.replace(/\*\*([^*\n][^\n]*?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\n/g, '<br>');
  return raw(s);
}

/**
 * يحوّل الكتل إلى HTML. mediaMap: public_id → {width,height}
 */
function renderBody(blocks, mediaMap = {}) {
  const out = [];
  let figNo = 0;
  for (const b of blocks) {
    switch (b.t) {
      case 'p': if (b.text.trim()) out.push(html`<p>${inline(b.text.trim())}</p>`); break;
      case 'h2': if (b.text.trim()) out.push(html`<h2>${b.text.trim()}</h2>`); break;
      case 'h3': if (b.text.trim()) out.push(html`<h3>${b.text.trim()}</h3>`); break;
      case 'quote': if (b.text.trim()) out.push(html`<blockquote><p>${inline(b.text.trim())}</p></blockquote>`); break;
      case 'ul': case 'ol': {
        if (!b.items.length) break;
        const li = b.items.map((x) => html`<li>${inline(x)}</li>`);
        out.push(b.t === 'ul' ? html`<ul>${li}</ul>` : html`<ol>${li}</ol>`);
        break;
      }
      case 'img': {
        const m = mediaMap[b.m];
        if (!m) break;
        figNo += 1;
        out.push(html`<figure class="fig">
          <a class="fig__link" href="/media/${b.m}" data-lightbox>
            <img src="/media/${b.m}" width="${m.width}" height="${m.height}" loading="lazy" decoding="async" alt="${b.cap || `صورة ${figNo} من المقال`}">
          </a>
          ${b.cap ? html`<figcaption>${b.cap}</figcaption>` : ''}
        </figure>`);
        break;
      }
      default: break;
    }
  }
  return raw(out.map((x) => x.s).join('\n'));
}

function imageIds(blocks) { return blocks.filter((b) => b.t === 'img').map((b) => b.m); }

function plainText(blocks) {
  return blocks.map((b) => (b.items ? b.items.join(' ') : b.text || '')).join(' ').replace(/\*+/g, '');
}

function wordCount(blocks) { return plainText(blocks).split(/\s+/).filter(Boolean).length; }
function readingMinutes(blocks) { return Math.max(1, Math.round(wordCount(blocks) / 170)); }
/** «دقيقة واحدة»، «دقيقتان»، «3 دقائق»، «11 دقيقة» */
function readingLabel(blocks) {
  const n = readingMinutes(blocks);
  if (n === 1) return 'قراءة في دقيقة واحدة';
  if (n === 2) return 'قراءة في دقيقتين';
  return `قراءة في ${n} ${n <= 10 ? 'دقائق' : 'دقيقة'}`;
}

function slugify(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[ً-ْـ]/g, '') // التشكيل والتطويل
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/, '')
    .toLowerCase();
}

// ===== التواريخ والصفوف =====
const TZ = 'Asia/Muscat';
const fmtDate = (iso) => iso ? new Intl.DateTimeFormat('ar-OM-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(new Date(iso)) : '';
const fmtDateTime = (iso) => iso ? new Intl.DateTimeFormat('ar-OM-u-nu-latn', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ }).format(new Date(iso)) : '';
const fmtWeekday = (d = new Date()) => new Intl.DateTimeFormat('ar-OM-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }).format(d);
const gradeLabel = (g, section) => g ? `الصف ${GRADE_NAMES[g] || g}${section ? ` / ${section}` : ''}` : '';

/** توقيع الكاتب العام وفق الموافقات المسجلة */
function byline(a, publishing) {
  const nameOk = !publishing.require_name_consent || a.consent_name_public;
  return {
    name: nameOk ? a.author_name : null,
    text: nameOk ? `بقلم الطالب: ${a.author_name}` : `بقلم طالب من ${gradeLabel(a.grade)}`,
    grade: gradeLabel(a.grade),
    photo: nameOk && a.consent_photo_public && a.photo_pid ? a.photo_pid : null,
  };
}

module.exports = { sanitizeBlocks, parseBody, renderBody, inline, imageIds, plainText, wordCount, readingMinutes, readingLabel, slugify, fmtDate, fmtDateTime, fmtWeekday, gradeLabel, byline, LIMITS };
