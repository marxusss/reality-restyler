$ErrorActionPreference = 'Stop'
$setup = Join-Path $PSScriptRoot 'setup.ps1'
try {
    & $setup
} catch {
    Write-Error $_
    exit 1
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $python (Join-Path $PSScriptRoot 'app.py')
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
exit $exitCode
