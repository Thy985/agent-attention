import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

/**
 * Register daemon at Windows startup + spawn initial daemon process.
 *
 * 1. Verify dist/daemon.js exists (assumes npm run build already ran)
 * 2. Create %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\agent-attention-daemon.vbs
 *    (VBScript with hidden window via Wscript.Shell.Run(,0,true))
 * 3. Spawn daemon detached (no parent)
 * 4. Print confirmation
 *
 * Idempotent: re-running replaces the .vbs and spawns a fresh daemon.
 */

const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);
const STARTUP_NAME = 'agent-attention';

function main(): void {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const distDaemon = path.join(projectRoot, 'dist', 'daemon.js');
  const vbsPath = path.join(STARTUP_DIR, `${STARTUP_NAME}.vbs`);

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

  // Create VBScript to run daemon hidden using WScript.Shell.Run with window style 0 (hidden)
  // The VBScript itself runs without showing a window when double-clicked from startup
  const escapedPath = distDaemon.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const vbsContent = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run Chr(34) & "node" & Chr(34) & " " & Chr(34) & "${escapedPath}" & Chr(34), 0, False`,
  ].join('\n');

  fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
  console.log(`Installed startup hook: ${vbsPath}`);

  const daemon = spawn(process.execPath, [distDaemon], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  daemon.unref();

  console.log(`Spawned daemon (pid=${daemon.pid})`);
  console.log(`Daemon will auto-start on Windows login from now on.`);
  console.log(`To uninstall: npm run bin:uninstall`);
}

main();