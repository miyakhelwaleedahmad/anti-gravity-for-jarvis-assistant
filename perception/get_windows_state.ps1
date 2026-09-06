Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class User32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@

# Active Window
$activeHwnd = [User32]::GetForegroundWindow()
$activePid = 0
[void][User32]::GetWindowThreadProcessId($activeHwnd, [ref]$activePid)
$activeTitleBuilder = New-Object System.Text.StringBuilder 256
[void][User32]::GetWindowText($activeHwnd, $activeTitleBuilder, 256)
$activeTitle = $activeTitleBuilder.ToString()

$activeProcessName = ""
if ($activePid -gt 0) {
    $activeProcess = Get-Process -Id $activePid -ErrorAction SilentlyContinue
    if ($activeProcess) {
        $activeProcessName = $activeProcess.ProcessName
    }
}

# Open Windows
$openWindows = Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object {
    [PSCustomObject]@{
        name = $_.ProcessName
        pid = $_.Id
        windowTitle = $_.MainWindowTitle
        hwnd = "0x" + $_.MainWindowHandle.ToString("X")
    }
}

$output = [PSCustomObject]@{
    activeWindow = [PSCustomObject]@{
        title = $activeTitle
        processName = $activeProcessName
        pid = $activePid
        hwnd = "0x" + $activeHwnd.ToString("X")
    }
    openApps = @($openWindows)
}

$output | ConvertTo-Json -Depth 3 -Compress
