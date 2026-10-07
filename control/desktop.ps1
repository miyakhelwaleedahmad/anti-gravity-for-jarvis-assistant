# control/desktop.ps1
# Screenshots and the clipboard for JARVIS (P14, docs/upgrade/PC_CONTROL.md).
# Everything comes from environment variables, each checked here:
#   JARVIS_DESKTOP_ACTION  clipboard_read, clipboard_write or screenshot
#   JARVIS_DESKTOP_FILE    the PNG to write, or the UTF-8 file holding the new
#                          clipboard text (text never appears in this script)
#   JARVIS_DESKTOP_MODE    screenshot: screen (all displays) or window (the
#                          window in front)
# Prints one line of JSON. Written for Windows PowerShell 5.1 (STA by default,
# which the clipboard needs).

$ErrorActionPreference = 'Stop'
# Titles and names can be in any language: print UTF-8, which JARVIS reads.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$action = [string]$env:JARVIS_DESKTOP_ACTION
$file = [string]$env:JARVIS_DESKTOP_FILE
$mode = [string]$env:JARVIS_DESKTOP_MODE

function Out-Json($value) {
  ConvertTo-Json -InputObject $value -Depth 4 -Compress
}

# A function of its own: System.Drawing is bound only when a screenshot is
# taken (PowerShell 7 off Windows cannot even compile code that names it).
function Save-Screenshot {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -Namespace JarvisDesktop -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
  [void][JarvisDesktop.Native]::SetProcessDPIAware()
  if ($mode -eq 'window') {
    $rect = New-Object JarvisDesktop.Native+RECT
    if (-not [JarvisDesktop.Native]::GetWindowRect([JarvisDesktop.Native]::GetForegroundWindow(), [ref]$rect)) { throw 'No window in front.' }
    $x = $rect.Left; $y = $rect.Top; $w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
  } else {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
  }
  if ($w -le 0 -or $h -le 0) { throw 'There is nothing to capture.' }
  $bitmap = New-Object System.Drawing.Bitmap $w, $h
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
    $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  $shot = 'screen'
  if ($mode -eq 'window') { $shot = 'window' }
  return @{ ok = $true; action = 'screenshot'; mode = $shot; width = $w; height = $h }
}

try {
  switch -Exact ($action) {
    'clipboard_read' {
      $text = Get-Clipboard -Raw -ErrorAction SilentlyContinue
      if ($null -eq $text) { $text = '' }
      $text = [string]$text
      Out-Json @{ ok = $true; action = $action; text = $text; length = $text.Length }
    }
    'clipboard_write' {
      if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'The file with the text is missing.' }
      $text = [string](Get-Content -LiteralPath $file -Raw -Encoding UTF8)
      if ($text.Length -eq 0) { throw 'There is no text to put on the clipboard.' }
      Set-Clipboard -Value $text
      $back = Get-Clipboard -Raw -ErrorAction SilentlyContinue
      if ($null -eq $back) { $back = '' }
      Out-Json @{ ok = $true; action = $action; length = $text.Length; readBack = ([string]$back).Length; same = (([string]$back).TrimEnd() -eq $text.TrimEnd()) }
    }
    'screenshot' {
      if (-not $file -or -not $file.EndsWith('.png')) { throw 'No PNG file to write.' }
      Out-Json (Save-Screenshot)
    }
    default {
      Out-Json @{ ok = $false; action = $action; error = 'unknown action' }
    }
  }
} catch {
  Out-Json @{ ok = $false; action = $action; error = [string]$_.Exception.Message }
}
