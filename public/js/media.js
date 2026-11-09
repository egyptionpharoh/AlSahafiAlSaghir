/* رفع صورة واحدة من حقل [data-upload]: الصورة الشخصية، صور الجريدة، غلاف العدد */
(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('input[type=file][data-upload]').forEach(function (input) {
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        var scope = input.closest('.asset, .panel, .profile__photo, section') || document;
        var status = scope.querySelector('[data-upload-status]');
        var frame = scope.querySelector('[data-photo-frame]');
        var kind = input.getAttribute('data-upload');
        var say = function (t, err) { if (status) { status.textContent = t; status.classList.toggle('danger', !!err); } };
        say('جارٍ تجهيز الصورة…');
        SS.compressImage(file, { maxSide: kind === 'profile' ? 800 : 2000, keepPng: kind === 'site' })
          .then(function (blob) {
            say('جارٍ الرفع… 0%');
            return SS.upload(input.getAttribute('data-target'), blob, function (p) { say('جارٍ الرفع… ' + p + '%'); });
          })
          .then(function (res) {
            if (frame) {
              frame.innerHTML = '';
              var img = document.createElement('img');
              img.src = '/media/' + res.pid; img.alt = ''; img.width = res.w; img.height = res.h;
              frame.appendChild(img);
            }
            say('تم رفع الصورة ✓');
            setTimeout(function () { location.reload(); }, 900);
          })
          .catch(function (err) { say(err.message, true); })
          .then(function () { input.value = ''; });
      });
    });
  });
})();
