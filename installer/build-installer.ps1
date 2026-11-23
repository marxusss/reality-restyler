$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$versionPath = Join-Path $root 'version.txt'
$version = (Get-Content -LiteralPath $versionPath -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'version.txt must contain a three-part version.' }
$compiler = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { $compiler = $command.Source }
}
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    $compiler = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
}
if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Inno Setup 6 is required to build the installer.' }

$dist = Join-Path $root 'dist'
$launcherSource = Join-Path $root 'src\launcher_bootstrap.cs'
$launcherExe = Join-Path $dist 'RealityRestylingLauncher.exe'
$pythonCache = Join-Path $dist 'python-20261110'
$pythonArchive = Join-Path $pythonCache 'python.tar.gz'
$pythonDir = Join-Path $pythonCache 'python'
$pythonSha = '5ca7e23bbcc8933a75f4ae9c3a5e5d1ffae5fd143aec9a9d77cf5124cc6e0eef'
New-Item -ItemType Directory -Force -Path $dist, $pythonCache | Out-Null
$csharpCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csharpCompiler -PathType Leaf)) { throw 'The Windows .NET Framework compiler is required to build the launcher.' }
& $csharpCompiler /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll "/out:$launcherExe" $launcherSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherExe -PathType Leaf)) { throw 'Could not build the windowless app launcher.' }
if (-not (Test-Path -LiteralPath $pythonArchive -PathType Leaf) -or
    (Get-FileHash -LiteralPath $pythonArchive -Algorithm SHA256).Hash -ne $pythonSha) {
    $pythonUrl = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.11.18%2B20261110-x86_64-pc-windows-msvc-install_only.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri $pythonUrl -OutFile $pythonArchive
}
if ((Get-FileHash -LiteralPath $pythonArchive -Algorithm SHA256).Hash -ne $pythonSha) {
    throw 'Bundled Python checksum mismatch.'
}
& tar.exe -xzf $pythonArchive -C $pythonCache
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $pythonDir 'python.exe') -PathType Leaf)) {
    throw 'Could not unpack bundled Python.'
}
Push-Location $root
try {
    & $compiler /Qp "/DAppVersion=$version" "/DBundledPythonDir=$pythonDir" "/DLauncherExe=$launcherExe" 'installer\RealityRestyling.iss'
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not compile RealityRestylingSetup.exe.' }
} finally {
    Pop-Location
}

$installer = Join-Path $root 'RealityRestylingSetup.exe'
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($installer + '.sha256', "$hash  RealityRestylingSetup.exe`n", [Text.UTF8Encoding]::new($false))

# Archive exactly the tracked source for the compiled checkout.
$sourceArchive = Join-Path $root 'RealityRestylingSource.zip'
& git -C $root archive --format=zip --output $sourceArchive HEAD
if ($LASTEXITCODE -ne 0) { throw 'Could not archive the corresponding source.' }
