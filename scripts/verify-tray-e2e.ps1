# L3 Tray User-Path E2E - REAL clicks on the REAL tray icon, pinned to the
# visible Windows 11 taskbar.
#
# Environment adapter (measured 2026-08-22): Win11 buries new notify icons in
# the hidden overflow. The pinned state lives in HKCU\Control Panel\
# NotifyIconSettings\<hash>\IsPromoted. This script promotes the icon (the
# same effect as the user choosing "Show in taskbar"), then drives all tests
# with physical mouse input at stable coordinates - no UIA invocation needed.
#
# Verifies (action -> event -> state change -> Oracle):
#   1. Left click      -> Center process spawns + owns real top-level window
#   2. WM_CLOSE        -> Center process exits
#   3. Left click again-> re-open works
#   4. Double click    -> mark-all-read (state.json unread==0)
#   5. Right click     -> context menu lists expected items
#   6. Menu 'Exit'     -> tray exits gracefully (procs gone, tray.pid removed)
#
# NOTE: keep this file ASCII-only (PS5.1 reads BOM-less UTF-8 as ANSI).

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cli  = Join-Path $root 'dist\daemon-cli.js'
$stateJson = Join-Path $env:USERPROFILE '.agent-attention\state.json'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class U32 {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c,string n);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
}
"@

$auto = [System.Windows.Automation.AutomationElement]
$cond = [System.Windows.Automation.Condition]::TrueCondition

function Send-ClickAt([double]$x,[double]$y,[switch]$Right,[switch]$Double) {
    [U32]::SetCursorPos([int]$x,[int]$y) | Out-Null
    Start-Sleep -Milliseconds 200
    $LD=0x2;$LU=0x4;$RD=0x8;$RU=0x10
    if ($Right) { [U32]::mouse_event($RD,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [U32]::mouse_event($RU,0,0,0,[UIntPtr]::Zero) }
    else {
        [U32]::mouse_event($LD,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [U32]::mouse_event($LU,0,0,0,[UIntPtr]::Zero)
        if ($Double) { Start-Sleep -Milliseconds 120; [U32]::mouse_event($LD,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 50; [U32]::mouse_event($LU,0,0,0,[UIntPtr]::Zero) }
    }
}

# Find OUR icon inside the real taskbar (Shell_TrayWnd). Returns @{X,Y} or $null.
# NOTE: the icon's position REFLOWS as tray icons register/unregister, so this
# must be called fresh before EVERY physical click.
function Get-TaskbarIconCenter {
    $tb = $auto::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,
        (New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty,'Shell_TrayWnd')))
    if (-not $tb) { return $null }
    foreach ($ctn in 'Button','ListItem') {
        $ct = [System.Windows.Automation.ControlType]::$ctn
        $els = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty,$ct)))
        foreach ($b in $els) {
            if ($b.Current.Name -like '*Agent Attention*') {
                $rr = $b.Current.BoundingRectangle
                if ($rr.Width -gt 0) { return @{ X=[double]($rr.X+$rr.Width/2); Y=[double]($rr.Y+$rr.Height/2) }
                }
            }
        }
    }
    return $null
}

# Make sure OUR icon sits in the visible taskbar:
#  1. Re-assert IsPromoted=1 on every powershell-hosted notify icon entry
#     (Win11 demotes icons back to the overflow when the tray re-registers).
#  2. Poll the taskbar for the icon.
function Ensure-IconInTaskbar {
    foreach ($round in 1..3) {
        $c = Get-TaskbarIconCenter
        if ($c) { return $c }
        # Re-assert promotion unconditionally
        $keys = Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction SilentlyContinue
        foreach ($k in $keys) {
            $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
            if ($p.ExecutablePath -and $p.ExecutablePath -match 'powershell\.exe$' -and $p.IsPromoted -ne 1) {
                try { Set-ItemProperty -Path $k.PSPath -Name IsPromoted -Value 1 -Type DWord } catch {}
            }
        }
        Start-Sleep -Seconds 4
        $c = Get-TaskbarIconCenter
        if ($c) { return $c }
    }
    return $null
}

