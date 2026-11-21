param(
    [switch]$PhoneAccess,
    [switch]$Unattended,
    [string]$LauncherSession,
    [int]$LauncherProcessId,
    [ValidateRange(5, 3600)]
    [int]$AutoUnloadSeconds = 30
)

$ErrorActionPreference = 'Stop'
$env:REALITY_RESTYLE_IDLE_SECONDS = [string]$AutoUnloadSeconds
Add-Type -AssemblyName System.Windows.Forms
if (-not $LauncherSession -or $LauncherProcessId -le 0) {
    Write-Error 'Start Reality Restyling from its launcher.'
    exit 2
}

function Write-LauncherError {
    param([string]$Message)
    $path = Join-Path $LauncherSession 'error.json'
    $pending = $path + '.tmp'
    $json = @{ message = $Message } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($pending, $json, [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($pending, $path)
}

function Stop-Launcher {
    param([string]$Message)
    Write-LauncherError -Message $Message
    Write-Error $Message
    exit 1
}

function Set-LauncherStage {
    param([string]$Message)
    if (-not $LauncherSession) { return }
    if ((Test-Path -LiteralPath (Join-Path $LauncherSession 'stop')) -or
        -not (Get-Process -Id $LauncherProcessId -ErrorAction SilentlyContinue)) { exit 0 }
    [IO.File]::WriteAllText((Join-Path $LauncherSession 'stage.txt'), $Message)
}

Set-LauncherStage 'Checking the app environment'
$runtimeDir = Join-Path $PSScriptRoot '.runtime'
$bundledPython = Join-Path $PSScriptRoot 'python\python.exe'
$runtimeCheck = Join-Path $PSScriptRoot 'runtime_cleanup.py'
if (-not (Test-Path -LiteralPath $bundledPython -PathType Leaf) -or -not (Test-Path -LiteralPath $runtimeCheck -PathType Leaf)) {
    Stop-Launcher 'The local runtime is incomplete. Run RealityRestylingSetup.exe again, then reopen Reality Restyling.'
}
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $bundledPython -B $runtimeCheck --root $PSScriptRoot --verify-ready 2>&1 | ForEach-Object { Write-Host $_ }
$runtimeExit = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
if ($runtimeExit -ne 0) {
    Stop-Launcher 'The local runtime is incomplete or outdated. Run RealityRestylingSetup.exe again, then reopen Reality Restyling.'
}
$env:PIP_CACHE_DIR = Join-Path $runtimeDir 'cache\pip'
$env:HF_HUB_CACHE = Join-Path $runtimeDir 'cache\huggingface'
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$modelsPathFile = Join-Path $runtimeDir 'models.path'
$modelSetup = Join-Path $PSScriptRoot 'model_setup.py'
$savedRoot = if (Test-Path -LiteralPath $modelsPathFile -PathType Leaf) {
    [IO.File]::ReadAllText($modelsPathFile, [Text.Encoding]::UTF8).Trim()
} elseif ($Unattended) {
    Join-Path $env:LOCALAPPDATA 'Reality Restyling\Models'
} else {
    Stop-Launcher 'The model folder has not been set up. Run RealityRestylingSetup.exe again and choose a model folder.'
}
if (-not $savedRoot -or -not [IO.Path]::IsPathRooted($savedRoot)) {
    Stop-Launcher 'The saved model folder is invalid. Run RealityRestylingSetup.exe again and choose a model folder.'
}
$modelsRoot = [IO.Path]::GetFullPath($savedRoot)
$installRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([char[]]@('\', '/'))
if ($modelsRoot.Equals($installRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $modelsRoot.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Launcher 'The saved model folder must be outside the app folder. Run RealityRestylingSetup.exe again and choose an external folder.'
}
if (Test-Path -LiteralPath $modelsRoot -PathType Container) {
    $modelItem = Get-Item -LiteralPath $modelsRoot -Force
    if ($modelItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Stop-Launcher 'The saved model folder is redirected. Run RealityRestylingSetup.exe again and choose a regular external folder.'
    }
}

function Normalize-ModelsRoot {
    param([string]$Path)
    $trimmedPath = $Path.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
    $leaf = Split-Path -Leaf $trimmedPath
    if ($leaf -in @('FLUX.2-klein-9B', 'FLUX.2-klein-9B-Nunchaku')) { return Split-Path -Parent $trimmedPath }
    return [IO.Path]::GetFullPath($trimmedPath)
}

function Test-ExternalModelsRoot {
    param([string]$Path)
    if (-not $Path) { return $false }
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ($fullPath.Equals($installRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    if (Test-Path -LiteralPath $fullPath -PathType Container) {
        $item = Get-Item -LiteralPath $fullPath -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
    }
    return $true
}

$modelsRoot = Normalize-ModelsRoot -Path $modelsRoot

function Save-ModelsRoot {
    param([string]$Path)
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    [IO.File]::WriteAllText($modelsPathFile, $Path, [Text.UTF8Encoding]::new($false))
}

function Invoke-ModelSetup {
    param([string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $python $modelSetup @Arguments | ForEach-Object { Write-Host $_ }
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    return $exitCode
}

function Select-ModelsRoot {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = [System.Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = 'Select the model folder or its parent folder'
    $dialog.ShowNewFolderButton = $false
    if (Test-Path -LiteralPath $modelsRoot -PathType Container) { $dialog.SelectedPath = $modelsRoot }
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dialog.SelectedPath }
    return ''
}

$env:REALITY_RESTYLE_MODELS_DIR = $modelsRoot
if (-not $Unattended) {
    Set-LauncherStage 'Checking model files'
    $modelArguments = @('--root', $modelsRoot, '--check')
    $modelState = Invoke-ModelSetup -Arguments $modelArguments
    while ($modelState -ne 0) {
        Set-LauncherStage 'Waiting for a model folder choice'
        $selectedRoot = Select-ModelsRoot
        if (-not $selectedRoot) { break }
        $selectedRoot = Normalize-ModelsRoot -Path $selectedRoot
        if (-not (Test-ExternalModelsRoot -Path $selectedRoot)) {
            [System.Windows.Forms.MessageBox]::Show('Choose a model folder outside the Reality Restyling app folder.', 'Reality Restyling', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
            continue
        }
        $modelsRoot = $selectedRoot
        $env:REALITY_RESTYLE_MODELS_DIR = $modelsRoot
        Save-ModelsRoot -Path $modelsRoot
        $modelArguments = @('--root', $modelsRoot, '--check')
        $modelState = Invoke-ModelSetup -Arguments $modelArguments
        if ($modelState -ne 0) {
            Set-LauncherStage 'The selected model folder is incomplete'
            $browseAgain = [System.Windows.Forms.MessageBox]::Show('Required model files were not found in this folder. Browse another folder?', 'Reality Restyling', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Error)
            if ($browseAgain -ne [System.Windows.Forms.DialogResult]::Yes) { break }
        }
    }
    if ($modelState -ne 0) {
        Set-LauncherStage 'Waiting for a model download choice'
        $download = [System.Windows.Forms.MessageBox]::Show('Download the missing model files now?', 'Reality Restyling', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
        if ($download -eq [System.Windows.Forms.DialogResult]::Yes) {
            Set-LauncherStage 'Downloading model files'
            $modelArguments = @('--root', $modelsRoot, '--download-required')
            $modelState = Invoke-ModelSetup -Arguments $modelArguments
        }
    }
    if ($modelState -eq 0 -or (Test-Path -LiteralPath $modelsRoot -PathType Container)) { Save-ModelsRoot -Path $modelsRoot }

    $upscalerState = Invoke-ModelSetup -Arguments @('--root', $modelsRoot, '--check-upscaler')
    if ($upscalerState -ne 0) {
        Set-LauncherStage 'Downloading the optional upscaler'
        $upscalerState = Invoke-ModelSetup -Arguments @('--root', $modelsRoot, '--download-upscaler')
        if ($upscalerState -ne 0) { Write-Host 'Compact 2x is unavailable. It will retry the next time you start the app.' }
    }
}

function Find-Tailscale {
    $command = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    $candidate = Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    return ''
}

$serverArguments = @((Join-Path $PSScriptRoot 'app.py'))
Set-LauncherStage 'Starting the server'
if ($LauncherSession) {
    $serverArguments += @('--launcher-session', $LauncherSession, '--launcher-process-id', $LauncherProcessId)
}
if ($PhoneAccess) {
    $tailscale = Find-Tailscale
    if ($tailscale) { $env:Path = "$(Split-Path -Parent $tailscale);$env:Path" }
    $serverArguments += '--phone-access'
    if ($Unattended) { $serverArguments += '--wait-for-tailscale' }
}

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $python @serverArguments
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
exit $exitCode
