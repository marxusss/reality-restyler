using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class LauncherBootstrap
{
    [STAThread]
    private static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "launcher.ps1");
        string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell\\v1.0\\powershell.exe");
        if (!File.Exists(script) || !File.Exists(powershell))
        {
            MessageBox.Show("Reality Restyling could not start.", "Reality Restyling", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        ProcessStartInfo start = new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = "-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File \"" + script + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };

        try
        {
            Process.Start(start);
            return 0;
        }
        catch
        {
            MessageBox.Show("Reality Restyling could not start.", "Reality Restyling", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