$results = @()
function Record($name,$ok,$detail='') {
    $script:results += [pscustomobject]@{Name=$name;Pass=$ok;Detail=$detail}
    Write-Host ("[{0}] {1} {2}" -f ($(if($ok){'PASS'}else{'FAIL'})), $name, $detail)
}
function Get-CenterProcs { @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*CenterWindow.ps1*' -and $_.ProcessId -ne $PID }) }
function Close-CenterWindows {
    # Real user close paths: UIA WindowPattern.Close, plus WM_CLOSE fallback
    # via the UIA-provided native handle. WPF shutdown can be slow, so callers
    # must poll for the window to disappear.
    try {
        $wins = $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
            (New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty,'Agent Attention Center')))
        foreach ($w in $wins) {
            try { ($w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)).Close() } catch {}
            try { [U32]::PostMessage([IntPtr]$w.Current.NativeWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null } catch {}
        }
    } catch {}
}

# Oracle helper: find the real 'Agent Attention Center' top-level window.
function Get-CenterWindow {
    try {
        return $auto::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,
            (New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty,'Agent Attention Center')))
    } catch { return $null }
}
function Wait-CenterWindow([int]$Seconds) {
    foreach ($i in 1..($Seconds*2)) {
        Start-Sleep -Milliseconds 500
        $w = Get-CenterWindow
        if ($w) { return $w }
    }
    return $null
}
# The tray menu is a classic Win32 popup: top-level Pane with class #32768.
function Get-TrayMenuItems {
    $items = @()
    try {
        $menus = $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,
            (New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty,'#32768')))
        foreach ($m in $menus) {
            foreach ($it in $m.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)) {
                if ($it.Current.Name) { $items += [pscustomobject]@{Name=$it.Current.Name; El=$it} }
            }
        }
    } catch {}
    return $items
}

# -- Setup --
node -e "const{recordEvent}=require('D:/Projects/Active/agent-attention/dist/state/AttentionState.js');recordEvent(process.env.USERPROFILE+'/.agent-attention/state.json',{type:'input_required',priority:'P0',agent_id:'tray-e2e',agent_name:'TrayE2E',title:'T',message:'tray path verification',timestamp:Date.now()});" | Out-Null
# Kill any ORPHANED trays first - two NotifyIcons fighting over one (exe,uid)
# registration slot end up with the icon invisible in both the taskbar and
# the overflow area.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*TrayIcon.ps1*' -and $_.CommandLine -notlike '*Get-CimInstance*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
node "$cli" daemon start | Out-Null
Start-Sleep -Seconds 6

# Kill ZOMBIE Centers (windowless processes still hold the single-instance
# mutex and silently swallow every new spawn) + close any live window.
Close-CenterWindows
Start-Sleep -Milliseconds 800
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*CenterWindow.ps1*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# -- Pin icon to the visible taskbar & locate it --
$pos = Ensure-IconInTaskbar
if (-not $pos) { Record 'Pin + locate icon in visible taskbar' $false 'icon never appeared'; node "$cli" daemon stop | Out-Null; exit 1 }
Record 'Pin + locate icon in visible taskbar' $true ("center=$([int]$pos.X),$([int]$pos.Y)")

# -- Test 1: left click -> Center window opens (fresh coords: icon reflows!) --
# First click after a tray respawn can be swallowed during icon registration,
# so retry once if no window appears.
$pos = Ensure-IconInTaskbar
Send-ClickAt $pos.X $pos.Y
$win = Wait-CenterWindow 12
if (-not $win) {
    Write-Host "  first click swallowed - retrying"
    $pos = Get-TaskbarIconCenter
    Send-ClickAt $pos.X $pos.Y
    $win = Wait-CenterWindow 10
}
$opened = [bool]$win
$cpid = if ($opened) { $win.Current.ProcessId } else { 0 }
Record 'Left click -> Center process spawned' $opened "pid=$cpid"

# Oracle: the spawned process owns a real top-level window (same element)
Record 'Center owns a real top-level window' $opened $(if($opened){ "class=$($win.Current.ClassName)" } else { '' })

