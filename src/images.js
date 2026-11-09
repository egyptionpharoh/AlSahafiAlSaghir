'use strict';
// فحص الصور المرفوعة من محتواها الحقيقي (لا من الامتداد)، وقراءة أبعادها،
// وإزالة البيانات الوصفية (EXIF / GPS / XMP / التعليقات) قبل الحفظ.
// إن كانت حزمة sharp مثبتة (اختياري) يُعاد ترميز الصورة بالكامل للحصول على أعلى درجة أمان وضغط.
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { randomId } = require('./security');

let sharp = null;
if (process.env.IMAGE_PROCESSOR !== 'builtin') {
  try { sharp = require('sharp'); } catch { /* اختياري */ }
}

const TYPES = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

function sniff(buf) {
  if (buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// ---------- JPEG ----------
function jpegClean(buf) {
  const out = [buf.slice(0, 2)];
  let i = 2, width = 0, height = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error('bad jpeg marker');
    let marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd9) { out.push(buf.slice(i, i + 2)); break; }
    if (marker >= 0xd0 && marker <= 0xd7) { out.push(buf.slice(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error('truncated jpeg');
    const seg = buf.slice(i, i + 2 + len);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      height = buf.readUInt16BE(i + 5); width = buf.readUInt16BE(i + 7);
    }
    const isApp = marker >= 0xe1 && marker <= 0xef; // APP1..APP15 (EXIF, XMP, ...)
    const isIcc = marker === 0xe2 && seg.toString('ascii', 4, 15) === 'ICC_PROFILE';
    const isComment = marker === 0xfe;
    if ((!isApp || isIcc) && !isComment) out.push(seg);
    i += 2 + len;
    if (marker === 0xda) { // بداية بيانات الصورة: ننسخ الباقي كما هو
      out.push(buf.slice(i));
      break;
    }
  }
  return { buf: Buffer.concat(out), width, height };
}

// ---------- PNG ----------
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD']);
function pngClean(buf) {
  const out = [buf.slice(0, 8)];
  let i = 8, width = 0, height = 0, sawEnd = false;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('ascii', i + 4, i + 8);
    const total = 12 + len;
    if (i + total > buf.length) throw new Error('truncated png');
    if (type === 'IHDR') { width = buf.readUInt32BE(i + 8); height = buf.readUInt32BE(i + 12); }
    if (PNG_KEEP.has(type)) out.push(buf.slice(i, i + total));
    i += total;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!sawEnd) throw new Error('png without IEND');
  return { buf: Buffer.concat(out), width, height };
}

// ---------- WebP ----------
function webpClean(buf) {
  const chunks = [];
  let i = 12, width = 0, height = 0, vp8x = null;
  while (i + 8 <= buf.length) {
    const type = buf.toString('ascii', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const total = 8 + len + (len % 2);
    if (i + 8 + len > buf.length) throw new Error('truncated webp');
    const chunk = Buffer.from(buf.slice(i, Math.min(i + total, buf.length)));
    if (type === 'VP8X') { vp8x = chunk; width = 1 + chunk.readUIntLE(12, 3); height = 1 + chunk.readUIntLE(15, 3); }
    if (type === 'VP8 ' && !width) { width = chunk.readUInt16LE(14) & 0x3fff; height = chunk.readUInt16LE(16) & 0x3fff; }
    if (type === 'VP8L' && !width) {
      const b = chunk.readUInt32LE(9);
      width = (b & 0x3fff) + 1; height = ((b >> 14) & 0x3fff) + 1;
    }
    if (type !== 'EXIF' && type !== 'XMP ') chunks.push(chunk);
    i += total;
  }
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // إلغاء علامتي EXIF و XMP
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii'); header.writeUInt32LE(4 + body.length, 4); header.write('WEBP', 8, 'ascii');
  return { buf: Buffer.concat([header, body]), width, height };
}

const MAX_SIDE = { profile: 800, cover: 2000, inline: 2000, site: 2000, issue: 2000 };

/**
 * يتحقق من الصورة ويُنظّفها. يرمي خطأ برسالة عربية مناسبة للمستخدم عند الرفض.
 */
async function processImage(buf, kind) {
  if (!buf || !buf.length) throw userError('لم يصل ملف الصورة.');
  if (buf.length > config.maxUploadBytes) throw userError(`حجم الصورة أكبر من الحد المسموح (${Math.round(config.maxUploadBytes / 1048576)} ميغابايت).`);
  const type = sniff(buf);
  if (!type) throw userError('نوع الملف غير مسموح. يُقبل فقط: JPG أو PNG أو WebP.');

  if (sharp) {
    try {
      const img = sharp(buf, { failOn: 'error', limitInputPixels: 50e6 }).rotate();
      const side = MAX_SIDE[kind] || 2000;
      const outType = type === 'png' ? 'png' : (type === 'webp' ? 'webp' : 'jpeg');
      let pipeline = img.resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true });
      pipeline = outType === 'jpeg' ? pipeline.jpeg({ quality: 84, mozjpeg: true })
        : outType === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.webp({ quality: 84 });
      const { data, info } = await pipeline.toBuffer({ resolveWithObject: true }); // sharp يحذف البيانات الوصفية افتراضيًا
      return { buf: data, width: info.width, height: info.height, ...TYPES[outType] };
    } catch {
      throw userError('تعذر قراءة الصورة. قد يكون الملف تالفًا.');
    }
  }

  let r;
  try {
    r = type === 'jpeg' ? jpegClean(buf) : type === 'png' ? pngClean(buf) : webpClean(buf);
  } catch {
    throw userError('تعذر قراءة الصورة. قد يكون الملف تالفًا أو غير مكتمل.');
  }
  if (!r.width || !r.height || r.width > 12000 || r.height > 12000) throw userError('أبعاد الصورة غير صالحة.');
  return { buf: r.buf, width: r.width, height: r.height, ...TYPES[type] };
}

