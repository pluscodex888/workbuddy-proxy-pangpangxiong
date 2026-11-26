@echo off
setlocal
if exist "%~dp0..\config.json" (
  for %%I in ("%~dp0..") do node "%~dp0scripts\public-desktop.mjs" start --home "%%~fI" %*
) else (
  node "%~dp0scripts\public-desktop.mjs" start %*
)
set "result=%errorlevel%"
if not "%result%"=="0" if "%~1"=="" pause
exit /b %result%
