# control/uia.ps1
# UI Automation for JARVIS (P14, docs/upgrade/PC_CONTROL.md): the elements of
# a window, and invoke, set the value of, or focus one of them. Everything
# comes from environment variables, each checked here:
#   JARVIS_UIA_ACTION     list, invoke, set_value or focus
#   JARVIS_UIA_HWND       the window's handle in decimal digits; empty for the
#                         window in front
#   JARVIS_UIA_REF        the element's UI Automation runtime id (numbers
#                         joined by dots)
#   JARVIS_UIA_NAME       the name and control type JARVIS saw: the element
#   JARVIS_UIA_TYPE       must still have them, or nothing is done
#   JARVIS_UIA_TEXT_FILE  set_value: the UTF-8 file holding the text
# Nothing here is built from those values. Prints one line of JSON.
# Written for Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'
# Names can be in any language: print UTF-8, which JARVIS reads.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$action = [string]$env:JARVIS_UIA_ACTION
$hwndText = [string]$env:JARVIS_UIA_HWND
$ref = [string]$env:JARVIS_UIA_REF
$expectName = [string]$env:JARVIS_UIA_NAME
$expectType = [string]$env:JARVIS_UIA_TYPE
$textFile = [string]$env:JARVIS_UIA_TEXT_FILE

# Breadth first, so a window's main controls come before deep menus; Store
# apps (Calculator) keep their buttons about five levels down.
$MaxDepth = 6
$MaxElements = 200

function Out-Json($value) {
  ConvertTo-Json -InputObject $value -Depth 6 -Compress
}

function Get-TypeName($el) {
  return ([string]$el.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
}

function Get-Info($el, [int]$depth) {
  $c = $el.Current
  $patterns = @($el.GetSupportedPatterns() | ForEach-Object { ([string]$_.ProgrammaticName) -replace 'PatternIdentifiers\.Pattern$', '' })
  $value = ''
  # Never the value of a password field.
  if (-not $c.IsPassword -and ($patterns -contains 'Value')) {
    try { $value = [string]$el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $value = '' }
    if ($value.Length -gt 200) { $value = $value.Substring(0, 200) }
  }
  return @{
    id = (@($el.GetRuntimeId()) -join '.')
    name = [string]$c.Name
    type = Get-TypeName $el
    automationId = [string]$c.AutomationId
    className = [string]$c.ClassName
    enabled = [bool]$c.IsEnabled
    focused = [bool]$c.HasKeyboardFocus
    password = [bool]$c.IsPassword
    offscreen = [bool]$c.IsOffscreen
    patterns = $patterns
    value = $value
    depth = $depth
  }
}

function Get-Window {
  if ($hwndText) {
    if ($hwndText -notmatch '^\d{1,19}$') { throw 'The window handle is not a number.' }
    $handle = New-Object IntPtr ([long]$hwndText)
  } else {
    $handle = [JarvisUia.Native]::GetForegroundWindow()
  }
  if ($handle -eq [IntPtr]::Zero) { throw 'There is no window in front.' }
  $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($null -eq $element) { throw 'The window is gone.' }
  $process = ''
  try { $process = [string](Get-Process -Id $element.Current.ProcessId -ErrorAction Stop).ProcessName } catch { $process = '' }
  return @{ handle = $handle; element = $element; process = $process }
}

function Get-Elements($root) {
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $found = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  $more = $false
  while ($queue.Count -gt 0) {
    if ($found.Count -ge $MaxElements) { $more = $true; break }
    $item = $queue.Dequeue()
    $el = $item[0]
    $depth = [int]$item[1]
    try { [void]$found.Add((Get-Info $el $depth)) } catch { continue }
    if ($depth -ge $MaxDepth) { continue }
    $children = New-Object System.Collections.ArrayList
    try {
      $child = $walker.GetFirstChild($el)
      while ($null -ne $child -and $children.Count -lt 100) {
        [void]$children.Add($child)
        $child = $walker.GetNextSibling($child)
      }
    } catch { }
    foreach ($c in $children) { $queue.Enqueue(@($c, ($depth + 1))) }
  }
  return @{ elements = $found; more = $more }
}

function Find-Element($root) {
  if ($ref -notmatch '^-?\d{1,10}(\.-?\d{1,10}){0,15}$') { throw 'The element reference is not a runtime id.' }
  if ((@($root.GetRuntimeId()) -join '.') -eq $ref) { return $root }
  $ids = [int[]]@($ref.Split('.') | ForEach-Object { [int]$_ })
  $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::RuntimeIdProperty, $ids)
  $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $el) { throw 'The element is no longer there.' }
  # The same element JARVIS looked at, not another one in its place. Names are
  # compared as JARVIS keeps them: spaces collapsed, at most 160 characters.
  $type = Get-TypeName $el
  if ($expectType -and $type -ne $expectType) { throw "It changed since JARVIS looked: it is now a $type." }
  $name = ([string]$el.Current.Name -replace '\s+', ' ').Trim()
  if ($name.Length -gt 160) { $name = $name.Substring(0, 160) }
  if ($name -ne $expectName) { throw 'It changed since JARVIS looked: its name is different now.' }
  return $el
}

try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -Namespace JarvisUia -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
  $window = Get-Window
  switch -Exact ($action) {
    'list' {
      $result = Get-Elements $window.element
      $info = @{ hwnd = [string]$window.handle.ToInt64(); title = [string]$window.element.Current.Name; process = $window.process }
      Out-Json @{ ok = $true; action = $action; window = $info; elements = $result.elements; more = $result.more }
    }
    'invoke' {
      $el = Find-Element $window.element
      if (-not $el.Current.IsEnabled) { throw 'The element is disabled.' }
      $pattern = $null
      $did = ''
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); $did = 'invoked' }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); $did = 'toggled' }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); $did = 'selected' }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); $did = 'expanded' }
      else { throw 'The element cannot be pressed: it has no invoke, toggle, select or expand pattern.' }
      Start-Sleep -Milliseconds 300
      $after = $null
      try { $after = Get-Info $el 0 } catch { $after = $null }
      $windowOpen = $true
      try { [void]$window.element.Current.Name } catch { $windowOpen = $false }
      Out-Json @{ ok = $true; action = $action; did = $did; element = $after; windowOpen = $windowOpen }
    }
    'set_value' {
      $el = Find-Element $window.element
      if ($el.Current.IsPassword) { throw 'JARVIS does not type into password fields.' }
      if (-not $textFile -or -not (Test-Path -LiteralPath $textFile -PathType Leaf)) { throw 'The file with the text is missing.' }
      $text = [string](Get-Content -LiteralPath $textFile -Raw -Encoding UTF8)
      $pattern = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw 'The element does not take a value.' }
      if ($pattern.Current.IsReadOnly) { throw 'The element is read-only.' }
      $pattern.SetValue($text)
      Start-Sleep -Milliseconds 150
      $now = [string]$pattern.Current.Value
      $shown = $now
      if ($shown.Length -gt 200) { $shown = $shown.Substring(0, 200) }
      Out-Json @{ ok = $true; action = $action; length = $text.Length; same = ($now -eq $text); value = $shown }
    }
    'focus' {
      $el = Find-Element $window.element
      $el.SetFocus()
      Start-Sleep -Milliseconds 150
      Out-Json @{ ok = $true; action = $action; focused = [bool]$el.Current.HasKeyboardFocus }
    }
    default {
      Out-Json @{ ok = $false; action = $action; error = 'unknown action' }
    }
  }
} catch {
  Out-Json @{ ok = $false; action = $action; error = [string]$_.Exception.Message }
}
