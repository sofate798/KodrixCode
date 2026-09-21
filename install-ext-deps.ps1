$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'
$failed = @()
$root = $PSScriptRoot
$extensionsDir = Join-Path $root 'extensions'

Get-ChildItem $extensionsDir -Directory | ForEach-Object {
    $pkgJson = Join-Path $_.FullName 'package.json'
    if (Test-Path $pkgJson) {
        $nm = Join-Path $_.FullName 'node_modules'
        if (-not (Test-Path $nm)) {
            Write-Host "Installing: $($_.Name)"
            Push-Location $_.FullName
            try {
                npm install 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    $failed += $_.Name
                    Write-Host "  FAILED: $($_.Name)"
                } else {
                    Write-Host "  OK: $($_.Name)"
                }
            } catch {
                $failed += $_.Name
                Write-Host "  ERROR: $($_.Name)"
            }
            Pop-Location
        }
    }
}

Write-Host ''
Write-Host "=== Failed: $($failed.Count) ==="
$failed | ForEach-Object { Write-Host "  $_" }
