param(
    [ValidateSet('Check', 'Install')]
    [string]$Action,
    [string]$SessionPath,
    [string]$VersionTag,
    [int]$LauncherProcessId = 0,
    [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-State {
    param([hashtable]$State)
    $path = Join-Path $SessionPath 'update-state.json'
    $pending = $path + '.tmp'
    $json = $State | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($pending, $json, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($pending, $path, $null) }
    else { [IO.File]::Move($pending, $path) }
}

function Read-UpdateConfig {
    $path = Join-Path $PSScriptRoot 'updates.json'
    $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($config.provider -ne 'github-releases' -or
        $config.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or
        $config.channel -notin @('stable', 'preview') -or
        $config.installer -ne 'RealityRestylingSetup.exe' -or
        $config.checksum -ne 'RealityRestylingSetup.exe.sha256') {
        throw 'The update source configuration is invalid.'
    }
    return $config
}

function Get-VersionValue {
    param([string]$Value)
    $normalized = $Value.Trim()
    if ($normalized.StartsWith('v', [StringComparison]::OrdinalIgnoreCase)) { $normalized = $normalized.Substring(1) }
    if ($normalized -notmatch '^\d+\.\d+\.\d+$') { throw 'The release version is invalid.' }
    return [Version]::Parse($normalized)
}

function Get-AppVersion {
    $path = Join-Path $InstallRoot 'version.txt'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'The installed app version is missing.' }
    return (Get-Content -LiteralPath $path -Raw).Trim()
}

function Test-ReleaseNeeded {
    param([string]$Target, [string]$Current)
    $targetVersion = Get-VersionValue -Value $Target
    $currentVersion = Get-VersionValue -Value $Current
    if ($targetVersion -ne $currentVersion) { return $targetVersion -gt $currentVersion }
    $python = Join-Path $InstallRoot 'python\python.exe'
    $check = Join-Path $InstallRoot 'runtime_cleanup.py'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf) -or -not (Test-Path -LiteralPath $check -PathType Leaf)) { return $true }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $python -B $check --root $InstallRoot --verify-ready *> $null
        return $LASTEXITCODE -ne 0
    } finally { $ErrorActionPreference = $previousPreference }
}

function Get-Release {
    param($Config, [string]$Tag)
    $base = 'https://api.github.com/repos/' + $Config.repository
    if ($Tag) {
        $uri = $base + '/releases/tags/' + [Uri]::EscapeDataString($Tag)
    } elseif ($Config.channel -eq 'preview') {
        $uri = $base + '/releases?per_page=20'
    } else {
        $uri = $base + '/releases/latest'
    }
    $headers = @{
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'RealityRestyling-Updater'
        'X-GitHub-Api-Version' = '2022-11-28'
    }
    $response = Invoke-RestMethod -UseBasicParsing -Uri $uri -Headers $headers -TimeoutSec 15
    if ($Config.channel -eq 'preview' -and -not $Tag) {
        $response = $response | Where-Object { -not $_.draft } | Select-Object -First 1
    }
    if (-not $response -or $response.draft -or ($Config.channel -eq 'stable' -and $response.prerelease)) {
        throw 'No release is available.'
    }
    return $response
}

function Get-ReleaseAssets {
    param($Release, $Config)
    $installer = $Release.assets | Where-Object name -eq $Config.installer | Select-Object -First 1
    $checksum = $Release.assets | Where-Object name -eq $Config.checksum | Select-Object -First 1
    foreach ($asset in @($installer, $checksum)) {
        if (-not $asset) { throw 'The release is missing an update file.' }
        $uri = [Uri]$asset.browser_download_url
        if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com') { throw 'The release update URL is invalid.' }
    }
    return @($installer, $checksum)
}

function Write-ProgressState {
    param([string]$Phase, [long]$Bytes = 0, [long]$Total = 0, [string]$Message = '')
    Write-State @{ phase = $Phase; bytes = $Bytes; total = $Total; message = $Message }
}

