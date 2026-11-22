param([switch]$PhoneStartup, [switch]$FirstLaunch)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

Add-Type -TypeDefinition @"
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
public class RestylePanel : Panel {
    public int Radius = 18;
    protected override void OnResize(System.EventArgs e) {
        base.OnResize(e);
        if (Width < Radius || Height < Radius) return;
        using (var path = new GraphicsPath()) {
            int d = Radius * 2;
            path.AddArc(0, 0, d, d, 180, 90);
            path.AddArc(Width-d, 0, d, d, 270, 90);
            path.AddArc(Width-d, Height-d, d, d, 0, 90);
            path.AddArc(0, Height-d, d, d, 90, 90);
            path.CloseFigure();
            var old = Region;
            Region = new Region(path);
            if (old != null) old.Dispose();
        }
    }
}
public class RestyleSegment : RadioButton {
    protected override void OnResize(System.EventArgs e) {
        base.OnResize(e);
        if (Width < 20 || Height < 20) return;
        using (var path = new GraphicsPath()) {
            path.AddArc(0,0,16,16,180,90); path.AddArc(Width-16,0,16,16,270,90);
            path.AddArc(Width-16,Height-16,16,16,0,90); path.AddArc(0,Height-16,16,16,90,90);
            path.CloseFigure(); var old = Region; Region = new Region(path); if (old != null) old.Dispose();
        }
    }
}
public class RestyleButton : Button {
    public RestyleButton() { FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; Cursor = Cursors.Hand; }
    protected override void OnResize(System.EventArgs e) {
        base.OnResize(e);
        if (Width < 24 || Height < 24) return;
        using (var path = new GraphicsPath()) {
            path.AddArc(0,0,20,20,180,90); path.AddArc(Width-20,0,20,20,270,90);
            path.AddArc(Width-20,Height-20,20,20,0,90); path.AddArc(0,Height-20,20,20,90,90);
            path.CloseFigure(); var old = Region; Region = new Region(path); if (old != null) old.Dispose();
        }
    }
}
public static class RestyleProcess {
    public static Process StartLogged(ProcessStartInfo info, string output, string error) {
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        var process = Process.Start(info);
        Task.WhenAll(
            CopyLog(process.StandardOutput.BaseStream, output),
            CopyLog(process.StandardError.BaseStream, error)
        ).ContinueWith(task => System.Console.Error.WriteLine(task.Exception), TaskContinuationOptions.OnlyOnFaulted);
        return process;
    }

    private static async Task CopyLog(Stream source, string path) {
        using (source)
        using (var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1, true)) {
            await source.CopyToAsync(file).ConfigureAwait(false);
        }
    }
}
"@ -ReferencedAssemblies System,System.Windows.Forms,System.Drawing

$showLauncherEvent = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::AutoReset, 'Local\RealityRestylingShowLauncher')
$launcherMutex = [Threading.Mutex]::new($false, 'Local\RealityRestylingLauncher')
$ownsLauncherMutex = $false
try { $ownsLauncherMutex = $launcherMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $ownsLauncherMutex = $true }
if (-not $ownsLauncherMutex) {
    if (-not $PhoneStartup) { [void]$showLauncherEvent.Set() }
    $launcherMutex.Dispose()
    $showLauncherEvent.Dispose()
    exit 0
}

function New-BackgroundProcessInfo([string]$FilePath, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($FilePath, ($Arguments -join ' '))
    $info.WorkingDirectory = $PSScriptRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    return $info
}

$background = [Drawing.ColorTranslator]::FromHtml('#F2F1ED')
$surface = [Drawing.ColorTranslator]::FromHtml('#FFFFFF')
$foreground = [Drawing.ColorTranslator]::FromHtml('#202D2A')
$muted = [Drawing.ColorTranslator]::FromHtml('#6B7772')
$accent = [Drawing.ColorTranslator]::FromHtml('#176B57')
$soft = [Drawing.ColorTranslator]::FromHtml('#E4EBE6')

$window = [Windows.Forms.Form]::new()
$window.Text = 'Reality Restyling'
$window.StartPosition = 'CenterScreen'
$window.FormBorderStyle = 'FixedSingle'
$window.MaximizeBox = $false
$window.BackColor = $background
$window.ForeColor = $foreground
$window.Font = [Drawing.Font]::new('Segoe UI', 10)
$window.AutoScaleDimensions = [Drawing.SizeF]::new(96, 96)
$window.AutoScaleMode = 'Dpi'
$window.ClientSize = [Drawing.Size]::new(500, 230)
$application = [Windows.Forms.ApplicationContext]::new()
$tray = [Windows.Forms.NotifyIcon]::new()
$tray.Icon = [Drawing.SystemIcons]::Application
$tray.Text = $window.Text
$trayMenu = [Windows.Forms.ContextMenuStrip]::new()
$openLauncher = $trayMenu.Items.Add('Open launcher')
$quitLauncher = $trayMenu.Items.Add('Quit')
$tray.ContextMenuStrip = $trayMenu

