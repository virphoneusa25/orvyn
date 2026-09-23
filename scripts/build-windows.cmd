@echo off
setlocal
cd /d "%~dp0.."
echo.
echo ORVYN Windows build
echo Folder: %CD%
echo.
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not on PATH. Install Node.js 22, then run this script again.
  exit /b 1
)
if not exist "node_modules\typescript\bin\tsc" (
  echo Installing dependencies...
  call npm ci
  if errorlevel 1 exit /b 1
)
call node scripts\dist-win.mjs
exit /b %ERRORLEVEL%
