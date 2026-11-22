param(
    [ValidateSet('existing', 'download', 'later')][string]$ModelMode = 'later',
    [string]$ModelsPath,
    [ValidateSet('spanv2x4', 'compact2x')][string]$UpscalerId = 'spanv2x4',
    [switch]$InstallTailscale
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$root = $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$logDir = Join-Path $runtimeDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& (Join-Path $root 'python\python.exe') -B (Join-Path $root 'log_retention.py') --prune
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + $PID
$script:logSequence = 0
$script:logPath = $null
$script:errorPath = $null
$pending = Join-Path $runtimeDir 'setup.pending'
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Reality Restyling Setup'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ClientSize = [Drawing.Size]::new(560, 256)
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
$form.Font = [Drawing.Font]::new('Segoe UI', 10)
$form.BackColor = [Drawing.Color]::White
$title = [System.Windows.Forms.Label]::new()
$title.SetBounds(24, 18, 512, 42)
$title.Font = [Drawing.Font]::new('Segoe UI', 20, [Drawing.FontStyle]::Bold)
$title.Text = 'Reality Restyling'
$stepLabel = [System.Windows.Forms.Label]::new()
$stepLabel.SetBounds(24, 72, 512, 22)
$stepLabel.ForeColor = [Drawing.Color]::DimGray
$label = [System.Windows.Forms.Label]::new()
$label.SetBounds(24, 96, 512, 28)
$label.Text = 'Preparing setup'
$bar = [System.Windows.Forms.ProgressBar]::new()
$bar.SetBounds(24, 129, 512, 14)
$bar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
$bar.Maximum = 8 + [int]$InstallTailscale.IsPresent
$detail = [System.Windows.Forms.Label]::new()
$detail.SetBounds(24, 154, 512, 24)
$detail.ForeColor = [Drawing.Color]::DimGray
$transfer = [System.Windows.Forms.ProgressBar]::new()
$transfer.SetBounds(24, 183, 512, 8)
$transfer.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
$transfer.Maximum = 100
$transfer.Visible = $false
$elapsedLabel = [System.Windows.Forms.Label]::new()
$elapsedLabel.SetBounds(24, 220, 280, 24)
$elapsedLabel.ForeColor = [Drawing.Color]::DimGray
$cancelButton = [System.Windows.Forms.Button]::new()
$cancelButton.Text = 'Cancel'
$cancelButton.SetBounds(424, 210, 112, 32)
$cancelButton.Add_Click({ $form.Close() })
$form.Controls.AddRange(@($title, $stepLabel, $label, $bar, $detail, $transfer, $elapsedLabel, $cancelButton))
$form.CancelButton = $cancelButton
$clock = [Diagnostics.Stopwatch]::StartNew()
$script:step = 1
$script:sample = $null
$env:REALITY_RESTYLE_INSTALL_PROGRESS = '1'
$env:PYTHONUNBUFFERED = '1'
$script:activeProcess = $null
$script:cancelRequested = $false
$script:allowClose = $false
$script:setupStarted = $false
$script:cleanupBlocked = $false
$form.Add_FormClosing({ param($sender, $event)
    if (-not $script:allowClose) {
        $event.Cancel = $true
        $script:cancelRequested = $true
        $cancelButton.Enabled = $false
        $label.Text = 'Canceling setup'
        $detail.Text = ''
        $transfer.Visible = $false
    }
})
$form.Show()
[System.Windows.Forms.Application]::DoEvents()

# Advisory only: no GPU model whitelist and no hard install restriction.
$hardwareResult = $null
try {
    $hardwareOutput = & (Join-Path $root 'python\python.exe') -B (Join-Path $root 'hardware_check.py')
    $hardwareResult = $hardwareOutput | ConvertFrom-Json
} catch { }
if (-not $hardwareResult) {
    $hardwareResult = @{ status = 'unknown'; message = 'Could not determine NVIDIA GPU compatibility.' }
}
if ($hardwareResult.status -ne 'ready') {
    $answer = [Windows.Forms.MessageBox]::Show(
        $form, "$($hardwareResult.message)`n`nContinue setup?",
        'GPU compatibility', [Windows.Forms.MessageBoxButtons]::YesNo,
        [Windows.Forms.MessageBoxIcon]::Warning)
    if ($answer -ne [Windows.Forms.DialogResult]::Yes) {
        $script:cancelRequested = $true
    }
}


function Format-Elapsed {
    param([double]$Seconds)
    $span = [TimeSpan]::FromSeconds([math]::Ceiling($Seconds))
    return '{0:D2}:{1:D2}' -f [int][math]::Floor($span.TotalMinutes), $span.Seconds
}

function Reset-Transfer {
    $script:sample = $null
    $transfer.Visible = $false
    $detail.Text = ''
}

function Set-Step {
    param([int]$Number, [string]$Text)
    $script:step = $Number
    $stepLabel.Text = "Step $Number of $($bar.Maximum)"
    $bar.Value = $Number - 1
    $label.Text = $Text
    Reset-Transfer
    $form.Refresh()
    if ($script:cancelRequested) { throw 'Setup canceled.' }
}

function Update-Transfer {
    param([long]$Bytes, [long]$Total, [string]$Activity)
    $now = $clock.Elapsed.TotalSeconds
    if (-not $script:sample -or $Total -ne $script:sample.Total -or $Bytes -lt $script:sample.Bytes) {
        $script:sample = @{ First = $now; Initial = $Bytes; Last = $now; Bytes = $Bytes; Total = $Total }
    }
    if ($Bytes -gt $script:sample.Bytes) { $script:sample.Last = $now }
    $script:sample.Bytes = $Bytes
    $script:sample.Activity = $Activity
}

function Update-ProgressView {
    $now = $clock.Elapsed.TotalSeconds
    $elapsedLabel.Text = 'Elapsed  ' + (Format-Elapsed $now)
    if (-not $script:sample) { return }
    $sample = $script:sample
    $bytes = $sample.Bytes
    $total = $sample.Total
    $detail.Text = '{0}  {1:N1} MB' -f $sample.Activity, ($bytes / 1000000)
    if ($total -le 0) { return }
    $transfer.Value = [int][math]::Min(100, [math]::Floor(100 * $bytes / $total))
    $transfer.Visible = $true
    $detail.Text = '{0}  {1}%  ({2:N1} / {3:N1} MB)' -f $sample.Activity, ([int][math]::Min(100, [math]::Floor(100 * $bytes / $total))), ($bytes / 1000000), ($total / 1000000)
    $duration = $sample.Last - $sample.First
    if ($bytes -ge $total) {
        $detail.Text += '  -  Finishing'
    } elseif ($now - $sample.Last -ge 6) {
        $detail.Text += '  -  Waiting for data'
    } elseif ($duration -ge 3 -and $bytes -gt $sample.Initial) {
        $seconds = ($total - $bytes) * $duration / ($bytes - $sample.Initial)
        $detail.Text += '  -  About ' + (Format-Elapsed $seconds) + ' left for this transfer'
    }
}

function Read-ChildProgress {
    param([IO.StreamReader]$Reader)
    while (-not $Reader.EndOfStream) {
        $line = $Reader.ReadLine()
        if ($line -match '^RR_STAGE ([1-6]) (.+)$' -and $script:step -le 6) {
            Set-Step -Number ([int]$Matches[1]) -Text $Matches[2]
        } elseif ($line -match '^Progress (\d+) of (\d+)$') {
            Update-Transfer ([long]$Matches[1]) ([long]$Matches[2]) 'Downloading'
        } elseif ($line -match '^RR_WHEEL (\d+) of (\d+)$') {
            Update-Transfer ([long]$Matches[1]) ([long]$Matches[2]) 'Downloading AI engine'
        } elseif ($line -match '^RR_MODEL (\d+) of (\d+)$') {
            Update-Transfer ([long]$Matches[1]) ([long]$Matches[2]) 'Model files'
        } elseif ($line -match '^(Downloading |Using cached |Installing collected packages:|Successfully installed )') {
            Reset-Transfer
            if ($line.StartsWith('Downloading ')) { $detail.Text = 'Downloading package files' }
            if ($line.StartsWith('Using cached ')) { $detail.Text = 'Using app-local cached package files' }
            if ($line.StartsWith('Installing collected packages:')) { $detail.Text = 'Installing downloaded packages' }
        }
    }
}

function Invoke-Child {
    param([string]$FilePath, [string]$Arguments, [int]$Number, [string]$Step)
    if ($script:cancelRequested) { throw 'Setup canceled.' }
    Set-Step -Number $Number -Text $Step
    $script:logSequence++
    $script:logPath = Join-Path $logDir "install-$stamp-$script:logSequence.log"
    $script:errorPath = Join-Path $logDir "install-$stamp-$script:logSequence-error.log"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath
    $script:activeProcess = $process
    $stream = [IO.File]::Open($logPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8)
    try {
        while (-not $process.HasExited) {
            [System.Windows.Forms.Application]::DoEvents()
            if ($script:cancelRequested) {
                if (-not $process.HasExited) {
                    $killArguments = '/PID ' + $process.Id + ' /T /F'
                    $kill = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') -ArgumentList $killArguments -WindowStyle Hidden -PassThru -Wait
                    $script:cleanupBlocked = -not $process.WaitForExit(5000)
                    if ($kill.ExitCode -ne 0 -and -not $process.HasExited) { $script:cleanupBlocked = $true }
                }
                throw 'Setup canceled.'
            }
            Read-ChildProgress $reader
            Update-ProgressView
            Start-Sleep -Milliseconds 150
            $process.Refresh()
        }
        $process.WaitForExit()
        $process.Refresh()
    } finally {
        $reader.Dispose()
        $script:activeProcess = $null
    }
    if ($script:cancelRequested) { throw 'Setup canceled.' }
    return [int]$process.ExitCode
}

function Quote-Argument {
    param([string]$Value)
    return '"' + [regex]::Replace($Value.Replace('"', '\"'), '\\+$', '$0$0') + '"'
}

function Invoke-ModelTool {
    param([string[]]$Arguments, [int]$Number, [string]$Step)
    $python = Join-Path $root '.venv\Scripts\python.exe'
    $script = Join-Path $root 'model_setup.py'
    $argumentLine = (Quote-Argument $script) + ' --root ' + (Quote-Argument $ModelsPath) + ' --upscaler-id ' + $UpscalerId + ' ' + ($Arguments -join ' ') + ' --non-interactive-auth'
    return Invoke-Child -FilePath $python -Arguments $argumentLine -Number $Number -Step $Step
}

function Find-Tailscale {
    $command = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    foreach ($candidate in @(
        (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
        (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return ''
}

function Show-LogError {
    param([string]$Message)
    $choice = [System.Windows.Forms.MessageBox]::Show($Message + "`n`nOpen the setup log?", 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Error)
    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
        if ($logPath -and (Test-Path -LiteralPath $logPath)) { Start-Process notepad.exe -ArgumentList (Quote-Argument $logPath) }
        if ($errorPath -and (Test-Path -LiteralPath $errorPath)) { Start-Process notepad.exe -ArgumentList (Quote-Argument $errorPath) }
    }
}

function Clear-CanceledRuntime {
    if ($script:cleanupBlocked) { throw 'The setup process is still running.' }
    $marker = Join-Path $runtimeDir 'setup.env'
    if (-not (Test-Path -LiteralPath $pending) -and
        (-not $script:setupStarted -or (Test-Path -LiteralPath $marker))) { return }
    $python = Join-Path $root 'python\python.exe'
    $cleanupScript = Join-Path $root 'runtime_cleanup.py'
    $arguments = '-B ' + (Quote-Argument $cleanupScript) + ' --root ' + (Quote-Argument $root) + ' --remove venv --remove cache --remove wheels --remove setup-marker --remove setup-pending'
    $cleanupProcess = Start-Process -FilePath $python -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($cleanupProcess.ExitCode -ne 0) { throw 'The app environment could not be cleared.' }
}

try {
    $ModelsPath = [IO.Path]::GetFullPath($ModelsPath)
    $installRoot = [IO.Path]::GetFullPath($root).TrimEnd([char[]]@('\', '/'))
    if ($ModelsPath.Equals($installRoot, [StringComparison]::OrdinalIgnoreCase) -or $ModelsPath.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Choose a model folder outside the application install folder so uninstalling the app will not remove model files.'
    }
    New-Item -ItemType Directory -Force -Path $ModelsPath | Out-Null
    $modelsPathFile = Join-Path $runtimeDir 'models.path'
    [IO.File]::WriteAllText($modelsPathFile, $ModelsPath, [Text.UTF8Encoding]::new($false))
    $env:REALITY_RESTYLE_MODELS_DIR = $ModelsPath
    $cacheDir = Join-Path $runtimeDir 'cache'
    $env:PIP_CACHE_DIR = Join-Path $cacheDir 'pip'
    $env:HF_HUB_CACHE = Join-Path $cacheDir 'huggingface'

    $setup = Join-Path $root 'setup.ps1'
    $setupArgs = '-NoProfile -ExecutionPolicy Bypass -File ' + (Quote-Argument $setup) + ' -InstallerProgress'
    $script:setupStarted = $true
    $setupExit = Invoke-Child -FilePath 'powershell.exe' -Arguments $setupArgs -Number 1 -Step 'Preparing app environment'
    if ($setupExit -ne 0) { throw 'The local runtime could not be installed.' }
    $python = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'The local runtime setup finished without creating its Python environment.' }

    $modelState = Invoke-ModelTool -Arguments @('--check') -Number 7 -Step 'Checking model files'
    if ($ModelMode -eq 'download' -or ($ModelMode -eq 'existing' -and $modelState -ne 0 -and [System.Windows.Forms.MessageBox]::Show('Some model files are missing. Download the missing files now?', 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question) -eq [System.Windows.Forms.DialogResult]::Yes)) {
        $downloadState = Invoke-ModelTool -Arguments @('--download-required') -Number 7 -Step 'Downloading model files'
        if ($downloadState -ne 0) { throw 'The requested model download did not finish. Open the launcher to resume it.' }
        $modelState = Invoke-ModelTool -Arguments @('--check') -Number 7 -Step 'Verifying model files'
        if ($modelState -ne 0) { throw 'The required model files are still incomplete.' }
    }

    $upscalerState = Invoke-ModelTool -Arguments @('--check-upscaler') -Number 8 -Step 'Checking upscaler'
    if ($upscalerState -ne 0) {
        $upscalerState = Invoke-ModelTool -Arguments @('--download-upscaler') -Number 8 -Step 'Downloading upscaler'
        if ($upscalerState -ne 0) { throw 'The selected upscaler could not be downloaded.' }
    }
    [IO.File]::WriteAllText((Join-Path $runtimeDir 'upscaler-id'), $UpscalerId, [Text.UTF8Encoding]::new($false))

    if ($InstallTailscale) {
        Set-Step -Number 9 -Text 'Checking phone setup'
        $tailscale = Find-Tailscale
        if (-not $tailscale) {
            $winget = Get-Command winget -ErrorAction SilentlyContinue
            if ($winget) {
                $wingetArgs = 'install --id Tailscale.Tailscale --exact --accept-source-agreements --accept-package-agreements'
                $tailscaleExit = Invoke-Child -FilePath $winget.Source -Arguments $wingetArgs -Number 9 -Step 'Installing Tailscale'
                if ($tailscaleExit -ne 0) { Show-LogError 'Tailscale could not be installed.' }
                $tailscale = Find-Tailscale
            }
        }
        if ($tailscale) {
            $env:Path = (Split-Path -Parent $tailscale) + ';' + $env:Path
            $statusOutput = & $tailscale status --json 2>$null
            $status = $null
            try { $status = $statusOutput | ConvertFrom-Json } catch { }
            if (-not $status -or $status.BackendState -ne 'Running') {
                $tailscaleExit = Invoke-Child -FilePath $tailscale -Arguments 'up' -Number 9 -Step 'Opening Tailscale sign-in'
                if ($tailscaleExit -ne 0) { Show-LogError 'Tailscale sign-in did not complete. Open Tailscale and sign in to continue.' }
            }
        } else {
            [System.Windows.Forms.MessageBox]::Show('Install Tailscale to connect a phone. https://tailscale.com/download/windows', 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
    }

    if (-not (Test-Path 'HKCU:\Software\RealityRestyling')) {
        New-Item -Path 'HKCU:\Software\RealityRestyling' -Force | Out-Null
    }
    Set-ItemProperty -Path 'HKCU:\Software\RealityRestyling' -Name 'PhoneAccessEnabled' -Value ([int]$InstallTailscale.IsPresent)

    if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force -ErrorAction Stop }
    Reset-Transfer
    $bar.Value = $bar.Maximum
    $label.Text = if ($modelState -eq 0) { 'Setup complete. Ready to use.' } else { 'Installed. Model files required before use.' }
    $form.Refresh()
    $script:allowClose = $true
    Start-Sleep -Milliseconds 500
    $form.Close()
} catch {
    if ($script:cancelRequested) {
        $message = 'Setup canceled.'
        try {
            $label.Text = 'Cleaning up setup'
            $form.Refresh()
            Clear-CanceledRuntime
        } catch {
            $message += "`n" + $_.Exception.Message
        }
        $script:allowClose = $true
        $form.Close()
        [System.Windows.Forms.MessageBox]::Show($message, 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        exit 130
    }
    $script:allowClose = $true
    $form.Close()
    Show-LogError ($_.Exception.Message + "`nThe local runtime is not ready. Run setup again to retry.")
    exit 1
}

exit 0
