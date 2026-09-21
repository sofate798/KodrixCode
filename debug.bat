@echo off
rem ============================================================================
rem  Minicode Development Launcher
rem
rem  用法:
rem    .\debug.bat                   快速启动 (esbuild transpile)
rem    .\debug.bat -Prepare          仅准备环境，不启动应用
rem    .\debug.bat -Watch            启动 + 文件监听自动重编译
rem    .\debug.bat -FullCompile      强制全量 recompile 后启动
rem
rem  内部委托: scripts/dev-fast.ps1
rem ============================================================================
chcp 65001 > nul 2>&1
title Minicode Fast Debug
setlocal

pushd %~dp0

set "MODE="
if /I "%~1"=="-FullCompile" (set "MODE=FullCompile" & shift)
if /I "%~1"=="-Watch" (set "MODE=Watch" & shift)
if /I "%~1"=="-Prepare" (set "MODE=Prepare" & shift)

if "%MODE%"=="FullCompile" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" -FullCompile %* 2>&1
    goto :checkerr
)
if "%MODE%"=="Watch" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" -Watch %* 2>&1
    goto :checkerr
)
if "%MODE%"=="Prepare" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\dev-fast.ps1" -NoLaunch %* 2>&1
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
