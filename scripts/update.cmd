@echo off
REM ===========================================================================
REM  @dawn/dsh-auto-evolve - one-click updater (double-click to run)
REM
REM  This is only a launcher for update.ps1; it bypasses the PowerShell
REM  execution policy. All real logic lives in update.ps1 - edit that file.
REM
REM  NOTE: this file is intentionally ASCII-only. cmd.exe reads .cmd files in
REM  the OEM/ANSI code page, so UTF-8 Chinese text here would print as garbage.
REM  Chinese messages come from update.ps1 (which has a UTF-8 BOM).
REM
REM  Usage from a terminal:
REM      update.cmd -DryRun
REM      update.cmd -ProfileDir "D:\other\.dsh\profiles\work"
REM ===========================================================================

setlocal
set "SCRIPT_DIR=%~dp0"
set "PS1=%SCRIPT_DIR%update.ps1"

if not exist "%PS1%" (
    echo [ERROR] update.ps1 not found next to this launcher.
    pause
    exit /b 1
)

where powershell >nul 2>nul
if errorlevel 1 (
    echo [ERROR] powershell not found. Windows 10/11 ships it; check your system.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
    echo [FAILED] Update did not finish. Send the errors above to the maintainer.
) else (
    echo [DONE] Remember to fully quit and restart the DSH desktop app.
)
echo.
pause
exit /b %RC%
