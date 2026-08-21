# Agent Attention Center — Center Window (WPF)
#
# Usage:
#   powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File CenterWindow.ps1
#              [-StatePath <path>] [-RegistryPath <path>]

param(
    [string]$StatePath   = "$env:USERPROFILE\.agent-attention\state.json",
    [string]$RegistryPath = "$env:USERPROFILE\.agent-attention\agents.json"
)

# ---------------------------------------------------------------------------
# Single-instance protection
# WindowsIdentity.Name may contain '\' (e.g. "DOMAIN\User" or "LAPTOP\User")
# which is invalid in a Mutex name.  Sanitize by replacing '\' with '_'.
# ---------------------------------------------------------------------------
$userId  = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$mutexName = "Local\agent-attention-center-" + $userId.Replace('\', '_')
$mutex     = New-Object System.Threading.Mutex($false, $mutexName)
$acquired  = $false
try {
    $acquired = $mutex.WaitOne(0, $true)
} catch {}
if (-not $acquired) {
    Write-Warning "Another Center window is already open."
    exit 0
}
trap { $mutex.ReleaseMutex(); break }

# ---------------------------------------------------------------------------
# Resolve CLI path for mark-read (issue F: per-event read in center)
# ---------------------------------------------------------------------------
$script:_centerCliPath = if ($env:AGENT_ATTENTION_CLI) { $env:AGENT_ATTENTION_CLI } else { Join-Path $PSScriptRoot '..\..\dist\daemon-cli.js' }
if (-not (Test-Path $script:_centerCliPath)) {
    $alt = Join-Path $PSScriptRoot '..\..\..\AppData\Local\mise\installs\node\*\agent-attention.cmd'
    $found = Get-ChildItem -Path (Split-Path $alt) -Directory | ForEach-Object { Join-Path $_.FullName 'agent-attention.cmd' } | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) { $script:_centerCliPath = $found }
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Get-State {
    try {
        if (Test-Path $StatePath) {
            Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else { @{ unreadCount = 0; events = @() } }
    } catch {
        Write-Warning "Invalid state: $_"
        @{ unreadCount = 0; events = @() }
    }
}

function Get-Registry {
    try {
        if (Test-Path $RegistryPath) {
            Get-Content $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else { @{ agents = @() } }
    } catch {
        Write-Warning "Invalid registry: $_"
        @{ agents = @() }
    }
}

function Get-TimeAgo {
    param([long]$TimestampMs)
    $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $seconds = [math]::Floor(($now - $TimestampMs) / 1000)
    if ($seconds -lt 60) { return "${seconds}s ago" }
    $minutes = [math]::Floor($seconds / 60)
    if ($minutes -lt 60) { return "${minutes}m ago" }
    $hours   = [math]::Floor($minutes / 60)
    if ($hours -lt 24)   { return "${hours}h ago" }
    return "${[math]::Floor($hours / 24)}d ago"
}

function Get-ConnectionStatus {
    param([long]$lastSeenAt)
    $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $minsAgo = [math]::Floor(($now - $lastSeenAt) / 60000)
    if ($minsAgo -lt 5)  { return @{ status = 'connected'; label = "● Connected" } }
    return @{ status = 'inactive'; label = "● Last seen ${minsAgo}m ago" }
}

# ---------------------------------------------------------------------------
# Load data
# ---------------------------------------------------------------------------
$state   = Get-State
$registry = Get-Registry

$agentMap = @{}
foreach ($a in $registry.agents) {
    $agentMap[$a.agent_id] = $a
}

$agentGroups = @{}
foreach ($ev in $state.events) {
    $aid = $ev.agent_id
    if (-not $agentMap.ContainsKey($aid)) { $agentMap[$aid] = @{ agent_id = $aid; name = $aid } }
    if (-not $agentGroups.ContainsKey($aid)) { $agentGroups[$aid] = @() }
    $agentGroups[$aid] += @($ev)
}

# ---------------------------------------------------------------------------
# WPF setup
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$window = New-Object System.Windows.Window
$window.Title         = 'Agent Attention Center'
$window.Width         = 480
$window.Height        = 540
$window.ResizeMode    = 'CanMinimize'
$window.WindowStartupLocation = 'CenterScreen'
$window.Background    = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#1E1E1E')))

$scrollViewer = New-Object System.Windows.Controls.ScrollViewer
$scrollViewer.VerticalScrollBarVisibility = 'Auto'
$scrollViewer.HorizontalScrollBarVisibility = 'Disabled'

$stackPanel = New-Object System.Windows.Controls.StackPanel
$stackPanel.Margin = '12'

# Title
$titleBlock = New-Object System.Windows.Controls.TextBlock
$titleBlock.Text         = 'Agent Attention'
$titleBlock.FontSize     = 20
$titleBlock.FontWeight   = 'Bold'
$titleBlock.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#FFFFFF')))
$titleBlock.Margin       = '0,0,0,8'
$stackPanel.Children.Add($titleBlock) | Out-Null

# Subtitle
$totalUnread = $state.events | Where-Object { -not $_.read } | Measure-Object
$subtitleBlock = New-Object System.Windows.Controls.TextBlock
$subtitleBlock.Text         = "$($totalUnread.Count) unread notification(s)"
$subtitleBlock.FontSize     = 12
$subtitleBlock.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#AAAAAA')))
$subtitleBlock.Margin       = '0,0,0,12'
$stackPanel.Children.Add($subtitleBlock) | Out-Null

# Separator
$sep = New-Object System.Windows.Shapes.Rectangle
$sep.Height       = 1
$sep.Fill         = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#3E3E3E')))
$sep.Margin       = '0,0,0,12'
$stackPanel.Children.Add($sep) | Out-Null

# ---------------------------------------------------------------------------
# Agent sections
# ---------------------------------------------------------------------------
if ($agentGroups.Count -eq 0) {
    $emptyBlock = New-Object System.Windows.Controls.TextBlock
    $emptyBlock.Text         = 'No events yet. Run agent-notify to trigger notifications.'
    $emptyBlock.FontSize     = 13
    $emptyBlock.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
        [System.Windows.Media.ColorConverter]::ConvertFromString('#888888')))
    $emptyBlock.HorizontalAlignment = 'Center'
    $emptyBlock.Margin        = '0,40,0,0'
    $stackPanel.Children.Add($emptyBlock) | Out-Null
} else {
    foreach ($agentId in $agentGroups.Keys) {
        $events     = $agentGroups[$agentId]
        $agentInfo  = $agentMap[$agentId]
        $agentName  = if ($agentInfo.name) { $agentInfo.name } else { $agentId }
        $unreadForAgent = ($events | Where-Object { -not $_.read }).Count

        # Connection status
        $connStatus = if ($agentInfo.last_seen_at) {
            Get-ConnectionStatus $agentInfo.last_seen_at
        } else {
            @{ status = 'inactive'; label = "● Unknown" }
        }

        # Agent header
        $agentHeaderPanel = New-Object System.Windows.Controls.StackPanel
        $agentHeaderPanel.Margin = '0,8,0,4'

        $agentTitle = New-Object System.Windows.Controls.TextBlock
        $agentTitle.Text         = "$agentName  ($unreadForAgent unread)"
        $agentTitle.FontSize     = 14
        $agentTitle.FontWeight   = 'SemiBold'
        $agentTitle.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#E0E0E0')))
        $agentHeaderPanel.Children.Add($agentTitle) | Out-Null

        $connText = New-Object System.Windows.Controls.TextBlock
        $connText.Text         = $connStatus.label
        $connText.FontSize     = 10
        $connText.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#888888')))
        $agentHeaderPanel.Children.Add($connText) | Out-Null

        $stackPanel.Children.Add($agentHeaderPanel) | Out-Null

        # Events (up to 8)
        $maxShow = [math]::Min($events.Count, 8)
        for ($i = 0; $i -lt $maxShow; $i++) {
            $ev = $events[$i]
            $evPanel = New-Object System.Windows.Controls.StackPanel
            $evPanel.Orientation = 'Horizontal'
            $evPanel.Margin      = '8,2,0,2'

            # Priority dot
            $priorityColor = switch ($ev.priority) {
                'P0' { '#FF5555' }
                'P1' { '#FFAA33' }
                default { '#55BB55' }
            }
            $dot = New-Object System.Windows.Shapes.Ellipse
            $dot.Fill    = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString($priorityColor)))
            $dot.Width   = 8; $dot.Height = 8
            $dot.Margin  = '2,4,6,4'
            $evPanel.Children.Add($dot) | Out-Null

            # Event type
            $typeText = New-Object System.Windows.Controls.TextBlock
            $typeText.Text         = $ev.type
            $typeText.FontSize     = 12
            $typeText.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#CCCCCC')))
            $typeText.VerticalAlignment = 'Center'
            $evPanel.Children.Add($typeText) | Out-Null

            # Separator (middle dot)
            $sep2 = New-Object System.Windows.Controls.TextBlock
            $sep2.Text         = '  ·  '
            $sep2.FontSize     = 12
            $sep2.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
            $sep2.VerticalAlignment = 'Center'
            $evPanel.Children.Add($sep2) | Out-Null

            # Message
            $msgText = New-Object System.Windows.Controls.TextBlock
            $msgText.Text         = $ev.message
            $msgText.FontSize     = 12
            $msgText.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#DDDDDD')))
            $msgText.VerticalAlignment = 'Center'
            $msgText.TextWrapping      = 'Wrap'
            $msgText.MaxWidth          = 320
            $evPanel.Children.Add($msgText) | Out-Null

            # Time
            $timeText = New-Object System.Windows.Controls.TextBlock
            $timeText.Text         = Get-TimeAgo $ev.timestamp
            $timeText.FontSize     = 10
            $timeText.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#777777')))
            $timeText.VerticalAlignment = 'Center'
            $evPanel.Children.Add($timeText) | Out-Null

            $stackPanel.Children.Add($evPanel) | Out-Null
        }

        if ($events.Count -gt 8) {
            $moreText = New-Object System.Windows.Controls.TextBlock
            $moreText.Text         = "  …and $($events.Count - 8) more"
            $moreText.FontSize     = 10
            $moreText.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#666666')))
            $moreText.Margin       = '18,2,0,0'
            $stackPanel.Children.Add($moreText) | Out-Null
        }

        # Agent separator
        $agentSep = New-Object System.Windows.Shapes.Rectangle
        $agentSep.Height       = 1
        $agentSep.Fill         = (New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#2A2A2A')))
        $agentSep.Margin       = '0,6,0,0'
        $stackPanel.Children.Add($agentSep) | Out-Null
    }
}

