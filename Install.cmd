@echo off
setlocal
node "%~dp0scripts\public-desktop.mjs" install %*
set "result=%errorlevel%"
if "%~1"=="" pause
exit /b %result%
