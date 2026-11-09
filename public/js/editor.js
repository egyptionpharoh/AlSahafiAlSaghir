/* محرر المقال — كتل بسيطة (فقرة، عنوان، اقتباس، قائمة، صورة) مع حفظ تلقائي ونسخة على الجهاز */
(function () {
  'use strict';
  var D = JSON.parse(document.getElementById('article-data').textContent);
  var isEditor = D.mode === 'editor';
  var LS_KEY = 'ss-draft-' + D.pid;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var el = function (tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  };

  var state = {
    title: D.title || '', subtitle: D.subtitle || '', summary: D.summary || '',
    categoryId: D.categoryId || '', cover: D.cover, coverCaption: D.coverCaption || '',
    blocks: (D.blocks || []).map(function (b, i) { return Object.assign({ _id: 'b' + i }, b); }),
  };
  var media = D.media || {};
  var seq = state.blocks.length;
  var dirty = false, saving = false, lastSavedAt = null, timer = null, focusIdx = -1;
  if (!state.blocks.length) state.blocks.push({ _id: 'b' + seq++, t: 'p', text: '' });

  var statusEl = $('[data-save-status]');
  function setStatus(text, tone) { statusEl.textContent = text; statusEl.setAttribute('data-tone', tone || ''); }
  function timeNow() { return new Date().toLocaleTimeString('ar-OM-u-nu-latn', { hour: 'numeric', minute: '2-digit' }); }

  /* ===== الحقول الأساسية ===== */
  var fTitle = $('#f-title'), fSub = $('#f-subtitle'), fCat = $('#f-category'), fSum = $('#f-summary'), fCapCover = $('#f-covercap');
  function fillFields() {
    fTitle.value = state.title; fSub.value = state.subtitle; fSum.value = state.summary;
    fCat.value = state.categoryId ? String(state.categoryId) : ''; fCapCover.value = state.coverCaption;
    countSummary();
  }
  function countSummary() { var c = $('[data-count="f-summary"]'); if (c) c.textContent = fSum.value.length; }
  [[fTitle, 'title'], [fSub, 'subtitle'], [fSum, 'summary'], [fCapCover, 'coverCaption']].forEach(function (p) {
    p[0].addEventListener('input', function () { state[p[1]] = p[0].value; if (p[1] === 'summary') countSummary(); changed(); });
  });
  fCat.addEventListener('change', function () { state.categoryId = fCat.value; changed(); });

  /* ===== صورة الغلاف ===== */
  var coverBox = $('[data-cover-box]'), coverInput = $('[data-cover-input]'), coverRemove = $('[data-cover-remove]');
  function renderCover(progress) {
    coverBox.innerHTML = '';
    if (progress !== undefined) { coverBox.appendChild(el('div', { class: 'uploading' }, [el('span', { text: 'جارٍ رفع الصورة… ' + progress + '%' })])); return; }
    if (state.cover) {
      coverBox.appendChild(el('img', { src: '/media/' + state.cover.pid, width: state.cover.w, height: state.cover.h, alt: 'صورة الغلاف' }));
      coverRemove.hidden = false;
    } else {
      coverBox.appendChild(el('p', { class: 'muted', text: 'لا توجد صورة غلاف. الصورة الأفقية تظهر بشكل أجمل.' }));
      coverRemove.hidden = true;
    }
  }
  coverInput.addEventListener('change', function () {
    var file = coverInput.files[0]; if (!file) return;
    renderCover(0);
    SS.compressImage(file, { maxSide: 2000 })
      .then(function (blob) { return SS.upload(D.endpoints.upload + '&kind=cover', blob, renderCover); })
      .then(function (r) { state.cover = { pid: r.pid, w: r.w, h: r.h }; renderCover(); changed(true); })
      .catch(function (e) { renderCover(); alert(e.message); })
      .then(function () { coverInput.value = ''; });
  });
  coverRemove.addEventListener('click', function () { state.cover = null; renderCover(); changed(); });

  /* ===== الكتل ===== */
  var blocksEl = $('[data-blocks]');
  var LABEL = { p: 'فقرة', h2: 'عنوان', h3: 'عنوان فرعي', quote: 'اقتباس', ul: 'قائمة نقطية', ol: 'قائمة مرقمة', img: 'صورة' };

  function autoGrow(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 900) + 'px'; }

  function wrapSelection(t, mark) {
    var s = t.selectionStart, e = t.selectionEnd, v = t.value;
    if (s === e) { t.focus(); return; }
    var sel = v.slice(s, e);
    var lead = sel.match(/^\s*/)[0], trail = sel.match(/\s*$/)[0];
    var core = sel.trim();
    if (!core) return;
    t.value = v.slice(0, s) + lead + mark + core + mark + trail + v.slice(e);
    t.setSelectionRange(s + lead.length, s + lead.length + core.length + mark.length * 2);
    t.dispatchEvent(new Event('input'));
    t.focus();
  }

  function move(i, d) {
    var j = i + d; if (j < 0 || j >= state.blocks.length) return;
    var tmp = state.blocks[i]; state.blocks[i] = state.blocks[j]; state.blocks[j] = tmp;
    render(); changed();
    var target = blocksEl.children[j]; if (target) { var f = target.querySelector('textarea, input'); (f || target).focus(); }
  }

  function removeBlock(i) {
    var b = state.blocks[i];
    var hasContent = (b.text && b.text.trim()) || (b.items && b.items.length) || b.t === 'img';
    if (hasContent && !confirm('حذف هذا الجزء من المقال؟')) return;
    state.blocks.splice(i, 1);
    if (!state.blocks.length) state.blocks.push({ _id: 'b' + seq++, t: 'p', text: '' });
    render(); changed();
  }

  function blockTools(i, b) {
    return el('div', { class: 'blk__tools' }, [
      el('span', { class: 'blk__label', text: LABEL[b.t] }),
      (b.t === 'p' || b.t === 'quote' || b.t === 'ul' || b.t === 'ol') ? el('button', { type: 'button', class: 'blk__fmt', title: 'عريض', 'aria-label': 'خط عريض للنص المحدد', onclick: function () { wrapSelection(this.closest('.blk').querySelector('textarea'), '**'); } }, [el('b', { text: 'عريض' })]) : null,
      (b.t === 'p' || b.t === 'quote' || b.t === 'ul' || b.t === 'ol') ? el('button', { type: 'button', class: 'blk__fmt', title: 'مائل', 'aria-label': 'خط مائل للنص المحدد', onclick: function () { wrapSelection(this.closest('.blk').querySelector('textarea'), '*'); } }, [el('i', { text: 'مائل' })]) : null,
      el('span', { class: 'blk__spacer' }),
      el('button', { type: 'button', 'aria-label': 'تحريك لأعلى', title: 'لأعلى', disabled: i === 0 ? 'disabled' : null, onclick: function () { move(i, -1); } }, ['▲']),
      el('button', { type: 'button', 'aria-label': 'تحريك لأسفل', title: 'لأسفل', disabled: i === state.blocks.length - 1 ? 'disabled' : null, onclick: function () { move(i, 1); } }, ['▼']),
      el('button', { type: 'button', class: 'blk__del', 'aria-label': 'حذف', title: 'حذف', onclick: function () { removeBlock(i); } }, ['✕']),
    ]);
  }

  function renderBlock(b, i) {
    var wrap = el('div', { class: 'blk blk--' + b.t, 'data-i': i, 'data-id': b._id });
    wrap.addEventListener('focusin', function () { focusIdx = i; });
    wrap.appendChild(blockTools(i, b));
    if (b.t === 'h2' || b.t === 'h3') {
      var inp = el('input', { type: 'text', maxlength: 200, value: b.text || '', placeholder: b.t === 'h2' ? 'عنوان داخل المقال' : 'عنوان فرعي', 'aria-label': LABEL[b.t] });
      inp.addEventListener('input', function () { b.text = inp.value; changed(); });
      wrap.appendChild(inp);
    } else if (b.t === 'p' || b.t === 'quote') {
      var ta = el('textarea', { rows: 3, maxlength: 6000, placeholder: b.t === 'p' ? 'اكتب فقرتك هنا…' : 'نص الاقتباس، واذكر قائله في الفقرة التالية', 'aria-label': LABEL[b.t] });
      ta.value = b.text || '';
      ta.addEventListener('input', function () { b.text = ta.value; autoGrow(ta); changed(); });
      wrap.appendChild(ta); requestAnimationFrame(function () { autoGrow(ta); });
    } else if (b.t === 'ul' || b.t === 'ol') {
      var tl = el('textarea', { rows: 3, placeholder: 'اكتب كل عنصر في سطر مستقل', 'aria-label': LABEL[b.t] });
      tl.value = (b.items || []).join('\n');
      tl.addEventListener('input', function () { b.items = tl.value.split('\n'); autoGrow(tl); changed(); });
      wrap.appendChild(tl); requestAnimationFrame(function () { autoGrow(tl); });
      wrap.appendChild(el('p', { class: 'hint', text: 'كل سطر = عنصر في القائمة.' }));
    } else if (b.t === 'img') {
      if (b.uploading !== undefined) {
        wrap.appendChild(el('div', { class: 'uploading' }, [el('span', { text: 'جارٍ رفع الصورة… ' + b.uploading + '%' })]));
      } else {
        var m = media[b.m] || {};
        wrap.appendChild(el('img', { src: '/media/' + b.m, width: m.w, height: m.h, alt: b.cap || 'صورة في المقال', class: 'blk__img' }));
        var cap = el('input', { type: 'text', maxlength: 300, value: b.cap || '', placeholder: 'وصف الصورة: ماذا تُظهر؟ (مطلوب)', 'aria-label': 'وصف الصورة', class: b.cap ? '' : 'needs' });
        cap.addEventListener('input', function () { b.cap = cap.value; cap.classList.toggle('needs', !cap.value.trim()); changed(); });
        wrap.appendChild(cap);
      }
    }
    return wrap;
  }

  function render() {
    blocksEl.innerHTML = '';
    state.blocks.forEach(function (b, i) { blocksEl.appendChild(renderBlock(b, i)); });
    updateCounts();
  }

  function insertAt() { return focusIdx >= 0 && focusIdx < state.blocks.length ? focusIdx + 1 : state.blocks.length; }

  document.querySelectorAll('[data-add]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var t = btn.getAttribute('data-add');
      var b = { _id: 'b' + seq++, t: t };
      if (t === 'ul') b.items = []; else b.text = '';
      var at = insertAt();
      state.blocks.splice(at, 0, b);
      render(); changed();
      var node = blocksEl.children[at]; if (node) { var f = node.querySelector('textarea, input'); if (f) f.focus(); focusIdx = at; }
    });
  });

  var addImg = $('[data-add-image]');
  addImg.addEventListener('change', function () {
    var files = Array.prototype.slice.call(addImg.files || []).slice(0, 10);
    addImg.value = '';
    var at = insertAt();
    files.forEach(function (file, k) {
      var b = { _id: 'b' + seq++, t: 'img', m: null, cap: '', uploading: 0 };
      state.blocks.splice(at + k, 0, b);
      render();
      SS.compressImage(file, { maxSide: 2000 })
        .then(function (blob) { return SS.upload(D.endpoints.upload + '&kind=inline', blob, function (p) { b.uploading = p; var n = blocksEl.querySelector('[data-id="' + b._id + '"] .uploading span'); if (n) n.textContent = 'جارٍ رفع الصورة… ' + p + '%'; }); })
        .then(function (r) { media[r.pid] = { w: r.w, h: r.h }; b.m = r.pid; delete b.uploading; render(); changed(true); })
        .catch(function (e) {
          var idx = state.blocks.indexOf(b); if (idx > -1) state.blocks.splice(idx, 1);
          render(); alert(e.message);
        });
    });
  });

  /* ===== الحمولة والفحص ===== */
  function payload() {
    return {
      title: state.title, subtitle: state.subtitle, summary: state.summary,
      categoryId: state.categoryId ? Number(state.categoryId) : null,
      cover: state.cover ? state.cover.pid : null, coverCaption: state.coverCaption,
      blocks: state.blocks.filter(function (b) { return !(b.t === 'img' && (!b.m || b.uploading !== undefined)); }).map(function (b) {
        if (b.t === 'img') return { t: 'img', m: b.m, cap: b.cap || '' };
        if (b.t === 'ul' || b.t === 'ol') return { t: b.t, items: (b.items || []).map(function (x) { return x.trim(); }).filter(Boolean) };
        return { t: b.t, text: b.text || '' };
      }),
    };
  }

  function words() {
    var txt = state.blocks.map(function (b) { return b.items ? b.items.join(' ') : (b.text || ''); }).join(' ');
    return txt.split(/\s+/).filter(Boolean).length;
  }

  function problems() {
    var p = [];
    var w = words();
    var caps = state.blocks.filter(function (b) { return b.t === 'img' && b.m && !(b.cap || '').trim(); }).length;
    p.push([state.title.trim().length >= 4, 'عنوان للمقال']);
    p.push([!!state.categoryId, 'تصنيف مناسب']);
    p.push([w >= 40, 'نص لا يقل عن 40 كلمة (الآن ' + w + ')']);
    p.push([caps === 0, 'وصف لكل صورة داخل المقال']);
    p.push([!!state.summary.trim(), 'مقدمة قصيرة (مستحسنة)', true]);
    p.push([!state.cover || !!state.coverCaption.trim(), 'وصف لصورة الغلاف (مستحسن)', true]);
    return p;
  }

  function updateCounts() {
    var wc = $('[data-wordcount]'); if (wc) wc.textContent = 'عدد الكلمات: ' + words();
    var list = $('[data-checklist]'); if (!list) return;
    list.innerHTML = '';
    problems().forEach(function (x) {
      list.appendChild(el('li', { class: x[0] ? 'ok' : (x[2] ? 'soft' : 'no') }, [(x[0] ? '✓ ' : (x[2] ? '○ ' : '✗ ')) + x[1]]));
    });
  }

  /* ===== الحفظ ===== */
  function backupLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ at: new Date().toISOString(), data: payload(), media: media, cover: state.cover })); } catch (e) { /* التخزين غير متاح */ }
  }
  function clearLocal() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* */ } }

  function changed(immediate) {
    dirty = true;
    updateCounts();
    if (isEditor) { setStatus('تعديلات غير محفوظة', 'warn'); return; }
    backupLocal();
    setStatus('تعديلات غير محفوظة…', 'warn');
    clearTimeout(timer);
    timer = setTimeout(save, immediate ? 200 : 1500);
  }

  function save() {
    if (saving) { clearTimeout(timer); timer = setTimeout(save, 800); return Promise.resolve(false); }
    if (!dirty) return Promise.resolve(true);
    var body = payload();
    if (isEditor) {
      var note = ($('#edit-note') || {}).value || '';
      if (note.trim().length < 3) { setStatus('اكتب سبب التعديل أولًا', 'err'); $('#edit-note').focus(); return Promise.resolve(false); }
      body.editNote = note;
    }
    saving = true; dirty = false;
    setStatus('جارٍ الحفظ…', 'busy');
    return fetch(D.endpoints.save, {
      method: 'PUT', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': SS.csrf(), Accept: 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw Object.assign(new Error(j.error || 'تعذر الحفظ.'), { status: r.status });
        return j;
      });
    }).then(function () {
      saving = false; lastSavedAt = timeNow();
      if (!dirty) { setStatus('محفوظ ✓ ' + lastSavedAt, 'ok'); if (!isEditor) clearLocal(); }
      return true;
    }).catch(function (e) {
      saving = false; dirty = true;
      if (e.status === 401) setStatus('انتهت الجلسة — نسختك محفوظة على هذا الجهاز. سجّل الدخول ثم عد للمقال.', 'err');
      else if (e.status && e.status < 500) setStatus(e.message, 'err');
      else { setStatus('غير متصل — نسختك محفوظة على هذا الجهاز وستُرسل عند عودة الاتصال', 'err'); clearTimeout(timer); timer = setTimeout(save, 10000); }
      return false;
    });
  }

  document.querySelectorAll('[data-save]').forEach(function (b) { b.addEventListener('click', function () { dirty = true; save(); }); });
  $('#editor').addEventListener('submit', function (e) { e.preventDefault(); });
  window.addEventListener('online', function () { if (dirty) save(); });
  window.addEventListener('beforeunload', function (e) { if (dirty || saving) { if (!isEditor) backupLocal(); e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && dirty && !isEditor) save(); });

  var prev = $('[data-preview]');
  if (prev) prev.addEventListener('click', function (e) {
    if (!dirty) return;
    e.preventDefault();
    save().then(function (ok) { if (ok) location.href = prev.href; });
  });

  var submitForm = $('[data-submit-form]');
  if (submitForm) submitForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var blockers = problems().filter(function (x) { return !x[0] && !x[2]; });
    if (blockers.length) { alert('قبل الإرسال أكمل: ' + blockers.map(function (x) { return x[1]; }).join('، ')); return; }
    if (!confirm('إرسال المقال إلى هيئة التحرير؟ لن تستطيع تعديله حتى تتم مراجعته.')) return;
    var btn = submitForm.querySelector('button'); btn.disabled = true;
    (dirty ? save() : Promise.resolve(true)).then(function (ok) {
      if (ok) { dirty = false; clearLocal(); submitForm.submit(); } else btn.disabled = false;
    });
  });

  /* ===== استعادة نسخة الجهاز إن كانت أحدث ===== */
  function offerRestore() {
    if (isEditor) return;
    var saved; try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { saved = null; }
    if (!saved || !saved.data) return;
    if (new Date(saved.at) <= new Date(D.updatedAt)) { clearLocal(); return; }
    var cur = JSON.stringify(payload());
    if (JSON.stringify(saved.data) === cur) { clearLocal(); return; }
    var bar = el('div', { class: 'flash flash--warn restorebar', role: 'alert' }, [
      el('span', { text: 'وجدنا على هذا الجهاز نسخة من مقالك أحدث من المحفوظة (لم تُحفظ بسبب انقطاع أو إغلاق الصفحة).' }),
      el('button', { type: 'button', class: 'btn btn--small', text: 'استعادتها', onclick: function () {
        var d = saved.data;
        Object.assign(media, saved.media || {});
        state.title = d.title || ''; state.subtitle = d.subtitle || ''; state.summary = d.summary || '';
        state.categoryId = d.categoryId || ''; state.coverCaption = d.coverCaption || '';
        state.cover = saved.cover || null;
        state.blocks = (d.blocks || []).map(function (b) { return Object.assign({ _id: 'b' + seq++ }, b); });
        if (!state.blocks.length) state.blocks.push({ _id: 'b' + seq++, t: 'p', text: '' });
        fillFields(); renderCover(); render(); bar.remove(); changed(true);
      } }),
      el('button', { type: 'button', class: 'btn btn--small btn--ghost', text: 'تجاهلها', onclick: function () { clearLocal(); bar.remove(); } }),
    ]);
    $('#editor').prepend(bar);
  }

  fillFields(); renderCover(); render(); offerRestore();
  if (!isEditor) setStatus('محفوظ', 'ok');
})();
