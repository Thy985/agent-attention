# agent-attention Known Issue Regression Suite
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/regression-test.ps1

param(
    [string]$ProjectRoot = "D:\Projects\Active\agent-attention"
)

Set-Location $ProjectRoot

$cli = Join-Path $ProjectRoot "dist\daemon-cli.js"
$notify = Join-Path $ProjectRoot "dist\index.js"
$results = @{}

Write-Host "============================================================"
Write-Host "   agent-attention Regression Suite"
Write-Host "============================================================"

# R1: CLI triggers VS Code
Write-Host ""
Write-Host "[R1] CLI does not trigger VS Code"
$before = (Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Measure-Object).Count
& $cli doctor 2>&1 | Out-Null
Start-Sleep 1
$after = (Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Measure-Object).Count
$results["R1"] = $after -le $before
Write-Host "  Code: $before -> $after $(if($results["R1"]){'PASS'}else{'FAIL'})"

# R2: Single instance check
Write-Host ""
Write-Host "[R2] Single instance check"
$tray = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'TrayIcon' }).Count
$daemon = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'daemon\.js' }).Count
$results["R2"] = $tray -le 1 -and $daemon -le 1
Write-Host "  tray=$tray daemon=$daemon $(if($results["R2"]){'PASS'}else{'FAIL'})"

# R3: Center null protection
Write-Host ""
Write-Host "[R3] Center null protection"
$content = Get-Content "src/center/CenterWindow.ps1" -Raw
$results["R3"] = $content -match 'IsDisposed'
Write-Host "  IsDisposed: $(if($results["R3"]){'PASS'}else{'FAIL'})"

# R4: PS5.1 compatibility
Write-Host ""
Write-Host "[R4] PS5.1 compatibility (::new check)"
$ps1Files = @("src/center/CenterWindow.ps1", "src/center/TrayIcon.ps1")
$allGood = $true
foreach ($f in $ps1Files) {
    $c = Get-Content $f -Raw
    if ($c -match '::new\(') {
        Write-Host "  $f : still has ::new()"
        $allGood = $false
    }
}
$results["R4"] = $allGood
Write-Host "  $(if($results["R4"]){'PASS'}else{'FAIL'})"

# R5: daemon lifecycle
Write-Host ""
Write-Host "[R5] daemon lifecycle"
& $cli daemon stop 2>&1 | Out-Null
Start-Sleep 1
$before = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*daemon*' }).Count
& $cli daemon start 2>&1 | Out-Null
Start-Sleep 2
$after = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*daemon*' }).Count
$started = $after -ge 1
& $cli daemon stop 2>&1 | Out-Null
Start-Sleep 1
$final = (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*daemon*' }).Count
$results["R5"] = $started -and $final -le 1
Write-Host "  start=$started cleanup=$final $(if($results["R5"]){'PASS'}else{'FAIL'})"

# R6: notify does not trigger VS Code
Write-Host ""
Write-Host "[R6] notify does not trigger VS Code"
$before = (Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Measure-Object).Count
& $notify completed "test" 2>&1 | Out-Null
Start-Sleep 1
$after = (Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Measure-Object).Count
$results["R6"] = $after -le $before
Write-Host "  Code: $before -> $after $(if($results["R6"]){'PASS'}else{'FAIL'})"

Write-Host ""
Write-Host "============================================================"
$pass = ($results.Values | Where-Object { $_ }).Count
$fail = ($results.Values | Where-Object { -not $_ }).Count
Write-Host "Result: $pass/$($results.Count) PASS"
Write-Host "============================================================"

exit $(if ($fail -gt 0) { 1 } else { 0 })