function Download-Asset {
    param([string]$Uri, [string]$Destination, [string]$Name, [long]$ExpectedSize, [switch]$ReportProgress)
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.Method = 'GET'
    $request.UserAgent = 'RealityRestyling-Updater'
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $response = $request.GetResponse()
    $total = if ($ExpectedSize -gt 0) { $ExpectedSize } else { [long]$response.ContentLength }
    $source = $response.GetResponseStream()
    $target = [IO.File]::Create($Destination)
    $buffer = New-Object byte[] 65536
    $received = [long]0
    $lastUpdate = [DateTime]::UtcNow
    try {
        while (($count = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $target.Write($buffer, 0, $count)
            $received += $count
            if ($ReportProgress -and ([DateTime]::UtcNow - $lastUpdate).TotalMilliseconds -ge 250) {
                Write-ProgressState -Phase 'downloading' -Bytes $received -Total $total -Message $Name
                $lastUpdate = [DateTime]::UtcNow
            }
        }
    } finally {
        $target.Dispose()
        $source.Dispose()
        $response.Dispose()
    }
    if ($ExpectedSize -gt 0 -and $received -ne $ExpectedSize) { throw 'The update download was incomplete.' }
    if ($ReportProgress) { Write-ProgressState -Phase 'downloading' -Bytes $received -Total $total -Message $Name }
    return $received
}

function Get-SafeSessionPath {
    $full = [IO.Path]::GetFullPath($SessionPath)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
    $leaf = Split-Path -Leaf $full
    if (-not ([IO.Path]::GetDirectoryName($full)).Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
        $leaf -notmatch '^RealityRestyling-Update-[0-9a-f]{32}$') {
        throw 'The update session path is invalid.'
    }
    return $full
}

function Remove-SafeSessionPath {
    $session = Get-SafeSessionPath
    $item = Get-Item -LiteralPath $session -Force -ErrorAction SilentlyContinue
    if ($item -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        Remove-Item -LiteralPath $session -Recurse -Force
    }
}

function Start-UpdatedLauncher {
    $launcher = Join-Path $InstallRoot 'RealityRestyling.exe'
    if (Test-Path -LiteralPath $launcher -PathType Leaf) {
        Start-Process -FilePath $launcher -WorkingDirectory $InstallRoot | Out-Null
    }
}

function Install-Release {
    param($Config)
    if (-not $VersionTag -or $LauncherProcessId -le 0) { throw 'The update request is incomplete.' }
    $session = Get-SafeSessionPath
    $currentVersion = Get-AppVersion
    $release = Get-Release -Config $Config -Tag $VersionTag
    if ($release.tag_name -ne $VersionTag) { throw 'The selected release changed.' }
    if (-not (Test-ReleaseNeeded -Target $release.tag_name -Current $currentVersion)) { throw 'The installed version is already current.' }
    $assets = Get-ReleaseAssets -Release $release -Config $Config
    $installerAsset = $assets[0]
    $checksumAsset = $assets[1]
    $installerPart = Join-Path $session ($Config.installer + '.part')
    $checksumPath = Join-Path $session $Config.checksum
    $installerPath = Join-Path $session $Config.installer

    Write-ProgressState -Phase 'downloading' -Bytes 0 -Total ([long]$installerAsset.size) -Message $Config.installer
    [void](Download-Asset -Uri $installerAsset.browser_download_url -Destination $installerPart -Name $Config.installer -ExpectedSize ([long]$installerAsset.size) -ReportProgress)
    [void](Download-Asset -Uri $checksumAsset.browser_download_url -Destination $checksumPath -Name $Config.checksum -ExpectedSize ([long]$checksumAsset.size))
    $checksumText = Get-Content -LiteralPath $checksumPath -Raw
    if ($checksumText -notmatch '(?m)^([A-Fa-f0-9]{64})\s+\*?RealityRestylingSetup\.exe\s*$') { throw 'The update checksum file is invalid.' }
    $expectedHash = $Matches[1].ToLowerInvariant()
    $actualHash = (Get-FileHash -LiteralPath $installerPart -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw 'The update checksum did not match.' }
    Move-Item -LiteralPath $installerPart -Destination $installerPath -Force
    Write-ProgressState -Phase 'ready' -Bytes ([long]$installerAsset.size) -Total ([long]$installerAsset.size) -Message $release.tag_name

    while (Get-Process -Id $LauncherProcessId -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }

    Write-ProgressState -Phase 'installing' -Bytes ([long]$installerAsset.size) -Total ([long]$installerAsset.size) -Message $release.tag_name
    $setup = Start-Process -FilePath $installerPath -ArgumentList '/SILENT /NORESTART /SP- /CLOSEAPPLICATIONS' -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "Setup exited with code $($setup.ExitCode)." }
    if (Test-ReleaseNeeded -Target $release.tag_name -Current (Get-AppVersion)) { throw 'Setup did not finish repairing the app.' }
    Write-ProgressState -Phase 'complete' -Message $release.tag_name
    Start-UpdatedLauncher
    Remove-SafeSessionPath
}

try {
    $SessionPath = Get-SafeSessionPath
    [void][IO.Directory]::CreateDirectory($SessionPath)
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $config = Read-UpdateConfig
    if ($Action -eq 'Check') {
        try {
            $current = Get-AppVersion
            $release = Get-Release -Config $config
            $available = Test-ReleaseNeeded -Target $release.tag_name -Current $current
            $assets = if ($available) { Get-ReleaseAssets -Release $release -Config $config }
            Write-State @{
                phase = 'checked'
                updateAvailable = [bool]$available
                currentVersion = $current
                version = if ($available) { $release.tag_name -replace '^[vV]', '' } else { '' }
                tag = if ($available) { $release.tag_name } else { '' }
            }
        } catch {
            Write-State @{ phase = 'unavailable'; updateAvailable = $false }
        }
    } else {
        Install-Release -Config $config
    }
} catch {
    $message = $_.Exception.Message
    if (-not $message) { $message = 'The update could not be completed.' }
    try { Write-State @{ phase = 'failed'; message = $message } } catch { }
    if ($Action -eq 'Install') {
        if (-not (Get-Process -Id $LauncherProcessId -ErrorAction SilentlyContinue)) {
            Add-Type -AssemblyName System.Windows.Forms
            [Windows.Forms.MessageBox]::Show($message, 'Reality Restyling update', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
            Start-UpdatedLauncher
            Remove-SafeSessionPath
        }
    }
    exit 1
}
