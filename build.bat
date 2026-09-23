@echo off
setlocal
rem ============================================================================
rem  Kodrix Windows Installer Builder
rem
rem  Usage:
rem    .\build.bat                        default x64 user installer
rem    .\build.bat -Target system         per-machine installer
rem    .\build.bat -Arch arm64            ARM64
rem    .\build.bat -SkipPackage           app folder only, no Inno Setup
rem    .\build.bat -Force                 force rebuild, ignore cache
rem
rem  Delegates to: scripts\build-exe.ps1
rem  First build: ~30-90 min (includes copilot esbuild)
rem ============================================================================
chcp 65001 >nul 2>&1
title Kodrix Build Installer

pushd "%~dp0"

echo.
echo =========================================
echo   Kodrix One-Click EXE Build
echo =========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-exe.ps1" %*

set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
    echo.
    echo =========================================
    echo   Build failed with exit code %EXITCODE%
    echo   Check output above for details.
    echo =========================================
    echo.
    pause
)

popd
endlocal
exit /b %EXITCODE%
