$ErrorActionPreference = 'Stop'
$centerPath = Join-Path $PSScriptRoot 'CenterWindow.ps1'
$script:StatePath = "$env:USERPROFILE\.agent-attention\state.json"
$script:cliPath = 'D:\Projects\Active\agent-attention\dist\daemon-cli.js'

$launchArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$centerPath`""
          , '-StatePath', $script:StatePath)
if ($script:cliPath) {
    $stateDir = Split-Path $script:StatePath -Parent
    $launchArgs += '-RegistryPath', (Join-Path $stateDir 'agents.json')
}
$i=0; foreach($e in $launchArgs){ Write-Host ("[{0}] type={1} val={2}" -f $i,$e.GetType().FullName,$e); $i++ }

Write-Host "--- T1: cast [string[]]"
try { Start-Process powershell -ArgumentList ([string[]]$launchArgs) -WindowStyle Hidden; Write-Host "T1 OK" } catch { Write-Host "T1 ERR: $_" }
Start-Sleep -Seconds 3
Write-Host "--- T2: joined single string"
try { Start-Process powershell -ArgumentList ($launchArgs -join ' ') -WindowStyle Hidden; Write-Host "T2 OK" } catch { Write-Host "T2 ERR: $_" }
Start-Sleep -Seconds 3
Write-Host "--- T3: inline array literal"
try { Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 30' -WindowStyle Hidden; Write-Host "T3 OK" } catch { Write-Host "T3 ERR: $_" }
Start-Sleep -Seconds 2
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*CenterWindow.ps1*' -or $_.CommandLine -like '*Start-Sleep 30*' } | ForEach-Object { Write-Host "spawned pid=$($_.ProcessId): $($_.CommandLine.Substring(0,[Math]::Min(120,$_.CommandLine.Length)))" }
