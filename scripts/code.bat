@echo off
setlocal enabledelayedexpansion

title Minicode Dev

:: Disable QuickEdit mode to prevent accidental click-selection from pausing the launcher
powershell -NoProfile -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleMode { [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle); [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode); [DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode); public static void DisableQuickEdit() { IntPtr h = GetStdHandle(-10); uint mode; GetConsoleMode(h, out mode); mode &= ~0x40U; SetConsoleMode(h, mode); } }'; [ConsoleMode]::DisableQuickEdit()" >nul 2>&1

pushd %~dp0\..

:: Get electron, compile, built-in extensions
if "%VSCODE_SKIP_PRELAUNCH%"=="" (
	node build/lib/preLaunch.ts || (
		echo Failed to prepare VS Code for launch ^(build/lib/preLaunch.ts^). 1>&2
		exit /b 1
	)
)

:: ── Resolve Electron executable name from product.json ────────────
set "NAMESHORT="
for /f "tokens=2 delims=:," %%a in ('findstr /R /C:"\"nameShort\":.*" product.json') do if not defined NAMESHORT set "NAMESHORT=%%~a"
set NAMESHORT=%NAMESHORT: "=%
set NAMESHORT=%NAMESHORT:"=%.exe
set "CODE=.build\electron\%NAMESHORT%"

:: Verify executable exists
if not exist "%CODE%" (
	echo.
	echo ERROR: Electron executable not found: "%CODE%" 1>&2
	echo        Run debug.bat -Prepare or debug.bat -FullCompile first. 1>&2
	echo.
	pause
	exit /b 1
)

:: Manage built-in extensions
if "%~1"=="--builtin" goto builtin

:: Configuration
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

:: Detect if --extensionTestsPath is present (either form: --extensionTestsPath or --extensionTestsPath=value)
set "DISABLE_TEST_EXTENSION=--disable-extension=vscode.vscode-api-tests"
for %%A in (%*) do (
	if /i "%%~A"=="--extensionTestsPath" set "DISABLE_TEST_EXTENSION="
)

:: Use substring matching for --extensionTestsPath= detection
set "_DISABLE_FOUND=0"
for %%A in (%*) do (
	set "_ARG=%%~A"
	if /i "!_ARG:~0,21!"=="--extensionTestsPath=" set "_DISABLE_FOUND=1"
)
if "!_DISABLE_FOUND!"=="1" set "DISABLE_TEST_EXTENSION="

:: Launch Minicode (use delayed expansion for proper empty-var handling)
:: Default locale is zh-cn; override by passing --locale=en or --locale=zh-tw
"%CODE%" . !DISABLE_TEST_EXTENSION! --locale=zh-cn %*
goto end

:builtin
"%CODE%" build/builtin

:end

popd

endlocal
