# Agent Attention Center 鈥?Center Window (WPF)
# Shows a popup window with agent-grouped events.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File CenterWindow.ps1
#        [-StatePath <path>] [-RegistryPath <path>]

param(
    [string]$StatePath = "$env:USERPROFILE\.agent-attention\state.json",
    [string]$RegistryPath = "$env:USERPROFILE\.agent-attention\agents.json"
)

# 鈹€鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function Get-State {
    try {
        if (Test-Path $StatePath) {
            Get-Content $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else { @{ unreadCount = 0; events = @() } }
    } catch { Write-Warning "Invalid state: $_"; @{ unreadCount = 0; events = @() } }
}

function Get-Registry {
    try {
        if (Test-Path $RegistryPath) {
            Get-Content $RegistryPath -Raw -Encoding UTF8 | ConvertFrom-Json
        } else { @{ agents = @() } }
    } catch { Write-Warning "Invalid registry: $_"; @{ agents = @() } }
}

function Get-TimeAgo {
    param([long]$TimestampMs)
    $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $seconds = [math]::Floor(($now - $TimestampMs) / 1000)
    if ($seconds -lt 60) { return "${seconds}s ago" }
    $minutes = [math]::Floor($seconds / 60)
    if ($minutes -lt 60) { return "${minutes}m ago" }
    $hours = [math]::Floor($minutes / 60)
    if ($hours -lt 24) { return "${hours}h ago" }
    return "${[math]::Floor($hours / 24)}d ago"
}

function Get-ConnectionStatus {
    param([long]$lastSeenAt)
    $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $minsAgo = [math]::Floor(($now - $lastSeenAt) / 60000)
    if ($minsAgo -lt 5) { return @{ status = 'connected'; label = '鈼?Connected' } }
    return @{ status = 'inactive'; label = "鈼?Last seen ${minsAgo}m ago" }
}

# 鈹€鈹€鈹€ Load data 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
$state = Get-State
$registry = Get-Registry

# Build agent lookup
$agentMap = @{}
foreach ($a in $registry.agents) {
    $agentMap[$a.agent_id] = $a
}

# Group events by agent_id
$agentGroups = @{}
foreach ($ev in $state.events) {
    $aid = $ev.agent_id
    if (-not $agentMap.ContainsKey($aid)) { $agentMap[$aid] = @{ agent_id = $aid; name = $aid } }
    if (-not $agentGroups.ContainsKey($aid)) { $agentGroups[$aid] = @() }
    $agentGroups[$aid] += @($ev)
}

# 鈹€鈹€鈹€ WPF setup 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

# Window
$window = New-Object System.Windows.Window
$window.Title = 'Agent Attention Center'
$window.Width = 480
$window.Height = 540
$window.ResizeMode = 'CanMinimize'
$window.WindowStartupLocation = 'CenterScreen'
$window.Background = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#1E1E1E')))

# Main scroll viewer
$scrollViewer = New-Object System.Windows.Controls.ScrollViewer
$scrollViewer.VerticalScrollBarVisibility = 'Auto'
$scrollViewer.HorizontalScrollBarVisibility = 'Disabled'

# Stack panel
$stackPanel = New-Object System.Windows.Controls.StackPanel
$stackPanel.Margin = '12'

# Title
$titleBlock = New-Object System.Windows.Controls.TextBlock
$titleBlock.Text = 'Agent Attention'
$titleBlock.FontSize = 20
$titleBlock.FontWeight = 'Bold'
$titleBlock.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#FFFFFF')))
$titleBlock.Margin = '0,0,0,8'
$stackPanel.Children.Add($titleBlock) | Out-Null

# Subtitle: total unread
$totalUnread = $state.events | Where-Object { -not $_.read } | Measure-Object
$subtitleBlock = New-Object System.Windows.Controls.TextBlock
$subtitleBlock.Text = "$($totalUnread.Count) unread notification(s)"
$subtitleBlock.FontSize = 12
$subtitleBlock.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#AAAAAA')))
$subtitleBlock.Margin = '0,0,0,12'
$stackPanel.Children.Add($subtitleBlock) | Out-Null

