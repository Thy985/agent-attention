# Agent Attention Center 鈥?Tray Icon (PowerShell + WPF)
# Usage:
#   TrayIcon.ps1 show                    # start persistent NotifyIcon
#   TrayIcon.ps1 exit                    # close icon and exit
#
# Stdin protocol (one JSON object per line): each line replaces current state.

param(
    [Parameter(Mandatory=$true)][ValidateSet('show','exit')][string]$Command
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Dot-source MiniPanel helpers
$miniPanelPath = Join-Path $PSScriptRoot 'MiniPanel.ps1'
. $miniPanelPath

$script:NotifyIcon = $null
$script:CurrentState = @{ unreadCount = 0; events = @() }

function Update-Icon {
    param($State)
    $script:CurrentState = $State

    # Compute total unread
    $totalUnread = ($script:CurrentState.events | Where-Object { -not $_.read }).Count
    $text = if ($totalUnread -gt 0) { "[$totalUnread]" } else { "[0]" }
    $script:NotifyIcon.Text = "Agent Attention: $text"

    # Create a simple colored icon based on unread count
    $iconColor = if ($totalUnread -gt 0) { [System.Drawing.Color]::Red } else { [System.Drawing.Color]::Green }
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($iconColor)
    $g.Dispose()
    $script:NotifyIcon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $header = New-Object System.Windows.Forms.ToolStripMenuItem
    $header.Text = "Agent Attention"
    $header.Enabled = $false
    $menu.Items.Add($header) | Out-Null

    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Open Center menu item
    $openCenter = New-Object System.Windows.Forms.ToolStripMenuItem
    $openCenter.Text = 'Open Center'
    $openCenter.Add_Click({
        $centerPath = Join-Path $PSScriptRoot 'CenterWindow.ps1'
        Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$centerPath`"" -WindowStyle Normal
    }.GetNewClosure())
    $menu.Items.Add($openCenter) | Out-Null

    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    if (-not $State.events -or $State.events.Count -eq 0) {
        $empty = New-Object System.Windows.Forms.ToolStripMenuItem
        $empty.Text = "(no events)"
        $empty.Enabled = $false
        $menu.Items.Add($empty) | Out-Null
    } else {
        $maxItems = [math]::Min($State.events.Count, 20)
        for ($i = 0; $i -lt $maxItems; $i++) {
            $ev = $State.events[$i]
            $item = New-Object System.Windows.Forms.ToolStripMenuItem
            $readMark = if ($ev.read) { "[R]" } else { "[U]" }
            $agent = if ($ev.agent_name) { $ev.agent_name } elseif ($ev.agent_id) { $ev.agent_id } else { "agent" }
            $item.Text = "$readMark $agent : $($ev.type) - $($ev.message)"
            $item.Tag = $ev
            $item.Add_Click({
                param($s, $e)
                $ev = $s.Tag
                $agentName = if ($ev.agent_name) { $ev.agent_name } elseif ($ev.agent_id) { $ev.agent_id } else { "agent" }
                $readStatus = if ($ev.read) { "Yes" } else { "No" }
                $details = "Agent: $agentName`nType: $($ev.type)`nMessage: $($ev.message)`nPriority: $($ev.priority)`nRead: $readStatus"
                [System.Windows.Forms.MessageBox]::Show($details, "Agent Attention", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
            }.GetNewClosure())
            $menu.Items.Add($item) | Out-Null
        }
    }

    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
    $exitItem.Text = "Exit"
    $exitItem.Add_Click({
        $script:NotifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }.GetNewClosure())
    $menu.Items.Add($exitItem) | Out-Null

    $script:NotifyIcon.ContextMenuStrip = $menu
}

function Start-Tray {
    $script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
    $script:NotifyIcon.Icon = [System.Drawing.SystemIcons]::Application
    $script:NotifyIcon.Visible = $true

    # Left-click shows latest event
    $script:NotifyIcon.Add_Click({
        if ($script:CurrentState.events.Count -gt 0) {
            $latest = $script:CurrentState.events[0]
            $details = "Agent: $(if ($latest.agent_name) { $latest.agent_name } elseif ($latest.agent_id) { $latest.agent_id } else { 'agent' })`nType: $($latest.type)`nMessage: $($latest.message)`nPriority: $($latest.priority)`nRead: $(if ($latest.read) { 'Yes' } else { 'No' })"
            [System.Windows.Forms.MessageBox]::Show($details, "Agent Attention", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
        } else {
            [System.Windows.Forms.MessageBox]::Show("No events yet.`nRun agent-notify to trigger notifications.", "Agent Attention", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
        }
    })

    # Double-click clears unread count
    $script:NotifyIcon.Add_DoubleClick({
        $script:CurrentState.unreadCount = 0
        Update-Icon $script:CurrentState
        [System.Windows.Forms.MessageBox]::Show("Marked all as read.", "Agent Attention", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    })

    # Read state JSON from stdin line by line
    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { break }
        try {
            $state = $line | ConvertFrom-Json
            Update-Icon $state
        } catch [System.Exception] {
            Write-Warning ("invalid state JSON: {0}" -f $_.Exception.Message)
        }
    }
}

function Invoke-Exit {
    if ($script:NotifyIcon) {
        $script:NotifyIcon.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
}

switch ($Command) {
    'show' { Start-Tray }
    'exit' { Invoke-Exit }
}