function Add-Control($Parent, $Type, $Text, $X, $Y, $Width, $Height) {
    $control = switch ($Type) {
        'Panel' { [RestylePanel]::new() }
        'Button' { [RestyleButton]::new() }
        'RadioButton' { [RestyleSegment]::new() }
        default { New-Object "System.Windows.Forms.$Type" }
    }
    $control.Text = $Text
    $control.SetBounds($X, $Y, $Width, $Height)
    if ($Type -eq 'Panel') { $control.BackColor = $surface }
    if ($Type -eq 'Button') { $control.BackColor = $soft; $control.ForeColor = $foreground }
    if ($Type -eq 'TextBox') {
        $control.ReadOnly = $true
        $control.BorderStyle = 'None'
        $control.BackColor = $surface
        $control.ForeColor = $muted
    }
    $Parent.Controls.Add($control)
    return $control
}

$mode = Add-Control $window Panel '' 24 22 452 48
$mode.BackColor = $soft
$mode.Radius = 12
$phone = Add-Control $mode CheckBox 'Phone access' 18 8 200 32
$phone.AutoSize = $true
$phone.BackColor = $soft
$phone.Font = [Drawing.Font]::new('Segoe UI Semibold', 11)
$phoneStatus = Add-Control $mode Label 'Disabled' 200 12 123 25
$phoneStatus.TextAlign = 'MiddleRight'
$phoneStatus.ForeColor = $muted
$phoneSetup = Add-Control $mode Button 'Set up' 344 8 94 32
$phoneSetup.Visible = $false
$storedPhoneMode = (Get-ItemProperty -LiteralPath 'HKCU:\Software\RealityRestyling' -Name PhoneAccessEnabled -ErrorAction SilentlyContinue).PhoneAccessEnabled
$phone.Checked = $storedPhoneMode -eq 1

$statusCard = Add-Control $window Panel '' 24 88 452 118
$statusTitle = Add-Control $statusCard Label '' 18 16 416 27
$statusTitle.Font = [Drawing.Font]::new('Segoe UI Semibold', 13)
$statusDetail = Add-Control $statusCard Label '' 18 49 416 42
$statusDetail.ForeColor = $muted
$statusDetail.AutoEllipsis = $true
$start = Add-Control $statusCard Button '&Start server' 18 58 194 42
$start.BackColor = $accent
$start.ForeColor = [Drawing.Color]::White
$stop = Add-Control $statusCard Button 'S&top server' 18 58 194 42
$log = Add-Control $statusCard Button 'View &logs' 222 58 212 42
$log.Enabled = $false

$desktopCard = Add-Control $window Panel '' 24 222 452 134
$desktopCard.Visible = $false
$desktopLabel = Add-Control $desktopCard Label 'Desktop link' 18 16 416 24
$desktopUrl = Add-Control $desktopCard TextBox '' 18 46 416 26
$desktopUrl.AccessibleName = 'Desktop URL'
$open = Add-Control $desktopCard Button '&Open app' 18 78 194 40
$open.BackColor = $accent
$open.ForeColor = [Drawing.Color]::White
$copyDesktop = Add-Control $desktopCard Button '&Copy link' 222 78 212 40

$phoneCard = Add-Control $window Panel '' 24 372 452 148
$phoneCard.Visible = $false
$phoneLabel = Add-Control $phoneCard Label 'Phone link' 18 16 270 24
$phoneLabel.Font = [Drawing.Font]::new('Segoe UI Semibold', 11)
$phoneUrl = Add-Control $phoneCard TextBox '' 18 48 270 26
$phoneUrl.AccessibleName = 'Phone URL'
$copyPhone = Add-Control $phoneCard Button 'Copy phone &link' 18 90 270 40
$qr = Add-Control $phoneCard PictureBox '' 314 14 120 120
$qr.SizeMode = 'Zoom'
$qr.AccessibleName = 'Phone access QR code'

$startupCheck = Add-Control $window CheckBox 'Start with Windows' 24 0 260 24
$startupCheck.BackColor = $background
$startupCheck.ForeColor = $foreground
$startupCheck.AutoSize = $true

$autoUnloadLabel = Add-Control $window Label 'Auto-unload after' 24 0 177 24
$autoUnloadInput = Add-Control $window NumericUpDown '' 208 0 86 26
$autoUnloadInput.Minimum = 5
$autoUnloadInput.Maximum = 3600
$autoUnloadInput.Increment = 5
$autoUnloadInput.Value = 30
$autoUnloadInput.AccessibleName = 'Auto-unload after seconds'
$autoUnloadUnit = Add-Control $window Label 'seconds' 303 0 105 24
$autoUnloadUnit.ForeColor = $muted
$autoUnloadHint = [Windows.Forms.ToolTip]::new()
$autoUnloadHint.SetToolTip($autoUnloadInput, 'The change applies the next time the server starts.')
$cpuOffloadCheck = Add-Control $window CheckBox 'CPU offload when VRAM is low' 24 0 420 24
$cpuOffloadCheck.BackColor = $background
$cpuOffloadCheck.ForeColor = $foreground
$cpuOffloadCheck.AutoSize = $true
$cpuOffloadHint = [Windows.Forms.ToolTip]::new()
$cpuOffloadHint.SetToolTip($cpuOffloadCheck, 'The change applies the next time the server starts.')

