Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

Add-Type -TypeDefinition @"
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
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
public static class RestyleWindow {
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr window);
}
"@ -ReferencedAssemblies System.Windows.Forms,System.Drawing

$launcherMutex = [Threading.Mutex]::new($false, 'Local\RealityRestylingLauncher')
$ownsLauncherMutex = $false
try { $ownsLauncherMutex = $launcherMutex.WaitOne(0) }
catch [Threading.AbandonedMutexException] { $ownsLauncherMutex = $true }
if (-not $ownsLauncherMutex) {
    $existing = Get-Process -Name powershell,pwsh -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -ne $PID -and $_.MainWindowTitle -eq 'Reality Restyling' } |
        Select-Object -First 1
    if ($existing -and $existing.MainWindowHandle -ne [IntPtr]::Zero) {
        [void][RestyleWindow]::ShowWindowAsync($existing.MainWindowHandle, 9)
        [void][RestyleWindow]::SetForegroundWindow($existing.MainWindowHandle)
    }
    $launcherMutex.Dispose()
    exit 0
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
$desktop = Add-Control $mode RadioButton '&Desktop' 4 4 222 40
$phone = Add-Control $mode RadioButton '&Phone' 226 4 222 40
foreach ($segment in @($desktop, $phone)) {
    $segment.Appearance = 'Button'
    $segment.FlatStyle = 'Flat'
    $segment.FlatAppearance.BorderSize = 0
    $segment.FlatAppearance.CheckedBackColor = $surface
    $segment.TextAlign = 'MiddleCenter'
    $segment.Cursor = 'Hand'
}
$desktop.Checked = $true

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
$log = Add-Control $statusCard Button 'View &logs' 298 58 136 42
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

$state = @{ Worker = $null; Directory = $null; Name = 'stopped'; Closing = $false; PhonePrompted = $false; UpdateWorker = $null; UpdateDirectory = $null; UpdateMode = ''; PendingUpdate = $null; UpdateTag = '' }
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
    $mode.Enabled = $null -eq $state.Worker
    $start.Enabled = $mode.Enabled -and -not $state.Closing
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
    $desktopCard.Top = $statusCard.Bottom + 16
    $phoneCard.Visible = $state.Name -eq 'ready' -and $phone.Checked -and [bool]$phoneUrl.Text
    $phoneCard.Top = if ($desktopCard.Visible) { $desktopCard.Bottom + 16 } else { $statusCard.Bottom + 16 }
    $bottom = if ($phoneCard.Visible) { $phoneCard.Bottom } elseif ($desktopCard.Visible) { $desktopCard.Bottom } else { $statusCard.Bottom }
    $window.ClientSize = [Drawing.Size]::new($window.ClientSize.Width, $bottom + 24)
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
    return Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden -PassThru
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

$start.Add_Click({
    try {
        $state.PhonePrompted = $false
        $state.Directory = Join-Path ([IO.Path]::GetTempPath()) ('RealityRestyling-' + [guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($state.Directory)
        $arguments = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $PSScriptRoot 'run.ps1')),
            '-LauncherSession', ('"{0}"' -f $state.Directory), '-LauncherProcessId', $PID)
        if ($phone.Checked) { $arguments += '-PhoneAccess' }
        $workerOptions = @{
            FilePath = (Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe')
            ArgumentList = $arguments
            WorkingDirectory = $PSScriptRoot
            WindowStyle = 'Hidden'
            PassThru = $true
            RedirectStandardOutput = (Join-Path $state.Directory 'output.log')
            RedirectStandardError = (Join-Path $state.Directory 'error.log')
        }
        $state.Worker = Start-Process @workerOptions
        $log.Enabled = $true
        Show-State 'starting' 'Starting server' 'Checking the app environment'
        $timer.Start()
    } catch {
        Show-State 'error' 'Could not start the server' $_.Exception.Message
    }
})
$stop.Add_Click({ Request-Stop })
$open.Add_Click({
    try { Start-Process $desktopUrl.Text }
    catch { Show-Detail 'Could not open the default browser. Copy the desktop URL to open it manually.' }
})
$copyDesktop.Add_Click({ Set-ClipboardUrl $desktopUrl.Text })
$copyPhone.Add_Click({ Set-ClipboardUrl $phoneUrl.Text })
$log.Add_Click({ Start-Process explorer.exe -ArgumentList ('"{0}"' -f $state.Directory) })
$phone.Add_CheckedChanged({ Sync-PhoneCard })
$window.Add_Shown({
    Sync-PhoneCard
    $timer.Start()
    Start-UpdateCheck
})

$timer.Add_Tick({
    if ($state.UpdateWorker) {
        try {
            $state.UpdateWorker.Refresh()
            $updateExited = $state.UpdateWorker.HasExited
        } catch { $updateExited = $true }
        $updateState = Read-JsonFile $state.UpdateDirectory 'update-state.json'
        if ($state.UpdateMode -eq 'check' -and $updateExited) {
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
    if ($state.Worker -and $state.Worker.HasExited) {
        $timer.Stop()
        $exitCode = $null
        try {
            $state.Worker.Refresh()
            $exitCode = [int]$state.Worker.ExitCode
        } catch { }
        $state.Worker.Dispose()
        $state.Worker = $null
        if ($state.Closing) { $window.Close(); return }
        if ($state.PendingUpdate) {
            $state.PendingUpdate = $null
            Start-UpdateInstall
            return
        }
        if ($state.Name -eq 'stopping' -and $exitCode -eq 0) {
            Show-State 'stopped' 'Server stopped' ''
        } else {
            $failure = Read-SessionJson 'error.json'
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
            $question = @(
                'Phone access may publish this exact hostname in a permanent public certificate log.',
                $hostname,
                'Use a generic Tailscale device name before continuing.',
                'Enable phone access?'
            ) -join ([Environment]::NewLine * 2)
            $reply = [Windows.Forms.MessageBox]::Show($window, $question, 'Phone access', 'YesNo', 'Warning', 'Button2')
            if ($reply -eq 'Yes') {
                $pending = Join-Path $state.Directory 'phone.pending'
                [IO.File]::WriteAllText($pending, $hostname)
                [IO.File]::Move($pending, (Join-Path $state.Directory 'phone.approved'))
            } else { Request-Stop }
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
        Show-State 'ready' 'Server ready' ''
        $open.Focus()
    }
})
$window.Add_FormClosing({
    param($sender, $eventArgs)
    if ($null -eq $state.Worker) { return }
    $eventArgs.Cancel = $true
    $state.Closing = $true
    if ($state.Name -ne 'stopping') { Request-Stop }
})

Show-State 'stopped' 'Server stopped' ''
try { [void]$window.ShowDialog() }
finally {
    $timer.Dispose()
    if ($qr.Image) { $qr.Image.Dispose() }
    $window.Dispose()
    if ($ownsLauncherMutex) { $launcherMutex.ReleaseMutex() }
    $launcherMutex.Dispose()
}
