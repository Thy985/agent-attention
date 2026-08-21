import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

/**
 * Register daemon at Windows startup + spawn initial daemon process.
 *
 * 1. Verify dist/daemon.js exists
 * 2. Create %APPDATA%\...\Startup\agent-attention.vbs
 *    (VBScript launches node with absolute path, window hidden)
 * 3. Spawn daemon detached + write PID file
 * 4. Print confirmation
 *
 * Idempotent: re-running replaces the .vbs and restarts the daemon.
 */

const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);
const STARTUP_NAME = 'agent-attention';
const STATE_DIR    = path.join(os.homedir(), '.agent-attention');
const PID_FILE     = path.join(STATE_DIR, 'daemon.pid');

function main(): void {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const distDaemon  = path.join(projectRoot, 'dist', 'daemon.js');
  const vbsPath     = path.join(STARTUP_DIR, `${STARTUP_NAME}.vbs`);

  if (!fs.existsSync(distDaemon)) {
    console.error(`Daemon not built. Run: npm run build`);
    console.error(`Expected: ${distDaemon}`);
    process.exit(1);
  }

  if (!fs.existsSync(STARTUP_DIR)) {
    console.error(`Startup directory not found: ${STARTUP_DIR}`);
    console.error(`(Are you on Windows?)`);
    process.exit(1);
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });

  // Write VBScript with ABSOLUTE node path so it works even without node in PATH.
  const nodeExe  = process.execPath;                           // e.g. C:\Program Files\nodejs\node.exe
  const escapedNode = nodeExe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedDaemon = distDaemon.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const vbsContent = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run Chr(34) & "${escapedNode}" & Chr(34) & " " & Chr(34) & "${escapedDaemon}" & Chr(34), 0, False`,
  ].join('\n');

  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
  console.log(`Installed startup hook: ${vbsPath}`);

  // Kill any previous daemon instance before spawning a fresh one.
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (!isNaN(existingPid)) {
      try { process.kill(existingPid, 'SIGTERM'); } catch {}
      // Give it a moment to die
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        try { process.kill(existingPid, 0); } catch { break; }
        require('child_process').execSync('ping -n 1 127.0.0.1 >nul', { shell: true });
      }
      try { process.kill(existingPid, 'SIGKILL'); } catch {}
      console.log(`Killed stale daemon (pid=${existingPid})`);
    }
  } catch { /* no PID file yet */ }

  const daemon = spawn(process.execPath, [distDaemon], {
    detached: true,
    stdio:    'ignore',
    windowsHide: true,
  });
  daemon.unref();

  // Write PID file for uninstall and health checks.
  fs.writeFileSync(PID_FILE, String(daemon.pid!), 'utf-8');
  console.log(`Spawned daemon (pid=${daemon.pid})`);
  console.log(`Daemon will auto-start on Windows login from now on.`);
  console.log(`To uninstall: npm run bin:uninstall`);
}

main();