$autoUnloadDir = Join-Path $env:LOCALAPPDATA 'Reality Restyling'
$autoUnloadPath = Join-Path $autoUnloadDir 'launcher-settings.json'
$savedCpuOffload = $false
try {
    if (Test-Path -LiteralPath $autoUnloadPath -PathType Leaf) {
        $saved = Get-Content -LiteralPath $autoUnloadPath -Raw | ConvertFrom-Json
        $savedSeconds = 0
        if ([int]::TryParse([string]$saved.autoUnloadSeconds, [ref]$savedSeconds) -and
            $savedSeconds -ge 5 -and $savedSeconds -le 3600) {
            $autoUnloadInput.Value = $savedSeconds
        }
        if ($saved.PSObject.Properties.Name -contains 'cpuOffloadWhenLow' -and
            $saved.cpuOffloadWhenLow -is [bool]) {
            $savedCpuOffload = $saved.cpuOffloadWhenLow
        }
    }
} catch {
    # Invalid configuration falls back to the existing 30-second default.
}
$cpuOffloadCheck.Checked = $savedCpuOffload
function Save-LauncherSettings {
    try {
        [void][IO.Directory]::CreateDirectory($autoUnloadDir)
        $json = @{
            autoUnloadSeconds = [int]$autoUnloadInput.Value
            cpuOffloadWhenLow = [bool]$cpuOffloadCheck.Checked
        } | ConvertTo-Json -Compress
        $temporary = $autoUnloadPath + '.tmp'
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $autoUnloadPath) {
            [IO.File]::Replace($temporary, $autoUnloadPath, $null)
        } else {
            [IO.File]::Move($temporary, $autoUnloadPath)
        }
    } catch {
        [Windows.Forms.MessageBox]::Show($window, 'Could not save the launcher settings.', 'Reality Restyling', 'OK', 'Warning') | Out-Null
    }
}
$autoUnloadInput.Add_ValueChanged({ Save-LauncherSettings })
$cpuOffloadCheck.Add_CheckedChanged({ Save-LauncherSettings })

$startupKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startupValueName = 'RealityRestylingPhoneAccess'
$startupCommand = '"' + (Join-Path $PSScriptRoot 'RealityRestyling.exe') + '" --phone-startup'
$startupApprovalKeyPath = 'HKCU:\Software\RealityRestyling'
$startupApprovalValueName = 'PhoneStartupApprovedHostname'
$phoneApprovalValueName = 'PhoneAccessApprovedHostname'
$startupValue = (Get-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -ErrorAction SilentlyContinue).$startupValueName
$startupCheck.Checked = $startupValue -eq $startupCommand

function Get-PhoneAccessApproval {
    $value = (Get-ItemProperty -LiteralPath $startupApprovalKeyPath -Name $phoneApprovalValueName -ErrorAction SilentlyContinue).$phoneApprovalValueName
    return ([string]$value).TrimEnd([char[]]@('.'))
}

function Get-PhoneStartupApproval {
    $value = (Get-ItemProperty -LiteralPath $startupApprovalKeyPath -Name $startupApprovalValueName -ErrorAction SilentlyContinue).$startupApprovalValueName
    if ($value) { return ([string]$value).TrimEnd([char[]]@('.')).ToLowerInvariant() }
    return ''
}

function Clear-PhoneStartupApproval {
    $value = (Get-ItemProperty -LiteralPath $startupApprovalKeyPath -Name $startupApprovalValueName -ErrorAction SilentlyContinue).$startupApprovalValueName
    if ($value) { Remove-ItemProperty -LiteralPath $startupApprovalKeyPath -Name $startupApprovalValueName -ErrorAction Stop }
}

