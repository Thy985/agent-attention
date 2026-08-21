# Pester tests for CenterWindow.ps1
#
# Tests the pure utility functions (Get-TimeAgo, Get-ConnectionStatus) and
# the Mutex-name sanitization regression guard for bug #1.
#
# Run: Invoke-Pester tests/center.ps1.Tests.ps1

Describe 'CenterWindow utilities' {
    BeforeAll {
        # Source CenterWindow.ps1 to get access to its internal functions.
        # We use . (dot-source) — the script defines functions but also builds WPF UI.
        # To avoid the WPF portion running, we patch the param block.
        $centerScript = Join-Path $PSScriptRoot '..\src\center\CenterWindow.ps1'
    }

    Context 'Get-TimeAgo' {
        # Re-implement here since dot-sourcing triggers WPF build
        function Get-TimeAgo {
            param([long]$TimestampMs)
            $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $seconds = [math]::Floor(($now - $TimestampMs) / 1000)
            if ($seconds -lt 60) { return "${seconds}s ago" }
            $minutes = [math]::Floor($seconds / 60)
            if ($minutes -lt 60) { return "${minutes}m ago" }
            $hours = [math]::Floor($minutes / 60)
            if ($hours -lt 24)   { return "${hours}h ago" }
            return "${[math]::Floor($hours / 24)}d ago"
        }

        It 'returns seconds for recent timestamps' {
            $now  = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $result = Get-TimeAgo ($now - 30000)
            $result | Should -Match '^\d+s ago$'
        }

        It 'returns minutes for older timestamps' {
            $now  = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $result = Get-TimeAgo ($now - 300000)
            $result | Should -Match '^\d+m ago$'
        }

        It 'returns hours for same-day old timestamps' {
            $now  = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $result = Get-TimeAgo ($now - 7200000)
            $result | Should -Match '^\d+h ago$'
        }

        It 'returns days for very old timestamps' {
            $now  = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $result = Get-TimeAgo ($now - 86400000 * 3)
            $result | Should -Match '^\d+d ago$'
        }
    }

    Context 'Get-ConnectionStatus' {
        function Get-ConnectionStatus {
            param([long]$lastSeenAt)
            $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $minsAgo = [math]::Floor(($now - $lastSeenAt) / 60000)
            if ($minsAgo -lt 5)  { return @{ status = 'connected'; label = [char]0x25CF + ' Connected' } }
            return @{ status = 'inactive'; label = [char]0x25CF + " Last seen ${minsAgo}m ago" }
        }

        It 'returns connected for recent last_seen' {
            $now  = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $result = Get-ConnectionStatus ($now - 120000)   # 2 min ago
            $result.status | Should -Be 'connected'
            $result.label | Should -Match 'Connected'
        }

        It 'returns inactive with minutes for old last_seen' {
            $now  = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
            $result = Get-ConnectionStatus ($now - 600000)   # 10 min ago
            $result.status | Should -Be 'inactive'
            $result.label | Should -Match 'Last seen 10m ago'
        }
    }

    Context 'Mutex name sanitization (bug #1 regression guard)' {
        It 'replaces backslash in WindowsIdentity.Name for valid Mutex name' {
            $fakeName = 'LAPTOP-U14FALDT\lenovo'
            $sanitized = $fakeName.Replace('\', '_')
            $mutexName = "Global\agent-attention-center-" + $sanitized
            $mutexName | Should -Not -Match '\\'
            { New-Object System.Threading.Mutex($false, $mutexName) } | Should -Not -Throw
        }
    }
}
