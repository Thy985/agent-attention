# E2E Ghost Icon Test
Write-Host "=== 完全清理 ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "daemon\.js" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -like "*TrayIcon.ps1*" } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep 5
Remove-Item "$env:USERPROFILE\.agent-attention\*.pid" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.agent-attention\tray-state.json" -Force -ErrorAction SilentlyContinue

function Get-TrayCount {
    $self = [System.Diagnostics.Process]::GetCurrentProcess().Id
    return (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "powershell.exe" -and $_.CommandLine -like "*TrayIcon.ps1*" -and $_.ProcessId -ne $self } | Measure-Object).Count
}

function Get-DaemonCount {
    return (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "daemon\.js" } | Measure-Object).Count
}

Write-Host ""
Write-Host "--- Test 1: Graceful start/stop ---"
& agent-attention daemon start 2>&1
Start-Sleep 6
Write-Host ("Running: daemon=" + (Get-DaemonCount) + " tray=" + (Get-TrayCount))

& agent-attention daemon stop 2>&1
Start-Sleep 8
$v1 = Get-TrayCount
if ($v1 -eq 0) { Write-Host "Stop orphan: $v1 PASS" } else { Write-Host "Stop orphan: $v1 FAIL" }

Write-Host ""
Write-Host "--- Test 2: Crash ---"
& agent-attention daemon start 2>&1
Start-Sleep 5
$daemonPid = Get-Content "$env:USERPROFILE\.agent-attention\daemon.pid"
Write-Host ("daemon.pid=" + $daemonPid)
Stop-Process -Id $daemonPid -Force
Start-Sleep 4
$v2 = Get-TrayCount
if ($v2 -eq 0) { Write-Host "Crash orphan: $v2 PASS" } else { Write-Host "Crash orphan: $v2 FAIL" }

Write-Host ""
Write-Host "--- Test 3: Restart ---"
& agent-attention daemon start 2>&1
Start-Sleep 5
$v3 = Get-TrayCount
if ($v3 -le 1) { Write-Host "Restart tray: $v3 PASS" } else { Write-Host "Restart tray: $v3 FAIL" }

& agent-attention daemon stop 2>&1
Start-Sleep 8
$v4 = Get-TrayCount
if ($v4 -eq 0) { Write-Host "Final orphan: $v4 PASS - no ghost icons" } else { Write-Host "Final orphan: $v4 FAIL" }

Write-Host ""
& agent-attention doctor
