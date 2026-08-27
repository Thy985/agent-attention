# Agent Attention Portable Launcher
# Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File start.ps1
# Or double-click (PowerShell will prompt for execution policy)

$PSScriptRoot = $PSScriptRoot -replace '\portable$', ''

# ── Locate Node.js ──────────────────────────────────────────────────────
$nodeExe = Join-Path $PSScriptRoot "node\node.exe"
if (-not (Test-Path $nodeExe)) {
    Write-Host "ERROR: node.exe not found. Expected: $nodeExe" -ForegroundColor Red
    Write-Host "Please download the portable package and extract it first." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

# ── Verify dependencies ─────────────────────────────────────────────────
$npmCli = Join-Path (Split-Path $nodeExe) "node_modules\npm\bin\npm-cli.js"
if (-not (Test-Path $npmCli)) {
    Write-Host "Installing dependencies (first time only)..." -ForegroundColor Yellow
    & $nodeExe $npmCli install --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install failed. Ensure you have internet access." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
}

# ── Ensure daemon is not already running ────────────────────────────────
$daemonPidFile = Join-Path "$env:USERPROFILE\.agent-attention" "daemon.pid"
if (Test-Path $daemonPidFile) {
    $pid = Get-Content $daemonPidFile -ErrorAction SilentlyContinue
    if ($pid) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "[OK] Daemon already running (pid=$pid)" -ForegroundColor Green
        } else {
            Remove-Item $daemonPidFile -Force -ErrorAction SilentlyContinue
        }
    }
}

# ── Start daemon (hidden) ──────────────────────────────────────────────
$cliJs = Join-Path $PSScriptRoot "dist\daemon-cli.js"
if (-not (Test-Path $cliJs)) {
    Write-Host "ERROR: dist\daemon-cli.js not found" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Starting Agent Attention daemon..." -ForegroundColor Green
& $nodeExe $cliJs daemon start 2>&1 | Out-Null

Start-Sleep -Milliseconds 500

# ── Show status ────────────────────────────────────────────────────────
$status = & $nodeExe $cliJs doctor 2>&1
Write-Host ""
Write-Host $status
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. agent-attention discover    # Find installed agents"
Write-Host "  2. agent-attention integrate claude-code"
Write-Host "  3. Set AGENT_ID and start working!"
Write-Host ""
Write-Host "Files are in: $PSScriptRoot" -ForegroundColor Gray
Write-Host "Data is in:   $env:USERPROFILE\.agent-attention" -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close"
