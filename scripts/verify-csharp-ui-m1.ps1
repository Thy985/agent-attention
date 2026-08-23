# Reproducible M1 evidence gate for the C# UI Host migration.
# Run: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-ui-m1.ps1
# Add -AllowPartialEvidence only when a non-functional evidence item is explicitly NOT VERIFIED.
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
$failed = (-not (Invoke-Gate 'TypeScript/Jest regression' { npm test -- --runInBand })) -or $failed
$failed = (-not (Invoke-Gate 'Harness build' { dotnet build src/center/csharp/AgentAttention.UI.Harness/AgentAttention.UI.Harness.csproj -c Release --nologo })) -or $failed
$failed = (-not (Invoke-Gate 'C# interaction harness' { npm run test:ui:harness })) -or $failed
$failed = (-not (Invoke-Gate 'Lifecycle matrix' { pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-lifecycle.ps1 })) -or $failed

Write-Host '==> Legacy PowerShell/C# behavioral parity'
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

$failed = (-not (Invoke-Gate 'Packaging/install smoke' { pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-package.ps1 })) -or $failed

if ($failed) {
  Write-Host 'M1 C# UI Host gate: FAIL'
  exit 1
}
if (@($results | Where-Object status -eq 'NOT VERIFIED').Count -gt 0) {
  Write-Host 'M1 C# UI Host gate: PASS WITH EXPLICIT EVIDENCE GAP'
  exit 0
}
Write-Host 'M1 C# UI Host gate: PASS'
