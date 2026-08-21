import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

/**
 * Remove startup hook + kill running daemon.
 * Best-effort kill — uses tasklist/taskkill to find and terminate daemon.
 */

const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);
const LINK_NAME = 'agent-attention.lnk';

function main(): void {
  const cmdPath = path.join(STARTUP_DIR, LINK_NAME);

  if (fs.existsSync(cmdPath)) {
    fs.unlinkSync(cmdPath);
    console.log(`Removed startup hook: ${cmdPath}`);
  } else {
    console.log(`No startup hook found at ${cmdPath} (already uninstalled?)`);
  }

  if (process.platform === 'win32') {
    // Use tasklist to find node processes running daemon.js
    try {
      const output = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { encoding: 'utf-8' });
      const lines = output.trim().split('\n');
      let killed = 0;
      for (const line of lines) {
        // CSV format: ["node.exe","1234","Console","12345",...]
        const parts = line.split(',');
        if (parts.length >= 2) {
          const pid = parseInt(parts[1].replace(/"/g, ''), 10);
          if (!isNaN(pid)) {
            try {
              // Try to match by command line or just kill by PID (conservative)
              execSync(`taskkill /PID ${pid} /F`, { timeout: 1000 });
              killed++;
            } catch (e) {
              // Might be owned by another user, skip
            }
          }
        }
      }
      if (killed > 0) {
        console.log(`Killed ${killed} node process(es)`);
      } else {
        console.log(`No node.exe processes found (daemon may already be stopped)`);
      }
    } catch (err: any) {
      console.log(`(Could not enumerate processes: ${err.message})`);
    }
  } else {
    console.log(`Not on Windows — skipping daemon kill`);
  }
}

main();