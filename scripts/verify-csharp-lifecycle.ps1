# M1 lifecycle matrix for the native UI host.
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-lifecycle.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root 'src\center\csharp\dist\win-x64\AgentAttention.UI.exe'

if (-not (Test-Path $exe)) { throw "Native UI artifact not found: $exe" }

$results = New-Object System.Collections.Generic.List[object]
$script:startedHosts = New-Object System.Collections.Generic.List[object]
function Record([string]$name, [bool]$passed, [string]$detail = '') {
  $script:results.Add([pscustomobject]@{ name = $name; passed = $passed; detail = $detail })
  Write-Host ("[{0}] {1}{2}" -f ($(if ($passed) { 'PASS' } else { 'FAIL' })), $name, $(if ($detail) { " -- $detail" } else { '' }))
}

function New-Fixture {
  $directory = Join-Path ([IO.Path]::GetTempPath()) ("agent-attention-lifecycle-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $directory | Out-Null
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $state = [ordered]@{
    version = 1; updatedAt = $now; unreadCount = 1; visible = $true
    events = @(@{
      id = 'lifecycle-event'; timestamp = $now; type = 'input_required'; priority = 'P0'
      agent_id = 'codex'; agent_name = 'Codex'; title = 'Codex needs input'
      message = 'M1 lifecycle'; read = $false
    })
  }
  $registry = [ordered]@{ agents = @(@{ agent_id = 'codex'; name = 'Codex'; target = $null }) }
  $statePath = Join-Path $directory 'state.json'
  $trayStatePath = Join-Path $directory 'tray-state.json'
  $registryPath = Join-Path $directory 'agents.json'
  $daemonPidPath = Join-Path $directory 'daemon.pid'
  $cliPath = Join-Path $directory 'fake-cli.js'
  ($state | ConvertTo-Json -Depth 6) | Set-Content $statePath
  ($state | ConvertTo-Json -Depth 6) | Set-Content $trayStatePath
  ($registry | ConvertTo-Json -Depth 5) | Set-Content $registryPath
  "$PID" | Set-Content $daemonPidPath
  @'
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(__dirname, 'cli-calls.log'), JSON.stringify(process.argv.slice(2)) + '\n');
'@ | Set-Content $cliPath
  [pscustomobject]@{
    directory=$directory; state=$statePath; trayState=$trayStatePath; registry=$registryPath
    daemonPid=$daemonPidPath; cli=$cliPath
  }
}

function Start-Host([object]$fixture, [string]$logPath, [switch]$openCenter) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  foreach ($argument in @('-StatePath',$fixture.state,'-RegistryPath',$fixture.registry,'-CliPath',$fixture.cli,'-TrayStatePath',$fixture.trayState)) {
    [void]$psi.ArgumentList.Add($argument)
  }
  if ($openCenter) { [void]$psi.ArgumentList.Add('-OpenCenter') }
  $psi.EnvironmentVariables['AGENT_ATTENTION_UI_LOG'] = $logPath
  $process = [System.Diagnostics.Process]::Start($psi)
  $script:startedHosts.Add($process)
  return $process
}

function Wait-Exit([System.Diagnostics.Process]$process, [int]$milliseconds) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($milliseconds)
  while ((-not $process.HasExited) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  return $process.HasExited
}

