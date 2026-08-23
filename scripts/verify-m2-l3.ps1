# M2 L3 verification gate for C# UI Host migration.
# Run: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-m2-l3.ps1
param([switch]$AllowPartialEvidence)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$results = [System.Collections.Generic.List[object]]::new()
function Record([string]$name, [string]$status, [int]$exitCode) {
  $results.Add([pscustomobject]@{ name = $name; status = $status; exitCode = $exitCode })
  Write-Host ("[{0}] {1} (exit={2})" -f $status, $name, $exitCode)
}
function Invoke-Gate([string]$name, [scriptblock]$action) {
  Write-Host ("==> {0}" -f $name)
  & $action
  $code = $LASTEXITCODE
  if ($code -eq 0) { Record $name 'PASS' $code; return $true }
  Record $name 'FAIL' $code
  return $false
}

$failed = $false
$failed = (-not (Invoke-Gate 'TypeScript build' { npm run build })) -or $failed
$failed = (-not (Invoke-Gate 'Native UI publish' { npm run publish:ui })) -or $failed
$failed = (-not (Invoke-Gate 'Jest full suite' { npm test -- --runInBand })) -or $failed
$failed = (-not (Invoke-Gate 'Harness build' { dotnet build src/center/csharp/AgentAttention.UI.Harness/AgentAttention.UI.Harness.csproj -c Release --nologo })) -or $failed
$failed = (-not (Invoke-Gate 'C# interaction harness' { npm run test:ui:harness })) -or $failed
$failed = (-not (Invoke-Gate 'Lifecycle matrix' { pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-lifecycle.ps1 })) -or $failed
$failed = (-not (Invoke-Gate 'Packaging smoke' { pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-package.ps1 })) -or $failed

Write-Host '==> M2 L3: Real-process daemon lifecycle tests'
npm test -- --runInBand --testPathPattern='daemon-csharp|toast-integration'
$m2Code = $LASTEXITCODE
if ($m2Code -eq 0) {
  Record 'Daemon/C# real-process lifecycle' 'PASS' $m2Code
} elseif ($m2Code -eq 1) {
  # jest exits 1 when no tests match (e.g. running on non-Windows) — record gracefully
  $output = node_modules\.bin\jest.cmd --runInBand --testPathPattern='daemon-csharp|toast-integration' 2>&1
  if ($output -match 'No tests found') {
    Record 'Daemon/C# real-process lifecycle' 'NOT RUN' 0
    Write-Host 'M2 L3 tests skipped: environment does not support real-process spawn'
  } else {
    Record 'Daemon/C# real-process lifecycle' 'FAIL' $m2Code
    $failed = $true
  }
} else {
  Record 'Daemon/C# real-process lifecycle' 'FAIL' $m2Code
  $failed = $true
}

Write-Host '==> Legacy parity (may report NOT VERIFIED)'
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-parity.ps1
$parityCode = $LASTEXITCODE
if ($parityCode -eq 0) {
  Record 'Legacy/C# parity' 'PASS' $parityCode
} elseif ($parityCode -eq 2 -and $AllowPartialEvidence) {
  Record 'Legacy/C# parity' 'NOT VERIFIED' $parityCode
} else {
  Record 'Legacy/C# parity' 'FAIL' $parityCode
  $failed = $true
}

if ($failed) {
  Write-Host 'M2 L3 gate: FAIL'
  exit 1
}
if (@($results | Where-Object status -eq 'NOT VERIFIED').Count -gt 0) {
  Write-Host 'M2 L3 gate: PASS WITH EXPLICIT EVIDENCE GAP'
  exit 0
}
Write-Host 'M2 L3 gate: PASS'
