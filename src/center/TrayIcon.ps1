# Agent Attention Center 鈥?Tray Icon (PowerShell + WinForms)
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

$script:NotifyIcon = $null
$script:CurrentState = @{ unreadCount = 0; events = @() }

function Update-Icon {
    param($State)
    $script:CurrentState = $State

    $totalUnread = ($script:CurrentState.events | Where-Object { -not $_.read }).Count
    $text = if ($totalUnread -gt 0) { "[$totalUnread]" } else { "[0]" }
    $script:NotifyIcon.Text = "Agent Attention: $text"

    # Create colored icon: red=has unread, green=none
    $iconColor = if ($totalUnread -gt 0) {
        [System.Drawing.Color]::FromArgb(220, 50, 50)
    } else {
        [System.Drawing.Color]::FromArgb(50, 160, 80)
    }
    $bmp = New-Object System.Drawing.Bitmap(16, 16)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear($iconColor)
    # Draw white notification badge number if unread
    if ($totalUnread -gt 0) {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
        $font = New-Object System.Drawing.Font("Arial", 8, [System.Drawing.FontStyle]::Bold)
        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
        $numStr = if ($totalUnread -gt 9) { "+" } else { "$totalUnread" }
        $size = $g.MeasureString($numStr, $font)
        $x = [Math]::Max(0, [Math]::Floor((16 - $size.Width) / 2))
        $y = [Math]::Max(0, [Math]::Floor((16 - $size.Height) / 2))
        $g.DrawString($numStr, $font, $brush, $x, $y)
        $font.Dispose()
        $brush.Dispose()
    }
    $g.Dispose()
    $oldIcon = $script:NotifyIcon.Icon
    $script:NotifyIcon.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $bmp.Dispose()
    if ($oldIcon) { $oldIcon.Dispose() }

    # Build context menu
    $menu = New-Object System.Windows.Forms.ContextMenuStrip

    $header = New-Object System.Windows.Forms.ToolStripMenuItem
    $header.Text = "Agent Attention"
    $header.Enabled = $false
    $menu.Items.Add($header) | Out-Null
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Open Center
    $openCenter = New-Object System.Windows.Forms.ToolStripMenuItem
    $openCenter.Text = 'Open Center'
    $openCenter.Add_Click({
        $centerPath = Join-Path $PSScriptRoot 'CenterWindow.ps1'
        Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$centerPath`"" -WindowStyle Normal
    }.GetNewClosure())
    $menu.Items.Add($openCenter) | Out-Null
    $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

    # Event list
    if (-not $State.events -or $State.events.Count -eq 0) {
        $empty = New-Object System.Windows.Forms.ToolStripMenuItem
        $empty.Text = "(no events)"
        $empty.Enabled = $false
        $menu.Items.Add($empty) | Out-Null
    } else {
        $maxItems = [math]::Min($State.events.Count, 10)
        for ($i = 0; $i -lt $maxItems; $i++) {
            $ev = $State.events[$i]
            $readMark = if ($ev.read) { "[R]" } else { "[!]" }
            $agent = if ($ev.agent_name) { $ev.agent_name } elseif ($ev.agent_id) { $ev.agent_id } else { "agent" }
            $shortMsg = if ($ev.message.Length -gt 30) { $ev.message.Substring(0, 30) + "..." } else { $ev.message }
            $item = New-Object System.Windows.Forms.ToolStripMenuItem
            $item.Text = "$readMark $agent : $shortMsg"
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
    $script:NotifyIcon.ContextMenuStrip = $null

    # Left-click: open center window
    $script:NotifyIcon.Add_Click({
        $centerPath = Join-Path $PSScriptRoot 'CenterWindow.ps1'
        Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$centerPath`"" -WindowStyle Normal
    }.GetNewClosure())

    # Double-click: mark all read
    $script:NotifyIcon.Add_DoubleClick({
        $cliPath = Join-Path $PSScriptRoot '..\..\dist\daemon-cli.js'
        if (Test-Path $cliPath) {
            Start-Process node -ArgumentList $cliPath, 'daemon', 'mark-all-read' -WindowStyle Hidden -ErrorAction SilentlyContinue
        }
        $script:CurrentState.unreadCount = 0
        $script:CurrentState.events = @($script:CurrentState.events | ForEach-Object { $_.read = $true; $_ })
        Update-Icon $script:CurrentState
    }.GetNewClosure())

    # Read state JSON from stdin
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