# Separator
$sep = New-Object System.Windows.Shapes.Rectangle
$sep.Height = 1
$sep.Fill = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#3E3E3E')))
$sep.Margin = '0,0,0,12'
$stackPanel.Children.Add($sep) | Out-Null

# Agent sections
if ($agentGroups.Count -eq 0) {
    $emptyBlock = New-Object System.Windows.Controls.TextBlock
    $emptyBlock.Text = 'No events yet. Run agent-notify to trigger notifications.'
    $emptyBlock.FontSize = 13
    $emptyBlock.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
        [System.Windows.Media.ColorConverter]::ConvertFromString('#888888')))
    $emptyBlock.HorizontalAlignment = 'Center'
    $emptyBlock.Margin = '0,40,0,0'
    $stackPanel.Children.Add($emptyBlock) | Out-Null
} else {
    foreach ($agentId in $agentGroups.Keys) {
        $events = $agentGroups[$agentId]
        $agentInfo = $agentMap[$agentId]
        $agentName = if ($agentInfo.name) { $agentInfo.name } else { $agentId }
        $unreadForAgent = ($events | Where-Object { -not $_.read }).Count

        # Agent header
        $connStatus = if ($agentInfo.last_seen_at) {
            Get-ConnectionStatus $agentInfo.last_seen_at
        } else {
            @{ status = 'inactive'; label = '鈼?Unknown' }
        }

        $agentHeaderPanel = New-Object System.Windows.Controls.StackPanel
        $agentHeaderPanel.Margin = '0,8,0,4'

        $agentTitle = New-Object System.Windows.Controls.TextBlock
        $agentTitle.Text = "$agentName  ($unreadForAgent unread)"
        $agentTitle.FontSize = 14
        $agentTitle.FontWeight = 'SemiBold'
        $agentTitle.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#E0E0E0')))
        $agentHeaderPanel.Children.Add($agentTitle) | Out-Null

        $connText = New-Object System.Windows.Controls.TextBlock
        $connText.Text = $connStatus.label
        $connText.FontSize = 10
        $connText.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#888888')))
        $agentHeaderPanel.Children.Add($connText) | Out-Null

        $stackPanel.Children.Add($agentHeaderPanel) | Out-Null

        # Events for this agent (show up to 8)
        $maxShow = [math]::Min($events.Count, 8)
        for ($i = 0; $i -lt $maxShow; $i++) {
            $ev = $events[$i]
            $evPanel = New-Object System.Windows.Controls.StackPanel
            $evPanel.Orientation = 'Horizontal'
            $evPanel.Margin = '8,2,0,2'

            # Priority dot
            $priorityColor = switch ($ev.priority) {
                'P0' { '#FF5555' }
                'P1' { '#FFAA33' }
                default { '#55BB55' }
            }
            $dot = New-Object System.Windows.Shapes.Ellipse
            $dot.Fill = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString($priorityColor)))
            $dot.Width = 8
            $dot.Height = 8
            $dot.Margin = '2,4,6,4'
            $evPanel.Children.Add($dot) | Out-Null

            # Event type
            $typeText = New-Object System.Windows.Controls.TextBlock
            $typeText.Text = $ev.type
            $typeText.FontSize = 12
            $typeText.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#CCCCCC')))
            $typeText.VerticalAlignment = 'Center'
            $evPanel.Children.Add($typeText) | Out-Null

            # Separator
            $sep2 = New-Object System.Windows.Controls.TextBlock
            $sep2.Text = '  路  '
            $sep2.FontSize = 12
            $sep2.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
            $sep2.VerticalAlignment = 'Center'
            $evPanel.Children.Add($sep2) | Out-Null

            # Message
            $msgText = New-Object System.Windows.Controls.TextBlock
            $msgText.Text = $ev.message
            $msgText.FontSize = 12
            $msgText.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#DDDDDD')))
            $msgText.VerticalAlignment = 'Center'
            $msgText.TextWrapping = 'Wrap'
            $msgText.MaxWidth = 320
            $evPanel.Children.Add($msgText) | Out-Null

            # Time
            $timeText = New-Object System.Windows.Controls.TextBlock
            $timeText.Text = Get-TimeAgo $ev.timestamp
            $timeText.FontSize = 10
            $timeText.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#777777')))
            $timeText.VerticalAlignment = 'Center'
            $evPanel.Children.Add($timeText) | Out-Null

            $stackPanel.Children.Add($evPanel) | Out-Null
        }

        if ($events.Count -gt 8) {
            $moreText = New-Object System.Windows.Controls.TextBlock
            $moreText.Text = "  鈥nd $($events.Count - 8) more"
            $moreText.FontSize = 10
            $moreText.Foreground = (New-Object System.Windows.Media.SolidColorBrush(
                [System.Windows.Media.ColorConverter]::ConvertFromString('#666666')))
            $moreText.Margin = '18,2,0,0'
            $stackPanel.Children.Add($moreText) | Out-Null
        }

        # Agent separator
        $agentSep = New-Object System.Windows.Shapes.Rectangle
        $agentSep.Height = 1
        $agentSep.Fill = (New-Object System.Windows.Media.SolidColorBrush(
            [System.Windows.Media.ColorConverter]::ConvertFromString('#2A2A2A')))
        $agentSep.Margin = '0,6,0,0'
        $stackPanel.Children.Add($agentSep) | Out-Null
    }
}

