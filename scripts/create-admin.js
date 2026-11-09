'use strict';
// إنشاء حساب «مسؤول الجريدة» الأول (أو مسؤول إضافي) بأمان من سطر الأوامر.
//
//   node scripts/create-admin.js
//
// يسألك عن الاسم واسم المستخدم وكلمة المرور (لا تظهر كلمة المرور أثناء الكتابة).
// للاستضافات التي لا تتيح إدخالًا تفاعليًا يمكن تمرير القيم عبر متغيرات بيئة مؤقتة:
//   ADMIN_NAME="..." ADMIN_USERNAME="..." ADMIN_PASSWORD="..." node scripts/create-admin.js
// (احذف هذه المتغيرات من لوحة الاستضافة فور الانتهاء)
const readline = require('node:readline');
const db = require('../src/db');
const S = require('../src/security');

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = function (s) { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'.repeat(s.length ? 1 : 0)); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

(async () => {
  await db.open();
  const env = process.env;
  const interactive = !env.ADMIN_PASSWORD;
  const name = env.ADMIN_NAME || await ask('الاسم الذي يظهر في غرفة التحرير: ');
  const username = (env.ADMIN_USERNAME || await ask('اسم المستخدم (حروف إنجليزية وأرقام): ')).toLowerCase();
  if (!name || name.length < 3) { console.error('الاسم قصير جدًا.'); process.exit(1); }
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) { console.error('اسم المستخدم غير صالح.'); process.exit(1); }
  if (await db.one('SELECT 1 FROM users WHERE username = ?', username)) { console.error('اسم المستخدم موجود مسبقًا.'); process.exit(1); }
  let password = env.ADMIN_PASSWORD;
  if (interactive) {
    password = await ask('كلمة المرور (10 أحرف على الأقل، أحرف وأرقام): ', { hidden: true });
    const again = await ask('أعد كتابة كلمة المرور: ', { hidden: true });
    if (password !== again) { console.error('كلمتا المرور غير متطابقتين.'); process.exit(1); }
  }
  const problem = S.passwordProblem(password, { role: 'admin' });
  if (problem) { console.error(problem); process.exit(1); }
  const t = db.now();
  const r = await db.run('INSERT INTO users (username, password_hash, role, display_name, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    username, S.hashPassword(password), 'admin', name, t, t);
  await S.audit(null, 'admin.create.cli', 'user', Number(r.lastInsertRowid), { username });
  console.log(`\n✓ أُنشئ حساب مسؤول الجريدة «${name}» باسم المستخدم: ${username}`);
  console.log('  ادخل من صفحة /login ثم أكمل إعدادات الجريدة وأضف الطلبة.\n');
  db.close();
})();
