@echo off
chcp 65001 >nul
cd /d "%~dp0"
title رفع تحديث الصحفي الصغير
where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   برنامج Git غير موجود على هذا الجهاز. ثبّته من https://git-scm.com ثم أعد المحاولة.
  echo.
  pause
  exit /b
)
echo.
echo   جارٍ رفع التحديث إلى GitHub... (سيبدأ Vercel النشر تلقائيًا بعده)
echo.
git add -A
git commit -m "إصلاح النشر على Vercel (قاعدة Turso) + صفحة اكتب للجريدة بلا حساب"
git push origin main
echo.
if errorlevel 1 (
  echo   تعذر الرفع. انسخ الرسالة الظاهرة أعلاه وأرسلها لي.
) else (
  echo   تم الرفع بنجاح ✓ — انتظر دقيقة حتى ينتهي Vercel من النشر.
)
echo.
pause
