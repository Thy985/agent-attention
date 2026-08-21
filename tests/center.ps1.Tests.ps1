# Pester tests for MiniPanel.ps1
# Run: Invoke-Pester tests/center.ps1.Tests.ps1

Describe 'MiniPanel' {
    BeforeAll {
        $scriptPath = Join-Path $PSScriptRoot '..\src\center\MiniPanel.ps1'
        . $scriptPath
    }

    Context 'Get-RelativeTime' {
        It 'returns seconds for recent timestamps' {
            $now = (Get-Date).ToFileTime() / 10000
            $result = Get-RelativeTime -TimestampMs ($now - 30000)
            $result | Should -Match '^\d+s ago$'
        }

        It 'returns minutes for older timestamps' {
            $now = (Get-Date).ToFileTime() / 10000
            $result = Get-RelativeTime -TimestampMs ($now - 300000)
            $result | Should -Match '^\d+m ago$'
        }

        It 'returns days for very old timestamps' {
            $now = (Get-Date).ToFileTime() / 10000
            $result = Get-RelativeTime -TimestampMs ($now - 86400000 * 3)
            $result | Should -Match '^\d+d ago$'
        }
    }

    Context 'Get-PriorityBadge' {
        It 'returns red for P0' {
            Get-PriorityBadge 'P0' | Should -Be '🔴'
        }
        It 'returns yellow for P1' {
            Get-PriorityBadge 'P1' | Should -Be '🟡'
        }
        It 'returns green for P2' {
            Get-PriorityBadge 'P2' | Should -Be '🟢'
        }
        It 'returns green for unknown' {
            Get-PriorityBadge 'P9' | Should -Be '🟢'
        }
    }

    Context 'Format-EventMenuText' {
        It 'combines badge, agent, event, and time' {
            $now = (Get-Date).ToFileTime() / 10000
            $event = [PSCustomObject]@{
                priority = 'P0'
                agent = 'codex'
                event = 'permission_required'
                timestamp = $now - 60000
                message = 'ignored'
            }
            $result = Format-EventMenuText -Event $event
            $result | Should -Match '^🔴 codex · permission_required · \d+m ago$'
        }

        It 'uses default agent when missing' {
            $now = (Get-Date).ToFileTime() / 10000
            $event = [PSCustomObject]@{
                priority = 'P2'
                agent = $null
                event = 'completed'
                timestamp = $now
                message = ''
            }
            $result = Format-EventMenuText -Event $event
            $result | Should -Match '^🟢 agent · completed · \d+s ago$'
        }
    }
}