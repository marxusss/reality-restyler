# Opt-in: exercise the real updater's read-only check against GitHub releases.
param([Parameter(Mandatory = $true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $InstallRoot).Path
$session = Join-Path ([IO.Path]::GetTempPath()) ('RealityRestyling-Update-' + [guid]::NewGuid().ToString('N'))
try {
    & (Join-Path $root 'updater.ps1') -Action Check -SessionPath $session -InstallRoot $root
    if ($LASTEXITCODE -ne 0) { throw 'Updater check failed.' }
    $state = Get-Content -LiteralPath (Join-Path $session 'update-state.json') -Raw | ConvertFrom-Json
    if ($state.phase -ne 'checked') {
        throw 'The updater could not complete its release check.'
    }
    Write-Host "Updater check completed: $($state.phase)"
} finally {
    if (Test-Path -LiteralPath $session) {
        Remove-Item -LiteralPath $session -Recurse -Force
    }
}