function userError(msg) { const e = new Error(msg); e.userMessage = msg; e.status = 400; return e; }

// ===== التخزين الدائم =====
// 'disk': مجلد uploads (التشغيل على جهاز المدرسة). 'db': داخل قاعدة البيانات (Vercel/Turso — لا قرص دائم هناك).
// المفاتيح القديمة (2026/11/xxx.jpg) تبقى مقروءة من القرص دائمًا؛ المفاتيح الجديدة في قاعدة البيانات تبدأ بـ db/
const DB_KEY = /^db\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/;

async function storeFile(buf, ext) {
  if (config.imageStore === 'db') {
    const db = require('./db');
    const key = `db/${randomId(18)}.${ext}`;
    await db.run('INSERT INTO media_data (storage_key, data, created_at) VALUES (?, ?, ?)', key, buf, db.now());
    return key;
  }
  const d = new Date();
  const dir = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const name = `${randomId(18)}.${ext}`;
  const key = `${dir}/${name}`;
  const full = path.join(config.uploadsDir, dir);
  fs.mkdirSync(full, { recursive: true });
  const tmp = path.join(full, `.${name}.tmp`);
  fs.writeFileSync(tmp, buf, { mode: 0o640 });
  fs.renameSync(tmp, path.join(full, name)); // كتابة ذرية
  return key;
}

function filePath(key) {
  if (!/^\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.(jpg|png|webp)$/.test(key)) return null;
  return path.join(config.uploadsDir, key);
}

/** يقرأ محتوى الصورة أينما خُزّنت. يعيد Buffer أو null */
async function readFile(key) {
  if (DB_KEY.test(key)) {
    const db = require('./db');
    const r = await db.one('SELECT data FROM media_data WHERE storage_key = ?', key);
    return r && r.data ? Buffer.from(r.data) : null;
  }
  const p = filePath(key);
  if (!p) return null;
  try { return fs.readFileSync(p); } catch { return null; }
}

async function removeFile(key) {
  if (DB_KEY.test(key)) { const db = require('./db'); await db.run('DELETE FROM media_data WHERE storage_key = ?', key); return; }
  const p = filePath(key); if (p) fs.rm(p, { force: true }, () => {});
}

module.exports = { processImage, storeFile, filePath, readFile, removeFile, sniff, hasSharp: () => !!sharp };
