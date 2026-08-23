$ErrorActionPreference = 'Continue'
Set-Location D:\Projects\Active\agent-attention
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# replicate script setup: clean trays, fresh daemon
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*TrayIcon.ps1*' -and $_.CommandLine -notlike '*Get-CimInstance*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
node dist\daemon-cli.js daemon start | Out-Null
Start-Sleep -Seconds 6
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class UJ {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
}
"@
$auto = [System.Windows.Automation.AutomationElement]
$cond = [System.Windows.Automation.Condition]::TrueCondition

function Snap {
    $h = @{}
    $roots = $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$cond)
    foreach ($w in $roots) { $k = ($w.Current.RuntimeId -join '_'); $h[$k] = $w }
    return $h
}

# locate icon in taskbar
$tb = $auto::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,
    (New-Object System.Windows.Automation.PropertyCondition($auto::ClassNameProperty,'Shell_TrayWnd')))
$el = $null
foreach ($round in 1..3) {
    if ($tb) {
        $btns = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[System.Windows.Automation.ControlType]::Button)))
        foreach ($b in $btns) { if ($b.Current.Name -like '*Agent Attention*') { $el = $b; break } }
    }
    if ($el) { break }
    Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        if ($p.ExecutablePath -match 'powershell\.exe$' -and $p.IsPromoted -ne 1) { Set-ItemProperty -Path $_.PSPath -Name IsPromoted -Value 1 -Type DWord -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 4
}
if (-not $el) { Write-Host "NO ICON"; exit 1 }
$rr = $el.Current.BoundingRectangle
$x = [int]($rr.X + $rr.Width/2); $y = [int]($rr.Y + $rr.Height/2)
Write-Host "right-click at ($x,$y)"
$before = Snap
[UJ]::SetCursorPos($x,$y) | Out-Null; Start-Sleep -Milliseconds 300
[UJ]::mouse_event(8,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [UJ]::mouse_event(0x10,0,0,0,[UIntPtr]::Zero)
for ($wait = 1; $wait -le 5; $wait++) {
    Start-Sleep -Seconds 1
    $after = Snap
    $newKeys = @($after.Keys | Where-Object { -not $before.ContainsKey($_) })
    if ($newKeys.Count -gt 0) {
        foreach ($k in $newKeys) {
            $w = $after[$k]
            Write-Host "NEW[$wait]: class=$($w.Current.ClassName) name='$($w.Current.Name)' type=$($w.Current.ControlType.ProgrammaticName) pid=$($w.Current.ProcessId)"
            $names = @()
            foreach ($d in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,$cond)) { if ($d.Current.Name) { $names += $d.Current.Name } }
            if ($names.Count -gt 0) { Write-Host "   items: $($names -join ' | ')" }
        }
        break
    } else { Write-Host "[$wait] no new windows yet" }
}
