import { spawnSync } from 'child_process';

export interface AgentTarget { type: 'terminal'; pid: number; }
export interface JumpResult {
  ok: boolean;
  reason: string;
  pid?: number;
  hwnd?: string;
  foregroundBefore?: string;
  foregroundAfter?: string;
  setForegroundReturned?: boolean;
}

/** Best effort, NOT guaranteed focus. Success requires an observed foreground HWND.
 * No synthetic keystrokes, focus-lock changes or input-thread attachment.
 * Returning a failure is intentional: spawning PowerShell is not proof of focus.
 */
export function jumpToTarget(target: AgentTarget | null): JumpResult {
  if (!target || target.type !== 'terminal') return { ok: false, reason: 'no-target' };
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid > 0xffffffff) {
    return { ok: false, reason: 'invalid-pid' };
  }
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform', pid: target.pid };
  try {
    // Preserve newlines: PowerShell here-strings cannot be flattened into one line.
    // -EncodedCommand is UTF-16LE and avoids command-shell interpolation entirely.
    const psCode = `
$ErrorActionPreference = 'Stop'
$result = [ordered]@{ ok=$false; reason='unknown'; pid=${target.pid}; hwnd='0'; foregroundBefore='0'; foregroundAfter='0'; setForegroundReturned=$false }
try {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AAJumpNative {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
  $result.foregroundBefore = [AAJumpNative]::GetForegroundWindow().ToInt64().ToString()
  $proc = Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue
  if (-not $proc) { $result.reason='process-not-found' }
  else {
    $proc.Refresh()
    $handle = $proc.MainWindowHandle
    $result.hwnd = $handle.ToInt64().ToString()
    if ($handle -eq [IntPtr]::Zero) { $result.reason='no-window' }
    else {
      if ([AAJumpNative]::IsIconic($handle)) { [void][AAJumpNative]::ShowWindow($handle, 9) }
      $result.setForegroundReturned = [AAJumpNative]::SetForegroundWindow($handle)
      # Bounded observation only. Do not repeatedly steal focus or bypass Windows policy.
      for ($i=0; $i -lt 10; $i++) {
        $result.foregroundAfter = [AAJumpNative]::GetForegroundWindow().ToInt64().ToString()
        if ($result.foregroundAfter -eq $result.hwnd) { break }
        Start-Sleep -Milliseconds 50
      }
      $result.ok = ($result.foregroundAfter -eq $result.hwnd)
      $result.reason = if ($result.ok) { 'focused' } else { 'foreground-denied-or-changed' }
    }
  }
  $result.foregroundAfter = [AAJumpNative]::GetForegroundWindow().ToInt64().ToString()
  if ($result.ok -and $result.foregroundAfter -ne $result.hwnd) { $result.ok=$false; $result.reason='foreground-denied-or-changed' }
} catch { $result.ok=$false; $result.reason='native-error' }
$result | ConvertTo-Json -Compress
if ($result.ok) { exit 0 } else { exit 1 }
`;
    const run = spawnSync('powershell', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psCode, 'utf16le').toString('base64'),
    ], { timeout: 8000, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
    if (run.error || run.signal) return { ok: false, reason: 'powershell-error', pid: target.pid };
    let value: JumpResult;
    try { value = JSON.parse((run.stdout || '').trim().replace(/^\uFEFF/, '')); }
    catch { return { ok: false, reason: 'invalid-response', pid: target.pid }; }
    if (!value || typeof value !== 'object' || value.pid !== target.pid || typeof value.reason !== 'string') {
      return { ok: false, reason: 'invalid-response', pid: target.pid };
    }
    const observed = typeof value.hwnd === 'string' && /^[1-9]\d*$/.test(value.hwnd)
      && value.hwnd === value.foregroundAfter;
    if (value.ok === true && (run.status !== 0 || !observed || value.reason !== 'focused')) {
      return { ...value, ok: false, reason: 'unverified-focus' };
    }
    return { ...value, ok: value.ok === true && observed && run.status === 0 };
  } catch {
    return { ok: false, reason: 'powershell-error', pid: target.pid };
  }
}