# ---------------------------------------------------------------------------
# Bottom buttons
# ---------------------------------------------------------------------------
$btnPanel = New-Object System.Windows.Controls.StackPanel
$btnPanel.Orientation        = 'Horizontal'
$btnPanel.HorizontalAlignment = 'Right'
$btnPanel.Margin             = '0,12,0,0'

# Mark all read
$markBtn = New-Object System.Windows.Controls.Button
$markBtn.Content     = 'Mark all read'
$markBtn.Width       = 110
$markBtn.Height      = 32
$markBtn.Margin      = '0,0,8,0'
$markBtn.Background  = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#333333')))
$markBtn.Foreground  = [System.Windows.Media.Brushes]::White
$markBtn.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
$markBtn.Add_Click({
    param($s, $e)
    # Discover CLI: prefer absolute path via env, fall back to script-relative
    $cliEnv  = $env:AGENT_ATTENTION_CLI
    $cliPath = $null
    if ($cliEnv -and (Test-Path $cliEnv)) {
        $cliPath = $cliEnv
    } else {
        $cand = Join-Path $PSScriptRoot '..\..\dist\daemon-cli.js'
        if (Test-Path $cand) { $cliPath = $cand }
    }
    if ($cliPath) {
        $nodePath = $env:AGENT_ATTENTION_NODE
        if (-not $nodePath) { $nodePath = 'node' }
        Start-Process $nodePath -ArgumentList $cliPath, 'mark-all-read' `
            -WindowStyle Hidden -ErrorAction SilentlyContinue
    }
    if ($window -and -not $window.IsDisposed) {
        try { $window.Close() } catch {}
    }
}.GetNewClosure())
$btnPanel.Children.Add($markBtn) | Out-Null

# Close
$closeBtn = New-Object System.Windows.Controls.Button
$closeBtn.Content     = 'Close'
$closeBtn.Width       = 80
$closeBtn.Height      = 32
$closeBtn.Background  = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#333333')))
$closeBtn.Foreground  = [System.Windows.Media.Brushes]::White
$closeBtn.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
$closeBtn.Add_Click({
    if ($window -and -not $window.IsDisposed) {
        try { $window.Close() } catch {}
    }
}.GetNewClosure())
$btnPanel.Children.Add($closeBtn) | Out-Null

$stackPanel.Children.Add($btnPanel) | Out-Null

$scrollViewer.Content = $stackPanel
$window.Content       = $scrollViewer

# Escape to close
$window.Add_KeyDown({
    if ($_.Key -eq 'Escape') {
        if ($window -and -not $window.IsDisposed) {
            try { $window.Close() } catch {}
        }
    }
})

# Live-refresh: re-read state every 2s while window is open.
# Use Show() (modeless) so we can run a DoEvents polling loop alongside.
$refreshIntervalMs = 2000
$lastRefreshHash   = ''

$window.Add_Closed({
    param($s, $e)
    $script:_centerRefreshing = $false
})

# Script-scoped flag for the polling loop
$script:_centerRefreshing = $true

$window.Show()

while ($script:_centerRefreshing -and $window -and -not $window.IsDisposed) {
    [System.Windows.Forms.Application]::DoEvents()

    try {
        $freshState   = Get-State
        $freshRegistry = Get-Registry
        $freshHash    = ($freshState.events | ConvertTo-Json -Compress)

        if ($freshHash -ne $lastRefreshHash) {
            $lastRefreshHash = $freshHash
            # Rebuild the scroll content from scratch with fresh data
            $newStack = New-Object System.Windows.Controls.StackPanel
            $newStack.Margin = '12'

            # -- Title --
            $t = New-Object System.Windows.Controls.TextBlock
            $t.Text = 'Agent Attention'
            $t.FontSize = 20; $t.FontWeight = 'Bold'
            $t.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#FFFFFF')))
            $t.Margin = '0,0,0,8'
            $newStack.Children.Add($t) | Out-Null

            # -- Subtitle --
            $tu = $freshState.events | Where-Object { -not $_.read } | Measure-Object
            $st = New-Object System.Windows.Controls.TextBlock
            $st.Text         = "$($tu.Count) unread notification(s)"
            $st.FontSize     = 12
            $st.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#AAAAAA')))
            $st.Margin       = '0,0,0,12'
            $newStack.Children.Add($st) | Out-Null

            # -- Separator --
            $sr = New-Object System.Windows.Shapes.Rectangle
            $sr.Height = 1
            $sr.Fill   = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#3E3E3E')))
            $sr.Margin = '0,0,0,12'
            $newStack.Children.Add($sr) | Out-Null

            # -- Build agent map & groups --
            $fm = @{}
            foreach ($a in $freshRegistry.agents) { $fm[$a.agent_id] = $a }
            $fg = @{}
            foreach ($ev in $freshState.events) {
                $aid = $ev.agent_id
                if (-not $fm.ContainsKey($aid)) { $fm[$aid] = @{ agent_id = $aid; name = $aid } }
                if (-not $fg.ContainsKey($aid)) { $fg[$aid] = @() }
                $fg[$aid] += @($ev)
            }

            if ($fg.Count -eq 0) {
                $eb = New-Object System.Windows.Controls.TextBlock
                $eb.Text         = 'No events yet. Run agent-notify to trigger notifications.'
                $eb.FontSize     = 13
                $eb.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                    [System.Windows.Media.ColorConverter]::ConvertFromString('#888888')))
                $eb.HorizontalAlignment = 'Center'
                $eb.Margin        = '0,40,0,0'
                $newStack.Children.Add($eb) | Out-Null
            } else {
                foreach ($agentId in $fg.Keys) {
                    $evts  = $fg[$agentId]
                    $ainfo = $fm[$agentId]
                    $aname = if ($ainfo.name) { $ainfo.name } else { $agentId }
                    $unrd  = ($evts | Where-Object { -not $_.read }).Count

                    $cs = if ($ainfo.last_seen_at) {
                        Get-ConnectionStatus $ainfo.last_seen_at
                    } else {
                        @{ status = 'inactive'; label = '● Unknown' }
                    }

                    # Agent header
                    $ahp = New-Object System.Windows.Controls.StackPanel
                    $ahp.Margin = '0,8,0,4'

                    $at = New-Object System.Windows.Controls.TextBlock
                    $at.Text         = "$aname  ($unrd unread)"
                    $at.FontSize     = 14
                    $at.FontWeight   = 'SemiBold'
                    $at.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                        [System.Windows.Media.ColorConverter]::ConvertFromString('#E0E0E0')))
                    $ahp.Children.Add($at) | Out-Null

                    $ct = New-Object System.Windows.Controls.TextBlock
                    $ct.Text         = $cs.label
                    $ct.FontSize     = 10
                    $ct.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                        [System.Windows.Media.ColorConverter]::ConvertFromString('#888888')))
                    $ahp.Children.Add($ct) | Out-Null

                    $newStack.Children.Add($ahp) | Out-Null

                    # Events (up to 8)
                    $mx = [math]::Min($evts.Count, 8)
                    for ($i = 0; $i -lt $mx; $i++) {
                        $ev = $evts[$i]
                        $ep = New-Object System.Windows.Controls.StackPanel
                        $ep.Orientation = 'Horizontal'
                        $ep.Margin      = '8,2,0,2'

                        $pc = switch ($ev.priority) { 'P0' { '#FF5555' }; 'P1' { '#FFAA33' }; default { '#55BB55' } }
                        $dot = New-Object System.Windows.Shapes.Ellipse
                        $dot.Fill   = (New-Object System.Windows.Media.SolidColorBrush(
                            [System.Windows.Media.ColorConverter]::ConvertFromString($pc)))
                        $dot.Width  = 8; $dot.Height = 8
                        $dot.Margin = '2,4,6,4'
                        $ep.Children.Add($dot) | Out-Null

                        $tt = New-Object System.Windows.Controls.TextBlock
                        $tt.Text         = $ev.type
                        $tt.FontSize     = 12
                        $tt.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                            [System.Windows.Media.ColorConverter]::ConvertFromString('#CCCCCC')))
                        $tt.VerticalAlignment = 'Center'
                        $ep.Children.Add($tt) | Out-Null

                        $sp = New-Object System.Windows.Controls.TextBlock
                        $sp.Text         = '  ·  '
                        $sp.FontSize     = 12
                        $sp.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                            [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
                        $sp.VerticalAlignment = 'Center'
                        $ep.Children.Add($sp) | Out-Null

                        $mt = New-Object System.Windows.Controls.TextBlock
                        $mt.Text         = $ev.message
                        $mt.FontSize     = 12
                        $mt.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                            [System.Windows.Media.ColorConverter]::ConvertFromString('#DDDDDD')))
                        $mt.VerticalAlignment = 'Center'
                        $mt.TextWrapping      = 'Wrap'
                        $mt.MaxWidth          = 320
                        $ep.Children.Add($mt) | Out-Null

                        $tm = New-Object System.Windows.Controls.TextBlock
                        $tm.Text         = Get-TimeAgo $ev.timestamp
                        $tm.FontSize     = 10
                        $tm.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                            [System.Windows.Media.ColorConverter]::ConvertFromString('#777777')))
                        $tm.VerticalAlignment = 'Center'
                        $ep.Children.Add($tm) | Out-Null

                        # Per-event "mark read" button (issue F)
                        if (-not $ev.read) {
                            $rb = New-Object System.Windows.Controls.TextBlock
                            $rb.Text         = ' ✓'
                            $rb.FontSize     = 12
                            $rb.FontWeight   = 'Bold'
                            $rb.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                                [System.Windows.Media.ColorConverter]::ConvertFromString('#55BB55')))
                            $rb.Cursor       = [System.Windows.Input.Cursors]::Hand
                            $rb.Margin      = '8,4,0,4'
                            $rb.ToolTip     = 'Mark as read'
                            $evId = $ev.id
                            $evCliPath = $script:_centerCliPath
                            $rb.Add_MouseDown({
                                param($s, $e)
                                $e.Handled = $true
                                if ($evCliPath) {
                                    try { Start-Process $env:AGENT_ATTENTION_NODE -ArgumentList "$evCliPath", 'mark-read', $evId -WindowStyle Hidden -ErrorAction SilentlyContinue } catch {}
                                }
                                $s.Parent.RemoveChild($s)
                            }.GetNewClosure()) | Out-Null
                            $ep.Children.Add($rb) | Out-Null
                        }

                        $newStack.Children.Add($ep) | Out-Null
                    }

                    if ($evts.Count -gt 8) {
                        $mx2 = New-Object System.Windows.Controls.TextBlock
                        $mx2.Text         = "  …and $($evts.Count - 8) more"
                        $mx2.FontSize     = 10
                        $mx2.Foreground   = (New-Object System.Windows.Media.SolidColorBrush(
                            [System.Windows.Media.ColorConverter]::ConvertFromString('#666666')))
                        $mx2.Margin       = '18,2,0,0'
                        $newStack.Children.Add($mx2) | Out-Null
                    }

                    # Agent separator
                    $asp = New-Object System.Windows.Shapes.Rectangle
                    $asp.Height = 1
                    $asp.Fill   = (New-Object System.Windows.Media.SolidColorBrush(
                        [System.Windows.Media.ColorConverter]::ConvertFromString('#2A2A2A')))
                    $asp.Margin = '0,6,0,0'
                    $newStack.Children.Add($asp) | Out-Null
                }
            }

            # -- Buttons (reuse existing btnPanel structure) --
            $bp = New-Object System.Windows.Controls.StackPanel
            $bp.Orientation        = 'Horizontal'
            $bp.HorizontalAlignment = 'Right'
            $bp.Margin             = '0,12,0,0'

            $mb = New-Object System.Windows.Controls.Button
            $mb.Content     = 'Mark all read'
            $mb.Width       = 110
            $mb.Height      = 32
            $mb.Margin      = '0,0,8,0'
            $mb.Background  = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#333333')))
            $mb.Foreground  = [System.Windows.Media.Brushes]::White
            $mb.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
            $mb.Add_Click({
                param($s, $e)
                $cliEnv  = $env:AGENT_ATTENTION_CLI
                $cliPath = $null
                if ($cliEnv -and (Test-Path $cliEnv)) { $cliPath = $cliEnv }
                else {
                    $cand = Join-Path $PSScriptRoot '..\..\dist\daemon-cli.js'
                    if (Test-Path $cand) { $cliPath = $cand }
                }
                if ($cliPath) {
                    $np = $env:AGENT_ATTENTION_NODE
                    if (-not $np) { $np = 'node' }
                    Start-Process $np -ArgumentList $cliPath, 'mark-all-read' `
                        -WindowStyle Hidden -ErrorAction SilentlyContinue
                }
                if ($window -and -not $window.IsDisposed) { try { $window.Close() } catch {} }
            }.GetNewClosure())
            $bp.Children.Add($mb) | Out-Null

            $cb = New-Object System.Windows.Controls.Button
            $cb.Content     = 'Close'
            $cb.Width       = 80
            $cb.Height      = 32
            $cb.Background  = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#333333')))
            $cb.Foreground  = [System.Windows.Media.Brushes]::White
            $cb.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
            $cb.Add_Click({
                if ($window -and -not $window.IsDisposed) { try { $window.Close() } catch {} }
            }.GetNewClosure())
            $bp.Children.Add($cb) | Out-Null

            $newStack.Children.Add($bp) | Out-Null
            $scrollViewer.Content = $newStack
        }
    } catch {
        # Transient read error — ignore and retry next tick
    }

    Start-Sleep -Milliseconds $refreshIntervalMs
}
