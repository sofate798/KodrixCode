# Kodrix / VS Code 依赖安装脚本（Windows PowerShell）
# 用法: .\scripts\install-kodrix-deps.ps1
# 可选: -Full  尝试完整 npm install（含原生模块，需 VS Spectre 库）
# 可选: -SkipNative  跳过原生模块编译（默认，可编译扩展）

param(
	[switch]$Full
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

# 自动配置 VS 路径（非 C: 默认盘符时 npm preinstall 需要 vs2026_install 等变量）
& "$PSScriptRoot\verify-windows-build-env.ps1" -SetEnv
if ($LASTEXITCODE -ne 0 -and $Full) {
	Write-Error "构建环境未就绪。请先运行 .\scripts\verify-windows-build-env.ps1 查看详情。"
}

if ((Get-Content package.json -Raw) -notmatch '"name"\s*:\s*"code-oss-dev"') {
	Write-Error @"
根目录 package.json 不正确（应为 code-oss-dev）。
若被扩展 package.json 覆盖，请运行:
  Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/microsoft/vscode/main/package.json' -OutFile package.json
"@
}

Write-Host "==> 安装根目录依赖..." -ForegroundColor Cyan
if ($Full) {
	npm install
} else {
	npm install --ignore-scripts
}

$subdirs = @(
	'build',
	'extensions/kodrix-local',
	'extensions/kodrix-skills',
	'extensions/kodrix-agent-os'
)

foreach ($d in $subdirs) {
	Write-Host "==> $d" -ForegroundColor Cyan
	Push-Location $d
	if ($Full) { npm install } else { npm install --ignore-scripts }
	Pop-Location
}

Write-Host ""
Write-Host "完成。编译扩展:" -ForegroundColor Green
Write-Host "  npm run gulp -- compile-extension:kodrix-agent-os compile-extension:kodrix-local compile-extension:kodrix-skills"
Write-Host ""
if (-not $Full) {
	Write-Host "注意: 已跳过原生模块编译。启动 IDE 需完整安装:" -ForegroundColor Yellow
	Write-Host "  1. Visual Studio 2026 安装 'Spectre 缓解库' 组件（C++ 桌面开发工作负载）"
	Write-Host "  2. Node.js 24.17.0（见 .nvmrc）"
	Write-Host "  3. npm install（不加 --ignore-scripts）"
	Write-Host "  4. npm run compile && .\scripts\code.bat"
}
