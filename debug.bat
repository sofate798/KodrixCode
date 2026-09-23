@echo off
rem ============================================================================
rem  Kodrix Development Launcher（需求1：带实时日志的控制台调试启动）
rem
rem  用法:
rem    .\debug.bat                   快速启动 (esbuild transpile)
rem    .\debug.bat -Watch            启动 + 文件监听自动重编译
rem
rem  相关入口:
rem    .\debug-rebuild.bat           全量重编译后启动（需求3）
rem    .\build.bat                   一键打 EXE 安装包（需求2）
rem
rem  内部委托: scripts/dev-fast.ps1
rem  高级参数仍可用: -Prepare / -FullCompile（debug-rebuild.bat 即 -FullCompile）
rem ============================================================================
chcp 65001 > nul 2>&1
title Kodrix Fast Debug
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
