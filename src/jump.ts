import { spawnSync } from 'child_process';
import * as path from 'path';

export interface AgentTarget {
  type: 'terminal';
  pid: number;
}

/**
 * Best-effort attempt to focus a terminal window by PID on Windows.
 * Logs a warning on failure but never throws.
 */
export function jumpToTarget(target: AgentTarget | null): void {
  if (!target || target.type !== 'terminal') return;

  try {
    const psCode = `
      $proc = Get-Process -Id ${target.pid} -ErrorAction SilentlyContinue
      if ($proc) {
        $hwnd = $proc.MainWindowHandle
        if ($hwnd -ne 0) {
          Add-Type -TypeDefinition @"
            using System;
            using System.Runtime.InteropServices;
            public class Win32 {
              [DllImport("user32.dll")]
              public static extern bool SetForegroundWindow(IntPtr hWnd);
              [DllImport("user32.dll")]
              public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            }
"@
            [Win32]::ShowWindow($hwnd, 3)
            [Win32]::SetForegroundWindow($hwnd)
          }
        }
      `;

    // Use spawnSync with explicit 'powershell' — process.execPath is Node, not PS.
    spawnSync('powershell', [
      '-NoProfile', '-Command', psCode.replace(/\n/g, ' '),
    ], { timeout: 5000, stdio: 'ignore', windowsHide: true });
  } catch (err) {
    console.warn(`[agent-attention] jump to PID ${target.pid} failed: ${err}`);
  }
}
