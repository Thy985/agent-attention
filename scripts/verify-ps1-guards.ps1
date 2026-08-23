# Static regression guards for the PowerShell UI scripts.
# Runs on any Windows PowerShell 5.1+ (no Pester dependency).
# Covers: P0-1 (GetNewClosure removal), P0-2 (DoEvents guard),
#         P1-9 (WPF RemoveChild), P1-13 (Get-TimeAgo day branch),
#         P1-11 ($script:cliPath resolution).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$tray = Get-Content (Join-Path $root 'src\center\TrayIcon.ps1') -Raw
$center = Get-Content (Join-Path $root 'src\center\CenterWindow.ps1') -Raw

$pass = 0; $fail = 0
function Check($name, $ok) {
    if ($ok) { $script:pass++ ; Write-Host "[PASS] $name" }
    else     { $script:fail++ ; Write-Host "[FAIL] $name" }
}

# --- P0-1: no .GetNewClosure() anywhere in TrayIcon.ps1 ---
Check 'P0-1: TrayIcon.ps1 has zero .GetNewClosure() calls' (-not ($tray -match '\.GetNewClosure\(\)'))

# --- P0-2: ThreadException handler registered + DoEvents wrapped in try/catch ---
Check 'P0-2a: Application.ThreadException handler registered' (($tray -match 'add_ThreadException') -and ($tray -match 'SetUnhandledExceptionMode'))
$idx = $tray.IndexOf('::DoEvents()')
$before = if ($idx -ge 0) { $tray.Substring([Math]::Max(0, $idx - 300), [Math]::Min(300, $idx)) } else { '' }
$lastTry = $before.LastIndexOf('try {')
$lastCatchClose = $before.LastIndexOf('} catch {')
Check 'P0-2b: DoEvents() is inside a try block' ($idx -ge 0 -and $lastTry -gt $lastCatchClose)

# --- P1-9: WPF RemoveChild replaced with Children.Remove ---
$badRemove = [regex]::IsMatch($center, '\.Parent\.RemoveChild\(')
$goodRemove = [regex]::IsMatch($center, '\.Parent\.Children\.Remove\(')
Check 'P1-9a: no Parent.RemoveChild( in CenterWindow.ps1' (-not $badRemove)
Check 'P1-9b: uses Parent.Children.Remove( instead' $goodRemove

# --- P1-13: Get-TimeAgo day branch computes into a local first ---
# Strip full-line comments first so quoted old code in explanations doesn't match.
$centerCode = ($center -split "`n" | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
$badDays = [regex]::IsMatch($centerCode, '\$\{\[math\]::Floor\(\$hours\s*/\s*24\)\}d ago')
$goodDaysCalc = [regex]::IsMatch($centerCode, '\$days\s*=\s*\[math\]::Floor\(\$hours\s*/\s*24\)')
$goodDaysUse = [regex]::IsMatch($centerCode, '"\$\{days\}d ago"')
Check 'P1-13a: buggy nested-interpolation form removed' (-not $badDays)
Check 'P1-13b: days computed then interpolated' ($goodDaysCalc -and $goodDaysUse)

# --- P1-11: Start-Tray assigns resolved local $cliPath to $script:cliPath ---
$cliGood = [regex]::IsMatch($tray, '\$script:cliPath\s*=\s*\$cliPath\b')
$cliBad = [regex]::IsMatch($tray, '\$script:cliPath\s*=\s*\$CliPath\b')
Check 'P1-11: script:cliPath gets resolved local, not raw param' ($cliGood -and (-not $cliBad))

# --- P1-10/Center node fallback: explicit 'node' default next to env uses ---
$nodeUses = [regex]::Matches($center, '\$env:AGENT_ATTENTION_NODE').Count
$fallbacks = [regex]::Matches($center, "= 'node' \}").Count
Check 'P1-10: AGENT_ATTENTION_NODE uses have explicit node fallback' ($nodeUses -ge 3 -and $fallbacks -ge 2)

Write-Host ''
Write-Host "PS1 static guards: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 } else { exit 0 }
