@echo off
rem ============================================================================
rem  Kodrix Full Rebuild + Debug Launch
rem  Force full TypeScript compile, then launch with live logs
rem
rem  Usage: .\debug-rebuild.bat
rem  Same as: debug.bat -FullCompile
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
