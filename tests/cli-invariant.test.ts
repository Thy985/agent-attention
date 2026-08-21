/**
 * CLI Invariant Test
 *
 * Verifies that running agent-attention CLI commands does NOT trigger
 * VS Code (Code.exe) or other editor processes to launch.
 *
 * Root cause: .ps1 file association hijacked by VS Code/Codex.
 * Fix: Use spawn with explicit 'powershell' command (NOT process.execPath,
 *      which is Node.exe and cannot run PowerShell scripts).
 */

import { spawnSync } from 'child_process';

describe('CLI Invariant: no unexpected editor launches', () => {
  function countCodeProcesses(): number {
    try {
      const result = spawnSync('powershell', [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_Process -Filter "Name=\'Code.exe\' or Name=\'atomcode.exe\'" | Measure-Object).Count',
      ], { encoding: 'utf8', shell: true });
      return parseInt(result.stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  it('should not launch Code.exe when running agent-attention doctor', () => {
    const before = countCodeProcesses();
    spawnSync('powershell', ['-NoProfile', '-Command', 'agent-attention doctor'], { encoding: 'utf8', shell: true });
    const after = countCodeProcesses();
    expect(after).toBeLessThanOrEqual(before);
  });

  it('should not launch Code.exe when running agent-attention daemon status', () => {
    const before = countCodeProcesses();
    spawnSync('powershell', ['-NoProfile', '-Command', 'agent-attention daemon status'], { encoding: 'utf8', shell: true });
    const after = countCodeProcesses();
    expect(after).toBeLessThanOrEqual(before);
  });

  it('should not launch Code.exe when running agent-attention tray doctor', () => {
    const before = countCodeProcesses();
    spawnSync('powershell', ['-NoProfile', '-Command', 'agent-attention tray doctor'], { encoding: 'utf8', shell: true });
    const after = countCodeProcesses();
    expect(after).toBeLessThanOrEqual(before);
  });

  it('should use spawn with explicit powershell (not process.execPath)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('src/jump.ts', 'utf8');
    // Must use spawnSync('powershell', ...) — NOT spawnSync(process.execPath, ...)
    expect(src).toContain("spawnSync('powershell'");
    expect(src).not.toContain('spawnSync(process.execPath');
    expect(src).not.toContain('execSync(`powershell');
  });

  it('should use spawn with explicit powershell in win32.ts (not process.execPath)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    // Must use spawn('powershell', ...) — NOT spawn(process.execPath, ...)
    expect(src).toContain("spawn('powershell'");
    expect(src).not.toContain('spawn(process.execPath');
    expect(src).not.toContain('exec(`powershell');
  });
});
