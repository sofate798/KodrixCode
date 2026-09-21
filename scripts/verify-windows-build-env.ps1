# 验证 Windows 上构建 Minicode / VS Code 所需的环境
# 用法: .\scripts\verify-windows-build-env.ps1
# 可选: -SetEnv  将检测到的 VS 路径写入当前 PowerShell 会话的环境变量

param(
	[switch]$SetEnv
)

$ErrorActionPreference = "Continue"
$script:HasError = $false

function Write-Check {
	param(
		[ValidateSet('OK', 'Warn', 'Fail')]
		[string]$Status,
		[string]$Message
	)
	switch ($Status) {
		'OK' { Write-Host "  [OK]   $Message" -ForegroundColor Green }
		'Warn' { Write-Host "  [WARN] $Message" -ForegroundColor Yellow }
		'Fail' { Write-Host "  [FAIL] $Message" -ForegroundColor Red; $script:HasError = $true }
	}
}

function Get-VsWherePath {
	$path = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
	if (Test-Path $path) { return $path }
	return $null
}

function Get-VisualStudioInstall {
	param([string]$VsWhere)

	$requires = @(
		'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
	)
	$args = @('-latest', '-format', 'json', '-utf8') + ($requires | ForEach-Object { '-requires'; $_ })
	$json = & $VsWhere @args 2>$null | ConvertFrom-Json
	if (-not $json) { return $null }

	[PSCustomObject]@{
		DisplayName       = $json.displayName
		InstallationPath  = $json.installationPath
		ProductLineVersion = $json.catalog.productLineVersion
	}
}

function Set-VisualStudioEnvVar {
	param(
		[string]$InstallationPath,
		[string]$ProductLineVersion
	)

	$envName = switch ($ProductLineVersion) {
		'19' { 'vs2028_install' }
		'18' { 'vs2026_install' }
		'17' { 'vs2022_install' }
		'16' { 'vs2019_install' }
		default { $null }
	}

	if (-not $envName) {
		# Fallback: try to set the latest known env var for unknown versions
		$envName = 'vs2026_install'
		Write-Check Warn "无法识别 VS 版本 (productLine=$ProductLineVersion)，已尝试设置 `$env:$envName"
		Set-Item -Path "Env:$envName" -Value $InstallationPath
		return
	}

	Set-Item -Path "Env:$envName" -Value $InstallationPath
	Write-Check OK "已设置 `$env:$envName = $InstallationPath"
}

Write-Host "Minicode Windows 构建环境检查" -ForegroundColor Cyan
Write-Host ""

# Node.js
Write-Host "Node.js" -ForegroundColor Cyan
$nvmrcPath = Join-Path (Join-Path $PSScriptRoot '..') '.nvmrc'
$requiredNode = if (Test-Path $nvmrcPath) { (Get-Content $nvmrcPath -Raw).Trim() } else { '24.17.0' }
try {
	$nodeVersion = (node -v 2>$null).TrimStart('v')
	if ($nodeVersion -match '^(\d+)\.(\d+)\.(\d+)') {
		$major = [int]$Matches[1]
		$minor = [int]$Matches[2]
		$patch = [int]$Matches[3]
		$req = $requiredNode -match '^(\d+)\.(\d+)\.(\d+)'
		$reqMajor = [int]$Matches[1]
		$reqMinor = [int]$Matches[2]
		$reqPatch = [int]$Matches[3]

		if ($major -ne $reqMajor -or $minor -lt $reqMinor -or ($minor -eq $reqMinor -and $patch -lt $reqPatch)) {
			Write-Check Warn "当前 v$nodeVersion，项目 .nvmrc 要求 v$requiredNode 或同主版本更新补丁"
		} else {
			Write-Check OK "v$nodeVersion（要求 v$requiredNode+）"
		}
	} else {
		Write-Check Warn "无法解析 Node 版本: $nodeVersion"
	}
} catch {
	Write-Check Fail "未找到 Node.js，请安装 v$requiredNode"
}

# Python
Write-Host "Python (node-gyp)" -ForegroundColor Cyan
try {
	$pyVersion = (python --version 2>&1).ToString().Replace('Python ', '')
	Write-Check OK "Python $pyVersion"
} catch {
	Write-Check Fail "未找到 Python 3.x（node-gyp 需要）"
}

