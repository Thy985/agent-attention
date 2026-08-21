# Agent Attention Center — Tray Icon (PowerShell + WinForms)
#
# Architecture: daemon writes tray-state.json → TrayIcon polls + pumps messages.
#
# Usage:
#   powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File TrayIcon.ps1
#             [-StatePath <path>] [-CliPath <path>]

param(
    [string]$StatePath   = "$env:USERPROFILE\.agent-attention\state.json",
    [string]$CliPath     = "",
    [string]$TrayPidPath = ""   # path to tray.pid file (written by daemon, read on exit)
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# Single-instance mutex (issue #2)
# ---------------------------------------------------------------------------
$userId   = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$mutexName = "Local\agent-attention-tray-" + $userId.Replace('\', '_')
$mutex     = New-Object System.Threading.Mutex($false, $mutexName)
$acquired  = $false
try {
    $acquired = $mutex.WaitOne(0, $true)
} catch {}
if (-not $acquired) {
    Write-Warning "Another TrayIcon is already running."
    exit 0
}
trap { $mutex.ReleaseMutex(); break }

$script:notifyIcon      = $null
$script:currentState    = @{ unreadCount = 0; events = @() }
$script:stopSignal      = $false
$script:lastMenuVisible = $false   # track whether context menu is open
$script:clickTimestamp  = 0         # for double-click debounce (issue #8)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-IconColor {
    param($Unread)
    if ($Unread -gt 0) {
        [System.Drawing.Color]::FromArgb(220, 50, 50)
    } else {
        [System.Drawing.Color]::FromArgb(50, 160, 80)
    }
}

function Build-IconBitmap {
    param($Unread, $Color)
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($Color)
    if ($Unread -gt 0) {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $font  = New-Object System.Drawing.Font("Arial", 8, [System.Drawing.FontStyle]::Bold)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        $numStr = if ($Unread -gt 9) { "+" } else { "$Unread" }
        $size = $g.MeasureString($numStr, $font)
        $x = [Math]::Max(0, [Math]::Floor((16 - $size.Width) / 2))
        $y = [Math]::Max(0, [Math]::Floor((16 - $size.Height) / 2))
        $g.DrawString($numStr, $font, $brush, $x, $y)
        $font.Dispose(); $brush.Dispose()
    }
    $g.Dispose()
    return $bmp
}

function Update-NotifyIcon {
    param($State)
    $script:currentState = $State
    $totalUnread = ($State.events | Where-Object { -not $_.read }).Count
    $badge       = if ($totalUnread -gt 0) { "[$totalUnread]" } else { "[0]" }
    $script:notifyIcon.Text = "Agent Attention: $badge"

    $iconColor = Get-IconColor $totalUnread
    $bmp       = Build-IconBitmap $totalUnread $iconColor
    $newIcon   = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

    $oldIcon = $script:notifyIcon.Icon
    $script:notifyIcon.Icon = $newIcon
    $bmp.Dispose()
    # Only dispose if it's OURS (not a shared SystemIcon) — issue #13
    if ($oldIcon -and $oldIcon -ne [System.Drawing.SystemIcons]::Application) {
        $oldIcon.Dispose()
    }
}

function Mark-EventRead {
    param($EventId, $Cli)
    if (-not $Cli) { return }
    try {
        $cliDir = Split-Path $Cli -Parent
        $exe    = if ($env:AGENT_ATTENTION_NODE) { $env:AGENT_ATTENTION_NODE } else { "node" }
        Start-Process $exe -ArgumentList $Cli, 'mark-event', $EventId -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    } catch {}
}

function Build-ContextMenu {
    param($State, $Cli)

    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    # Header
    $header = New-Object System.Windows.Forms.ToolStripMenuItem
    $header.Text    = "Agent Attention"
    $header.Enabled = $false
    $menu.Items.Add($header) | Out-Null
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Open Center — forward StatePath and RegistryPath (issue #10)
    $openItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $openItem.Text = "Open Center"
    $openItem.Add_Click({
        param($s, $e)
        $centerPath = Join-Path $PSScriptRoot 'CenterWindow.ps1'
        $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$centerPath`"")
        # Forward paths so Center reads the same data as tray
        if ($using:StatePath)  { $args += '-StatePath',  $using:StatePath }
        if ($using:CliPath) {
            $stateDir = Split-Path $using:StatePath -Parent
            $args += '-RegistryPath', (Join-Path $stateDir 'agents.json')
        }
        Start-Process powershell -ArgumentList $args -WindowStyle Hidden
    }.GetNewClosure())
    $menu.Items.Add($openItem) | Out-Null
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Event list (max 10) — clicking marks read (issue #12)
    if (-not $State.events -or $State.events.Count -eq 0) {
        $empty = New-Object System.Windows.Forms.ToolStripMenuItem
        $empty.Text    = "(no events)"
        $empty.Enabled = $false
        $menu.Items.Add($empty) | Out-Null
    } else {
        $maxItems = [math]::Min($State.events.Count, 10)
        for ($i = 0; $i -lt $maxItems; $i++) {
            $ev       = $State.events[$i]
            $readMk   = if ($ev.read) { "[R]" } else { "[!]" }
            $agent    = if ($ev.agent_name) { $ev.agent_name } elseif ($ev.agent_id) { $ev.agent_id } else { "agent" }
            $shortMsg = if ($ev.message.Length -gt 28) { $ev.message.Substring(0, 28) + "..." } else { $ev.message }
            $item     = New-Object System.Windows.Forms.ToolStripMenuItem
            $item.Text = "$readMk $agent : $shortMsg"
            $item.Tag  = $ev
            $item.Add_Click({
                param($s, $e)
                $ev       = $s.Tag
                $agentNm  = if ($ev.agent_name) { $ev.agent_name } elseif ($ev.agent_id) { $ev.agent_id } else { "agent" }
                $readSt   = if ($ev.read) { "Yes" } else { "No" }
                # Mark as read via CLI (issue #12)
                Mark-EventRead $ev.id $using:CliPath
                $details  = "Agent: $agentNm`nType: $($ev.type)`nMessage: $($ev.message)`nPriority: $($ev.priority)`nRead: $readSt"
                [System.Windows.Forms.MessageBox]::Show(
                    $details, "Agent Attention",
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                )
            }.GetNewClosure())
            $menu.Items.Add($item) | Out-Null
        }
    }

    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Exit
    $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $exitItem.Text = "Exit"
    $exitItem.Add_Click({
        param($s, $e)
        $script:notifyIcon.Visible = $false
        $script:stopSignal = $true
        [System.Windows.Forms.Application]::Exit()
    }.GetNewClosure())
    $menu.Items.Add($exitItem) | Out-Null

    # Rebuild menu when it closes (issue #11)
    $menu.Add_Opening({
        $script:lastMenuVisible = $true
    }) | Out-Null
    $menu.Add_Closed({
        param($s, $e)
        $script:lastMenuVisible = $false
        # Rebuild with latest state so menu is always fresh
        if ($script:notifyIcon) {
            $stateJson = Get-Content $script:trayStatePath -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($stateJson) {
                try {
                    $fresh = $stateJson | ConvertFrom-Json
                    $script:currentState = $fresh
                    Update-NotifyIcon $fresh
                    $script:notifyIcon.ContextMenuStrip = Build-ContextMenu $fresh $using:CliPath
                } catch {}
            }
        }
    }) | Out-Null

    $menu
}

# ---------------------------------------------------------------------------
# Left-click → Open Center  (debounced to avoid double-trigger on dbl-click)
# Double-click → mark-all-read
# ---------------------------------------------------------------------------

function Start-Tray {
    # Resolve CLI path — support AGENT_ATTENTION_NODE for global installs (issue #9)
    $cliExe  = $env:AGENT_ATTENTION_NODE ?? "node"
    $cliPath = $CliPath
    if (-not $cliPath -or -not (Test-Path $cliPath)) {
        $candidate = Join-Path $PSScriptRoot '..\..\dist\daemon-cli.js'
        if (Test-Path $candidate) { $cliPath = $candidate }
        if (-not $cliPath -or -not (Test-Path $cliPath)) {
            # Try relative to state dir (global install fallback)
            $stateDir  = Split-Path $StatePath -Parent
            $candidate = Join-Path $stateDir 'daemon-cli.js'
            if (Test-Path $candidate) { $cliPath = $candidate }
        }
    }
    $script:cliPath = $cliPath
    $script:trayStatePath = "$env:TEMP\agent-attention-tray-state.json"

    # Create owned initial icon (never use SystemIcons — issue #13)
    $initBmp  = Build-IconBitmap 0 (Get-IconColor 0)
    $initIcon = [System.Drawing.Icon]::FromHandle($initBmp.GetHicon())
    $initBmp.Dispose()

    $script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $script:notifyIcon.Icon       = $initIcon
    $script:notifyIcon.Visible    = $true

    # Left-click — open Center (issue #8: debounce to suppress spurious click on dbl-click)
    $script:notifyIcon.Add_Click({
        param($s, $e)
        $now = [DateTime]::Now.Ticks
        # Only act if this isn't part of a double-click (>250ms since last click)
        if ($now - $script:clickTimestamp -gt 2500000) {
            $centerPath = Join-Path $PSScriptRoot 'CenterWindow.ps1'
            $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$centerPath`"" 
                      , '-StatePath', $script:StatePath)
            if ($script:cliPath) {
                $stateDir = Split-Path $script:StatePath -Parent
                $args += '-RegistryPath', (Join-Path $stateDir 'agents.json')
            }
            Start-Process powershell -ArgumentList $args -WindowStyle Hidden
        }
        $script:clickTimestamp = $now
    }.GetNewClosure()) | Out-Null

    # Double-click — mark all read (fires AFTER both clicks, so debounced click is suppressed by timestamp gap)
    $script:notifyIcon.Add_DoubleClick({
        param($s, $e)
        if ($script:cliPath -and (Test-Path $script:cliPath)) {
            try {
                Start-Process $cliExe -ArgumentList $script:cliPath, 'mark-all-read' `
                    -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
            } catch {}
        }
        # Also local mark for immediate feedback
        $script:currentState.unreadCount = 0
        $script:currentState.events = @($script:currentState.events | ForEach-Object { $_.read = $true; $_ })
        Update-NotifyIcon $script:currentState
    }.GetNewClosure()) | Out-Null

    # Initial context menu
    $script:notifyIcon.ContextMenuStrip = Build-ContextMenu @{ unreadCount=0; events=@() } $script:cliPath

    # Load initial state if available
    if (Test-Path $StatePath) {
        try {
            $initial = Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
            Update-NotifyIcon $initial
            $script:notifyIcon.ContextMenuStrip = Build-ContextMenu $initial $script:cliPath
        } catch {
            Write-Warning "Failed to read initial state: $_"
        }
    }
}

function Invoke-Exit {
    param($Graceful = $true)
    if ($script:notifyIcon) {
        $script:notifyIcon.Visible = $false
        $script:notifyIcon.Dispose()
        $script:notifyIcon = $null
    }
    # Clean up PID file and polling state so next spawn starts fresh (issue #1, secondary)
    if ($TrayPidPath -and (Test-Path $TrayPidPath)) {
        try { Remove-Item $TrayPidPath -Force -ErrorAction SilentlyContinue } catch {}
    }
    # Also remove our local temp copy of tray-state.json if present
    if ($script:trayStatePath -and (Test-Path $script:trayStatePath)) {
        try { Remove-Item $script:trayStatePath -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($Graceful) {
        [System.Windows.Forms.Application]::Exit()
    }
}

# ---------------------------------------------------------------------------
# Exit triggers
#   1. stopSignal     — set by Ctrl+C handler or explicit Exit menu
#   2. state file gone — daemon deleted tray-state.json (graceful stop)
#   3. parent dead    — daemon.pid lost (daemon crashed/killed externally)
# ---------------------------------------------------------------------------
[Console]::TreatInputLineAsCommandLine = $false

# Ctrl+C → set stopSignal so polling loop exits → Invoke-Exit hides icon
$ctrlHandler = {
    param($s, $e)
    Write-Host "[TrayIcon] Ctrl+C received — exiting" -ForegroundColor Yellow
    $script:stopSignal = $true
}.GetNewClosure()
[Console]::Add_CancelKeyPress($ctrlHandler) | Out-Null

# Build a helper that checks all three exit conditions
function Test-TrayShouldExit {
    if ($script:stopSignal) { return $true }
    if (-not (Test-Path $script:trayStatePath)) { return $true }
    # Parent death detection: daemon.pid missing or process gone
    if ($StatePath) {
        $stateDir = Split-Path $StatePath -Parent
        $daemonPidPath = Join-Path $stateDir 'daemon.pid'
        if (-not (Test-Path $daemonPidPath)) { return $true }
        try {
            $pid = [int](Get-Content $daemonPidPath -Raw)
            if ($pid -gt 0) {
                # Windows: use WMI to check liveness (no Get-Process .Handle access)
                $alive = Get-CimInstance Win32_Process -Filter "ProcessId=$pid" -ErrorAction SilentlyContinue
                if (-not $alive) { return $true }
            }
        } catch { return $true }
    }
    return $false
}

# ---------------------------------------------------------------------------
# Polling loop
# Exit when: stopSignal set / state file deleted by daemon / parent daemon dead
# ---------------------------------------------------------------------------

Start-Tray

# Ensure tray-state.json exists on FIRST start only (before the loop).
# NOTE: We do NOT recreate it inside the loop — if daemon deletes it to signal
# shutdown, we must exit, not silently recreate and stay alive.
if (-not (Test-Path $script:trayStatePath)) {
    @{ version=1; updatedAt=0; unreadCount=0; events=@() } | ConvertTo-Json -Depth 3 |
        Set-Content $script:trayStatePath -Encoding UTF8
}

Write-Host "[TrayIcon] polling $script:trayStatePath" -ForegroundColor Green

while (-not (Test-TrayShouldExit)) {
    # Pump Windows messages so Click/DoubleClick/ContextMenu callbacks fire
    [System.Windows.Forms.Application]::DoEvents()

    # Read state from file written by daemon
    try {
        if (Test-Path $script:trayStatePath) {
            $newState = Get-Content $script:trayStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
            # Only rebuild menu when state actually changes AND menu is not visible (issue #11)
            $oldJson  = ($script:currentState.events | ConvertTo-Json -Compress)
            $newJson  = ($newState.events   | ConvertTo-Json -Compress)
            if ($oldJson -ne $newJson -and -not $script:lastMenuVisible) {
                Update-NotifyIcon $newState
                $script:notifyIcon.ContextMenuStrip = Build-ContextMenu $newState $script:cliPath
            }
        }
    } catch {
        # Transient read error — ignore and retry next tick
    }

    Start-Sleep -Milliseconds 500
}

Invoke-Exit
Write-Host "[TrayIcon] stopped." -ForegroundColor Yellow
