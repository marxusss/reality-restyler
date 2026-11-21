# Serve the checkout directly; installed releases are never replaced.
param([ValidateRange(1, 65535)][int]$Port = 8782)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Reality Restyling'

$localPython = Join-Path $root '.venv\Scripts\python.exe'
$installedPython = Join-Path $installed '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $localPython -PathType Leaf) {
    $python = $localPython
} elseif (Test-Path -LiteralPath $installedPython -PathType Leaf) {
    $python = $installedPython
} else {
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $command) { throw 'Install Reality Restyling or prepare a Python environment with its dependencies.' }
    $python = $command.Source
}

if (-not $env:REALITY_RESTYLE_MODELS_DIR) {
    foreach ($modelsFile in @((Join-Path $root '.runtime\models.path'), (Join-Path $installed '.runtime\models.path'))) {
        if (Test-Path -LiteralPath $modelsFile -PathType Leaf) {
            $env:REALITY_RESTYLE_MODELS_DIR = [IO.File]::ReadAllText($modelsFile).Trim()
            break
        }
    }
}
$env:REALITY_RESTYLE_PORT = [string]$Port
Write-Host "Developer server: http://127.0.0.1:$Port/"
Write-Host "Serving current source: $root"
Write-Host 'Restart after code changes. Installed releases are unchanged.'
Push-Location -LiteralPath $root
try {
    & $python -B (Join-Path $root 'app.py') --dev
    if ($LASTEXITCODE -ne 0) { throw "Developer server exited with code $LASTEXITCODE." }
} finally {
    Pop-Location
}
