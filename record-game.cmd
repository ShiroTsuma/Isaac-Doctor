@echo off
setlocal
title IsaacProf - 25 second recording
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0record-game.ps1" -NoPause %*
set "record_exit=%errorlevel%"
echo.
pause
exit /b %record_exit%
