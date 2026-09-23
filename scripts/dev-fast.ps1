<#
.SYNOPSIS
  Kodrix Fast Development Launcher
  智能 dev 启动器，优先使用 esbuild transpile (秒级)，替代 tsc 全量 compile (分钟级)

.DESCRIPTION
  执行流程:
    [1/5] 验证 node_modules → 缺失时自动 npm install
    [2/5] 验证 Electron → 缺失时下载到 .build/electron/
    [3/5] 编译客户端代码 → esbuild transpile 或全量 compile
    [4/5] 编译 Kodrix 自定义扩展 (kodrix-local/skills/agent-os)
    [5/5] 异步启动 Kodrix.exe → 5 秒后释放控制台

.PARAMETER Watch
  启动后台 watch-transpile 进程 + Kodrix

.PARAMETER FullCompile
  强制全量 TypeScript compile (替代 esbuild transpile)

.PARAMETER NoLaunch
  仅准备环境，不启动 Kodrix

.EXAMPLE
  .\scripts\dev-fast.ps1              快速启动
  .\scripts\dev-fast.ps1 -Watch       文件监听 + 热更新
  .\scripts\dev-fast.ps1 -FullCompile 首次构建 / 恢复环境
  .\scripts\dev-fast.ps1 -NoLaunch    仅准备环境
  .\debug-rebuild.bat                 等同于 -FullCompile（推荐入口）

.NOTES
  内部被 debug.bat / debug-rebuild.bat 调用
  跳过 preLaunch.ts (设置 VSCODE_SKIP_PRELAUNCH=1) 以加快启动
#>

param(
	[switch]$Watch,
	[switch]$FullCompile,
	[switch]$NoLaunch,
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$CodeArgs
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Write-Step([string]$Message) {
	Write-Host $Message -ForegroundColor Cyan
}

function Test-KodrixExtensionsCompiled {
	# 仅检查 out/extension.js 是否存在是不够的：src 比 out 新时编译产物已过期，
	# 继续使用会导致扩展运行旧代码（例如刚改完的 bug 不生效）。
	# 这里按「out 下最新文件 ≥ src 下最新文件」判定，过期即触发重编译。
	$exts = @('kodrix-local', 'kodrix-skills', 'kodrix-agent-os')
	foreach ($name in $exts) {
		$extRoot = Join-Path $Root "extensions\$name"
		$main = Join-Path $extRoot 'out\extension.js'
		if (-not (Test-Path $main)) { return $false }
		$newestSrc = Get-ChildItem (Join-Path $extRoot 'src') -Recurse -File -ErrorAction SilentlyContinue |
			Sort-Object LastWriteTime -Descending | Select-Object -First 1
		$newestOut = Get-ChildItem (Join-Path $extRoot 'out') -Recurse -File -ErrorAction SilentlyContinue |
			Sort-Object LastWriteTime -Descending | Select-Object -First 1
		if (-not $newestSrc -or -not $newestOut) { return $false }
		if ($newestSrc.LastWriteTime -gt $newestOut.LastWriteTime) {
			Write-Host "  [stale] $name : src ($($newestSrc.LastWriteTime.ToString('MM-dd HH:mm'))) newer than out ($($newestOut.LastWriteTime.ToString('MM-dd HH:mm')))" -ForegroundColor Yellow
			return $false
		}
	}
	return $true
}

function Test-ClientOutFresh {
	# out/main.js 存在但 src/ 更新时，跳过编译会跑旧客户端；与扩展 stale 判定对齐。
	$main = Join-Path $Root 'out\main.js'
	if (-not (Test-Path $main)) { return $false }
	$newestSrc = Get-ChildItem (Join-Path $Root 'src') -Recurse -File -ErrorAction SilentlyContinue |
		Sort-Object LastWriteTime -Descending | Select-Object -First 1
	if (-not $newestSrc) { return $true }
	$outTime = (Get-Item $main).LastWriteTime
	if ($newestSrc.LastWriteTime -gt $outTime) {
		Write-Host "  [stale] client : src ($($newestSrc.LastWriteTime.ToString('MM-dd HH:mm'))) newer than out/main.js ($($outTime.ToString('MM-dd HH:mm')))" -ForegroundColor Yellow
		return $false
	}
	return $true
}

function Set-BuiltinExtensionControl {
	$controlDir = Join-Path $env:USERPROFILE '.kodrix-dev\extensions'
	New-Item -ItemType Directory -Force -Path $controlDir | Out-Null
	$controlPath = Join-Path $controlDir 'control.json'
	@{
		'ms-vscode.js-debug' = 'disabled'
		'ms-vscode.js-debug-companion' = 'disabled'
		'ms-vscode.vscode-js-profile-table' = 'disabled'
	} | ConvertTo-Json -Compress | Set-Content -Path $controlPath -Encoding UTF8
}

Write-Host ''
Write-Host '=========================================' -ForegroundColor Magenta
Write-Host '  Kodrix Fast Debug' -ForegroundColor Magenta
Write-Host '=========================================' -ForegroundColor Magenta
Write-Host ''

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
	Write-Step '[1/5] Installing dependencies (first run)...'
	& "$PSScriptRoot\verify-windows-build-env.ps1" -SetEnv
	npm install
	if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
} else {
	Write-Step '[1/5] Dependencies ready'
}

