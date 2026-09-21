@echo off
rem ============================================================================
rem  Minicode Watch + Development Mode
rem  启动后台 watch-transpile 进程 + Minicode 窗口
rem  修改 src/ 文件后自动增量重编译，无需手动重启
rem
rem  用法: .\watch-dev.bat
rem  等同于: debug.bat -Watch
rem ============================================================================
chcp 65001 > nul 2>&1
title Minicode Watch + Dev
setlocal

pushd %~dp0

echo =========================================
echo   Minicode Watch + Fast Debug
echo   watch-transpile runs in background
echo =========================================
echo.

call debug.bat -Watch %*

popd
endlocal
