'use strict';
// نسخة احتياطية كاملة: قاعدة البيانات + كل الصور المرفوعة.
//
//   node scripts/backup.js                 → backups/2026-11-08_1830/
//   node scripts/backup.js --out D:\Backups → مجلد آخر
//
// يمكن تشغيله والتطبيق يعمل (يستخدم VACUUM INTO للحصول على نسخة متسقة من قاعدة البيانات).
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1;
  return n;
}

function backup(outRoot = config.backupsDir) {
  db.open();
  const dir = path.join(outRoot, stamp());
  fs.mkdirSync(dir, { recursive: true });
  const dbOut = path.join(dir, 'app.db');
  db.get().exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  const up = path.join(dir, 'uploads');
  if (fs.existsSync(config.uploadsDir)) fs.cpSync(config.uploadsDir, up, { recursive: true, filter: (src) => !path.basename(src).endsWith('.tmp') });
  else fs.mkdirSync(up);
  const manifest = {
    app: 'alsahafi-alsaghir', created_at: new Date().toISOString(),
    articles: db.one('SELECT COUNT(*) n FROM articles').n,
    users: db.one('SELECT COUNT(*) n FROM users').n,
    media_rows: db.one('SELECT COUNT(*) n FROM media').n,
    upload_files: countFiles(up),
    includes: ['app.db (قاعدة البيانات كاملة)', 'uploads/ (كل الصور)'],
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.close();
  return { dir, manifest };
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const out = i > -1 ? path.resolve(process.argv[i + 1]) : undefined;
  const { dir, manifest } = backup(out);
  console.log(`✓ اكتملت النسخة الاحتياطية في: ${dir}`);
  console.log(`  مقالات: ${manifest.articles} | حسابات: ${manifest.users} | صور: ${manifest.upload_files}`);
}

module.exports = { backup };
