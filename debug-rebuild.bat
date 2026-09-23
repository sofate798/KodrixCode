@echo off
rem ============================================================================
rem  Kodrix Full Rebuild + Debug Launch
rem  强制全量 TypeScript compile 后，带实时日志启动控制台调试(全量重编译后启动并带日志)
rem
rem  用法: .\debug-rebuild.bat
rem  等同于: debug.bat -FullCompile
rem ============================================================================
chcp 65001 > nul 2>&1
title Kodrix Full Rebuild + Debug
setlocal

pushd %~dp0

echo =========================================
echo   Kodrix Full Rebuild + Debug
echo   Force recompile, then launch with logs
echo =========================================
echo.

call debug.bat -FullCompile %*

popd
endlocal