# Bottom buttons
$btnPanel = New-Object System.Windows.Controls.StackPanel
$btnPanel.Orientation = 'Horizontal'
$btnPanel.HorizontalAlignment = 'Right'
$btnPanel.Margin = '0,12,0,0'

# Mark all read
$markBtn = New-Object System.Windows.Controls.Button
$markBtn.Content = 'Mark all read'
$markBtn.Width = 110
$markBtn.Height = 32
$markBtn.Margin = '0,0,8,0'
$markBtn.Background = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#333333')))
$markBtn.Foreground = [System.Windows.Media.Brushes]::White
$markBtn.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
$markBtn.Add_Click({
    # Call the CLI to clear all
    $cliPath = Join-Path $PSScriptRoot '..\..\dist\daemon-cli.js'
    if (Test-Path $cliPath) {
        Start-Process node -ArgumentList $cliPath, 'daemon', 'restart' -WindowStyle Hidden
    }
    if ($window -and -not $window.IsDisposed) { try { $window.Close() } catch {} }
})
$btnPanel.Children.Add($markBtn) | Out-Null

# Close
$closeBtn = New-Object System.Windows.Controls.Button
$closeBtn.Content = 'Close'
$closeBtn.Width = 80
$closeBtn.Height = 32
$closeBtn.Background = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#333333')))
$closeBtn.Foreground = [System.Windows.Media.Brushes]::White
$closeBtn.BorderBrush = (New-Object System.Windows.Media.SolidColorBrush(
    [System.Windows.Media.ColorConverter]::ConvertFromString('#555555')))
$closeBtn.Add_Click({ if ($window -and -not $window.IsDisposed) { try { $window.Close() } catch {} } })
$btnPanel.Children.Add($closeBtn) | Out-Null

$stackPanel.Children.Add($btnPanel) | Out-Null

$scrollViewer.Content = $stackPanel
$window.Content = $scrollViewer

# Keyboard shortcut: Escape to close
$window.Add_KeyDown({ if ($_.Key -eq 'Escape') { if ($window -and -not $window.IsDisposed) { try { $window.Close() } catch {} } } })

$window.ShowDialog()

