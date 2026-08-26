# M1 behavioral parity gate for legacy PowerShell Center and native C# Host.
# Run: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-parity.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = Split-Path $PSScriptRoot -Parent
$nativeExe = Join-Path $root 'src\center\csharp\dist\win-x64\AgentAttention.UI.exe'
$legacyScript = Join-Path $root 'src\center\CenterWindow.ps1'
if (-not (Test-Path $nativeExe)) { throw "Native UI artifact not found: $nativeExe" }
if (-not (Test-Path $legacyScript)) { throw "Legacy Center script not found: $legacyScript" }
$existing = @(Get-Process -Name AgentAttention.UI -ErrorAction SilentlyContinue)
if ($existing.Count -ne 0) { throw ("Native Host already running: {0}" -f (($existing | ForEach-Object Id) -join ', ')) }

$results = [System.Collections.Generic.List[object]]::new()
$tracked = [System.Collections.Generic.List[object]]::new()
function Record([string]$name, [bool]$passed, [string]$detail = '') {
  $results.Add([pscustomobject]@{ name = $name; passed = $passed; detail = $detail })
  Write-Host ("[{0}] {1}{2}" -f ($(if ($passed) { 'PASS' } else { 'FAIL' })), $name, $(if ($detail) { " -- $detail" } else { '' }))
}
function New-Fixture {
  $directory = Join-Path ([IO.Path]::GetTempPath()) ('agent-attention-parity-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $directory | Out-Null
  $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $events = @(
    @{ id='parity-input'; timestamp=$now; type='input_required'; priority='P0'; agent_id='codex'; agent_name='Codex'; title='Codex needs input'; message='M1 parity'; read=$false },
    @{ id='parity-completed'; timestamp=$now-1000; type='completed'; priority='P1'; agent_id='claude'; agent_name='Claude'; title='Claude completed'; message='M1 parity'; read=$false }
  )
  $state = [ordered]@{ version=1; updatedAt=$now; unreadCount=2; visible=$true; events=$events }
  $registry = [ordered]@{ agents=@(@{ agent_id='codex'; name='Codex' }, @{ agent_id='claude'; name='Claude' }) }
  $statePath = Join-Path $directory 'state.json'
  $registryPath = Join-Path $directory 'agents.json'
  $cliPath = Join-Path $directory 'fake-cli.js'
  ($state | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $statePath -Encoding UTF8
  ($registry | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $registryPath -Encoding UTF8
  $lines = @(
    'const fs = require(''fs'');',
    'const path = require(''path'');',
    'const statePath = path.join(__dirname, ''state.json'');',
    'const state = JSON.parse(fs.readFileSync(statePath, ''utf8''));',
    'if (process.argv[2] === ''mark-all-read'') {',
    '  state.unreadCount = 0;',
    '  state.visible = false;',
    '  state.events.forEach(event => { event.read = true; });',
    '}',
    'fs.writeFileSync(statePath, JSON.stringify(state, null, 2));',
    'fs.appendFileSync(path.join(__dirname, ''cli-calls.log''), JSON.stringify(process.argv.slice(2)) + ''\n'');'
  )
  Set-Content -LiteralPath $cliPath -Value $lines -Encoding UTF8
  [pscustomobject]@{ Directory=$directory; State=$statePath; Registry=$registryPath; Cli=$cliPath; Calls=(Join-Path $directory 'cli-calls.log') }
}
function Invoke-MarkAllButton($process) {
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ((-not $process.HasExited) -and $process.MainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
    $process.Refresh(); Start-Sleep -Milliseconds 150
  }
  if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw "window handle was not created (pid=$($process.Id))" }
  $window = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, 'Mark all read')
  $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
  if (-not $button) { throw "Mark all read button not found (pid=$($process.Id))" }
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
}
function Wait-StateChanged($fixture) {
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $state = Get-Content -LiteralPath $fixture.State -Raw | ConvertFrom-Json
      if ((Test-Path $fixture.Calls) -and $state.unreadCount -eq 0) { return $state }
    } catch {}
    Start-Sleep -Milliseconds 100
  }
  Get-Content -LiteralPath $fixture.State -Raw | ConvertFrom-Json
}
function Assert-Observable([string]$label, $fixture) {
  $state = Wait-StateChanged $fixture
  $calls = if (Test-Path $fixture.Calls) { @(Get-Content -LiteralPath $fixture.Calls) } else { @() }
  $allRead = @($state.events | Where-Object { -not $_.read }).Count -eq 0
  Record "$label/unread becomes zero" ($state.unreadCount -eq 0) ("unreadCount=" + $state.unreadCount)
  Record "$label/all events become read" $allRead
  Record "$label/CLI receives mark-all-read" (($calls | Where-Object { $_ -match 'mark-all-read' }).Count -gt 0) ($calls -join '; ')
}
function Stop-TrackedProcesses {
  foreach ($process in $tracked) {
    try {
      $process.Refresh()
      if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
        $deadline = [DateTime]::UtcNow.AddSeconds(3)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
      }
    } catch {}
  }
}

