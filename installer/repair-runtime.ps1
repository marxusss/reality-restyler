# Update/repair path: preserve model location and reuse normal dependency setup.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root 'python\python.exe'
$check = Join-Path $root 'runtime_cleanup.py'
$runtime = Join-Path $root '.runtime'
$logs = Join-Path $runtime 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + $PID
$log = Join-Path $logs "install-$stamp-repair.log"
try {
    & $python -B (Join-Path $root 'log_retention.py') --prune
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'models.path'))) {
        $models = Join-Path $env:LOCALAPPDATA 'Reality Restyling\Models'
        New-Item -ItemType Directory -Force -Path $models | Out-Null
        [IO.File]::WriteAllText((Join-Path $runtime 'models.path'), $models, [Text.UTF8Encoding]::new($false))
    }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $python -B $check --root $root --verify-ready *> $log
    $ready = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $old
    if (-not $ready) {
        $process = Start-Process -FilePath (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $root 'setup.ps1'))) -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logs "install-$stamp-setup.log") -RedirectStandardError (Join-Path $logs "install-$stamp-error.log")
        if ($process.ExitCode -ne 0) { throw 'The runtime repair failed.' }
        & $python -B $check --root $root --remove setup-pending
        if ($LASTEXITCODE -ne 0) { throw 'Could not clear the completed setup marker.' }
        & $python -B $check --root $root --verify-ready
        if ($LASTEXITCODE -ne 0) { throw 'The repaired runtime failed verification.' }
    }
    exit 0
} catch {
    Add-Content -LiteralPath $log -Value $_.Exception.Message
    exit 1
}
