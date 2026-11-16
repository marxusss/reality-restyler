param(
    [ValidateSet('existing', 'download', 'later')][string]$ModelMode = 'later',
    [string]$ModelsPath,
    [switch]$InstallTailscale
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$root = $PSScriptRoot
$runtimeDir = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
$logPath = Join-Path $runtimeDir 'install.log'
$errorPath = Join-Path $runtimeDir 'install-error.log'
$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Reality Restyling Setup'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ControlBox = $true
$form.ClientSize = [Drawing.Size]::new(460, 165)
$label = [System.Windows.Forms.Label]::new()
$label.AutoSize = $false
$label.Location = [Drawing.Point]::new(20, 18)
$label.Size = [Drawing.Size]::new(420, 38)
$label.Text = 'Preparing Reality Restyling...'
$bar = [System.Windows.Forms.ProgressBar]::new()
$bar.Location = [Drawing.Point]::new(20, 76)
$bar.Size = [Drawing.Size]::new(420, 22)
$bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
$bar.MarqueeAnimationSpeed = 24
$cancelButton = [System.Windows.Forms.Button]::new()
$cancelButton.Text = 'Cancel'
$cancelButton.Location = [Drawing.Point]::new(360, 116)
$cancelButton.Size = [Drawing.Size]::new(80, 28)
$cancelButton.Add_Click({ $form.Close() })
$form.Controls.Add($label)
$form.Controls.Add($bar)
$form.Controls.Add($cancelButton)
$script:activeProcess = $null
$script:cancelRequested = $false
$script:completed = $false
$script:allowClose = $false
$form.Add_FormClosing({
    if (-not $script:allowClose) {
        $script:cancelRequested = $true
        if ($script:activeProcess -and -not $script:activeProcess.HasExited) {
            $killArguments = '/PID ' + $script:activeProcess.Id + ' /T /F'
            Start-Process -FilePath (Join-Path $env:WINDIR 'System32\taskkill.exe') -ArgumentList $killArguments -WindowStyle Hidden -Wait
        }
    }
})
$form.Show()
[System.Windows.Forms.Application]::DoEvents()

function Set-Step {
    param([string]$Text)
    $label.Text = $Text
    $form.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
}

function Invoke-Child {
    param([string]$FilePath, [string]$Arguments, [string]$Step)
    Set-Step -Text $Step
    Remove-Item -LiteralPath $logPath, $errorPath -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errorPath
    $script:activeProcess = $process
    while (-not $process.HasExited) {
        [System.Windows.Forms.Application]::DoEvents()
        if ($script:cancelRequested) { return 130 }
        Start-Sleep -Milliseconds 120
        $process.Refresh()
    }
    $script:activeProcess = $null
    return $process.ExitCode
}

function Quote-Argument {
    param([string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-ModelTool {
    param([string[]]$Arguments, [string]$Step)
    $python = Join-Path $root '.venv\Scripts\python.exe'
    $script = Join-Path $root 'model_setup.py'
    $argumentLine = (Quote-Argument $script) + ' --root ' + (Quote-Argument $ModelsPath) + ' ' + ($Arguments -join ' ') + ' --non-interactive-auth'
    return Invoke-Child -FilePath $python -Arguments $argumentLine -Step $Step
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
        if (Test-Path -LiteralPath $logPath) { Start-Process notepad.exe -ArgumentList (Quote-Argument $logPath) }
        if (Test-Path -LiteralPath $errorPath) { Start-Process notepad.exe -ArgumentList (Quote-Argument $errorPath) }
    }
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

    $setup = Join-Path $root 'setup.ps1'
    $setupArgs = '-NoProfile -ExecutionPolicy Bypass -File ' + (Quote-Argument $setup)
    $setupExit = Invoke-Child -FilePath 'powershell.exe' -Arguments $setupArgs -Step 'Installing Python and the local AI runtime...'
    if ($setupExit -ne 0) { throw 'The local runtime could not be installed.' }

    $modelState = Invoke-ModelTool -Arguments @('--check') -Step 'Checking model files...'
    if ($ModelMode -eq 'download' -or ($ModelMode -eq 'existing' -and $modelState -ne 0 -and [System.Windows.Forms.MessageBox]::Show('Some model files are missing. Download the missing files now?', 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question) -eq [System.Windows.Forms.DialogResult]::Yes)) {
        $downloadState = Invoke-ModelTool -Arguments @('--download-required') -Step 'Downloading model files. This can take a while...'
        if ($downloadState -ne 0) { Show-LogError 'The model download did not finish. It can be resumed by running setup again.' }
    }

    $upscalerState = Invoke-ModelTool -Arguments @('--check-upscaler') -Step 'Checking Compact 2x...'
    if ($upscalerState -ne 0) {
        $upscalerState = Invoke-ModelTool -Arguments @('--download-upscaler') -Step 'Downloading Compact 2x...'
        if ($upscalerState -ne 0) { Show-LogError 'Compact 2x could not be downloaded. The app can still run without it.' }
    }

    if ($InstallTailscale) {
        $tailscale = Find-Tailscale
        if (-not $tailscale) {
            $winget = Get-Command winget -ErrorAction SilentlyContinue
            if ($winget) {
                $wingetArgs = 'install --id Tailscale.Tailscale --exact --accept-source-agreements --accept-package-agreements'
                $tailscaleExit = Invoke-Child -FilePath $winget.Source -Arguments $wingetArgs -Step 'Installing Tailscale...'
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
                $tailscaleExit = Invoke-Child -FilePath $tailscale -Arguments 'up' -Step 'Opening Tailscale sign-in...'
                if ($tailscaleExit -ne 0) { Show-LogError 'Tailscale sign-in did not complete. Open Tailscale and sign in to continue.' }
            }
        } else {
            [System.Windows.Forms.MessageBox]::Show('Install Tailscale to connect a phone. https://tailscale.com/download/windows', 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        }
    }

    Set-Step 'Setup complete.'
    $script:completed = $true
    $script:allowClose = $true
    Start-Sleep -Milliseconds 500
    $form.Close()
} catch {
    if ($script:cancelRequested) {
        $script:allowClose = $true
        $form.Close()
        [System.Windows.Forms.MessageBox]::Show('Setup canceled. Run the installer again to resume.', 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
        exit 0
    }
    $script:allowClose = $true
    $form.Close()
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Reality Restyling Setup', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    exit 1
}

exit 0