function Find-TailscaleExecutable {
    $tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
    if (-not $tailscale) {
        foreach ($candidate in @((Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'), (Join-Path $env:LOCALAPPDATA 'Tailscale\tailscale.exe'))) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { $tailscale = $candidate; break }
        }
    }
    return $tailscale
}

function Get-TailscaleDnsName {
    $tailscale = Find-TailscaleExecutable
    if (-not $tailscale) { return '' }
    try {
        $info = New-BackgroundProcessInfo $tailscale @('status', '--json')
        $info.RedirectStandardOutput = $true
        $process = [Diagnostics.Process]::Start($info)
        try {
            $output = $process.StandardOutput.ReadToEndAsync()
            if (-not $process.WaitForExit(5000)) { $process.Kill(); return '' }
            if ($process.ExitCode -ne 0) { return '' }
            $status = $output.GetAwaiter().GetResult() | ConvertFrom-Json
        } finally { $process.Dispose() }
        if ($status.BackendState -ne 'Running') { return '' }
        $hostname = ([string]$status.Self.DNSName).Trim().TrimEnd([char[]]@('.')).ToLowerInvariant()
        if ($hostname -notmatch '^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$') { return '' }
        return $hostname
    } catch { return '' }
}

$logDirectory = Join-Path $PSScriptRoot '.runtime\logs'
[void][IO.Directory]::CreateDirectory($logDirectory)
$logPython = Join-Path $PSScriptRoot 'python\pythonw.exe'
function Invoke-LogPrune {
    if (Test-Path -LiteralPath $logPython -PathType Leaf) {
        $info = New-BackgroundProcessInfo $logPython @('-B', ('"{0}"' -f (Join-Path $PSScriptRoot 'log_retention.py')), '--prune')
        [Diagnostics.Process]::Start($info).Dispose()
    }
}
Invoke-LogPrune
$logTimer = [Windows.Forms.Timer]::new()
$logTimer.Interval = 3600000
$logTimer.Add_Tick({ Invoke-LogPrune })
$logTimer.Start()
$state = @{ Worker = $null; Directory = $null; StopStarted = $null; Name = 'stopped'; Closing = $false; RestartRequested = $false; PhonePrompted = $false; UpdateWorker = $null; UpdateDirectory = $null; UpdateMode = ''; PendingUpdate = $null; UpdateTag = ''; CheckOnOpen = -not $FirstLaunch; OpenFirstRun = [bool]$FirstLaunch; StartupUpdating = $false; Unattended = $false; StartupFailure = '' }
$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 250

function Show-State($Name, $Heading, $Detail) {
    $state.Name = $Name
    $statusTitle.Text = $Heading
    $statusTitle.ForeColor = if ($Name -eq 'error') { [Drawing.ColorTranslator]::FromHtml('#AB4335') } else { $foreground }
    $statusDetail.Text = $Detail
    $statusDetail.Visible = [bool]$Detail
    $statusCard.Height = if ($Detail) { 164 } else { 118 }
    $actionY = if ($Detail) { 104 } else { 58 }
    foreach ($button in @($start, $stop, $log)) { $button.Top = $actionY }
    $mode.Enabled = $Name -in @('stopped', 'ready', 'error')
    $cpuOffloadCheck.Enabled = $null -eq $state.Worker
    $start.Enabled = $null -eq $state.Worker -and -not $state.Closing
    $start.Text = if ($Name -eq 'error') { '&Try again' } else { '&Start server' }
    $start.Visible = $Name -in @('stopped', 'error')
    $stop.Visible = $Name -in @('starting', 'ready', 'stopping')
    $log.Visible = $log.Enabled
    $stop.Enabled = $Name -in @('starting', 'ready')
    $stop.Text = if ($Name -eq 'starting') { '&Cancel startup' } else { 'S&top server' }
    $open.Enabled = $Name -eq 'ready'
    $copyDesktop.Enabled = $open.Enabled
    $copyPhone.Enabled = $open.Enabled -and [bool]$phoneUrl.Text
    $window.AcceptButton = if ($open.Enabled) { $open } elseif ($start.Enabled) { $start } else { $null }
    $desktopCard.Visible = $open.Enabled
    Sync-PhoneCard
    if (-not $open.Enabled) {
        $desktopUrl.Clear()
        $phoneUrl.Clear()
        if ($qr.Image) {
            $qr.Image.Dispose()
            $qr.Image = $null
        }
    }
}

function Sync-PhoneCard {
    $desktopReady = $state.Name -eq 'ready'
    $phoneReady = $desktopReady -and $phone.Checked -and [bool]$phoneUrl.Text
    $phoneStatus.Text = if (-not $phone.Checked) { 'Disabled' } elseif ($phoneReady) { 'Ready' } elseif ($desktopReady) { 'Setup required' } else { 'Enabled' }
    $phoneStatus.ForeColor = if (-not $phone.Checked) { $muted } elseif ($phoneReady) { $accent } else { [Drawing.ColorTranslator]::FromHtml('#AB7F2A') }
    $phoneSetup.Visible = $phone.Checked -and -not $phoneReady
    $desktopCard.Top = $statusCard.Bottom + 16
    $phoneCard.Visible = $phoneReady
    $phoneCard.Top = if ($desktopReady) { $desktopCard.Bottom + 16 } else { $statusCard.Bottom + 16 }
    $bottom = if ($phoneReady) { $phoneCard.Bottom } elseif ($desktopReady) { $desktopCard.Bottom } else { $statusCard.Bottom }
    $startupCheck.Top = $bottom + 12
    $autoUnloadLabel.Top = $startupCheck.Bottom + 12
    $autoUnloadInput.Top = $autoUnloadLabel.Top
    $autoUnloadUnit.Top = $autoUnloadLabel.Top + 3
    $cpuOffloadCheck.Top = $autoUnloadInput.Bottom + 10
    $window.ClientSize = [Drawing.Size]::new($window.ClientSize.Width, $cpuOffloadCheck.Bottom + 16)
}

function Set-WindowsStartup($Enabled) {
    if ($state.StartupUpdating) { return }
    $state.StartupUpdating = $true
    $createdStartup = $false
    try {
        $current = (Get-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -ErrorAction SilentlyContinue).$startupValueName
        if ($Enabled) {
            if ($current -and $current -ne $startupCommand) {
                $startupCheck.Checked = $false
                [Windows.Forms.MessageBox]::Show($window, 'Another startup entry uses this name.', 'Reality Restyling', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
                return
            }
            $hostname = ''
            if ($phone.Checked) {
                $hostname = Get-TailscaleDnsName
                if (-not $hostname) {
                    $startupCheck.Checked = $false
                    [Windows.Forms.MessageBox]::Show($window, 'Connect Tailscale before enabling phone startup.', 'Reality Restyling', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
                    return
                }
                $question = "Allow phone access at Windows sign-in for this exact Tailscale hostname?`n`n$hostname`n`nThis name may appear in public certificate logs."
                $reply = [Windows.Forms.MessageBox]::Show($window, $question, 'Phone startup approval', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Warning, [Windows.Forms.MessageBoxDefaultButton]::Button2)
                if ($reply -ne [Windows.Forms.DialogResult]::Yes) {
                    $startupCheck.Checked = $false
                    return
                }
            }
            if ($current -ne $startupCommand) {
                if (-not (Test-Path -LiteralPath $startupKeyPath)) {
                    New-Item -Path $startupKeyPath -ErrorAction Stop | Out-Null
                }
                Set-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -Value $startupCommand -ErrorAction Stop
                $createdStartup = $true
            }
            if ($hostname) {
                if (-not (Test-Path -LiteralPath $startupApprovalKeyPath)) {
                    New-Item -Path $startupApprovalKeyPath -ErrorAction Stop | Out-Null
                }
                Set-ItemProperty -LiteralPath $startupApprovalKeyPath -Name $startupApprovalValueName -Value $hostname -ErrorAction Stop
            }
        } else {
            Clear-PhoneStartupApproval
            if ($current -eq $startupCommand) {
                Remove-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -ErrorAction Stop
            }
        }
    } catch {
        if ($Enabled) {
            if ($createdStartup) {
                $after = (Get-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -ErrorAction SilentlyContinue).$startupValueName
                if ($after -eq $startupCommand) { Remove-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -ErrorAction SilentlyContinue }
            }
            try { Clear-PhoneStartupApproval } catch { }
        }
        $startupCheck.Checked = -not [bool]$Enabled
        [Windows.Forms.MessageBox]::Show($window, 'Could not update Windows startup.', 'Reality Restyling', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Error) | Out-Null
    } finally {
        $state.StartupUpdating = $false
    }
    Sync-PhoneCard
}

function Show-Detail($Message) {
    $statusDetail.Text = $Message
    $statusDetail.Visible = $true
    $statusCard.Height = 164
    foreach ($button in @($start, $stop, $log)) { $button.Top = 104 }
    Sync-PhoneCard
}

function Set-ClipboardUrl($Url) {
    try { [Windows.Forms.Clipboard]::SetText($Url) }
    catch { Show-Detail 'Clipboard unavailable. Select the URL and press Ctrl+C to copy it.' }
}

function Request-Stop {
    $state.StopStarted = [DateTime]::UtcNow
    [IO.File]::WriteAllText((Join-Path $state.Directory 'stop'), '')
    Show-State 'stopping' 'Stopping server' 'Waiting for current work to finish and releasing the server.'
}

function Read-JsonFile($Directory, $Name) {
    if (-not $Directory) { return $null }
    $path = Join-Path $Directory $Name
    if (Test-Path -LiteralPath $path) {
        try { return [IO.File]::ReadAllText($path) | ConvertFrom-Json }
        catch [IO.IOException] { return $null }
    }
}

function Read-SessionJson($Name) { return Read-JsonFile $state.Directory $Name }

function Remove-UpdateSession {
    if (-not $state.UpdateDirectory) { return }
    $full = [IO.Path]::GetFullPath($state.UpdateDirectory)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([char[]]@('\', '/'))
    $parent = [IO.Path]::GetDirectoryName($full)
    $leaf = Split-Path -Leaf $full
    if ($parent.Equals($temp, [StringComparison]::OrdinalIgnoreCase) -and $leaf -match '^RealityRestyling-Update-[0-9a-f]{32}$') {
        $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
        if ($item -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $full -Recurse -Force
        }
    }
    $state.UpdateDirectory = $null
}

function Start-UpdateProcess($Action, $Tag = '') {
    $scriptPath = Join-Path $PSScriptRoot 'updater.ps1'
    $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $arguments = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $scriptPath),
        '-Action', $Action, '-SessionPath', ('"{0}"' -f $state.UpdateDirectory),
        '-LauncherProcessId', $PID, '-InstallRoot', ('"{0}"' -f $PSScriptRoot))
    if ($Tag) { $arguments += @('-VersionTag', $Tag) }
    return [Diagnostics.Process]::Start((New-BackgroundProcessInfo $powershell $arguments))
}

function Start-UpdateCheck {
    try {
        $state.UpdateDirectory = Join-Path ([IO.Path]::GetTempPath()) ('RealityRestyling-Update-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($state.UpdateDirectory)
        $state.UpdateMode = 'check'
        $state.UpdateWorker = Start-UpdateProcess -Action 'Check'
    } catch {
        $state.UpdateMode = ''
        $state.UpdateWorker = $null
        Remove-UpdateSession
    }
}

function Start-UpdateInstall {
    try {
        $state.UpdateMode = 'install'
        $state.UpdateWorker = Start-UpdateProcess -Action 'Install' -Tag $state.UpdateTag
        Show-State 'updating' 'Updating app' 'Preparing update'
        $timer.Start()
    } catch {
        $state.UpdateMode = ''
        $state.UpdateWorker = $null
        Remove-UpdateSession
        Show-State 'error' 'Update unavailable' 'Could not start the update.'
    }
}

function Handle-UpdateCheck {
    $worker = $state.UpdateWorker
    $state.UpdateWorker = $null
    $state.UpdateMode = ''
    if ($worker) { $worker.Dispose() }
    $update = Read-JsonFile $state.UpdateDirectory 'update-state.json'
    if ($state.Closing -or -not $update -or -not $update.updateAvailable -or -not $update.tag) {
        Remove-UpdateSession
        return
    }
    $reply = [Windows.Forms.MessageBox]::Show("Version $($update.version) is available. Download and install it?", 'Reality Restyling', [Windows.Forms.MessageBoxButtons]::YesNo, [Windows.Forms.MessageBoxIcon]::Question)
    if ($reply -ne [Windows.Forms.DialogResult]::Yes) {
        Remove-UpdateSession
        return
    }
    $state.UpdateTag = [string]$update.tag
    if ($state.Worker) {
        $state.PendingUpdate = $update
        if ($state.Name -ne 'stopping') { Request-Stop }
    } else {
        Start-UpdateInstall
    }
}

function Start-Server([switch]$Unattended) {
    if ($state.Worker -or $state.Closing) { return }
    try {
        $state.PhonePrompted = $false
        $state.StartupFailure = ''
        $state.StopStarted = $null
        $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + $PID
        $state.Directory = Join-Path ([IO.Path]::GetTempPath()) ('RealityRestyling-Session-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($state.Directory)
        $arguments = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $PSScriptRoot 'run.ps1')),
            '-LauncherSession', ('"{0}"' -f $state.Directory), '-LauncherProcessId', $PID,
            '-AutoUnloadSeconds', [int]$autoUnloadInput.Value)
        $state.Unattended = [bool]$Unattended
        if ($phone.Checked -and (-not $Unattended -or (Get-PhoneStartupApproval))) { $arguments += '-PhoneAccess' }
        if ($state.Unattended) { $arguments += '-Unattended' }
        $powershell = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
        $info = New-BackgroundProcessInfo $powershell $arguments
        $outputLog = Join-Path $logDirectory "launcher-$stamp-output.log"
        $errorLog = Join-Path $logDirectory "launcher-$stamp-error.log"
        $state.Worker = [RestyleProcess]::StartLogged($info, $outputLog, $errorLog)
        $log.Enabled = $true
        Show-State 'starting' 'Starting server' 'Checking the app environment'
        $timer.Start()
    } catch {
        Show-State 'error' 'Could not start the server' $_.Exception.Message
    }
}

function Show-Launcher {
    if ($state.Closing) { return }
    $window.WindowState = 'Normal'
    $window.Show()
    $window.Activate()
    if ($state.CheckOnOpen) {
        $state.CheckOnOpen = $false
        Start-UpdateCheck
    }
}

$start.Add_Click({ Start-Server })
$stop.Add_Click({ Request-Stop })
$open.Add_Click({
    try { Start-Process $desktopUrl.Text }
    catch { Show-Detail 'Could not open the default browser. Copy the desktop URL to open it manually.' }
})
$copyDesktop.Add_Click({ Set-ClipboardUrl $desktopUrl.Text })
$copyPhone.Add_Click({ Set-ClipboardUrl $phoneUrl.Text })
$log.Add_Click({ Start-Process explorer.exe -ArgumentList ('"{0}"' -f $logDirectory) })
$phoneSetup.Add_Click({
    $tailscale = Find-TailscaleExecutable
    try {
        if (-not $tailscale) {
            Start-Process 'https://tailscale.com/download'
        } elseif (-not (Get-TailscaleDnsName)) {
            Start-Process -FilePath $tailscale -ArgumentList 'up'
        } else {
            Start-Process 'https://login.tailscale.com/admin/dns'
        }
    } catch { Show-Detail 'Could not open Tailscale setup.' }
})
$phone.Add_CheckedChanged({
    if (-not $phone.Enabled) { return }
    try {
        if (-not (Test-Path -LiteralPath 'HKCU:\Software\RealityRestyling')) {
            New-Item -Path 'HKCU:\Software\RealityRestyling' -Force -ErrorAction Stop | Out-Null
        }
        Set-ItemProperty -LiteralPath 'HKCU:\Software\RealityRestyling' -Name PhoneAccessEnabled -Value ([int]$phone.Checked) -ErrorAction Stop
    } catch {
        $phone.Enabled = $false
        $phone.Checked = -not $phone.Checked
        $phone.Enabled = $true
        Show-Detail 'Could not save phone access preference.'
        return
    }
    if ($state.Name -eq 'ready') {
        $state.RestartRequested = $true
        Request-Stop
    } else {
        Sync-PhoneCard
    }
})
$startupCheck.Add_CheckedChanged({ Set-WindowsStartup $startupCheck.Checked })
$openLauncher.Add_Click({ Show-Launcher })
$quitLauncher.Add_Click({ $window.Close() })
$tray.Add_MouseClick({
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [Windows.Forms.MouseButtons]::Left) { Show-Launcher }
})
$window.Add_Resize({
    if ($window.WindowState -eq 'Minimized') { $window.Hide() }
})

$timer.Add_Tick({
    if ($showLauncherEvent.WaitOne(0)) { Show-Launcher }
    if ($state.UpdateWorker) {
        try {
            $state.UpdateWorker.Refresh()
            $updateExited = $state.UpdateWorker.HasExited
        } catch { $updateExited = $true }
        $updateState = Read-JsonFile $state.UpdateDirectory 'update-state.json'
        if ($state.UpdateMode -eq 'check' -and $updateExited -and $window.Visible) {
            Handle-UpdateCheck
        } elseif ($state.UpdateMode -eq 'install') {
            if ($updateState -and $updateState.phase -eq 'downloading') {
                if ($updateState.total -gt 0) {
                    $received = [math]::Round($updateState.bytes / 1MB, 1)
                    $total = [math]::Round($updateState.total / 1MB, 1)
                    $statusDetail.Text = "Downloading update: $received / $total MB"
                } else {
                    $statusDetail.Text = 'Downloading update'
                }
            } elseif ($updateState -and $updateState.phase -eq 'ready') {
                $state.Closing = $true
                $timer.Stop()
                $window.Close()
                return
            } elseif ($updateState -and $updateState.phase -eq 'failed') {
                if ($updateExited) {
                    $state.UpdateWorker.Dispose()
                    $state.UpdateWorker = $null
                    $state.UpdateMode = ''
                    $message = if ($updateState.message) { [string]$updateState.message } else { 'The update could not be completed.' }
                    Remove-UpdateSession
                    Show-State 'error' 'Update failed' $message
                    return
                }
            } elseif ($updateExited) {
                $state.UpdateWorker.Dispose()
                $state.UpdateWorker = $null
                $state.UpdateMode = ''
                Remove-UpdateSession
                Show-State 'error' 'Update failed' 'The update could not be completed.'
                return
            }
        }
    }
    if ($state.Worker -and $state.StopStarted -and -not $state.Worker.HasExited -and
        ([DateTime]::UtcNow - $state.StopStarted).TotalSeconds -gt 30) {
        $killArgs = '/PID ' + $state.Worker.Id + ' /T /F'
        $info = New-BackgroundProcessInfo (Join-Path $env:WINDIR 'System32\taskkill.exe') $killArgs
        [Diagnostics.Process]::Start($info).Dispose()
        $state.StopStarted = [DateTime]::UtcNow
    }
    if ($state.Worker -and $state.Worker.HasExited) {
        $exitCode = $null
        try {
            $state.Worker.Refresh()
            $exitCode = [int]$state.Worker.ExitCode
        } catch { }
        $state.Worker.Dispose()
        $state.Worker = $null
        $failure = Read-SessionJson 'error.json'
        # Completed session IPC is separate from persistent logs.
        if ($state.Directory) {
            $item = Get-Item -LiteralPath $state.Directory -Force -ErrorAction SilentlyContinue
            if ($item -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                $known = @('stage.txt', 'stop', 'phone.json', 'phone.json.tmp', 'phone.png', 'phone.approved', 'phone.pending', 'phone-setup.json', 'phone-setup.json.tmp', 'ready.json', 'ready.json.tmp', 'error.json', 'error.json.tmp')
                Get-ChildItem -LiteralPath $state.Directory -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -in $known -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
                    Remove-Item -Force -ErrorAction SilentlyContinue
                if (-not (Get-ChildItem -LiteralPath $state.Directory -Force -ErrorAction SilentlyContinue)) {
                    Remove-Item -LiteralPath $state.Directory -ErrorAction SilentlyContinue
                }
            }
            $state.Directory = $null
        }
        if ($state.Closing) { $window.Close(); return }
        if ($state.PendingUpdate) {
            $state.PendingUpdate = $null
            Start-UpdateInstall
            return
        }
        if ($state.RestartRequested) {
            $state.RestartRequested = $false
            Start-Server
            return
        }
        if ($state.StartupFailure) {
            Show-State 'error' 'Server unavailable' $state.StartupFailure
        } elseif ($state.Name -eq 'stopping' -and $exitCode -eq 0) {
            Show-State 'stopped' 'Server stopped' ''
        } else {
            if ($failure -and $failure.message) {
                $detail = [string]$failure.message
            } elseif ($null -ne $exitCode) {
                $detail = "The server exited (code $exitCode). Open Startup logs for details."
            } else {
                $detail = 'The server stopped unexpectedly. Open Startup logs for details.'
            }
            Show-State 'error' 'Server unavailable' $detail
        }
        return
    }
    if ($state.Name -ne 'starting') { return }
    $stage = Join-Path $state.Directory 'stage.txt'
    if (Test-Path -LiteralPath $stage) {
        try {
            $message = [IO.File]::ReadAllText($stage)
            if ($message) { $statusDetail.Text = $message }
        } catch [IO.IOException] { }
    }
    $consent = Read-SessionJson 'phone.json'
    if ($consent -and -not $state.PhonePrompted) {
        $state.PhonePrompted = $true
        $timer.Stop()
        try {
            $hostname = $consent.hostname
            $savedHostname = Get-PhoneStartupApproval
            $savedPhoneHostname = Get-PhoneAccessApproval
            $currentHostname = ([string]$hostname).TrimEnd([char[]]@('.'))
            if ($savedHostname -and -not [string]::Equals($savedHostname, $currentHostname, [StringComparison]::OrdinalIgnoreCase)) {
                Clear-PhoneStartupApproval
                $savedHostname = ''
            }
            $startupValue = (Get-ItemProperty -LiteralPath $startupKeyPath -Name $startupValueName -ErrorAction SilentlyContinue).$startupValueName
            $autoApprove = $state.Unattended -and ($startupValue -eq $startupCommand) -and $savedHostname -and [string]::Equals($savedHostname, $currentHostname, [StringComparison]::OrdinalIgnoreCase)
            if (-not $autoApprove -and -not $state.Unattended -and $savedPhoneHostname -and [string]::Equals($savedPhoneHostname, $currentHostname, [StringComparison]::OrdinalIgnoreCase)) {
                $autoApprove = $true
            }
            if ($autoApprove) {
                $pending = Join-Path $state.Directory 'phone.pending'
                [IO.File]::WriteAllText($pending, $hostname)
                [IO.File]::Move($pending, (Join-Path $state.Directory 'phone.approved'))
            } elseif ($state.Unattended) {
                $state.StartupFailure = 'Re-enable phone startup to approve the current Tailscale hostname.'
                Request-Stop
            } else {
                $question = @(
                    'Phone access may publish this exact hostname in a permanent public certificate log.',
                    $hostname,
                    'Use a generic Tailscale device name before continuing.',
                    'Enable phone access?'
                ) -join ([Environment]::NewLine * 2)
                $reply = [Windows.Forms.MessageBox]::Show($window, $question, 'Phone access', 'YesNo', 'Warning', 'Button2')
                if ($reply -eq 'Yes') {
                    if (-not (Test-Path -LiteralPath $startupApprovalKeyPath)) { New-Item -Path $startupApprovalKeyPath -Force | Out-Null }
                    Set-ItemProperty -LiteralPath $startupApprovalKeyPath -Name $phoneApprovalValueName -Value $currentHostname
                    $pending = Join-Path $state.Directory 'phone.pending'
                    [IO.File]::WriteAllText($pending, $hostname)
                    [IO.File]::Move($pending, (Join-Path $state.Directory 'phone.approved'))
                } else { Request-Stop }
            }
        } finally { $timer.Start() }
    }
    $ready = Read-SessionJson 'ready.json'
    if ($ready -and $state.Name -eq 'starting') {
        $desktopUrl.Text = $ready.desktop
        $phoneUrl.Text = $ready.phone
        $qrPath = Join-Path $state.Directory 'phone.png'
        if (Test-Path -LiteralPath $qrPath) {
            try {
                $source = [Drawing.Image]::FromFile($qrPath)
                try { $qr.Image = [Drawing.Bitmap]::new($source) } finally { $source.Dispose() }
            } catch { }
        }
        $phoneSetupState = Read-SessionJson 'phone-setup.json'
        $detail = if ($phone.Checked -and $phoneSetupState) {
            if ($phoneSetupState.message -match 'Sign in|local IP') { 'Phone: sign in to Tailscale' }
            else { 'Phone: enable HTTPS in Tailscale' }
        } else { '' }
        Show-State 'ready' 'Server ready' $detail
        if ($window.Visible) { [void]$open.Focus() }
        if ($state.OpenFirstRun) {
            $state.OpenFirstRun = $false
            try { Start-Process $desktopUrl.Text } catch { }
        }
    }
})
$window.Add_FormClosing({
    param($sender, $eventArgs)
    if ($null -eq $state.Worker -or $eventArgs.CloseReason -eq 'WindowsShutDown') { return }
    $eventArgs.Cancel = $true
    $state.Closing = $true
    if ($state.Name -ne 'stopping') { Request-Stop }
})
$window.Add_FormClosed({ $application.ExitThread() })

Show-State 'stopped' 'Server stopped' ''
try {
    [void]$window.Handle
    $tray.Visible = $true
    $timer.Start()
    if ($PhoneStartup) {
        if ($startupCheck.Checked) { Start-Server -Unattended }
    } else {
        Show-Launcher
        if ($FirstLaunch) { Start-Server }
    }
    [Windows.Forms.Application]::Run($application)
}
finally {
    $tray.Dispose()
    $trayMenu.Dispose()
    $timer.Dispose()
    $logTimer.Dispose()
    if ($qr.Image) { $qr.Image.Dispose() }
    $window.Dispose()
    $application.Dispose()
    $showLauncherEvent.Dispose()
    if ($ownsLauncherMutex) { $launcherMutex.ReleaseMutex() }
    $launcherMutex.Dispose()
}