try {
  # Start / second instance / activation.
  $fixture = New-Fixture
  $firstLog = Join-Path $fixture.directory 'first.log'
  $secondLog = Join-Path $fixture.directory 'second.log'
  $activationLog = Join-Path $fixture.directory 'activator.log'
  $first = Start-Host $fixture $firstLog
  Start-Sleep -Seconds 2
  Record 'start/host remains running' ((-not $first.HasExited)) ("pid=" + $first.Id)

  $second = Start-Host $fixture $secondLog
  [void](Wait-Exit $second 3000)
  Start-Sleep -Seconds 1
  Record 'start again/second exits zero' ($second.HasExited -and $second.ExitCode -eq 0) ("exitCode=" + $(if ($second.HasExited) { $second.ExitCode } else { '<running>' }))
  Record 'start again/first remains' (-not $first.HasExited)
  Record 'start again/no duplicate host process' ((@(Get-Process -Name AgentAttention.UI -ErrorAction SilentlyContinue).Count -eq 1)) ("count=" + @(Get-Process -Name AgentAttention.UI -ErrorAction SilentlyContinue).Count)

  $activator = Start-Host $fixture $activationLog -OpenCenter
  [void](Wait-Exit $activator 3000)
  Start-Sleep -Seconds 1
  $first.Refresh() | Out-Null
  $activationSeen = (Test-Path $firstLog) -and (Get-Content $firstLog -Raw) -match 'activation received'
  Record '-OpenCenter/activator exits zero' ($activator.HasExited -and $activator.ExitCode -eq 0)
  Record '-OpenCenter/original receives activation event' $activationSeen
  Record '-OpenCenter/original remains' (-not $first.HasExited)

  # End the manually orchestrated phase before testing daemon ownership.
  $manualTrayState = Join-Path $fixture.directory 'tray-state.manual-stopped'
  Rename-Item -LiteralPath $fixture.trayState -NewName (Split-Path $manualTrayState -Leaf)
  [void](Wait-Exit $first 5000)
  Record 'manual phase/original exits on stop signal' ($first.HasExited -and $first.ExitCode -eq 0)

  # Real daemon-owned stop through createDaemon(), not direct file deletion.
  $daemonHarness = @'
const fs = require('fs');
const path = require('path');
const { createDaemon } = require(process.env.AGENT_ATTENTION_DAEMON_MODULE);
const fixture = JSON.parse(fs.readFileSync(process.env.AGENT_ATTENTION_FIXTURE, 'utf8'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
(async () => {
  const summaryPath = process.env.AGENT_ATTENTION_SUMMARY;
  const daemon = createDaemon({
    statePath: fixture.state,
    powerShellPath: 'powershell',
    trayScriptPath: 'src/center/TrayIcon.ps1',
    trayStatePath: fixture.trayState,
    trayPidPath: fixture.trayPid,
    cliPath: fixture.cli,
    uiExecutablePath: fixture.exe,
    debug: true,
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const uiPid = Number(fs.readFileSync(fixture.trayPid, 'utf8'));
  const uiAliveBeforeStop = alive(uiPid);
  await daemon.stop();
  await new Promise(resolve => setTimeout(resolve, 500));
  fs.writeFileSync(summaryPath, JSON.stringify({ uiPid, uiAliveBeforeStop, uiAliveAfterStop: alive(uiPid) }));
})().catch(error => { console.error(error); process.exit(1); });
'@
  $daemonHarnessPath = Join-Path $fixture.directory 'daemon-harness.js'
  Set-Content -LiteralPath $daemonHarnessPath -Value $daemonHarness
  $fixtureData = @{
    state=$fixture.state; trayState=$fixture.trayState; trayPid=(Join-Path $fixture.directory 'tray.pid')
    cli=$fixture.cli; exe=$exe
  } | ConvertTo-Json -Compress
  $summaryPath = Join-Path $fixture.directory 'daemon-summary.json'
  $env:AGENT_ATTENTION_DAEMON_MODULE = Join-Path $root 'dist\daemon.js'
  $env:AGENT_ATTENTION_FIXTURE = Join-Path $fixture.directory 'fixture.json'
  $env:AGENT_ATTENTION_SUMMARY = $summaryPath
  Set-Content -LiteralPath $env:AGENT_ATTENTION_FIXTURE -Value $fixtureData
  $nodeOutput = & node $daemonHarnessPath 2>&1
  $nodeCode = $LASTEXITCODE
  if ($nodeCode -ne 0) { throw "daemon harness failed: $($nodeOutput -join ' ')" }
  $summary = Get-Content $summaryPath -Raw | ConvertFrom-Json
  Record 'daemon stop/UI pid assigned' ($summary.uiPid -gt 0) ("uiPid=" + $summary.uiPid)
  Record 'daemon stop/UI alive before stop' $summary.uiAliveBeforeStop
  Record 'daemon stop/UI exits and no zombie' (-not $summary.uiAliveAfterStop)

  # Restart creates a new Host PID; each daemon still owns graceful cleanup.
  $restartSummaries = @()
  foreach ($round in 1..2) {
    $roundFixturePath = Join-Path $fixture.directory "restart-fixture-$round.json"
    $roundSummaryPath = Join-Path $fixture.directory "restart-summary-$round.json"
    $trayPidPath = Join-Path $fixture.directory "restart-tray-$round.pid"
    $roundFixture = @{
      state=$fixture.state; trayState=$fixture.trayState; trayPid=$trayPidPath
      cli=$fixture.cli; exe=$exe
    } | ConvertTo-Json -Compress
    Set-Content -LiteralPath $roundFixturePath -Value $roundFixture
    $env:AGENT_ATTENTION_FIXTURE = $roundFixturePath
    $env:AGENT_ATTENTION_SUMMARY = $roundSummaryPath
    [void](& node $daemonHarnessPath 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "daemon restart round $round failed" }
    $restartSummaries += Get-Content $roundSummaryPath -Raw | ConvertFrom-Json
  }
  Record 'daemon restart/new Host PID' ($restartSummaries[0].uiPid -ne $restartSummaries[1].uiPid) ("pids=$($restartSummaries[0].uiPid),$($restartSummaries[1].uiPid)")
  Record 'daemon restart/no zombie after either run' (($false -eq $restartSummaries[0].uiAliveAfterStop) -and ($false -eq $restartSummaries[1].uiAliveAfterStop))
}
finally {
  foreach ($process in $script:startedHosts) {
    try { if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(2000) } } catch {}
  }
}

$failed = @($results | Where-Object { -not $_.passed }).Count
$total = $results.Count
Write-Host ("M1 lifecycle matrix: passed={0} failed={1} total={2}" -f ($total - $failed), $failed, $total)
exit $(if ($failed -eq 0) { 0 } else { 1 })
