param([switch]$InstallerProgress)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$requirements = Join-Path $root 'requirements.txt'
$runtimeDir = Join-Path $root '.runtime'
$wheelDir = Join-Path $runtimeDir 'wheels'
$cacheDir = Join-Path $runtimeDir 'cache'
$marker = Join-Path $runtimeDir 'setup.env'
$pending = Join-Path $runtimeDir 'setup.pending'
$bundledPython = Join-Path $root 'python\python.exe'
$pythonDll = Join-Path $root 'python\python311.dll'

if (-not (Test-Path -LiteralPath $bundledPython -PathType Leaf) -or -not (Test-Path -LiteralPath $pythonDll -PathType Leaf)) {
    throw 'The bundled Python files are missing. Run RealityRestylingSetup.exe again.'
}

$env:PIP_CACHE_DIR = Join-Path $cacheDir 'pip'
$env:HF_HUB_CACHE = Join-Path $cacheDir 'huggingface'

function Write-SetupStage {
    param([int]$Number, [string]$Text)
    if ($InstallerProgress) { [Console]::WriteLine("RR_STAGE $Number $Text") }
}

Write-SetupStage 1 'Preparing app environment'

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

$requirementsHash = Get-Sha256 -Path $requirements
$setupHash = Get-Sha256 -Path $PSCommandPath
$wheelName = 'nunchaku-1.4.1+cu13.0torch2.14-cp311-cp311-win_amd64.whl'
$wheelHash = '4cbe71d71c49590728b208ecdb9fc22e405c582def53deb6cca9cd396e598da4'
$wheelRevision = '51c61df1b9369b50b652587dd7c7ce1c985024a5'
$pythonBuild = Get-Sha256 -Path $pythonDll
$expected = "setup-v3;python=$pythonBuild;torch=2.14.1;torchvision=0.29.1;cuda=13.0;nunchaku=1.4.1;wheel=$wheelHash;requirements=$requirementsHash;setup=$setupHash"
$probe = "import importlib.metadata as m, sys, torch, torchvision; from diffusers import Flux2KleinPipeline; from nunchaku.models.transformers.transformer_flux2 import NunchakuFlux2Transformer2DModel; from transformers import BitsAndBytesConfig, Qwen3ForCausalLM; assert sys.version_info[:2] == (3, 11); assert m.version('torch').split('+')[0] == '2.14.1'; assert m.version('torchvision').split('+')[0] == '0.29.1'; assert torch.version.cuda == '13.0'; assert m.version('nunchaku') == '1.4.1+cu13.0torch2.14'; assert m.version('diffusers') == '0.43.0'"

function Test-PythonCode {
    param([string]$Code, [switch]$ShowFailure)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = & $python -c $Code 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($exitCode -ne 0 -and $ShowFailure) {
        foreach ($line in $output) { Write-Host $line }
    }
    return ($exitCode -eq 0)
}

function Invoke-CheckedNative {
    param([string]$FilePath, [string[]]$Arguments, [string]$Failure)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & $FilePath @Arguments
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($exitCode -ne 0) { throw $Failure }
}

$cleanupScript = Join-Path $root 'runtime_cleanup.py'
Invoke-CheckedNative -FilePath $bundledPython -Arguments @(
    $cleanupScript, '--root', $root,
    '--check', 'venv', '--check', 'cache', '--check', 'wheels',
    '--check', 'setup-marker', '--check', 'setup-pending'
) -Failure 'An app runtime folder is redirected or unsafe.'

$configurationPath = Join-Path $venv 'pyvenv.cfg'
$configuration = if (Test-Path -LiteralPath $configurationPath -PathType Leaf) {
    [IO.File]::ReadAllText($configurationPath, [Text.Encoding]::UTF8)
} else { '' }
$pythonHome = [regex]::Match($configuration, '(?m)^home\s*=\s*(.+)$').Groups[1].Value.Trim()
$expectedPythonHome = [IO.Path]::GetFullPath((Split-Path -Parent $bundledPython)).TrimEnd([IO.Path]::DirectorySeparatorChar)
$actualPythonHome = if ($pythonHome) { [IO.Path]::GetFullPath($pythonHome).TrimEnd([IO.Path]::DirectorySeparatorChar) } else { '' }
$usesExpectedPython = $actualPythonHome -eq $expectedPythonHome
if ($usesExpectedPython -and (Test-Path -LiteralPath $python -PathType Leaf) -and
    (Test-Path -LiteralPath $marker -PathType Leaf) -and (Get-Content -LiteralPath $marker -Raw).Trim() -eq $expected) {
    if (Test-PythonCode $probe) {
        Write-SetupStage 6 'Checking installed runtime'
        Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'check') -Failure 'The Python environment has incompatible packages.'
        return
    }
}

