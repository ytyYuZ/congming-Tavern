@echo off
rem SmartTavern web launcher.
rem Double-click this file (or the desktop shortcut) to serve the built web UI on
rem http://127.0.0.1:4173/ and open it in the default browser.
rem The messages stay ASCII-only on purpose: a .cmd file has no reliable encoding
rem on Windows consoles, and garbled output is worse than English output.
setlocal
cd /d "%~dp0"

if not exist "package.json" (
  echo [error] package.json not found - keep this script in the repository root.
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo [error] pnpm was not found. Install Node.js 22 or newer, then pnpm.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] Installing dependencies, this only happens once...
  call pnpm install
  if errorlevel 1 (
    echo [error] pnpm install failed.
    pause
    exit /b 1
  )
)

if not exist "apps\web\dist\index.html" (
  echo [2/3] Building the interface, this takes about a minute...
  call pnpm build
  if errorlevel 1 (
    echo [error] The build failed.
    pause
    exit /b 1
  )
)

echo [3/3] Serving http://127.0.0.1:4173/ - the browser opens as soon as it answers.
echo       Keep this window open while you use the app; closing it stops the server.
echo.

rem Poll the URL in the background, then hand it to the default browser.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "$u = 'http://127.0.0.1:4173/'; for ($i = 0; $i -lt 120; $i++) { try { Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2 | Out-Null; Start-Process $u; break } catch { Start-Sleep -Milliseconds 500 } }"

call pnpm --filter @smarttavern/web exec vite preview --port 4173 --strictPort --host 127.0.0.1

echo.
echo Server stopped.
pause
