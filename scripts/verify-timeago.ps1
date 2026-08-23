# L3 verification: extract Get-TimeAgo from the REAL CenterWindow.ps1 and
# run it against the SYSTEM_MAP §7 time-boundary oracle matrix.
$ErrorActionPreference = 'Stop'

$src = Get-Content (Join-Path $PSScriptRoot '..\src\center\CenterWindow.ps1') -Raw

# Extract the Get-TimeAgo function block from the real source (brace-counting)
$start = $src.IndexOf('function Get-TimeAgo')
if ($start -lt 0) { throw 'Get-TimeAgo not found in source' }
$bodyStart = $src.IndexOf('{', $start)
$depth = 1; $i = $bodyStart + 1
while ($depth -gt 0 -and $i -lt $src.Length) {
    $ch = $src[$i]
    if ($ch -eq '{') { $depth++ }
    elseif ($ch -eq '}') { $depth-- }
    $i++
}
$fnText = $src.Substring($start, $i - $start)
Invoke-Expression $fnText

$now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$cases = @(
    @{ name='0s';     offsetMs=0;                 expected='^0s ago$' },
    @{ name='30s';    offsetMs=30000;             expected='^30s ago$' },
    @{ name='59s';    offsetMs=59000;             expected='^59s ago$' },
    @{ name='60s';    offsetMs=60000;             expected='^1m ago$' },
    @{ name='59m';    offsetMs=59*60000;          expected='^59m ago$' },
    @{ name='60m';    offsetMs=60*60000;          expected='^1h ago$' },
    @{ name='23h59m'; offsetMs=(23*60+59)*60000;  expected='^23h ago$' },
    @{ name='24h';    offsetMs=24*3600000;        expected='^1d ago$' },
    @{ name='48h';    offsetMs=48*3600000;        expected='^2d ago$' },
    @{ name='7d';     offsetMs=7*24*3600000;      expected='^7d ago$' }
)

$pass = 0; $fail = 0
foreach ($c in $cases) {
    $result = Get-TimeAgo ($now - $c.offsetMs)
    $ok = $result -match $c.expected
    if ($ok) { $pass++ } else { $fail++ }
    $mark = if ($ok) { 'PASS' } else { 'FAIL' }
    Write-Host ("[{0}] {1,-6} -> '{2}'   (expected /{3}/)" -f $mark, $c.name, $result, $c.expected)
}
Write-Host ""
Write-Host "Get-TimeAgo boundary oracle: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 } else { exit 0 }
