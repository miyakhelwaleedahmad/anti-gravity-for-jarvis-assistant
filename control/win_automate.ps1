param(
    [string]$Action,
    # control-window: focus, close, minimize, maximize or move
    [string]$ActionType = "",
    [int]$X = 0,
    [int]$Y = 0,
    [int]$FromX = 0,
    [int]$FromY = 0,
    [int]$ToX = 0,
    [int]$ToY = 0,
    [int]$Amount = 0,
    [string]$Text = "",
    [string]$Key = "",
    [string]$Modifiers = "",
    [string]$Hwnd = "",
    [string]$Button = "left",
    [bool]$Double = $false,
    [int]$Width = 0,
    [int]$Height = 0
)

# Load Win32 methods
$code = @"
using System;
using System.Runtime.InteropServices;
public class WinAutomate {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, uint dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue | Out-Null
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue | Out-Null

# Mouse event constants
$MOUSEEVENTF_LEFTDOWN   = 0x0002
$MOUSEEVENTF_LEFTUP     = 0x0004
$MOUSEEVENTF_RIGHTDOWN  = 0x0008
$MOUSEEVENTF_RIGHTUP    = 0x0010
$MOUSEEVENTF_MIDDLEDOWN = 0x0020
$MOUSEEVENTF_MIDDLEUP   = 0x0040
$MOUSEEVENTF_WHEEL      = 0x0800

# Virtual Keys
$VK_TAB    = 0x09
$VK_RETURN = 0x0D
$VK_ESCAPE = 0x1B
$VK_CONTROL= 0x11
$VK_MENU   = 0x12  # Alt
$VK_SHIFT  = 0x10
$VK_LWIN   = 0x5B

$KEYEVENTF_KEYUP = 0x0002

function Send-Click($down, $up) {
    [WinAutomate]::mouse_event($down, 0, 0, 0, 0)
    Start-Sleep -m 30
    [WinAutomate]::mouse_event($up, 0, 0, 0, 0)
}

switch ($Action.ToLower()) {
    "move-mouse" {
        [void][WinAutomate]::SetCursorPos($X, $Y)
        Write-Output "Moved mouse to $X, $Y"
    }
    "click-mouse" {
        [void][WinAutomate]::SetCursorPos($X, $Y)
        Start-Sleep -m 50
        $down = $MOUSEEVENTF_LEFTDOWN
        $up = $MOUSEEVENTF_LEFTUP
        if ($Button.ToLower() -eq "right") {
            $down = $MOUSEEVENTF_RIGHTDOWN
            $up = $MOUSEEVENTF_RIGHTUP
        } elseif ($Button.ToLower() -eq "middle") {
            $down = $MOUSEEVENTF_MIDDLEDOWN
            $up = $MOUSEEVENTF_MIDDLEUP
        }
        
        Send-Click $down $up
        if ($Double) {
            Start-Sleep -m 100
            Send-Click $down $up
        }
        Write-Output "Clicked mouse at $X, $Y ($Button, Double=$Double)"
    }
    "drag-mouse" {
        [void][WinAutomate]::SetCursorPos($FromX, $FromY)
        Start-Sleep -m 100
        [WinAutomate]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
        Start-Sleep -m 100
        # Smooth drag
        $steps = 10
        for ($i = 1; $i -le $steps; $i++) {
            $cx = $FromX + (($ToX - $FromX) / $steps) * $i
            $cy = $FromY + (($ToY - $FromY) / $steps) * $i
            [void][WinAutomate]::SetCursorPos([int]$cx, [int]$cy)
            Start-Sleep -m 10
        }
        [void][WinAutomate]::SetCursorPos($ToX, $ToY)
        Start-Sleep -m 100
        [WinAutomate]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
        Write-Output "Dragged mouse from $FromX, $FromY to $ToX, $ToY"
    }
    "scroll-mouse" {
        [WinAutomate]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $Amount, 0)
        Write-Output "Scrolled mouse by $Amount"
    }
    "type-text" {
        # SendKeys expects a string, some characters require escaping.
        # {} are used to escape special keys. SendWait handles this.
        [System.Windows.Forms.SendKeys]::SendWait($Text)
        Write-Output "Typed text: $Text"
    }
    "press-key" {
        # Helper to get virtual key
        $vk = 0
        switch ($Key.ToLower()) {
            "enter"  { $vk = $VK_RETURN }
            "escape" { $vk = $VK_ESCAPE }
            "tab"    { $vk = $VK_TAB }
            "w"      { $vk = 0x57 }
            "f4"     { $vk = 0x73 }
            default {
                if ($Key.Length -eq 1) {
                    $vk = [byte][char]$Key.ToUpper()
                }
            }
        }
        
        # Press modifiers down
        $mods = $Modifiers.Split(",")
        if ($mods -contains "ctrl") { [WinAutomate]::keybd_event($VK_CONTROL, 0, 0, 0) }
        if ($mods -contains "alt") { [WinAutomate]::keybd_event($VK_MENU, 0, 0, 0) }
        if ($mods -contains "shift") { [WinAutomate]::keybd_event($VK_SHIFT, 0, 0, 0) }
        if ($mods -contains "win") { [WinAutomate]::keybd_event($VK_LWIN, 0, 0, 0) }
        
        # Press key down & up
        if ($vk -ne 0) {
            [WinAutomate]::keybd_event($vk, 0, 0, 0)
            Start-Sleep -m 10
            [WinAutomate]::keybd_event($vk, 0, $KEYEVENTF_KEYUP, 0)
        }
        
        # Release modifiers
        if ($mods -contains "win") { [WinAutomate]::keybd_event($VK_LWIN, 0, $KEYEVENTF_KEYUP, 0) }
        if ($mods -contains "shift") { [WinAutomate]::keybd_event($VK_SHIFT, 0, $KEYEVENTF_KEYUP, 0) }
        if ($mods -contains "alt") { [WinAutomate]::keybd_event($VK_MENU, 0, $KEYEVENTF_KEYUP, 0) }
        if ($mods -contains "ctrl") { [WinAutomate]::keybd_event($VK_CONTROL, 0, $KEYEVENTF_KEYUP, 0) }
        
        Write-Output "Pressed key $Key with modifiers $Modifiers"
    }
    "control-window" {
        # The window action comes in -ActionType. It was read from -Action,
        # which is always "control-window" here, so until Step C no window
        # action ran and nothing was said (the owner's seventh Windows run).
        # Anything not done is an error now, never a silent success.
        if ($Hwnd -notmatch '^0x[0-9a-fA-F]{1,16}$') { throw "The window handle is not a hex number: $Hwnd" }
        $ptr = [IntPtr][Convert]::ToInt64($Hwnd, 16)
        switch ($ActionType.ToLower()) {
            "focus" {
                [void][WinAutomate]::ShowWindow($ptr, 9) # Restore if minimized
                [void][WinAutomate]::SetForegroundWindow($ptr)
                Write-Output "Focused window $Hwnd"
            }
            "close" {
                if (-not [WinAutomate]::PostMessage($ptr, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw "Windows did not take the close message for window $Hwnd." }
                Write-Output "Closed window $Hwnd"
            }
            "minimize" {
                [void][WinAutomate]::ShowWindow($ptr, 2)
                Write-Output "Minimized window $Hwnd"
            }
            "maximize" {
                [void][WinAutomate]::ShowWindow($ptr, 3)
                Write-Output "Maximized window $Hwnd"
            }
            "move" {
                if (-not [WinAutomate]::MoveWindow($ptr, $X, $Y, $Width, $Height, $true)) { throw "Windows did not move window $Hwnd." }
                Write-Output "Moved/Resized window $Hwnd to $X, $Y with size $Width x $Height"
            }
            default { throw "Unknown window action: '$ActionType'." }
        }
    }
}
