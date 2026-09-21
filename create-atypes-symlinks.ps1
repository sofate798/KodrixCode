$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'
$sharedTypes = Join-Path $PSScriptRoot 'extensions\node_modules\@types'
$dirs = @(
    'configuration-editing', 'css-language-features', 'debug-auto-launch', 'debug-server-ready',
    'emmet', 'extension-editing', 'git', 'git-base', 'github', 'github-authentication',
    'grunt', 'gulp', 'html-language-features', 'ipynb', 'jake', 'json-language-features',
    'media-preview', 'merge-conflict', 'microsoft-authentication', 'npm',
    'php-language-features', 'references-view', 'search-result', 'terminal-suggest',
    'tunnel-forwarding', 'typescript-language-features', 'vscode-api-tests',
    'vscode-colorize-perf-tests', 'vscode-colorize-tests', 'vscode-test-resolver'
)

$base = Join-Path $PSScriptRoot 'extensions'
$ok = 0
$fail = 0

foreach ($dir in $dirs) {
    $targetDir = Join-Path $base "$dir\node_modules\@types"
    if (-not (Test-Path $targetDir)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    $targetLink = Join-Path $targetDir 'node'
    if (-not (Test-Path $targetLink)) {
        try {
            New-Item -ItemType Junction -Path $targetLink -Target (Join-Path $sharedTypes 'node') -Force | Out-Null
            $ok++
        } catch {
            try {
                Copy-Item -Recurse (Join-Path $sharedTypes 'node') $targetLink -Force
                $ok++
            } catch {
                Write-Host "FAILED: $dir - $_"
                $fail++
            }
        }
    } else {
        Write-Host "EXISTS: $dir"
        $ok++
    }
}

Write-Host "Created: $ok, Failed: $fail"
