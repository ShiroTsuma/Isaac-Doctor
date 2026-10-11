@echo off
node "%~dp0viewer\scripts\analyze.mts" %*
exit /b %errorlevel%