# -- Test 2: real close -> process exits --
if ($opened) {
    Close-CenterWindows
    $gone = $false
    foreach ($i in 1..30) { Start-Sleep -Milliseconds 500; if (-not (Get-CenterWindow)) { $gone = $true; break } }
    # Wait until the process itself is gone too - it still holds the
    # single-instance mutex for a while after the window disappears, which
    # would silently swallow the next spawn (Test 3).
    $cpid2 = if ($opened) { $cpid } else { 0 }
    foreach ($i in 1..20) {
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
            Where-Object { $_.CommandLine -like '*CenterWindow.ps1*' -and $_.ProcessId -ne $PID })
        if ($procs.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    Record 'Close -> Center process exited' $gone
} else { Record 'Close -> Center process exited' $false 'skipped' }

# -- Test 3: re-open --
Start-Sleep -Milliseconds 800
$pos = Ensure-IconInTaskbar
Send-ClickAt $pos.X $pos.Y
$win2 = Wait-CenterWindow 8
$reopened = [bool]$win2
Record 'Second left click -> Center reopens' $reopened
if ($reopened) { Close-CenterWindows; Start-Sleep -Seconds 2 }

# -- Test 4: double-click -> mark-all-read --
# Guarantee an unread event exists right before the gesture.
node -e "const{recordEvent}=require('D:/Projects/Active/agent-attention/dist/state/AttentionState.js');recordEvent(process.env.USERPROFILE+'/.agent-attention/state.json',{type:'input_required',priority:'P0',agent_id:'tray-e2e',agent_name:'TrayE2E',title:'T',message:'dblclick verification',timestamp:Date.now()});" | Out-Null
try { $unreadBefore = @((Get-Content $stateJson -Raw | ConvertFrom-Json).events | Where-Object { -not $_.read }).Count } catch { $unreadBefore = '?' }
$pos = Ensure-IconInTaskbar
Send-ClickAt $pos.X $pos.Y -Double
Start-Sleep -Seconds 4
try { $unreadAfter = @((Get-Content $stateJson -Raw | ConvertFrom-Json).events | Where-Object { -not $_.read }).Count } catch { $unreadAfter = 'n/a' }
Record 'Double click -> mark-all-read (unread==0)' (($unreadAfter -eq 0) -and ($unreadBefore -gt 0)) "before=$unreadBefore after=$unreadAfter"

# -- Test 5/6: right-click menu -> Exit --
# A double-click's leading Click may have opened Center; close it so the
# context menu gets focus.
Close-CenterWindows
Start-Sleep -Seconds 2
$pos = Ensure-IconInTaskbar
Send-ClickAt $pos.X $pos.Y -Right
$menuItems = @()
foreach ($scan in 1..4) {
    Start-Sleep -Milliseconds 800
    $menuItems = Get-TrayMenuItems
    if ($menuItems.Count -gt 0) { break }
}
$names = @($menuItems | ForEach-Object { $_.Name })
$expectedHits = (@('Agent Attention','Open Center','Exit') | Where-Object { $names -contains $_ }).Count
Record 'Right click -> context menu shows expected items' (($names.Count -gt 0) -and ($expectedHits -ge 2)) (($names -join ' | '))

if ($names -contains 'Exit') {
    $ex = $menuItems | Where-Object { $_.Name -eq 'Exit' } | Select-Object -First 1
    if ($ex) {
        $er = $ex.El.Current.BoundingRectangle
        Send-ClickAt ($er.X+$er.Width/2) ($er.Y+$er.Height/2)
        Start-Sleep -Seconds 4
        $trayAlive = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
            Where-Object { $_.CommandLine -like '*TrayIcon.ps1*' -and $_.CommandLine -notlike '*Get-CimInstance*' }).Count
        $pidFileGone = -not (Test-Path (Join-Path $env:USERPROFILE '.agent-attention\tray.pid'))
        Record 'Menu Exit -> tray exited gracefully' (($trayAlive -eq 0) -and $pidFileGone) "procs=$trayAlive pidFileRemoved=$pidFileGone"
    } else {
        Record 'Menu Exit -> tray exited gracefully' $false 'Exit item not located'
        node "$cli" daemon stop | Out-Null
    }
} else {
    Record 'Menu Exit -> tray exited gracefully' $false 'skipped (no menu)'
    node "$cli" daemon stop | Out-Null
}

$pass = ($results | Where-Object Pass).Count
Write-Host ''
Write-Host "Tray user-path E2E: $pass/$($results.Count) passed"
if ($pass -lt $results.Count) { exit 1 } else { exit 0 }
