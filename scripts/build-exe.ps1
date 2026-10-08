<#
.SYNOPSIS
  Kodrix Windows Installer Builder (Inno Setup)
  一键构建 Windows EXE 安装包（本地 build.bat 与 GitHub Actions 共用）

.DESCRIPTION
  构建流程:
    [0/5] 验证 Windows 构建环境 (Visual Studio Build Tools / Python / etc.)
    [1/5] 执行 gulp vscode-win32-{Arch}-min → 编译+打包桌面应用（-SkipMinBuild 可跳过）
    [2/5] 向发布包注入官方 zh-cn 语言包（apply-release-zh-langpack.mjs；失败则明确告警）
    [3/5] 准备 Inno Setup 更新工具
    [4/5] 构建 {Target} 安装包 (Inno Setup)
    [5/5] 代码签名（提供证书时）→ 输出到 dist/ 目录并生成 .sha256

  首次构建耗时约 30-90 分钟 (含 copilot esbuild 7 路并行编译)

.PARAMETER Arch
  目标架构: x64 (默认) 或 arm64

.PARAMETER Target
  安装器类型: user (默认) 或 system (per-machine)

.PARAMETER SkipPackage
  跳过 Inno Setup 打包，仅输出 VSCode-win32-* 文件夹

.PARAMETER Force
  忽略 1 小时内缓存的安装包，强制重建

.PARAMETER SkipMinBuild
  跳过 [1/5] 编译步骤，要求 ../VSCode-win32-{Arch} 已预先就位
  （CI installer job 复用 build job 产物时由 build.yml 传入）

.PARAMETER SkipLangpack
  跳过 zh-cn 语言包注入

.PARAMETER CertPath
  PFX 证书文件路径。未传时读取环境变量 CERT_PATH。
  两者都为空 = 不签名，产物为未签名包（用户会看到 SmartScreen 警告）。

.PARAMETER CertPassword
  PFX 密码。未传时读取环境变量 CERT_PASSWORD_SECRET（CI 从 secrets 注入）。

.PARAMETER TimestampUrl
  Authenticode 时间戳服务器，默认读取环境变量 SIGN_TOOL_TIMESTAMP_URL，
  否则使用公开 TSA: http://timestamp.digicert.com（可覆盖）

.EXAMPLE
  .\scripts\build-exe.ps1                     默认 x64 user installer
  .\scripts\build-exe.ps1 -Target system      系统级安装
  .\scripts\build-exe.ps1 -SkipPackage        仅编译，不打包
  .\scripts\build-exe.ps1 -Force              强制重建
  .\scripts\build-exe.ps1 -SkipMinBuild       CI：复用已编译产物，仅打包+签名

.NOTES
  需要安装 Inno Setup 6+（或 build 依赖中的 innosetup npm 包）
  签名使用 signtool（Windows ADK/SDK 自带），找不到 signtool 且传入了证书时构建报错退出。
  首次构建受 compile-copilot-extension-build 影响较慢，请耐心等待
#>

param(
	[ValidateSet('x64', 'arm64')]
	[string]$Arch = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }),
	[ValidateSet('user', 'system')]
	[string]$Target = 'user',
	[switch]$SkipPackage,
	[switch]$Force,
	[switch]$SkipMinBuild,
	[switch]$SkipLangpack,
	[string]$CertPath = $env:CERT_PATH,
	[string]$CertPassword = $env:CERT_PASSWORD_SECRET,
	[string]$TimestampUrl = $(if ($env:SIGN_TOOL_TIMESTAMP_URL) { $env:SIGN_TOOL_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }),
	[string]$OutputDir
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

