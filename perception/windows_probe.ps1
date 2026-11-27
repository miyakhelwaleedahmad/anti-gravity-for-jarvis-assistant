# perception/windows_probe.ps1
# Read-only readings of this Windows PC for JARVIS (P14,
# docs/upgrade/SYSTEM_AWARENESS.md). Which reading to take comes from
# $env:JARVIS_PROBE_SECTION and must be one of the fixed names below; nothing
# else from outside reaches this script. Prints one line of JSON.
# Written for Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
# Titles and names can be in any language: print UTF-8, which JARVIS reads.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$section = [string]$env:JARVIS_PROBE_SECTION

function Out-Json($value) {
  ConvertTo-Json -InputObject $value -Depth 4 -Compress
}

try {
  switch -Exact ($section) {
    'gpu' {
      $items = @(Get-CimInstance -ClassName Win32_VideoController | ForEach-Object {
        @{
          name = [string]$_.Name
          driver = [string]$_.DriverVersion
          memoryBytes = [double]$_.AdapterRAM
          width = [int]$_.CurrentHorizontalResolution
          height = [int]$_.CurrentVerticalResolution
          refreshHz = [int]$_.CurrentRefreshRate
          status = [string]$_.Status
        }
      })
      Out-Json @{ ok = $true; section = $section; items = $items }
    }
    'displays' {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -Namespace JarvisProbe -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
      [void][JarvisProbe.Dpi]::SetProcessDPIAware()
      $items = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        @{
          name = [string]$_.DeviceName
          primary = [bool]$_.Primary
          x = [int]$_.Bounds.X
          y = [int]$_.Bounds.Y
          width = [int]$_.Bounds.Width
          height = [int]$_.Bounds.Height
        }
      })
      Out-Json @{ ok = $true; section = $section; items = $items }
    }
    'audio' {
      $devices = @(Get-CimInstance -ClassName Win32_SoundDevice | ForEach-Object {
        @{ name = [string]$_.Name; maker = [string]$_.Manufacturer; status = [string]$_.Status }
      })
      $endpoints = @(Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
        @{ name = [string]$_.FriendlyName; status = [string]$_.Status }
      })
      Out-Json @{ ok = $true; section = $section; devices = $devices; endpoints = $endpoints }
    }
    'cameras' {
      $items = @(Get-PnpDevice -Class Camera, Image -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
        @{ name = [string]$_.FriendlyName; kind = [string]$_.Class; status = [string]$_.Status }
      })
      Out-Json @{ ok = $true; section = $section; items = $items }
    }
    'apps' {
      $paths = @(
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
      )
      $seen = @{}
      $found = New-Object System.Collections.ArrayList
      foreach ($p in $paths) {
        foreach ($entry in @(Get-ItemProperty -Path $p -ErrorAction SilentlyContinue)) {
          if (-not $entry.DisplayName -or $entry.SystemComponent -eq 1) { continue }
          $key = [string]$entry.DisplayName + '|' + [string]$entry.DisplayVersion
          if ($seen.ContainsKey($key)) { continue }
          $seen[$key] = $true
          [void]$found.Add(@{ name = [string]$entry.DisplayName; version = [string]$entry.DisplayVersion; publisher = [string]$entry.Publisher })
        }
      }
      $items = @($found | Sort-Object { $_.name } | Select-Object -First 400)
      Out-Json @{ ok = $true; section = $section; items = $items; total = $found.Count }
    }
    'services' {
      $items = @(Get-Service -ErrorAction SilentlyContinue | ForEach-Object {
        @{ name = [string]$_.Name; display = [string]$_.DisplayName; status = [string]$_.Status; start = [string]$_.StartType }
      })
      Out-Json @{ ok = $true; section = $section; items = $items }
    }
    'ports' {
      $names = @{}
      foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) { $names[[int]$proc.Id] = [string]$proc.ProcessName }
      $items = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        $owner = [int]$_.OwningProcess
        @{ address = [string]$_.LocalAddress; port = [int]$_.LocalPort; pid = $owner; process = [string]$names[$owner] }
      })
      Out-Json @{ ok = $true; section = $section; items = $items }
    }
    'windows' {
      # Every visible top-level window, not one per program: Store apps
      # (Calculator, Settings) all run in one ApplicationFrameHost process.
      Add-Type -Namespace JarvisProbe -Name Win -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int max);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
public static System.Collections.Generic.List<IntPtr> Visible() {
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumWindows(delegate (IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
    int cloaked = 0;
    if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
    found.Add(h);
    return true;
  }, IntPtr.Zero);
  return found;
}
public static string Title(IntPtr h) { var s = new System.Text.StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
public static uint Owner(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
'@
      $names = @{}
      foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) { $names[[int]$proc.Id] = [string]$proc.ProcessName }
      $items = New-Object System.Collections.ArrayList
      foreach ($h in [JarvisProbe.Win]::Visible()) {
        if ($items.Count -ge 80) { break }
        $title = [JarvisProbe.Win]::Title($h)
        if (-not $title) { continue }
        $owner = [int][JarvisProbe.Win]::Owner($h)
        [void]$items.Add(@{ hwnd = [string]$h.ToInt64(); pid = $owner; process = [string]$names[$owner]; title = $title })
      }
      Out-Json @{ ok = $true; section = $section; items = $items }
    }
    'window_state' {
      # One window, by its handle in $env:JARVIS_PROBE_HWND (decimal digits):
      # is it there, visible, in front, minimised, maximised.
      $handleText = [string]$env:JARVIS_PROBE_HWND
      if ($handleText -notmatch '^\d{1,19}$') { throw 'The window handle is not a number.' }
      Add-Type -Namespace JarvisProbe -Name One -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
'@
      $h = New-Object IntPtr ([long]$handleText)
      $exists = [JarvisProbe.One]::IsWindow($h)
      Out-Json @{
        ok = $true; section = $section; exists = [bool]$exists
        visible = [bool]($exists -and [JarvisProbe.One]::IsWindowVisible($h))
        foreground = [bool]($exists -and ([JarvisProbe.One]::GetForegroundWindow() -eq $h))
        minimized = [bool]($exists -and [JarvisProbe.One]::IsIconic($h))
        maximized = [bool]($exists -and [JarvisProbe.One]::IsZoomed($h))
      }
    }
    default {
      Out-Json @{ ok = $false; section = $section; error = 'unknown section' }
    }
  }
} catch {
  Out-Json @{ ok = $false; section = $section; error = [string]$_.Exception.Message }
}
