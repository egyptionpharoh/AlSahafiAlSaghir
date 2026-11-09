'use strict';
// نقطة تشغيل تطبيق «الصحفي الصغير»
// التشغيل:  node server.js     (يتطلب Node.js 22.13 أو أحدث — لا يحتاج npm install)
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`يتطلب التطبيق Node.js 22.13 أو أحدث. الإصدار الحالي: ${process.versions.node}`);
  process.exit(1);
}

const config = require('./src/config');
const { start } = require('./src/app');
const db = require('./src/db');
const images = require('./src/images');
const { setupUrl } = require('./src/routes/setup');

function openBrowser(url) {
  const { exec } = require('node:child_process');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

start().then((server) => {
  console.log(`\n  «الصحفي الصغير» يعمل الآن على: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
  console.log(`  البيئة: ${config.isProd ? 'إنتاج' : 'تطوير'} | البيانات: ${config.dataDir} | معالجة الصور: ${images.hasSharp() ? 'sharp' : 'مدمجة'}`);
  const local = `http://localhost:${config.port}`;
  const setup = setupUrl(local);
  if (setup) {
    console.log('\n  ⚠ لا يوجد حساب مسؤول بعد. افتح هذا الرابط لإنشائه من المتصفح:');
    console.log(`    ${setup}\n`);
  }
  // على جهاز المدرسة (وضع التطوير) يُفتح المتصفح تلقائيًا
  if (!config.isProd && process.env.NODE_ENV !== 'test' && process.env.OPEN_BROWSER !== '0') openBrowser(setup || local);

  const shutdown = () => {
    console.log('\n  إيقاف الخادم...');
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});