function Find-SignTool {
	# signtool.exe 不在默认 PATH 时，回退到 Windows SDK 安装目录查找（CI runner 预装 SDK）
	$cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
	if ($cmd) { return $cmd.Source }
	$roots = @(
		(Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
		(Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\11\bin'),
		(Join-Path $env:ProgramFiles 'Windows Kits\11\bin')
	)
	foreach ($r in $roots) {
		if ($r -and (Test-Path $r)) {
			$hit = Get-ChildItem -Path $r -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
				Where-Object { $_.FullName -match '[\\/]x64[\\/]' } |
				Sort-Object FullName -Descending |
				Select-Object -First 1
			if ($hit) { return $hit.FullName }
		}
	}
	return $null
}

function Invoke-SignTool([string]$SignTool, [string]$FilePath, [string]$Cert, [string]$Password, [string]$TsUrl) {
	Write-Host "  signtool sign -> $(Split-Path $FilePath -Leaf)" -ForegroundColor DarkGray
	& $SignTool sign /fd SHA256 /tr $TsUrl /td SHA256 /f $Cert /p $Password $FilePath
	if ($LASTEXITCODE -ne 0) { throw "signtool sign failed (exit $LASTEXITCODE) for $FilePath" }
	& $SignTool verify /pa /all $FilePath
	if ($LASTEXITCODE -ne 0) { throw "signtool verify failed (exit $LASTEXITCODE) for $FilePath" }
}

Write-Host ''
Write-Host '=========================================' -ForegroundColor Magenta
Write-Host '  Kodrix Windows Installer Build' -ForegroundColor Magenta
Write-Host "  Arch: $Arch  Target: $Target" -ForegroundColor Magenta
Write-Host '=========================================' -ForegroundColor Magenta
Write-Host ''

Write-Step '[0/5] Verifying build environment...'
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
$productJsonContent = Get-Content (Join-Path $Root 'product.json') -Raw | ConvertFrom-Json
$appExeName = "$($productJsonContent.nameShort).exe"
$appFolder = Join-Path (Split-Path $Root -Parent) "VSCode-win32-$Arch"
$setupDir = Join-Path $Root ".build\win32-$Arch\$Target-setup"
$setupExe = Join-Path $setupDir 'KodrixSetup.exe'
$distDir = if ($OutputDir) { $OutputDir } else { Join-Path $Root 'dist' }

if (-not $Force -and (Test-Path $setupExe) -and -not $SkipPackage) {
	$age = (Get-Date) - (Get-Item $setupExe).LastWriteTime
	if ($age.TotalHours -lt 1) {
		Write-Host "Recent installer exists (<1h): $setupExe" -ForegroundColor Yellow
		Write-Host 'Use -Force to rebuild.' -ForegroundColor Yellow
	}
}

if ($SkipMinBuild) {
	Write-Step '[1/5] Skipped min build (-SkipMinBuild); verifying prepared app folder...'
	if (-not (Test-Path (Join-Path $appFolder $appExeName))) {
		throw "-SkipMinBuild 需要预置的编译产物，但未找到 $appFolder\$appExeName"
	}
	Write-Host "  App folder: $appFolder" -ForegroundColor DarkGray
} else {
	Write-Step '[1/5] Building minified desktop app (vscode-win32-*-min)...'
	Write-Host '  This step compiles, bundles, and packages into VSCode-win32-* (30–90 min first run).' -ForegroundColor DarkGray
	Invoke-Gulp @("vscode-win32-$Arch-min")
}

# zh-cn 语言包注入发布包（必须在 Inno 打包前完成，安装器直接打包 $appFolder 内容）
$langpackApplied = $false
if ($SkipLangpack) {
	Write-Step '[2/5] zh-cn language pack: skipped (-SkipLangpack)'
} else {
	Write-Step '[2/5] Applying zh-cn language pack to release package...'
	node "$PSScriptRoot\apply-release-zh-langpack.mjs" --app-dir "$appFolder"
	if ($LASTEXITCODE -eq 0) {
		$langpackApplied = $true
	} else {
		Write-Warning 'zh-cn 语言包注入失败（见上方 [apply-release-zh-langpack] 错误输出）。'
		Write-Warning '本次安装包不含中文语言包，界面将保持英文。'
	}
}

Write-Step '[3/5] Preparing Inno updater tools...'
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

Write-Step "[4/5] Building $Target installer (Inno Setup)..."
# 注：不传 --sign —— 该路径走上游 ESRP (build/azure-pipelines/common/sign-win32.ts，
# 依赖微软内部 EsrpCliDllPath，外部不可用)。签名在 PowerShell 层用 signtool 完成。
Invoke-Gulp @("vscode-win32-$Arch-$Target-setup")

if (-not (Test-Path $setupExe)) {
	throw "Installer not found at $setupExe"
}

Write-Step '[5/5] Signing (if configured) and copying to dist/...'
$signed = $false
$haveCert = -not [string]::IsNullOrWhiteSpace($CertPath) -or -not [string]::IsNullOrWhiteSpace($CertPassword)
if ($haveCert) {
	if ([string]::IsNullOrWhiteSpace($CertPath) -or [string]::IsNullOrWhiteSpace($CertPassword)) {
		throw '签名配置不完整：CERT_PATH 与 CERT_PASSWORD_SECRET（或 -CertPath/-CertPassword）必须同时提供'
	}
	if (-not (Test-Path $CertPath)) { throw "证书文件不存在: $CertPath" }
	$signtool = Find-SignTool
	if (-not $signtool) { throw '已提供证书，但未找到 signtool.exe（请安装 Windows SDK / ADK）' }
	Write-Host "  signtool : $signtool" -ForegroundColor DarkGray
	Write-Host "  TSA      : $TimestampUrl" -ForegroundColor DarkGray
	# 先签应用主 EXE（在 SourceDir 中，但此时已被 Inno 打包进安装器，因此仅对
	# 安装器签名即可消除下载入口的 SmartScreen；主 EXE 签名留给后续整目录方案）
	Invoke-SignTool -SignTool $signtool -FilePath $setupExe -Cert $CertPath -Password $CertPassword -TsUrl $TimestampUrl
	$signed = $true
} else {
	Write-Warning '未签名：用户下载/运行安装器时将看到 Windows SmartScreen 警告。'
	Write-Warning '如需签名，请设置 CERT_PATH (PFX 文件) 与 CERT_PASSWORD_SECRET，或使用 -CertPath / -CertPassword 参数。'
}

New-Item -ItemType Directory -Force -Path $distDir | Out-Null
$distName = if ($Target -eq 'user') {
	"Kodrix-$version-$Arch-UserSetup.exe"
} else {
	"Kodrix-$version-$Arch-SystemSetup.exe"
}
$distPath = Join-Path $distDir $distName
Copy-Item -Force -Path $setupExe -Destination $distPath

$hash = (Get-FileHash -Path $distPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $distName" | Set-Content -Path "$distPath.sha256" -Encoding ascii

Write-Host ''
Write-Host '=========================================' -ForegroundColor Green
Write-Host '  Build complete' -ForegroundColor Green
Write-Host "  App folder : $appFolder" -ForegroundColor Green
Write-Host "  Installer  : $distPath" -ForegroundColor Green
Write-Host "  SHA256     : $hash" -ForegroundColor Green
Write-Host "  Signed     : $(if ($signed) { 'YES' } else { 'NO (SmartScreen 警告将出现)' })" -ForegroundColor $(if ($signed) { 'Green' } else { 'Yellow' })
Write-Host "  zh-cn 包   : $(if ($langpackApplied) { '已注入' } elseif ($SkipLangpack) { '已跳过 (-SkipLangpack)' } else { '注入失败——本次安装包不含中文语言包' })" -ForegroundColor $(if ($langpackApplied) { 'Green' } else { 'Yellow' })
Write-Host '=========================================' -ForegroundColor Green
Write-Host ''
