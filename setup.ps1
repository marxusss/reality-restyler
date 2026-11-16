$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$requirements = Join-Path $root 'requirements.txt'
$runtimeDir = Join-Path $root '.runtime'
$wheelDir = Join-Path $runtimeDir 'wheels'
$marker = Join-Path $runtimeDir 'setup.env'
$requirementsHash = (Get-FileHash -LiteralPath $requirements -Algorithm SHA256).Hash
$setupHash = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash
$wheelName = 'nunchaku-1.4.1+cu13.0torch2.14-cp311-cp311-win_amd64.whl'
$wheelHash = '4cbe71d71c49590728b208ecdb9fc22e405c582def53deb6cca9cd396e598da4'
$wheelRevision = '51c61df1b9369b50b652587dd7c7ce1c985024a5'
$expected = "setup-v2;python=3.11;torch=2.14.1;torchvision=0.29.1;cuda=13.0;nunchaku=1.4.1;wheel=$wheelHash;requirements=$requirementsHash;setup=$setupHash"
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

if ((Test-Path -LiteralPath $python -PathType Leaf) -and (Test-Path -LiteralPath $marker -PathType Leaf) -and (Get-Content -LiteralPath $marker -Raw).Trim() -eq $expected) {
    if (Test-PythonCode $probe) {
        Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'check') -Failure 'The Python environment has incompatible packages.'
        return
    }
}

$rootFull = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$venvFull = [IO.Path]::GetFullPath($venv).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($venvFull -ne (Join-Path $rootFull '.venv')) { throw 'The Python environment path is invalid.' }

$venvValid = Test-Path -LiteralPath $python -PathType Leaf
if ($venvValid) {
    $configurationPath = Join-Path $venv 'pyvenv.cfg'
    if (-not (Test-Path -LiteralPath $configurationPath -PathType Leaf)) {
        $venvValid = $false
    } else {
        $configuration = Get-Content -LiteralPath $configurationPath -Raw
        if ($configuration -match '(?m)^include-system-site-packages\s*=\s*true\s*$') { $venvValid = $false }
        if ($venvValid -and -not (Test-PythonCode "import sys; assert sys.version_info[:2] == (3, 11)")) { $venvValid = $false }
    }
}

if (-not $venvValid) {
    if (Test-Path -LiteralPath $venv) { Remove-Item -LiteralPath $venv -Recurse -Force }
    $launcher = Get-Command py -ErrorAction Stop
    Invoke-CheckedNative -FilePath $launcher.Source -Arguments @('-3.11', '-m', 'venv', $venv) -Failure 'Could not create the Python 3.11 environment.'
    $python = Join-Path $venv 'Scripts\python.exe'
}

Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'install', '--upgrade', 'pip') -Failure 'Could not update pip.'

$torchProbe = "import importlib.metadata as m, torch, torchvision; assert m.version('torch').split('+')[0] == '2.14.1'; assert m.version('torchvision').split('+')[0] == '0.29.1'; assert torch.version.cuda == '13.0'"
if (-not (Test-PythonCode $torchProbe)) {
    Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'install', '--upgrade', '--force-reinstall', 'torch==2.14.1', 'torchvision==0.29.1', '--index-url', 'https://download.pytorch.org/whl/cu130') -Failure 'Could not install the CUDA runtime.'
}

Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'install', '-r', $requirements) -Failure 'Could not install the application dependencies.'

$nunchakuProbe = "import importlib.metadata as m; from nunchaku.models.transformers.transformer_flux2 import NunchakuFlux2Transformer2DModel; assert m.version('nunchaku') == '1.4.1+cu13.0torch2.14'"
if (-not (Test-PythonCode $nunchakuProbe)) {
    $env:REALITY_RESTYLE_WHEEL_DIR = $wheelDir
    $env:REALITY_RESTYLE_WHEEL_NAME = $wheelName
    $env:REALITY_RESTYLE_WHEEL_REVISION = $wheelRevision
    $env:REALITY_RESTYLE_WHEEL_HASH = $wheelHash
    $downloadCode = "import hashlib, os; from pathlib import Path; from huggingface_hub import hf_hub_download; path=Path(hf_hub_download(repo_id='tonera/vitoom-nunchaku', filename=os.environ['REALITY_RESTYLE_WHEEL_NAME'], revision=os.environ['REALITY_RESTYLE_WHEEL_REVISION'], local_dir=os.environ['REALITY_RESTYLE_WHEEL_DIR'])); digest=hashlib.sha256(path.read_bytes()).hexdigest(); assert digest == os.environ['REALITY_RESTYLE_WHEEL_HASH'], 'Runtime wheel checksum mismatch'; print(path)"
    Invoke-CheckedNative -FilePath $python -Arguments @('-c', $downloadCode) -Failure 'Could not download or verify the local runtime.'
    $wheel = Join-Path $wheelDir $wheelName
    Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'install', $wheel) -Failure 'Could not install the local runtime.'
}

Invoke-CheckedNative -FilePath $python -Arguments @('-m', 'pip', 'check') -Failure 'The Python environment has incompatible packages.'

if (-not (Test-PythonCode $probe -ShowFailure)) { throw 'The local runtime failed its import check.' }

New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
if (Test-Path -LiteralPath (Join-Path $wheelDir $wheelName)) { Remove-Item -LiteralPath (Join-Path $wheelDir $wheelName) -Force }
Set-Content -LiteralPath $marker -Value $expected -NoNewline
