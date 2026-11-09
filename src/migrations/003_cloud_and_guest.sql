-- 003: تخزين الصور داخل قاعدة البيانات (للنشر على Vercel بلا قرص دائم)
--      + الكتابة المباشرة للطلبة دون حساب (صفحة «اكتب للجريدة»)

-- محتوى الصور عند التخزين في قاعدة البيانات (المفاتيح التي تبدأ بـ db/)
CREATE TABLE IF NOT EXISTS media_data (
  storage_key TEXT PRIMARY KEY,
  data        BLOB NOT NULL,
  created_at  TEXT NOT NULL
);

-- صورة رُفعت من صفحة «اكتب للجريدة» قبل إرسال المقال: تُربط بالمقال عند الإرسال بهذا الرمز السري
ALTER TABLE media ADD COLUMN claim_token TEXT;
CREATE INDEX IF NOT EXISTS idx_media_claim ON media(claim_token);

-- رمز سري لمتابعة حالة المقال المرسل دون حساب
ALTER TABLE articles ADD COLUMN guest_key TEXT;

-- حساب «كاتب ضيف» يُنشأ تلقائيًا لكل مشاركة دون حساب (لا يمكن الدخول به)
ALTER TABLE users ADD COLUMN is_guest INTEGER NOT NULL DEFAULT 0;
