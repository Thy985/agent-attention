# MiniPanel — pure functions for menu rendering.
# Dot-sourced by TrayIcon.ps1; tested by Pester.

function Get-RelativeTime {
    param([long]$TimestampMs)
    $delta = (Get-Date).ToFileTime() / 10000 - $TimestampMs
    $seconds = [math]::Floor($delta / 1000)
    if ($seconds -lt 60) { return "${seconds}s ago" }
    $minutes = [math]::Floor($seconds / 60)
    if ($minutes -lt 60) { return "${minutes}m ago" }
    $hours = [math]::Floor($minutes / 60)
    if ($hours -lt 24) { return "${hours}h ago" }
    $days = [math]::Floor($hours / 24)
    return "${days}d ago"
}

function Get-PriorityBadge {
    param([string]$Priority)
    switch ($Priority) {
        'P0' { return '🔴' }
        'P1' { return '🟡' }
        default { return '🟢' }
    }
}

function Format-EventMenuText {
    param($Event)
    $badge = Get-PriorityBadge $Event.priority
    $agent = if ($Event.agent) { $Event.agent } else { 'agent' }
    return "$badge $agent · $($Event.event) · $(Get-RelativeTime $Event.timestamp)"
}