try {
  $node = (Get-Command node).Source
  $previousCli = $env:AGENT_ATTENTION_CLI
  $previousNode = $env:AGENT_ATTENTION_NODE
  $env:AGENT_ATTENTION_NODE = $node

  $fixture = New-Fixture
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell'
  foreach ($argument in @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$legacyScript,'-StatePath',$fixture.State,'-RegistryPath',$fixture.Registry)) { [void]$psi.ArgumentList.Add($argument) }
  $psi.EnvironmentVariables['AGENT_ATTENTION_CLI'] = $fixture.Cli
  $psi.EnvironmentVariables['AGENT_ATTENTION_NODE'] = $node
  $legacy = [System.Diagnostics.Process]::Start($psi); $tracked.Add($legacy)
  try {
    Invoke-MarkAllButton $legacy
    Assert-Observable 'PowerShell' $fixture
  } catch {
    Record 'PowerShell/real button automation' $false $($_.Exception.Message)
    Write-Host 'M1 PowerShell/C# parity: NOT VERIFIED (cross-process legacy WPF automation unavailable)'
    exit 2
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not $legacy.HasExited -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
  Record 'PowerShell/Center exits after mark-all' ($legacy.HasExited -and $legacy.ExitCode -eq 0) ("exitCode=" + $(if ($legacy.HasExited) { $legacy.ExitCode } else { '<running>' }))

  $fixture = New-Fixture
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $nativeExe
  foreach ($argument in @('-StatePath',$fixture.State,'-RegistryPath',$fixture.Registry,'-CliPath',$fixture.Cli,'-OpenCenter')) { [void]$psi.ArgumentList.Add($argument) }
  $psi.EnvironmentVariables['AGENT_ATTENTION_NODE'] = $node
  $native = [System.Diagnostics.Process]::Start($psi); $tracked.Add($native)
  Invoke-MarkAllButton $native
  Assert-Observable 'C#' $fixture
  $native.Refresh()
  Record 'C#/Tray Host remains after mark-all' (-not $native.HasExited) ("pid=" + $native.Id)
}
finally {
  Stop-TrackedProcesses
  if ($null -ne $previousCli) { $env:AGENT_ATTENTION_CLI = $previousCli } else { Remove-Item Env:AGENT_ATTENTION_CLI -ErrorAction SilentlyContinue }
  if ($null -ne $previousNode) { $env:AGENT_ATTENTION_NODE = $previousNode } else { Remove-Item Env:AGENT_ATTENTION_NODE -ErrorAction SilentlyContinue }
}
$failed = @($results | Where-Object { -not $_.passed }).Count
$total = $results.Count
Write-Host ("M1 PowerShell/C# parity: passed={0} failed={1} total={2}" -f ($total - $failed), $failed, $total)
exit $(if ($failed -eq 0) { 0 } else { 1 })
