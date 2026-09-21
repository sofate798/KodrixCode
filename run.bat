@echo off
rem ============================================================================
rem  Minicode Quick Launch (Full Init Path)
rem  执行完整 preLaunch 流程 (含 deps + electron + compile + 扩展下载)
rem  相比 debug.bat 更慢但更完整，适合首次启动或恢复环境
rem
rem  用法: .\run.bat
rem  快速启动推荐: .\debug.bat (跳过 preLaunch)
rem ============================================================================
chcp 65001 > nul 2>&1
title Minicode Launcher
setlocal enabledelayedexpansion

pushd "%~dp0"

echo.
echo =========================================
echo   Minicode Quick Launch
echo =========================================
echo.

rem --- Check node_modules ---
if not exist "node_modules\" (
    echo [1/3] Installing dependencies (first time ~10-30min)...
    echo If missing Visual Studio Build Tools: scripts\verify-windows-build-env.ps1
    npm install
    if errorlevel 1 (
        echo Dependency install failed! Check MIGRATION.md.
        popd & pause & exit /b 1
    )
    echo Dependencies installed!
) else (
    if not exist "node_modules\gulp\bin\gulp.js" (
        echo [1/3] Dependencies incomplete, reinstalling...
        npm install
        if errorlevel 1 (
            echo Dependency install failed!
            popd & pause & exit /b 1
        )
    ) else (
        echo [1/3] Dependencies ready
    )
)

rem --- Skip built-in extension GitHub downloads to avoid hangs ---
if not exist "%USERPROFILE%\.minicode-dev\extensions" (
    mkdir "%USERPROFILE%\.minicode-dev\extensions" 2>nul
)
echo {"ms-vscode.js-debug":"disabled","ms-vscode.js-debug-companion":"disabled","ms-vscode.vscode-js-profile-table":"disabled"}> "%USERPROFILE%\.minicode-dev\extensions\control.json"

rem --- Pre-launch ---
echo [2/3] Preparing launch environment...
node build/lib/preLaunch.ts
if errorlevel 1 (
    echo Pre-launch failed! Check Node.js v24+ and network.
    popd & pause & exit /b 1
)

rem --- Launch ---
echo [3/3] Launching Minicode...
echo.

set "NAMESHORT="
for /f "tokens=2 delims=:," %%a in ('findstr /R /C:"\"nameShort\":.*" product.json') do if not defined NAMESHORT set "NAMESHORT=%%~a"
set NAMESHORT=%NAMESHORT: "=%
set NAMESHORT=%NAMESHORT:"=%.exe
set CODE=".build\electron\%NAMESHORT%"

set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1

%CODE% . --disable-extension=vscode.vscode-api-tests --locale=zh-cn %*

popd
endlocal
