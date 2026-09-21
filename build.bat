@echo off
setlocal
rem ============================================================================
rem  Minicode Windows Installer Builder
rem
rem  用法:
rem    .\build.bat                        默认 x64 user installer
rem    .\build.bat -Target system         per-machine (系统级) installer
rem    .\build.bat -Arch arm64            ARM64 架构
rem    .\build.bat -SkipPackage           仅生成 VSCode-win32-* 文件夹，不打包
rem    .\build.bat -Force                 强制重新构建 (忽略缓存)
rem
rem  内部委托: scripts/build-exe.ps1
rem  首次构建耗时: 约 30-90 分钟 (含 copilot esbuild)
rem ============================================================================
chcp 65001 > nul 2>&1
title Minicode Build Installer

pushd %~dp0

echo.
echo =========================================
echo   Minicode One-Click EXE Build
echo =========================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-exe.ps1" %*

set EXITCODE=%ERRORLEVEL%
if %EXITCODE% neq 0 (
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