$electronDir = Join-Path $Root '.build\electron'
$productJson = Get-Content (Join-Path $Root 'product.json') -Raw | ConvertFrom-Json
$electronExe = Join-Path $electronDir "$($productJson.nameShort).exe"
$outDir = Join-Path $Root 'out'

if (-not (Test-Path $electronExe)) {
	Write-Step '[2/5] Fetching Electron...'
	if (Test-Path $electronDir) {
		Write-Host "  Found incomplete .build/electron directory (missing $electronExe). Re-downloading..." -ForegroundColor Yellow
	}
	npm run electron
	if ($LASTEXITCODE -ne 0) { throw 'npm run electron failed' }
} else {
	Write-Step '[2/5] Electron ready'
}

if ($FullCompile -or -not (Test-ClientOutFresh)) {
	if ($FullCompile) {
		Write-Step '[3/5] Full compile (requested)...'
		npm run compile
	} else {
		Write-Step '[3/5] Fast build (esbuild transpile + extensions)...'
		npm run build-fast
	}
	if ($LASTEXITCODE -ne 0) { throw 'Client build failed' }
} else {
	Write-Step '[3/5] Client out/ fresh — skipping compile (use -FullCompile to rebuild)'
}

# 简体中文界面：构建后注入官方中文语言包（幂等；transpile 会重建 nls.js，故置于编译之后）
Write-Step '[3.5/5] Applying zh-cn language pack...'
node "$PSScriptRoot\apply-zh-langpack.mjs"
if ($LASTEXITCODE -ne 0) { throw 'zh-cn language pack apply failed' }

Set-BuiltinExtensionControl

if (-not (Test-KodrixExtensionsCompiled)) {
	Write-Step '[4/5] Compiling Kodrix extensions...'
	npm run gulp -- compile-extension:kodrix-local compile-extension:kodrix-skills compile-extension:kodrix-agent-os
	if ($LASTEXITCODE -ne 0) { throw 'Kodrix extension compile failed' }
} else {
	Write-Step '[4/5] Kodrix extensions ready'
}

if ($Watch) {
	Write-Step '[watch] Starting watch-transpile in background...'
	$watchCmd = "Set-Location '$Root'; npm run watch-transpile"
	Start-Process powershell -ArgumentList @('-NoExit', '-Command', $watchCmd) -WindowStyle Minimized | Out-Null
	Write-Host '  watch-transpile running in a separate window' -ForegroundColor DarkGray
}

if ($NoLaunch) {
	Write-Host ''
	Write-Host 'Prepare complete (-NoLaunch).' -ForegroundColor Green
	exit 0
}

Write-Step '[5/5] Launching Kodrix Dev...'
Write-Host ''
Write-Host '  Tip: edit src/ with -Watch for incremental rebuild' -ForegroundColor DarkGray
Write-Host '  Full rebuild: .\debug-rebuild.bat' -ForegroundColor DarkGray
Write-Host ''

$codeBat = Join-Path $Root 'scripts\code.bat'
Write-Host "  Script: $codeBat" -ForegroundColor DarkGray

# Preserve extra args for code.bat
$extraArgs = ''
if ($CodeArgs) { $extraArgs = $CodeArgs -join ' ' }

# Build a cmd command that:
#   1. sets env var to skip preLaunch (already done by [1/5] verification)
#   2. runs code.bat
#   3. keeps the window open on error, closes on success
$cmdCommand = "set VSCODE_SKIP_PRELAUNCH=1 && call `"$codeBat`" $extraArgs"

Write-Host "  Opening Kodrix console window..." -ForegroundColor Green

# Start code.bat in its own cmd window (visible for debugging)
$proc = Start-Process cmd.exe -ArgumentList '/k', $cmdCommand -PassThru

if (-not $proc) {
	Write-Host "  ERROR: Failed to launch code.bat" -ForegroundColor Red
	exit 1
}

Write-Host "  Kodrix launching in separate console (launcher PID: $($proc.Id))." -ForegroundColor Green
Write-Host ""

# Pause briefly — if code.bat crashes immediately (e.g. Electron not found),
# the separate cmd window will show the error message and stay open (/k flag).
# This console can be closed at any time.
Start-Sleep -Seconds 2

if ($proc.HasExited -and $proc.ExitCode -ne 0) {
	Write-Host "  ERROR: Launcher exited with code $($proc.ExitCode)" -ForegroundColor Red
	Write-Host "  Possible causes:" -ForegroundColor Yellow
	Write-Host "    - Electron executable not found (run .\debug-rebuild.bat first)" -ForegroundColor Yellow
	Write-Host "    - Node.js version mismatch (check .nvmrc)" -ForegroundColor Yellow
	Write-Host "    - Missing compile output (run .\debug-rebuild.bat)" -ForegroundColor Yellow
	exit 1
}

Write-Host "  Kodrix is now starting in a separate window." -ForegroundColor Green
Write-Host "  Close that window to stop Kodrix, or close this one to exit." -ForegroundColor DarkGray
