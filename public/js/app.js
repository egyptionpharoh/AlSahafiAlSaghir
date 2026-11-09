/* «الصحفي الصغير» — تحسينات الواجهة العامة + أداة ضغط الصور ورفعها (مشتركة) */
(function () {
  'use strict';
  var SS = (window.SS = window.SS || {});

  SS.csrf = function () {
    var m = document.querySelector('meta[name="csrf"]');
    if (m) return m.content;
    var i = document.querySelector('input[name="_csrf"]');
    return i ? i.value : '';
  };

  /* ===== ضغط الصورة في المتصفح قبل رفعها =====
     يعيد رسم الصورة على canvas، فتُزال بياناتها الوصفية (مثل موقع التصوير)
     ويُصغَّر حجمها لتُرفع بسرعة من الهاتف. الخادم يعيد الفحص على أي حال. */
  SS.compressImage = function (file, opts) {
    opts = opts || {};
    var maxSide = opts.maxSide || 2000;
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type || 'image/')) { reject(new Error('اختر ملف صورة.')); return; }
      if (file.size > 40 * 1024 * 1024) { reject(new Error('الصورة كبيرة جدًا.')); return; }
      var done = function (source, w, h) {
        var scale = Math.min(1, maxSide / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var g = canvas.getContext('2d');
        var keepPng = opts.keepPng && file.type === 'image/png';
        if (!keepPng) { g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch); }
        g.drawImage(source, 0, 0, cw, ch);
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('تعذر تجهيز الصورة.')); return; }
          resolve(blob);
        }, keepPng ? 'image/png' : 'image/jpeg', 0.85);
      };
      var fallback = function () {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); done(img, img.naturalWidth, img.naturalHeight); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('تعذر قراءة الصورة. جرّب صورة بصيغة JPG أو PNG.')); };
        img.src = url;
      };
      if (window.createImageBitmap) {
        createImageBitmap(file, { imageOrientation: 'from-image' })
          .then(function (bmp) { done(bmp, bmp.width, bmp.height); })
          .catch(fallback);
      } else fallback();
    });
  };

  /* رفع ملف ثنائي مع شريط تقدّم */
  SS.upload = function (url, blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      xhr.setRequestHeader('X-CSRF-Token', SS.csrf());
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.timeout = 120000;
      if (onProgress && xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = function () {
        var data = null; try { data = JSON.parse(xhr.responseText); } catch (e) { /* */ }
        if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
        else reject(new Error((data && data.error) || 'تعذر رفع الصورة. تحقق من الاتصال وحاول مجددًا.'));
      };
      xhr.onerror = function () { reject(new Error('انقطع الاتصال أثناء الرفع. حاول مجددًا.')); };
      xhr.ontimeout = function () { reject(new Error('استغرق الرفع وقتًا طويلًا. جرّب اتصالًا أسرع أو صورة أصغر.')); };
      xhr.send(blob);
    });
  };

  document.addEventListener('DOMContentLoaded', function () {
    /* عرض الصور بحجم أكبر */
    var box = document.querySelector('.lightbox');
    if (box) {
      var big = box.querySelector('img');
      var close = function () { box.hidden = true; big.removeAttribute('src'); document.body.classList.remove('noscroll'); };
      document.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('[data-lightbox]');
        if (!a) return;
        e.preventDefault();
        var img = a.querySelector('img');
        big.src = a.getAttribute('href');
        big.alt = img ? img.alt : '';
        box.hidden = false;
        document.body.classList.add('noscroll');
        box.querySelector('.lightbox__close').focus();
      });
      box.addEventListener('click', function (e) { if (e.target !== big) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !box.hidden) close(); });
    }

    /* مشاركة الرابط */
    document.querySelectorAll('[data-share]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var title = (btn.closest('[data-share-title]') || {}).getAttribute ? btn.closest('[data-share-title]').getAttribute('data-share-title') : document.title;
        var url = location.href.split('#')[0];
        if (navigator.share) { navigator.share({ title: title, url: url }).catch(function () {}); return; }
        var ok = function () { var t = btn.textContent; btn.textContent = 'نُسخ الرابط'; setTimeout(function () { btn.textContent = t; }, 2000); };
        if (navigator.clipboard) navigator.clipboard.writeText(url).then(ok, function () { prompt('انسخ الرابط:', url); });
        else prompt('انسخ الرابط:', url);
      });
    });

    document.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

    /* تأكيد الإجراءات الحساسة + منع الإرسال المزدوج */
    document.querySelectorAll('form').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        var msg = f.getAttribute('data-confirm');
        if (msg && !confirm(msg)) { e.preventDefault(); return; }
        if (f.hasAttribute('data-submit-form')) return; // يتولاه المحرر
        setTimeout(function () { f.querySelectorAll('button[type="submit"], button:not([type])').forEach(function (b) { b.disabled = true; }); }, 0);
      });
    });

    /* أشرطة الإحصاءات */
    document.querySelectorAll('[data-w]').forEach(function (el) { el.style.width = Math.max(2, Number(el.getAttribute('data-w')) || 0) + '%'; });

    /* إغلاق قائمة المستخدم عند النقر خارجها */
    document.addEventListener('click', function (e) {
      document.querySelectorAll('details.menu[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
    });
  });
})();
