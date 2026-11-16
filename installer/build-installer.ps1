$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $compiler = $command.Source }
}
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Inno Setup 6 is required to build the installer.' }
New-Item -ItemType Directory -Force -Path (Join-Path $root 'dist') | Out-Null
Push-Location $root
try {
    & $compiler /Qp 'installer\RealityRestyling.iss'
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not compile RealityRestylingSetup.exe.' }
} finally {
    Pop-Location
}
