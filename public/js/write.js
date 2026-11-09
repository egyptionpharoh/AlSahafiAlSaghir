/* «اكتب للجريدة»: عدّاد الكلمات، إرفاق الصور (ضغطها في المتصفح ثم رفعها)، وحفظ المسودة في الجهاز */
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    var form = document.querySelector('[data-write]');
    if (!form) return;
    var minWords = Number(form.getAttribute('data-min-words')) || 40;
    var maxImages = Number(form.getAttribute('data-max-images')) || 6;
    var token = form.getAttribute('data-token');
    var body = form.querySelector('[data-body]');
    var count = form.querySelector('[data-count]');
    var pics = form.querySelector('[data-pics]');
    var field = form.querySelector('[data-images-field]');
    var file = form.querySelector('[data-file]');
    var status = form.querySelector('[data-status]');
    var submit = form.querySelector('[data-submit]');
    var uploading = 0;
    var DRAFT = 'ss-write-draft';

    var words = function () { return (body.value.trim().match(/\S+/g) || []).length; };
    var updateCount = function () {
      var n = words();
      count.textContent = n >= minWords ? 'عدد الكلمات: ' + n + ' ✓' : 'عدد الكلمات: ' + n + ' — اكتب ' + minWords + ' كلمة على الأقل.';
      count.classList.toggle('ok', n >= minWords);
    };
    var say = function (t, err) { status.textContent = t || ''; status.classList.toggle('danger', !!err); };

    var list = function () { return field.value ? field.value.split(',').filter(Boolean) : []; };
    var setList = function (a) { field.value = a.join(','); saveDraft(); };
    var refreshAdd = function () {
      var add = form.querySelector('[data-add]');
      if (add) add.hidden = list().length >= maxImages;
    };

    /* المسودة تُحفظ في هذا الجهاز فقط، حتى لا يضيع ما كتبه الطالب إن أُغلقت الصفحة */
    var fields = ['name', 'grade', 'section', 'category_id', 'title', 'body'];
    function saveDraft() {
      try {
        var d = {}; fields.forEach(function (k) { d[k] = form.elements[k].value; });
        d.images = field.value;
        d.caps = {}; form.querySelectorAll('[data-pic]').forEach(function (p) { d.caps[p.getAttribute('data-pic')] = p.querySelector('input').value; });
        localStorage.setItem(DRAFT, JSON.stringify(d));
      } catch (e) { /* التخزين غير متاح */ }
    }
    function restoreDraft() {
      try {
        var d = JSON.parse(localStorage.getItem(DRAFT) || 'null');
        if (!d) return;
        var empty = fields.every(function (k) { return !form.elements[k].value; });
        if (!empty) return; // الصفحة عادت من الخادم بقيمها
        fields.forEach(function (k) { if (d[k]) form.elements[k].value = d[k]; });
        (d.images || '').split(',').filter(Boolean).forEach(function (item) {
          var p = item.split(':'); addPic(p[0], p[1], '/media/' + p[0] + '?t=' + p[1], (d.caps || {})[p[0]] || '');
        });
        field.value = d.images || '';
      } catch (e) { /* */ }
    }

    function addPic(pid, tok, src, cap) {
      var fig = document.createElement('figure');
      fig.className = 'pic'; fig.setAttribute('data-pic', pid);
      var img = document.createElement('img'); img.src = src; img.alt = '';
      img.onerror = function () { // صورة قديمة حُذفت (مرّ عليها أكثر من يوم)
        fig.remove(); setList(list().filter(function (x) { return x.split(':')[0] !== pid; })); refreshAdd();
      };
      var x = document.createElement('button'); x.type = 'button'; x.className = 'pic__x'; x.setAttribute('data-remove', ''); x.setAttribute('aria-label', 'حذف الصورة'); x.textContent = '×';
      var input = document.createElement('input'); input.name = 'cap_' + pid; input.maxLength = 300; input.placeholder = 'وصف الصورة'; input.value = cap || '';
      fig.appendChild(img); fig.appendChild(x); fig.appendChild(input);
      pics.appendChild(fig);
      refreshAdd();
    }

    function upload(blob, onProgress) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/write/media');
        xhr.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
        xhr.setRequestHeader('X-Write-Token', token);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.timeout = 120000;
        if (xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = function () {
          var data = null; try { data = JSON.parse(xhr.responseText); } catch (e) { /* */ }
          if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
          else reject(new Error((data && data.error) || 'تعذر رفع الصورة. تحقق من الاتصال وحاول مجددًا.'));
        };
        xhr.onerror = function () { reject(new Error('انقطع الاتصال أثناء رفع الصورة. حاول مجددًا.')); };
        xhr.ontimeout = function () { reject(new Error('استغرق الرفع وقتًا طويلًا. جرّب صورة أصغر.')); };
        xhr.send(blob);
      });
    }

    file.addEventListener('change', function () {
      var files = Array.prototype.slice.call(file.files || []);
      file.value = '';
      var room = maxImages - list().length;
      if (files.length > room) { say('يمكن إرفاق ' + maxImages + ' صور فقط. أُخذت أول ' + room + '.', true); files = files.slice(0, room); }
      files.reduce(function (p, f, i) {
        return p.then(function () {
          uploading += 1;
          var label = files.length > 1 ? ' (' + (i + 1) + ' من ' + files.length + ')' : '';
          say('جارٍ تجهيز الصورة' + label + '…');
          return SS.compressImage(f, { maxSide: 1600 })
            .then(function (blob) { return upload(blob, function (pc) { say('جارٍ رفع الصورة' + label + '… ' + pc + '%'); }).then(function (r) { return { r: r, blob: blob }; }); })
            .then(function (o) {
              setList(list().concat(o.r.pid + ':' + o.r.token));
              addPic(o.r.pid, o.r.token, URL.createObjectURL(o.blob), '');
              say('أُضيفت الصورة ✓');
            })
            .catch(function (err) { say(err.message, true); })
            .then(function () { uploading -= 1; });
        });
      }, Promise.resolve());
    });

    pics.addEventListener('click', function (e) {
      var x = e.target.closest('[data-remove]');
      if (!x) return;
      var fig = x.closest('[data-pic]');
      var pid = fig.getAttribute('data-pic');
      fig.remove();
      setList(list().filter(function (item) { return item.split(':')[0] !== pid; }));
      refreshAdd();
    });

    form.addEventListener('input', function (e) {
      if (e.target === body) updateCount();
      var box = form.querySelector('[data-submit-status]'); if (box.textContent) { box.textContent = ''; box.classList.remove('danger'); }
      saveDraft();
    });
    form.addEventListener('change', saveDraft);

    form.addEventListener('submit', function (e) {
      var problems = [];
      if (form.elements.name.value.trim().length < 3) problems.push('اكتب اسمك.');
      if (!form.elements.grade.value) problems.push('اختر صفك.');
      if (!form.elements.category_id.value) problems.push('اختر نوع المقال.');
      if (form.elements.title.value.trim().length < 4) problems.push('اكتب عنوانًا للمقال.');
      if (words() < minWords) problems.push('المقال قصير: اكتب ' + minWords + ' كلمة على الأقل.');
      if (uploading > 0) problems.push('انتظر حتى ينتهي رفع الصور.');
      if (problems.length) {
        e.preventDefault();
        var box = form.querySelector('[data-submit-status]');
        box.textContent = problems.join(' ');
        box.classList.add('danger');
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      submit.disabled = true;
      submit.textContent = 'جارٍ الإرسال…';
      try { localStorage.removeItem(DRAFT); } catch (err) { /* */ }
    });

    restoreDraft();
    updateCount();
    refreshAdd();
  });
})();