if ($InstallerProgress) {
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    [IO.File]::WriteAllText($pending, '')
}
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }

$venvValid = $usesExpectedPython -and $configuration -and (Test-Path -LiteralPath $python -PathType Leaf) -and
    $configuration -notmatch '(?m)^include-system-site-packages\s*=\s*true\s*$' -and
    (Test-PythonCode "import sys; assert sys.version_info[:2] == (3, 11)")

if (-not $venvValid) {
    Invoke-CheckedNative -FilePath $bundledPython -Arguments @($cleanupScript, '--root', $root, '--remove', 'venv') -Failure 'Could not safely clear the old app environment.'
    Invoke-CheckedNative -FilePath $bundledPython -Arguments @('-m', 'venv', $venv) -Failure 'Could not create the app environment.'
}

Write-SetupStage 2 'Preparing package tools'
Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'ensurepip', '--upgrade') -Failure 'Could not prepare the bundled package tools.'
$pipProgress = @()
if ($InstallerProgress) { $pipProgress = @('--progress-bar', 'raw') }

Write-SetupStage 3 'Preparing GPU libraries'
$torchProbe = "import importlib.metadata as m, torch, torchvision; assert m.version('torch').split('+')[0] == '2.14.1'; assert m.version('torchvision').split('+')[0] == '0.29.1'; assert torch.version.cuda == '13.0'"
if (-not (Test-PythonCode $torchProbe)) {
    Invoke-CheckedNative -FilePath $python -Arguments (@('-m', 'pip', 'install', '--upgrade', '--force-reinstall', 'torch==2.14.1', 'torchvision==0.29.1', '--index-url', 'https://download.pytorch.org/whl/cu130') + $pipProgress) -Failure 'Could not install the CUDA runtime.'
}

Write-SetupStage 4 'Installing app libraries'
Invoke-CheckedNative -FilePath $python -Arguments (@('-m', 'pip', 'install', '-r', $requirements) + $pipProgress) -Failure 'Could not install the application dependencies.'

Write-SetupStage 5 'Preparing AI engine'
$nunchakuProbe = "import importlib.metadata as m; from nunchaku.models.transformers.transformer_flux2 import NunchakuFlux2Transformer2DModel; assert m.version('nunchaku') == '1.4.1+cu13.0torch2.14'"
if (-not (Test-PythonCode $nunchakuProbe)) {
    $env:REALITY_RESTYLE_WHEEL_DIR = $wheelDir
    $env:REALITY_RESTYLE_WHEEL_NAME = $wheelName
    $env:REALITY_RESTYLE_WHEEL_REVISION = $wheelRevision
    $env:REALITY_RESTYLE_WHEEL_HASH = $wheelHash
    $downloadCode = "import hashlib, os; from pathlib import Path; from huggingface_hub import hf_hub_download; from model_setup import _setup_progress_options; path=Path(hf_hub_download(repo_id='tonera/vitoom-nunchaku', filename=os.environ['REALITY_RESTYLE_WHEEL_NAME'], revision=os.environ['REALITY_RESTYLE_WHEEL_REVISION'], local_dir=os.environ['REALITY_RESTYLE_WHEEL_DIR'], **_setup_progress_options('RR_WHEEL'))); digest=hashlib.sha256(path.read_bytes()).hexdigest(); assert digest == os.environ['REALITY_RESTYLE_WHEEL_HASH'], 'Runtime wheel checksum mismatch'; print(path)"
    Invoke-CheckedNative -FilePath $python -Arguments @('-c', $downloadCode) -Failure 'Could not download or verify the local runtime.'
    $wheel = Join-Path $wheelDir $wheelName
    Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'install', $wheel) -Failure 'Could not install the local runtime.'
}

Write-SetupStage 6 'Checking installed runtime'
Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'check') -Failure 'The Python environment has incompatible packages.'

if (-not (Test-PythonCode $probe -ShowFailure)) { throw 'The local runtime failed its import check.' }

New-Item -ItemType Directory -Force -Path $runtimeDir, $cacheDir | Out-Null
if (Test-Path -LiteralPath (Join-Path $wheelDir $wheelName)) { Remove-Item -LiteralPath (Join-Path $wheelDir $wheelName) -Force }
Set-Content -LiteralPath $marker -Value $expected -NoNewline
