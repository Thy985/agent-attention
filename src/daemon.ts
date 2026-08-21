import * as chokidar from 'chokidar';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { readState } from './state/AttentionState';

export interface DaemonOptions {
  statePath: string;
  powerShellPath: string;
  trayScriptPath: string;
  debug?: boolean;
}

export interface Daemon {
  stop(): Promise<void>;
}

export function createDaemon(options: DaemonOptions): Daemon {
  let trayProc: ChildProcessWithoutNullStreams | null = null;
  let watcher: chokidar.FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const log = (msg: string) => {
    if (options.debug) {
      console.error(`[daemon] ${msg}`);
    }
  };

  const pushStateToTray = () => {
    if (!trayProc || !trayProc.stdin.writable) return;
    let state;
    try {
      state = readState(options.statePath);
    } catch (err) {
      log(`readState failed: ${err}`);
      return;
    }
    const perAgentUnread: Record<string, number> = {};
    for (const ev of state.events) {
      if (!ev.read) {
        perAgentUnread[ev.agent_id] = (perAgentUnread[ev.agent_id] || 0) + 1;
      }
    }
    const totalUnread = state.events.filter(e => !e.read).length;
    try {
      trayProc.stdin.write(JSON.stringify({ ...state, totalUnread, perAgentUnread }) + '\n');
    } catch (err) {
      log(`write to tray failed: ${err}`);
    }
  };

  const debouncedReload = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pushStateToTray();
    }, 100);
  };

  const spawnTray = () => {
    log(`spawning tray: ${options.powerShellPath} ${options.trayScriptPath} show`);
    trayProc = spawn(
      options.powerShellPath,
      [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', options.trayScriptPath,
        'show',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,  // Hide the PowerShell console window
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
  // Push initial state immediately (don't wait for file change)
  setTimeout(() => {
    if (!stopped) pushStateToTray();
  }, 500);

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      if (trayProc) {
        trayProc.kill();
        trayProc = null;
      }
    },
  };
}

if (require.main === module) {
  const os = require('os');
  const path = require('path');
  const statePath = path.join(os.homedir(), '.agent-attention', 'state.json');
  const trayScriptPath = path.join(__dirname, '..', 'src', 'center', 'TrayIcon.ps1');

  const debug = process.env.AGENT_ATTENTION_DEBUG === '1';
  const daemon = createDaemon({
    statePath,
    powerShellPath: 'powershell',
    trayScriptPath,
    debug,
  });

  process.on('SIGTERM', () => daemon.stop().then(() => process.exit(0)));
  process.on('SIGINT', () => daemon.stop().then(() => process.exit(0)));

  console.error(`[daemon] started, watching ${statePath}`);
}