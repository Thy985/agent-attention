import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Remove startup hook + kill running daemon.
 *
 * Fixed issues:
 * - Uses .vbs (consistent with install-daemon.ts) instead of .lnk
 * - Kills ONLY the daemon process (by PID file), NOT all node.exe processes
 */

const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);
const STARTUP_NAME = 'agent-attention';
const STATE_DIR    = path.join(os.homedir(), '.agent-attention');
const PID_FILE     = path.join(STATE_DIR, 'daemon.pid');

function main(): void {
  // 1. Remove startup hook (.vbs — same name install-daemon.ts writes)
  const vbsPath = path.join(STARTUP_DIR, `${STARTUP_NAME}.vbs`);
  if (fs.existsSync(vbsPath)) {
    fs.unlinkSync(vbsPath);
    console.log(`Removed startup hook: ${vbsPath}`);
  } else {
    console.log(`No startup hook found at ${vbsPath} (already uninstalled?)`);
  }

  // 2. Kill daemon by PID file ONLY — never enumerate all node.exe processes
  if (fs.existsSync(PID_FILE)) {
    const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`Sent SIGTERM to daemon (pid=${pid})`);
      } catch {
        console.log(`Daemon pid=${pid} not running (may have already exited)`);
      }
      // Clean up PID file
      try { fs.unlinkSync(PID_FILE); } catch {}
    }
  } else {
    console.log(`No PID file found at ${PID_FILE} (daemon may not be managed by install script)`);
  }

  // 3. If on Windows, verify no daemon.js processes are still lingering
  if (process.platform === 'win32') {
    try {
      // Find processes whose command line contains 'daemon.js' — targeted, not blanket
      const out = execSync(
        'powershell -NoProfile -Command ' +
        '$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*daemon.js*\' } | Select-Object -ExpandProperty ProcessId -First 5; ' +
        'if ($p) { $p -join \',\' } else { \'none\' }',
        { encoding: 'utf-8', timeout: 5000 },
      );
      const lingering = out.trim();
      if (lingering !== 'none' && lingering !== '') {
        console.warn(`Warning: lingering daemon.js processes found: ${lingering}`);
        console.warn('You may need to kill them manually: taskkill /F /PID <pid>');
      }
    } catch {
      // WMI unavailable — skip
    }
  }
}

main();
