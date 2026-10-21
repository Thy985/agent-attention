# Windows Target Jump + notification lifecycle acceptance (PowerShell 5.1+).
# Run in an ordinary interactive Windows desktop, NOT an elevated/headless CI session.
# This script creates one uniquely named test agent and up to three test events.
# It never clears other events or changes existing agents' targets. No focus-policy hacks.
[CmdletBinding()]
param(
  [string]$AgentId = '',
  [int]$TargetProcessId = 0,
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent),
  [string]$OutputDirectory = '',
  [switch]$AllowRestart
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::UserInteractive) {
  throw 'An interactive Windows desktop is required; no Windows acceptance was performed.'
}
if ($env:AGENT_ATTENTION_HOME -and $env:AGENT_ATTENTION_HOME -ne (Join-Path $env:USERPROFILE '.agent-attention')) {
  throw 'Custom AGENT_ATTENTION_HOME is not supported consistently by this version. No state has been changed.'
}
$RepoRoot = (Resolve-Path $RepoRoot).Path
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $RepoRoot 'dist\daemon-cli.js'
$notify = Join-Path $RepoRoot 'dist\index.js'
if (-not (Test-Path $cli) -or -not (Test-Path $notify)) { throw 'Build this patched checkout first: npm run build' }
$stateDirectory = Join-Path $env:USERPROFILE '.agent-attention'
$statePath = Join-Path $stateDirectory 'state.json'
$registryPath = Join-Path $stateDirectory 'agents.json'
$testId = 'acceptance-' + [Guid]::NewGuid().ToString('N').Substring(0,12)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $env:TEMP ('aa-acceptance-' + $testId) }
[void](New-Item -ItemType Directory -Force -Path $OutputDirectory)
$report = [ordered]@{ environment=@{windowsVersion=[Environment]::OSVersion.VersionString; powershellVersion=$PSVersionTable.PSVersion.ToString(); nodeVersion=(& $node --version)}; schema=1; startedAt=[DateTime]::UtcNow.ToString('o'); testId=$testId; checks=@(); foregroundSamples=@(); notes=@(); complete=$false }
$processes = @()
$oldAgentId=$env:AGENT_ID; $oldAgentName=$env:AGENT_NAME
$oldTimeout=$env:AGENT_ATTENTION_NOTIFY_TIMEOUT_MS
# UTF-8 scripts are ASCII-only except runtime data, so PS5.1 needs no encoding changes.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AAObserveNative {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
"@
function Add-Check([string]$name,[string]$outcome,$evidence) {
  $report.checks += [ordered]@{ name=$name; outcome=$outcome; evidence=$evidence }
  Write-Host ('[{0}] {1}' -f $outcome,$name)
}
function Read-Json([string]$file) {
  if (-not (Test-Path $file)) { return $null }
  # Bounded retries for a concurrent atomic file replacement; never write fallback state.
  for ($i=0;$i -lt 5;$i++) {
    try { return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json) }
    catch { if ($i -eq 4) { throw "Could not parse $file; no state was rewritten." }; Start-Sleep -Milliseconds 100 }
  }
}
function Snapshot {
  $s=Read-Json $statePath
  if (-not $s) { return @{ available=$false; events=@(); total=0 } }
  return @{ available=$true; total=@($s.events).Count; unreadCount=$s.unreadCount; events=@($s.events | Where-Object { $_.agent_id -eq $testId } | ForEach-Object { @{id=$_.id; type=$_.type; read=[bool]$_.read; timestamp=$_.timestamp} }) }
}
function Foreground {
  $h=[AAObserveNative]::GetForegroundWindow(); [uint32]$owner=0
  [void][AAObserveNative]::GetWindowThreadProcessId($h,[ref]$owner)
  return @{ hwnd=$h.ToInt64().ToString(); pid=$owner; at=[DateTime]::UtcNow.ToString('o') }
}
function Run-Node([string[]]$arguments,[int]$timeoutSeconds=45) {
  # All arguments are files or controlled single-line test IDs/messages; no shell execution.
  $p=New-Object System.Diagnostics.Process
  $p.StartInfo.FileName=$node
  $p.StartInfo.Arguments=(($arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' ')
  $p.StartInfo.UseShellExecute=$false; $p.StartInfo.CreateNoWindow=$true
  $p.StartInfo.RedirectStandardOutput=$true; $p.StartInfo.RedirectStandardError=$true
  [void]$p.Start()
  $outTask=$p.StandardOutput.ReadToEndAsync(); $errTask=$p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSeconds*1000)) {
    # Stop only the specific CLI process started here; no arbitrary process cleanup.
    try { $p.Kill() } catch {}
    throw "CLI timed out: $($arguments[1])"
  }
  $out=$outTask.GetAwaiter().GetResult(); $err=$errTask.GetAwaiter().GetResult()
  $r=@{exitCode=$p.ExitCode; stdout=$out.Trim(); stderr=$err.Trim()}; $p.Dispose(); return $r
}
function Daemon-Identity {
  $pidFile=Join-Path $stateDirectory 'daemon.pid'
  if (-not (Test-Path $pidFile)) { return @{running=$false; fromThisCheckout=$false} }
  [int]$daemonId=0
  if (-not [int]::TryParse((Get-Content $pidFile -Raw).Trim(),[ref]$daemonId)) { return @{running=$false; fromThisCheckout=$false} }
  $p=Get-CimInstance Win32_Process -Filter "ProcessId = $daemonId" -ErrorAction SilentlyContinue
  $expected=(Join-Path $RepoRoot 'dist\daemon.js').Replace('/','\')
  $owned=$p -and $p.CommandLine -and $p.CommandLine.Replace('/','\').IndexOf($expected,[StringComparison]::OrdinalIgnoreCase) -ge 0
  return @{pid=$daemonId; running=[bool]$p; fromThisCheckout=[bool]$owned}
}
try {
  $registry=Read-Json $registryPath
  if ($AgentId) {
    $source=@($registry.agents | Where-Object { $_.agent_id -eq $AgentId })
    if ($source.Count -ne 1 -or -not $source[0].target) { throw 'Selected agent has no registered target. No state was changed.' }
    if ($TargetProcessId -eq 0) { $TargetProcessId=[int]$source[0].target.pid }
  }
  if ($TargetProcessId -eq 0) {
    $candidates=@($registry.agents | Where-Object { $_.target -and $_.target.pid -gt 0 })
    if ($candidates.Count -eq 0) { throw 'No registered target. Re-run with -TargetProcessId <PID of the intended visible terminal host>.' }
    for($i=0;$i -lt $candidates.Count;$i++) { Write-Host ("{0}: {1} (PID {2})" -f ($i+1),$candidates[$i].agent_id,$candidates[$i].target.pid) }
    $choice=Read-Host 'Choose the target to test (number)'
    [int]$n=0
    if (-not [int]::TryParse($choice,[ref]$n) -or $n -lt 1 -or $n -gt $candidates.Count) { throw 'No valid target selected.' }
    $TargetProcessId=[int]$candidates[$n-1].target.pid
  }
  if ($TargetProcessId -le 0) { throw 'Target PID must be positive.' }
  $target=Get-Process -Id $TargetProcessId -ErrorAction Stop; $target.Refresh()
  $targetHwnd=$target.MainWindowHandle.ToInt64().ToString()
  $report.target=@{pid=$TargetProcessId; processName=$target.ProcessName; sessionId=$target.SessionId; hwnd=$targetHwnd; observerSession=(Get-Process -Id $PID).SessionId}
  # Parent chain reveals a shell-vs-window-host mismatch without recording command lines/titles.
  $report.targetParents=@(); $ancestor=$TargetProcessId
  for($i=0;$i -lt 6;$i++) {
    $a=Get-CimInstance Win32_Process -Filter "ProcessId = $ancestor" -ErrorAction SilentlyContinue
    if(-not $a) { break }
    $ap=Get-Process -Id $ancestor -ErrorAction SilentlyContinue
    $report.targetParents+=@{pid=$ancestor; parentPid=$a.ParentProcessId; name=$a.Name; hwnd=$(if($ap){$ap.MainWindowHandle.ToInt64().ToString()}else{'0'})}
    if($a.ParentProcessId -eq $ancestor -or $a.ParentProcessId -eq 0) { break }; $ancestor=[int]$a.ParentProcessId
  }
  Add-Check 'target owns a top-level MainWindowHandle' $(if($targetHwnd -ne '0'){'PASS'}else{'FAIL'}) $report.target
  if ($target.SessionId -ne (Get-Process -Id $PID).SessionId) { throw 'Target is in another session; no activation attempted.' }
  $snapshot=Snapshot
  if ($snapshot.total -gt 17) { throw 'State ring has more than 17 events. Refusing to evict history by adding test events. Use a spare Windows test account for the lifecycle test.' }
  Write-Host 'This adds three labeled test notifications and one test agent. Existing targets and read flags are not changed.'
  Write-Host 'Pause other agent emitters during the test. Do NOT click toast Dismiss or Mark all read (both mark unrelated events read); use only labeled test rows.'
  if ((Read-Host 'Continue? Type YES') -cne 'YES') { throw 'Cancelled before mutations.' }
  $registration=Run-Node @($cli,'agent','register',$testId,'Acceptance-test')
  if($registration.exitCode -ne 0) { throw 'Test agent registration failed.' }
  $setTarget=Run-Node @($cli,'agent','target','set',$testId,'--pid',[string]$TargetProcessId)
  if($setTarget.exitCode -ne 0) { throw 'Test target registration failed.' }
  $env:AGENT_ID=$testId; $env:AGENT_NAME='Acceptance-test'; $env:AGENT_ATTENTION_NOTIFY_TIMEOUT_MS='30000'
  $report.daemonBefore=Daemon-Identity
  if (-not $report.daemonBefore.running -or -not $report.daemonBefore.fromThisCheckout) {
    $report.notes+='Daemon is absent or runs from a different checkout. Lifecycle results cannot establish acceptance of this patch.'
    Add-Check 'patched checkout daemon' 'FAIL' $report.daemonBefore
  } else { Add-Check 'patched checkout daemon' 'PASS' $report.daemonBefore }
  foreach($eventType in @('completed','failed','input_required')) {
    if((Snapshot).total -ge 20) { throw 'State ring became full; stopped before evicting another event.' }
    Write-Host ("Sending {0}. Watch for its toast, click View, and inspect the labeled row in Center." -f $eventType)
    # Run async so the user can click while the notifier is still listening. Explicit per-process stdout/stderr files contain only this synthetic notification.
    $out=Join-Path $OutputDirectory ($eventType+'-notify.out.txt'); $err=Join-Path $OutputDirectory ($eventType+'-notify.err.txt')
    $args='"'+$notify+'" '+$eventType+' "AA-acceptance-'+$testId+'-'+$eventType+'"'
    $np=Start-Process -FilePath $node -ArgumentList $args -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    $processes+=@{process=$np; type=$eventType}
    $toast=(Read-Host 'Did that exact toast appear? y=yes, n=no, anything else=unobserved')
    Add-Check ($eventType+' toast visible') $(if($toast -eq 'y'){'USER-PASS'}elseif($toast -eq 'n'){'USER-FAIL'}else{'UNOBSERVED'}) 'Human observation, not inferred from CLI exit.'
    $center=(Read-Host 'Did View open Center with the labeled row? y/n (if toast absent, open Center manually and answer n)')
    Add-Check ($eventType+' View opens Center') $(if($center -eq 'y'){'USER-PASS'}elseif($center -eq 'n'){'USER-FAIL'}else{'UNOBSERVED'}) 'Human observation.'
    $s=Snapshot; $ev=@($s.events | Where-Object { $_.type -eq $eventType })
    Add-Check ($eventType+' event persisted') $(if($ev.Count -eq 1){'PASS'}else{'FAIL'}) $ev
    if($eventType -ne 'input_required') {
      [void](Read-Host 'Mark ONLY this test row read in Center, then return here and press Enter')
      $ev=@((Snapshot).events | Where-Object { $_.type -eq $eventType })
      Add-Check ($eventType+' UI read persisted') $(if($ev.Count -eq 1 -and $ev[0].read){'PASS'}else{'FAIL'}) $ev
    }
  }
  $report.jump=Run-Node @($cli,'jump',$testId,'--json') 15
  try { $report.jumpParsed=$report.jump.stdout | ConvertFrom-Json } catch { $report.jumpParsed=$null }
  Add-Check 'CLI activation observed' $(if($report.jump.exitCode -eq 0 -and $report.jumpParsed.ok){'PASS'}else{'FAIL'}) $report.jump
  # Observe a user-driven Center jump separately from CLI; do not send synthetic input.
  Write-Host 'In the next 15 seconds, open Center and click Jump on the Acceptance-test row. Do NOT manually click the target window.'
  Write-Host 'This checks a non-target -> target foreground transition; it does not bypass Windows focus rules.'
  $seenOther=$false; $sawTransition=$false; $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while([DateTime]::UtcNow -lt $deadline) {
    $fg=Foreground; $report.foregroundSamples+=$fg
    if($fg.hwnd -ne $targetHwnd){$seenOther=$true}
    if($targetHwnd -ne '0' -and $seenOther -and $fg.hwnd -eq $targetHwnd){$sawTransition=$true;break}
    Start-Sleep -Milliseconds 100
  }
  Add-Check 'Center Jump foreground transition observed' $(if($sawTransition){'PASS'}else{'FAIL'}) @{targetHwnd=$targetHwnd; nonTargetObserved=$seenOther; transition=$sawTransition}
  $uiJump=Read-Host 'Did you click ONLY Center Jump (not the target window) during that interval? y/n'
  Add-Check 'Center Jump interaction followed' $(if($uiJump -eq 'y'){'USER-PASS'}else{'UNOBSERVED'}) 'A foreground transition alone does not prove the click caused it.'
  $before=Snapshot; $report.beforeRestart=$before
  $identity=Daemon-Identity
  # The app's existing restart command cleans Agent Attention processes and writes its login startup hook.
  # Do not run that command if another checkout might be affected.
  $otherDaemons=@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop | Where-Object { $_.CommandLine -like '*daemon.js*' -and $_.CommandLine -like '*agent-attention*' -and $_.ProcessId -ne $identity.pid })
  $otherTrays=@(Get-CimInstance Win32_Process -Filter "Name = 'AgentAttention.UI.exe'" -ErrorAction Stop | Where-Object { -not $_.ExecutablePath -or -not $_.ExecutablePath.StartsWith($RepoRoot + '\',[StringComparison]::OrdinalIgnoreCase) })
  $restartSafe=($otherDaemons.Count -eq 0 -and $otherTrays.Count -eq 0)
  Write-Host 'Optional restart uses the app restart command: it cleans its daemon/tray processes and registers the Windows login startup hook. Prefer a spare test account.'
  if (-not $restartSafe) { $report.notes+='Other checkout daemon/tray detected, or process ownership unavailable: restart refused.' }
  if ($AllowRestart -and $restartSafe -and $identity.running -and $identity.fromThisCheckout -and ((Read-Host 'Restart this checkout Agent Attention daemon/tray now? Type RESTART') -ceq 'RESTART')) {
    $report.restart=Run-Node @($cli,'daemon','restart') 90
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do { Start-Sleep -Milliseconds 500; $afterId=Daemon-Identity } while((-not $afterId.running -or $afterId.pid -eq $identity.pid) -and [DateTime]::UtcNow -lt $deadline)
    $report.daemonAfter=$afterId
    Add-Check 'daemon replaced and running from this checkout' $(if($afterId.running -and $afterId.fromThisCheckout -and $afterId.pid -ne $identity.pid){'PASS'}else{'FAIL'}) $afterId
    $after=Snapshot; $report.afterRestart=$after
    $same=$true
    if(@($before.events).Count -ne 3 -or @($after.events).Count -ne 3){$same=$false}
    foreach($e in $before.events){$match=@($after.events | Where-Object {$_.id -eq $e.id});if($match.Count -ne 1 -or $match[0].read -ne $e.read){$same=$false}}
    $pendingBefore=@($before.events | Where-Object {$_.type -eq 'input_required' -and -not $_.read})
    Add-Check 'three test events and read/unread state survive restart' $(if($same -and $pendingBefore.Count -eq 1){'PASS'}else{'FAIL'}) @{before=$before;after=$after}
    [void](Read-Host 'Open Center after restart; mark ONLY the pending Acceptance-test input_required row read; then press Enter')
    $last=@((Snapshot).events | Where-Object {$_.type -eq 'input_required'})
    Add-Check 'post-restart UI read persisted' $(if($last.Count -eq 1 -and $last[0].read){'PASS'}else{'FAIL'}) $last
  } else { Add-Check 'daemon restart recovery' 'NOT-RUN' 'Requires -AllowRestart, an exclusively identified checkout daemon/tray, and explicit RESTART confirmation (including startup-hook registration).' }
  $report.complete=(@($report.checks | Where-Object {$_.outcome -notin @('PASS','USER-PASS')}).Count -eq 0)
} catch {
  $report.notes+=$_.Exception.Message
  Add-Check 'acceptance run reached completion' 'BLOCKED' $_.Exception.Message
} finally {
  $env:AGENT_ID=$oldAgentId; $env:AGENT_NAME=$oldAgentName; $env:AGENT_ATTENTION_NOTIFY_TIMEOUT_MS=$oldTimeout
  foreach($emitter in $processes) {
    try {
      $np=$emitter.process
      if(-not $np.HasExited -and -not $np.WaitForExit(35000)) {
        Add-Check ($emitter.type+' notifier process completed') 'FAIL' 'Still running after bounded wait; no arbitrary child processes were killed.'
      } else {
        Add-Check ($emitter.type+' notifier process completed') $(if($np.ExitCode -eq 0){'PASS'}else{'FAIL'}) @{exitCode=$np.ExitCode; note='Exit 0 is NOT proof a toast appeared; inspect the separate human and persistence checks.'}
        $np.Dispose()
      }
    } catch { Add-Check ($emitter.type+' notifier exit observed') 'UNOBSERVED' $_.Exception.Message }
  }
  $report.endedAt=[DateTime]::UtcNow.ToString('o')
  try { $report.finalState=Snapshot; Add-Check 'final test state retained' $(if($report.finalState.available -and @($report.finalState.events).Count -eq 3){'PASS'}else{'FAIL'}) $report.finalState } catch { Add-Check 'final state readable' 'BLOCKED' 'Final state unavailable; no fallback state was written.' }
  $report.complete=(@($report.checks | Where-Object {$_.outcome -notin @('PASS','USER-PASS')}).Count -eq 0)
  $report | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'acceptance.json') -Encoding UTF8
  Write-Host ("Diagnostics: {0}" -f $OutputDirectory)
  Write-Host 'Report excludes existing event bodies, window titles, command lines, IPC ports/tokens and credentials. Review before sharing.'
  Write-Host 'The labeled test agent/events are retained for follow-up; no unrelated history has been cleared.'
}
if(-not $report.complete){exit 1}
exit 0
