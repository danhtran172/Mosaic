@echo off
cd /d "%~dp0"
set "INDECK_UI_SOURCE=%USERPROFILE%\Downloads\InDeck"
set "INDECK_UI_DIR=%INDECK_UI_SOURCE%\dist"

call npm.cmd --prefix "%INDECK_UI_SOURCE%" run build
if errorlevel 1 goto :failed

if not exist "%INDECK_UI_DIR%\index.html" goto :failed
call npm.cmd start
if not errorlevel 1 exit /b 0

:failed
echo.
echo Khong the khoi dong InDeck. Nhan phim bat ky de dong cua so nay.
pause >nul
