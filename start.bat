@echo off
rem Start ProseArc from this folder (development run).
rem Double-click it, or run it from a terminal. Installs packages the first time.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH. Get it from https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo Installing packages, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

call npm start
if errorlevel 1 pause
