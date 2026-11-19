param([switch]$InstallUpscaler, [switch]$PhoneAccess, [switch]$Launcher)

$installUpscaler = [bool]$InstallUpscaler
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$setup = Join-Path $PSScriptRoot 'setup.ps1'
try {
    & $setup
} catch {
    Write-Error $_
    exit 1
}
$python = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$runtimeDir = Join-Path $PSScriptRoot '.runtime'
$modelsPathFile = Join-Path $runtimeDir 'models.path'
$modelSetup = Join-Path $PSScriptRoot 'model_setup.py'
$modelsRoot = Join-Path $PSScriptRoot 'models'
if (Test-Path -LiteralPath $modelsPathFile -PathType Leaf) {
    $savedRoot = [IO.File]::ReadAllText($modelsPathFile, [Text.Encoding]::UTF8).Trim()
    if ($savedRoot -and (Test-Path -LiteralPath $savedRoot -PathType Container)) {
        $modelsRoot = $savedRoot
    }
}

function Normalize-ModelsRoot {
    param([string]$Path)
    $trimmedPath = $Path.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
    $leaf = Split-Path -Leaf $trimmedPath
    if ($leaf -in @('FLUX.2-klein-9B', 'FLUX.2-klein-9B-Nunchaku')) { return Split-Path -Parent $trimmedPath }
    return [IO.Path]::GetFullPath($trimmedPath)
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
$modelArguments = @('--root', $modelsRoot, '--check')
$modelState = Invoke-ModelSetup -Arguments $modelArguments
while ($modelState -ne 0) {
    $selectedRoot = Select-ModelsRoot
    if (-not $selectedRoot) { break }
    $modelsRoot = Normalize-ModelsRoot -Path $selectedRoot
    $env:REALITY_RESTYLE_MODELS_DIR = $modelsRoot
    Save-ModelsRoot -Path $modelsRoot
    $modelArguments = @('--root', $modelsRoot, '--check')
    $modelState = Invoke-ModelSetup -Arguments $modelArguments
    if ($modelState -ne 0) {
        $browseAgain = [System.Windows.Forms.MessageBox]::Show('Required model files were not found in this folder. Browse another folder?', 'Reality Restyling', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Error)
        if ($browseAgain -ne [System.Windows.Forms.DialogResult]::Yes) { break }
    }
}
if ($modelState -ne 0) {
    $download = [System.Windows.Forms.MessageBox]::Show('Download the missing model files now?', 'Reality Restyling', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($download -eq [System.Windows.Forms.DialogResult]::Yes) {
        $modelArguments = @('--root', $modelsRoot, '--download-required')
        $modelState = Invoke-ModelSetup -Arguments $modelArguments
    }
}
if ($modelState -eq 0 -or (Test-Path -LiteralPath $modelsRoot -PathType Container)) { Save-ModelsRoot -Path $modelsRoot }

$upscalerState = Invoke-ModelSetup -Arguments @('--root', $modelsRoot, '--check-upscaler')
if ($installUpscaler -or $upscalerState -ne 0) {
    $upscalerState = Invoke-ModelSetup -Arguments @('--root', $modelsRoot, '--download-upscaler')
    if ($upscalerState -ne 0) { Write-Host 'Compact 2x is unavailable. Run run.bat -InstallUpscaler to retry.' }
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

$tailscale = Find-Tailscale
if ($tailscale) { $env:Path = "$(Split-Path -Parent $tailscale);$env:Path" }
if ($Launcher) {
    $launcherPython = Join-Path $PSScriptRoot '.venv\Scripts\pythonw.exe'
    if (-not (Test-Path -LiteralPath $launcherPython)) { $launcherPython = $python }
    Start-Process -FilePath $launcherPython -ArgumentList ('"' + (Join-Path $PSScriptRoot 'launcher.py') + '"') -WorkingDirectory $PSScriptRoot
    exit 0
}
$serverArguments = @((Join-Path $PSScriptRoot 'app.py'))
if ($PhoneAccess) { $serverArguments += '--phone-access' }

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& $python @serverArguments
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $previousPreference
exit $exitCode
