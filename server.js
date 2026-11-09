'use strict';
// نقطة تشغيل تطبيق «الصحفي الصغير»
//  • على جهاز المدرسة:  node server.js   (Node.js 22.13 أو أحدث — لا يحتاج npm install)
//  • على Vercel: يُصدِّر هذا الملف دالة (req, res) تستقبل كل الطلبات، ولا يفتح منفذًا ولا يُنهي العملية أبدًا.
const [major, minor] = process.versions.node.split('.').map(Number);
const tooOld = major < 22 || (major === 22 && minor < 13);

if (process.env.VERCEL) {
  const { handle } = require('./src/app');
  module.exports = (req, res) => handle(req, res);
} else {
  if (tooOld) {
    console.error(`يتطلب التطبيق Node.js 22.13 أو أحدث. الإصدار الحالي: ${process.versions.node}`);
    process.exit(1);
  }
  const config = require('./src/config');
  const { start } = require('./src/app');
  const db = require('./src/db');
  const images = require('./src/images');
  const { setupUrl } = require('./src/routes/setup');

  const openBrowser = (url) => {
    const { exec } = require('node:child_process');
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  };

  start().then(async (server) => {
    console.log(`\n  «الصحفي الصغير» يعمل الآن على: http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`  البيئة: ${config.isProd ? 'إنتاج' : 'تطوير'} | البيانات: ${db.kind() === 'turso' ? 'Turso (سحابية)' : config.dataDir} | معالجة الصور: ${images.hasSharp() ? 'sharp' : 'مدمجة'}`);
    const local = `http://localhost:${config.port}`;
    const setup = await setupUrl(local);
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
  }).catch((e) => {
    console.error('\n  تعذر تشغيل الجريدة:', e && e.message ? e.message : e);
    process.exit(1);
  });
}
