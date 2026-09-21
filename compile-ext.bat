@echo off
rem ============================================================================
rem  Minicode Extension Quick Compiler
rem  仅编译 Minicode 自定义扩展: local / skills / solo / agent-os
rem  用于修改扩展代码后快速验证，不编译上游 VS Code 扩展
rem
rem  用法: .\compile-ext.bat
rem ============================================================================
chcp 65001 > nul 2>&1
title Minicode Extension Quick Compile

pushd %~dp0

echo =========================================
echo   Minicode Extension Quick Compile
echo   Targets: minicode-local, skills, solo, agent-os
echo =========================================
echo.

call npm run gulp -- compile-extension:minicode-local compile-extension:minicode-skills compile-extension:minicode-solo compile-extension:minicode-agent-os

if %errorlevel% equ 0 (
    echo.
    echo [OK] All Minicode extensions compiled.
    echo   Launch with: debug.bat
    echo.
) else (
    echo.
    echo [ERROR] Compile failed — check TypeScript errors above.
    echo.
    pause
)

popd
