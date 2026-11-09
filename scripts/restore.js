'use strict';
// استعادة نسخة احتياطية (قاعدة البيانات + الصور).
//
//   1) أوقف التطبيق أولًا.
//   2) node scripts/restore.js --from backups/2026-11-08_183000 --yes
//
// قبل الاستبدال تُحفظ نسخة من البيانات الحالية تلقائيًا في backups/pre-restore-.../
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');

function restore(from, { quiet = false } = {}) {
  const src = path.resolve(from);
  const dbSrc = path.join(src, 'app.db');
  if (!fs.existsSync(dbSrc)) throw new Error(`لا توجد قاعدة بيانات في ${src}`);
  // تحقق سريع من سلامة الملف
  const { DatabaseSync } = require('node:sqlite');
  const check = new DatabaseSync(dbSrc, { readOnly: true });
  const ok = check.prepare('PRAGMA integrity_check').get();
  check.close();
  if (Object.values(ok)[0] !== 'ok') throw new Error('ملف قاعدة البيانات في النسخة تالف.');

  // حفظ البيانات الحالية قبل الاستبدال
  const safety = path.join(config.backupsDir, `pre-restore-${Date.now()}`);
  fs.mkdirSync(safety, { recursive: true });
  for (const f of ['app.db', 'app.db-wal', 'app.db-shm']) {
    const p = path.join(config.dataDir, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(safety, f));
  }
  if (fs.existsSync(config.uploadsDir)) fs.cpSync(config.uploadsDir, path.join(safety, 'uploads'), { recursive: true });

  // الاستبدال
  fs.mkdirSync(config.dataDir, { recursive: true });
  for (const f of ['app.db-wal', 'app.db-shm']) fs.rmSync(path.join(config.dataDir, f), { force: true });
  fs.copyFileSync(dbSrc, config.dbFile);
  fs.rmSync(config.uploadsDir, { recursive: true, force: true });
  const upSrc = path.join(src, 'uploads');
  if (fs.existsSync(upSrc)) fs.cpSync(upSrc, config.uploadsDir, { recursive: true });
  else fs.mkdirSync(config.uploadsDir, { recursive: true });
  if (!quiet) {
    console.log(`✓ استُعيدت النسخة من: ${src}`);
    console.log(`  البيانات السابقة محفوظة احتياطيًا في: ${safety}`);
  }
  return { safety };
}

if (require.main === module) {
  const i = process.argv.indexOf('--from');
  if (i < 0 || !process.argv[i + 1]) { console.error('الاستخدام: node scripts/restore.js --from <مجلد النسخة> --yes'); process.exit(1); }
  if (!process.argv.includes('--yes')) { console.error('تأكد أن التطبيق متوقف، ثم أعد الأمر مع --yes للتأكيد.'); process.exit(1); }
  try { restore(process.argv[i + 1]); } catch (e) { console.error('✗', e.message); process.exit(1); }
}

module.exports = { restore };
