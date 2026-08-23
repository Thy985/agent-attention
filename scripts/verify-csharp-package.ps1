# Packaging recovery smoke for the published npm tarball and bundled native Host.
# Run: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-csharp-package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$results = [System.Collections.Generic.List[object]]::new()
function Record([string]$name, [bool]$passed, [string]$detail = '') {
  $results.Add([pscustomobject]@{ name = $name; passed = $passed; detail = $detail })
  Write-Host ("[{0}] {1}{2}" -f ($(if ($passed) { 'PASS' } else { 'FAIL' })), $name, $(if ($detail) { " -- $detail" } else { '' }))
}
function Assert-File([string]$name, [string]$path) {
  Record $name (Test-Path -LiteralPath $path) $path
}

Write-Host '==> Building TypeScript and publishing native UI'
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed: $LASTEXITCODE" }
npm run publish:ui
if ($LASTEXITCODE -ne 0) { throw "npm run publish:ui failed: $LASTEXITCODE" }

Write-Host '==> Creating npm package'
$packOutput = npm pack --json
if ($LASTEXITCODE -ne 0) { throw "npm pack failed: $LASTEXITCODE" }
$packed = @($packOutput | Out-String | ConvertFrom-Json)[0]
$tarball = Join-Path $root $packed.filename
Record 'npm pack/tarball created' (Test-Path -LiteralPath $tarball) "$($packed.filename)"
$temp = Join-Path ([IO.Path]::GetTempPath()) ('agent-attention-pack-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $temp 'install'
New-Item -ItemType Directory -Path $temp | Out-Null
$copiedTarball = Join-Path $temp $packed.filename
Copy-Item -LiteralPath $tarball -Destination $copiedTarball

try {
  Write-Host '==> Installing into isolated prefix'
  Push-Location $temp
  try {
    npm install --prefix $installRoot --no-audit --no-fund --loglevel=error $copiedTarball
    if ($LASTEXITCODE -ne 0) { throw "isolated npm install failed: $LASTEXITCODE" }
  } finally { Pop-Location }

  $packageName = if ($packed.name) { $packed.name } else { 'agent-attention' }
  $packageRoot = Join-Path $installRoot "node_modules\$packageName"
  Assert-File 'installed/JS daemon CLI' (Join-Path $packageRoot 'dist\daemon-cli.js')
  Assert-File 'installed/notify CLI' (Join-Path $packageRoot 'dist\index.js')
  Assert-File 'installed/legacy Center script' (Join-Path $packageRoot 'src\center\CenterWindow.ps1')
  Assert-File 'installed/legacy Tray script' (Join-Path $packageRoot 'src\center\TrayIcon.ps1')
  Assert-File 'installed/native executable' (Join-Path $packageRoot 'src\center\csharp\dist\win-x64\AgentAttention.UI.exe')
  Assert-File 'installed/native assembly' (Join-Path $packageRoot 'src\center\csharp\dist\win-x64\AgentAttention.UI.dll')
  Assert-File 'installed/native runtime config' (Join-Path $packageRoot 'src\center\csharp\dist\win-x64\AgentAttention.UI.runtimeconfig.json')
  $attentionBin = Join-Path $installRoot 'node_modules\.bin\agent-attention.cmd'
  $notifyBin = Join-Path $installRoot 'node_modules\.bin\agent-notify.cmd'
  Assert-File 'launcher/agent-attention shim' $attentionBin
  Assert-File 'launcher/agent-notify shim' $notifyBin
  & $attentionBin --help | Out-Null
  & $attentionBin | Out-Null
  Record 'launcher/agent-attention usage exits zero' ($LASTEXITCODE -eq 0)
  & $notifyBin | Out-Null
  Record 'launcher/agent-notify validates args' ($LASTEXITCODE -eq 1)
  $resolverLines = @(
    'const { resolveNativeUiPath } = require(process.env.AGENT_ATTENTION_UI_HOST_MODULE);',
    'const resolved = resolveNativeUiPath();',
    'const expected = process.env.AGENT_ATTENTION_EXPECTED_UI;',
    'if (resolved !== expected) {',
    '  console.error(`resolver mismatch: ${resolved} != ${expected}`);',
    '  process.exit(1);',
    '}'
  )
  $resolverPath = Join-Path $temp 'resolve-ui.js'
  Set-Content -LiteralPath $resolverPath -Value $resolverLines -Encoding UTF8
  $env:AGENT_ATTENTION_UI_HOST_MODULE = Join-Path $packageRoot 'dist\ui-host.js'
  $env:AGENT_ATTENTION_EXPECTED_UI = Join-Path $packageRoot 'src\center\csharp\dist\win-x64\AgentAttention.UI.exe'
  node $resolverPath
  Record 'resolver/finds installed native Host' ($LASTEXITCODE -eq 0)
  $win32Source = Get-Content -LiteralPath (Join-Path $packageRoot 'dist\notification\win32.js') -Raw
  Record 'toast/no accidental Code.exe launch' (-not $win32Source.Contains('Code.exe'))
  Remove-Item Env:AGENT_ATTENTION_UI_HOST_MODULE -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_ATTENTION_EXPECTED_UI -ErrorAction SilentlyContinue
}
finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
$failed = @($results | Where-Object { -not $_.passed }).Count
$total = $results.Count
Write-Host ("M1 packaging smoke: passed={0} failed={1} total={2}" -f ($total - $failed), $failed, $total)
exit $(if ($failed -eq 0) { 0 } else { 1 })

