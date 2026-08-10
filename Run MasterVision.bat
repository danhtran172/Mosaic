@echo off
cd /d "%~dp0"
set "INDECK_UI_DIR="
call npm.cmd start -- %*
if not errorlevel 1 exit /b 0

:failed
echo.
echo Khong the khoi dong Mosaic. Nhan phim bat ky de dong cua so nay.
pause >nul
