'use strict';
// قائمة الترحيلات بأسماء صريحة — حتى تُضمَّن ملفات SQL تلقائيًا عند النشر على Vercel.
// عند إضافة ترحيل جديد: أنشئ ملف SQL ثم أضف سطرًا له هنا.
const fs = require('node:fs');
const path = require('node:path');

module.exports = [
  { name: '001_schema.sql', sql: fs.readFileSync(path.join(__dirname, '001_schema.sql'), 'utf8') },
  { name: '002_seed_categories.sql', sql: fs.readFileSync(path.join(__dirname, '002_seed_categories.sql'), 'utf8') },
  { name: '003_cloud_and_guest.sql', sql: fs.readFileSync(path.join(__dirname, '003_cloud_and_guest.sql'), 'utf8') },
];
