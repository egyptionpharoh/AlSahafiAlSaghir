@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Al-Sahafi Al-Saghir
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js غير مثبت. نزّله من https://nodejs.org ثم أعد المحاولة.
  echo.
  pause
  exit /b
)
echo.
echo   جارٍ تشغيل «الصحفي الصغير»... سيفتح المتصفح تلقائيًا.
echo   لا تغلق هذه النافذة ما دمت تستخدم الجريدة. لإيقافها أغلق النافذة.
node server.js
echo.
pause
