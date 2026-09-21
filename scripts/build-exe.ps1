<#
.SYNOPSIS
  Minicode Windows Installer Builder (Inno Setup)
  一键构建 Windows EXE 安装包

.DESCRIPTION
  构建流程:
    [0/4] 验证 Windows 构建环境 (Visual Studio Build Tools / Python / etc.)
    [1/4] 执行 gulp vscode-win32-{Arch}-min → 编译+打包桌面应用
    [2/4] 准备 Inno Setup 更新工具
    [3/4] 构建 {Target} 安装包 (Inno Setup)
    [4/4] 输出到 dist/ 目录

  首次构建耗时约 30-90 分钟 (含 copilot esbuild 7 路并行编译)

.PARAMETER Arch
  目标架构: x64 (默认) 或 arm64

.PARAMETER Target
  安装器类型: user (默认) 或 system (per-machine)

.PARAMETER SkipPackage
  跳过 Inno Setup 打包，仅输出 VSCode-win32-* 文件夹

.PARAMETER Force
  忽略 1 小时内缓存的安装包，强制重建

.EXAMPLE
  .\scripts\build-exe.ps1                     默认 x64 user installer
  .\scripts\build-exe.ps1 -Target system      系统级安装
  .\scripts\build-exe.ps1 -SkipPackage        仅编译，不打包
  .\scripts\build-exe.ps1 -Force              强制重建

.NOTES
  需要安装 Inno Setup 6+ 并确保 ISCC.exe 在 PATH 中
  首次构建受 compile-copilot-extension-build 影响较慢，请耐心等待
#>

param(
	[ValidateSet('x64', 'arm64')]
	[string]$Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }),
	[ValidateSet('user', 'system')]
	[string]$Target = 'user',
	[switch]$SkipPackage,
	[switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $Root

function Write-Step([string]$Message) {
	Write-Host $Message -ForegroundColor Cyan
}

function Invoke-Gulp([string[]]$Tasks) {
	$joined = $Tasks -join ' '
	Write-Host "  gulp $joined" -ForegroundColor DarkGray
	npm run gulp -- $Tasks
	if ($LASTEXITCODE -ne 0) { throw "gulp failed: $joined" }
}

Write-Host ''
Write-Host '=========================================' -ForegroundColor Magenta
Write-Host '  Minicode Windows Installer Build' -ForegroundColor Magenta
Write-Host "  Arch: $Arch  Target: $Target" -ForegroundColor Magenta
Write-Host '=========================================' -ForegroundColor Magenta
Write-Host ''

Write-Step '[0/4] Verifying build environment...'
& "$PSScriptRoot\verify-windows-build-env.ps1" -SetEnv
if ($LASTEXITCODE -ne 0) {
	Write-Warning 'Build environment check reported issues. Continuing — install may still fail on native modules.'
}

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
	Write-Step '[deps] Installing dependencies...'
	npm install
	if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

$packageJson = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$version = $packageJson.version
$appFolder = Join-Path (Split-Path $Root -Parent) "VSCode-win32-$Arch"
$setupDir = Join-Path $Root ".build\win32-$Arch\$Target-setup"
$setupExe = Join-Path $setupDir 'VSCodeSetup.exe'
$distDir = Join-Path $Root 'dist'

if (-not $Force -and (Test-Path $setupExe) -and -not $SkipPackage) {
	$age = (Get-Date) - (Get-Item $setupExe).LastWriteTime
	if ($age.TotalHours -lt 1) {
		Write-Host "Recent installer exists (<1h): $setupExe" -ForegroundColor Yellow
		Write-Host 'Use -Force to rebuild.' -ForegroundColor Yellow
	}
}

Write-Step '[1/4] Building minified desktop app (vscode-win32-*-min)...'
Write-Host '  This step compiles, bundles, and packages into VSCode-win32-* (30–90 min first run).' -ForegroundColor DarkGray
Invoke-Gulp @("vscode-win32-$Arch-min")

Write-Step '[2/4] Preparing Inno updater tools...'
# Pre-check: warn if inno_updater.exe source files are missing
$innoUpdaterSource = Join-Path $Root 'build\win32\inno_updater.exe'
$vcruntimeSource = Join-Path $Root 'build\win32\vcruntime140.dll'
if (-not (Test-Path $innoUpdaterSource) -or -not (Test-Path $vcruntimeSource)) {
	Write-Warning 'inno_updater.exe and/or vcruntime140.dll not found in build/win32/.'
	Write-Warning 'These are required for the auto-update feature. The build will continue,'
	Write-Warning 'but the resulting installer will lack auto-update support.'
	Write-Warning 'These files are typically provided by the upstream VS Code build.'
}
Invoke-Gulp @("vscode-win32-$Arch-inno-updater")

if ($SkipPackage) {
	Write-Host ''
	Write-Host "Package folder ready: $appFolder" -ForegroundColor Green
	exit 0
}

Write-Step "[3/4] Building $Target installer (Inno Setup)..."
Invoke-Gulp @("vscode-win32-$Arch-$Target-setup")

if (-not (Test-Path $setupExe)) {
	throw "Installer not found at $setupExe"
}

Write-Step '[4/4] Copying to dist/...'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$distName = if ($Target -eq 'user') {
	"Minicode-$version-$Arch-UserSetup.exe"
} else {
	"Minicode-$version-$Arch-SystemSetup.exe"
}
$distPath = Join-Path $distDir $distName
Copy-Item -Force -Path $setupExe -Destination $distPath

Write-Host ''
Write-Host '=========================================' -ForegroundColor Green
Write-Host '  Build complete' -ForegroundColor Green
Write-Host "  App folder : $appFolder" -ForegroundColor Green
Write-Host "  Installer  : $distPath" -ForegroundColor Green
Write-Host '=========================================' -ForegroundColor Green
Write-Host ''
