import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { readState } from './state/AttentionState';

export interface DaemonOptions {
  statePath: string;
  powerShellPath: string;
  trayScriptPath: string;
  trayStatePath: string;   // polling file written by daemon, read by TrayIcon.ps1
  cliPath: string;         // absolute path to daemon-cli.js (for tray double-click)
  debug?: boolean;
}

export interface Daemon {
  stop(): Promise<void>;
}

const TRAY_STATE_POLL_MS = 1000;
const PID_CHECK_INTERVAL_MS = 5000;

export function createDaemon(options: DaemonOptions): Daemon {
  let trayProc: ChildProcess | null = null;
  let watcher: chokidar.FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pidCheckTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastStateHash = '';

  const log = (msg: string) => {
    if (options.debug) {
      console.error(`[daemon] ${msg}`);
    }
  };

  /** Compute a light hash of state so we only rewrite tray-state.json on real changes. */
  function stateHash(state: ReturnType<typeof readState>): string {
    return JSON.stringify({
      unreadCount: state.unreadCount,
      events: state.events.map(e => `${e.id}:${e.read}`),
    });
  }

  /** Write current state to the polling file that TrayIcon.ps1 reads. */
  const pushStateToTrayFile = (): void => {
    let state;
    try {
      state = readState(options.statePath);
    } catch (err) {
      log(`readState failed: ${err}`);
      return;
    }
    const h = stateHash(state);
    if (h === lastStateHash) return;          // no change — skip write
    lastStateHash = h;
    try {
      fs.writeFileSync(options.trayStatePath, JSON.stringify(state, null, 2), 'utf-8');
      log('tray-state.json updated');
    } catch (err) {
      log(`write tray-state failed: ${err}`);
    }
  };

  const debouncedReload = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pushStateToTrayFile();
    }, 100);
  };

  /**
   * Check whether the tray process is still alive.
   * If dead and daemon not stopped → respawn after 1s.
   */
  const checkTrayAlive = (): void => {
    if (!trayProc || trayProc.killed) return;
    try {
      process.kill(trayProc.pid!, 0);
    } catch {
      log('tray process died unexpectedly — respawning');
      trayProc = null;
      if (!stopped) spawnTray();
    }
  };

  const spawnTray = () => {
    log(`spawning tray: ${options.powerShellPath} ${options.trayScriptPath}`);
    trayProc = spawn(
      options.powerShellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', options.trayScriptPath,
        '-StatePath', options.statePath,
        '-CliPath', options.cliPath,
      ],
      {
        // NO stdin/stdout pipes — tray polls tray-state.json file directly.
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        detached: false,
      },
    );

    trayProc.on('exit', (code) => {
      log(`tray process exited with code ${code}`);
      if (!stopped) {
        setTimeout(() => {
          if (!stopped) spawnTray();
        }, 1000);
      }
    });

    trayProc.stderr?.on('data', (chunk) => {
      log(`tray stderr: ${chunk.toString().trim()}`);
    });
  };

  // Watch state.json for changes
  watcher = chokidar.watch(options.statePath, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignoreInitial: true,
  });

  watcher.on('change', () => {
    log(`state.json changed`);
    debouncedReload();
  });

  watcher.on('add', () => {
    log(`state.json added`);
    debouncedReload();
  });

  watcher.on('error', (err) => {
    log(`chokidar error: ${err}`);
  });

  spawnTray();

  // Push initial state immediately
  setTimeout(() => {
    if (!stopped) pushStateToTrayFile();
  }, 500);

  // Periodic tray liveness check
  pidCheckTimer = setInterval(checkTrayAlive, PID_CHECK_INTERVAL_MS);

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pidCheckTimer) clearInterval(pidCheckTimer);
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      if (trayProc) {
        try { trayProc.kill('SIGTERM'); } catch {}
        trayProc = null;
      }
      // Clean up polling file so TrayIcon's loop exits
      try { fs.unlinkSync(options.trayStatePath); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const home = os.homedir();
  const stateDir = path.join(home, '.agent-attention');
  const statePath    = path.join(stateDir, 'state.json');
  const trayStatePath = path.join(stateDir, 'tray-state.json');
  const trayScriptPath = path.join(__dirname, '..', 'src', 'center', 'TrayIcon.ps1');
  const cliPath        = path.join(__dirname, '..', 'dist', 'daemon-cli.js');

  const debug = process.env.AGENT_ATTENTION_DEBUG === '1';
  const daemon = createDaemon({
    statePath,
    powerShellPath: 'powershell',
    trayScriptPath,
    trayStatePath,
    cliPath,
    debug,
  });

  process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)));
  process.on('SIGINT',  () => daemon.stop().then(() => process.exit(0)));

  console.error(`[daemon] started, watching ${statePath}`);
  console.error(`[daemon] tray polling file: ${trayStatePath}`);
}
