# Opt-in only. Run in a clean, disposable Windows VM: this performs a real install,
# including runtime dependency setup, and must never overwrite an existing install.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Reality Restyling'
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Reality Restyling' }
if ($existing -or (Test-Path -LiteralPath $installed)) {
    throw 'Use a clean disposable Windows VM. An existing Reality Restyling installation was found.'
}

$process = Start-Process -FilePath $installerPath -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-') -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "Installer failed (exit $($process.ExitCode))." }
foreach ($relative in @('RealityRestyling.exe', 'app.py', 'web\index.html', 'python\python.exe',
                        '.venv\Scripts\python.exe', 'version.txt')) {
    if (-not (Test-Path -LiteralPath (Join-Path $installed $relative) -PathType Leaf)) {
        throw "Installed application is incomplete: $relative."
    }
}
$python = Join-Path $installed '.venv\Scripts\python.exe'
Push-Location -LiteralPath $installed
try {
    # Import from the installed application, never a nearby source checkout.
    & $python -B -c 'from pathlib import Path; import app; assert Path(app.__file__).resolve() == Path("app.py").resolve(); app.create_app(); print("Installed application initialized successfully")'
    if ($LASTEXITCODE -ne 0) { throw 'Installed application could not initialize the server.' }
} finally {
    Pop-Location
}
Write-Host 'Installer smoke passed: application installed, runtime prepared, and server initialized.'
Write-Host "Installed app left in: $installed"
