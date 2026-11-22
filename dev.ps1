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
# If the data contract differs from the installed release, keep edits out of production data.
$contracts = @('preferences.py', 'runtime_settings.py', 'user_styles.py')
if ((Test-Path -LiteralPath $installed -PathType Container) -and
    @($contracts | Where-Object {
        $candidate = Join-Path $installed $_
        -not (Test-Path -LiteralPath $candidate -PathType Leaf) -or
        (Get-Item -LiteralPath (Join-Path $root $_)).Length -ne (Get-Item -LiteralPath $candidate).Length -or
        (Get-FileHash -LiteralPath (Join-Path $root $_) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash
    }).Count -gt 0) {
    $env:REALITY_RESTYLE_USER_DATA = Join-Path $env:LOCALAPPDATA 'Reality Restyling Dev'
    Write-Host 'Development data isolated (persistence code differs).'
}

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
