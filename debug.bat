@echo off
rem ============================================================================
rem  Kodrix Development Launcher
rem  Console debug launch with live logs
rem
rem  Usage:
rem    .\debug.bat                   fast start (esbuild transpile)
rem    .\debug.bat -Watch            start + file watch recompile
rem
rem  Related:
rem    .\debug-rebuild.bat           full recompile then start
rem    .\build.bat                   one-click EXE installer
rem
rem  Delegates to: scripts/dev-fast.ps1
rem  Advanced: -Prepare / -FullCompile (debug-rebuild.bat = -FullCompile)
rem ============================================================================
chcp 65001 > nul 2>&1
title Kodrix Fast Debug
setlocal

pushd %~dp0

rem NOTE: shift does not update %* - use %1..%9 for remaining args after shift
set "MODE="
if /I "%~1"=="-FullCompile" (set "MODE=FullCompile" & shift)
if /I "%~1"=="-Watch" (set "MODE=Watch" & shift)
if /I "%~1"=="-Prepare" (set "MODE=Prepare" & shift)

if "%MODE%"=="FullCompile" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" -FullCompile %1 %2 %3 %4 %5 %6 %7 %8 %9 2>&1
    goto :checkerr
)
if "%MODE%"=="Watch" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" -Watch %1 %2 %3 %4 %5 %6 %7 %8 %9 2>&1
    goto :checkerr
)
if "%MODE%"=="Prepare" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" -NoLaunch %1 %2 %3 %4 %5 %6 %7 %8 %9 2>&1
    goto :checkerr
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" %* 2>&1

:checkerr
set EXITCODE=%ERRORLEVEL%
if %EXITCODE% neq 0 (
    echo.
    echo ========================================
    echo  ERROR: Script exited with code %EXITCODE%
    echo  See output above for details.
    echo ========================================
    echo.
    pause
)
popd
endlocal
exit /b %EXITCODE%