# Visual Studio
Write-Host "Visual Studio (C++ 工具链)" -ForegroundColor Cyan
$vswhere = Get-VsWherePath
if (-not $vswhere) {
	Write-Check Fail "未找到 vswhere.exe，请安装 Visual Studio 或 Build Tools"
} else {
	$vs = Get-VisualStudioInstall -VsWhere $vswhere
	if (-not $vs) {
		Write-Check Fail "未找到带 MSVC x64 工具的 Visual Studio 安装"
		Write-Host "        请在 Visual Studio Installer 中勾选「使用 C++ 的桌面开发」工作负载" -ForegroundColor DarkGray
	} else {
		Write-Check OK "$($vs.DisplayName)"
		Write-Check OK "路径: $($vs.InstallationPath)"

		if ($SetEnv) {
			Set-VisualStudioEnvVar -InstallationPath $vs.InstallationPath -ProductLineVersion $vs.ProductLineVersion
		} else {
			$envHint = switch ($vs.ProductLineVersion) {
				'18' { 'vs2026_install' }
				'17' { 'vs2022_install' }
				'16' { 'vs2019_install' }
				default { 'vs2026_install' }
			}
			if (-not (Test-Path $vs.InstallationPath)) {
				Write-Check Fail "安装路径不存在: $($vs.InstallationPath)"
			} else {
				$defaultRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\') }
				$underDefaultRoot = $defaultRoots | Where-Object { $vs.InstallationPath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }
				if (-not $underDefaultRoot) {
					Write-Check Warn "VS 安装在非默认盘符，npm 可能检测不到。运行本脚本加 -SetEnv，或设置:"
					Write-Host "        `$env:$envHint = '$($vs.InstallationPath)'" -ForegroundColor DarkGray
				}
			}
		}

		# Spectre 缓解库（部分原生模块需要）
		$spectreArgs = @(
			'-latest',
			'-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
			'-requires', 'Microsoft.VisualStudio.Component.VC.Spectre',
			'-property', 'displayName',
			'-format', 'value'
		)
		$spectreName = & $vswhere @spectreArgs 2>$null
		if ($spectreName) {
			Write-Check OK "已安装 Spectre 缓解库"
		} else {
			Write-Check Warn "未安装 Spectre 缓解库。完整 npm install 可能失败。"
			Write-Host "        Visual Studio Installer → 修改 → C++ 桌面开发 → 单个组件 → 搜索 Spectre" -ForegroundColor DarkGray
		}
	}
}

# Inno Setup (for EXE installer packaging)
Write-Host "Inno Setup (EXE 安装包打包)" -ForegroundColor Cyan
$innoFound = $false
try {
	# Try resolving via innosetup npm package (used by build system)
	$innoSetupNpmPath = (Get-Item (Join-Path $PSScriptRoot '..\node_modules\innosetup\package.json') -ErrorAction SilentlyContinue)
	if ($innoSetupNpmPath) {
		$innoDir = (Get-Item (Join-Path $innoSetupNpmPath.DirectoryName '..\innosetup\bin')).FullName
		$isccPath = Join-Path $innoDir 'ISCC.exe'
		if (Test-Path $isccPath) {
			$innoFound = $true
			Write-Check OK "ISCC.exe 通过 innosetup npm 包解析成功: $isccPath"
		}
	}
} catch { }

if (-not $innoFound) {
	# Fallback: check PATH
	try {
		$isccInPath = (Get-Command ISCC.exe -ErrorAction SilentlyContinue)
		if ($isccInPath) {
			$innoFound = $true
			Write-Check OK "ISCC.exe 在 PATH 中: $($isccInPath.Source)"
		}
	} catch { }
}

if (-not $innoFound) {
	Write-Check Warn "未找到 ISCC.exe（Inno Setup 编译器）。如需打包 EXE 安装包，请安装 Inno Setup 6+"
	Write-Host "        下载: https://jrsoftware.org/isinfo.php" -ForegroundColor DarkGray
}

Write-Host ""
if ($script:HasError) {
	Write-Host "环境未就绪，请先解决上述 [FAIL] 项。" -ForegroundColor Red
	exit 1
}

Write-Host "环境检查通过。" -ForegroundColor Green
if (-not $SetEnv) {
	Write-Host "安装依赖前可执行: .\scripts\verify-windows-build-env.ps1 -SetEnv" -ForegroundColor DarkGray
}
exit 0
