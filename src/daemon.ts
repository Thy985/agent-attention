import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { readState } from './state/AttentionState';
import { getUiMode, resolveNativeUiPath } from './ui-host';
import { startPipeServer, pushStateToClients, stopPipeServer, emitNotification, watchRegistryForNotifications, registerRpcCommand } from './pipeline/ipc';
import { dispatchCommand } from './commands';
import { log } from './logging';

export interface DaemonOptions {
  statePath: string;
  trayStatePath: string;   // polling file written by daemon, read by C# tray
  trayPidPath: string;     // PID file for tray lifecycle management
  cliPath: string;         // absolute path to daemon-cli.js (for tray double-click)
  uiExecutablePath: string; // native C# UI host
  debug?: boolean;
}

export interface Daemon {
  stop(): Promise<void>;
}

const TRAY_STATE_POLL_MS = 1000;
const PID_CHECK_INTERVAL_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Replace a file atomically; readers see either the old complete file or the new one. */
function atomicWriteFileSync(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, contents, 'utf-8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// Module-level logger — writable from both createDaemon() and process handlers.
// Lazy-init: opening the stream at module load raced with parallel test
// workers that delete ~/.agent-attention between mkdirSync and open.
const LOG_MAX_LINES = 10_000;
let _logFile: fs.WriteStream | null = null;
const LOG_PATH = path.join(os.homedir(), '.agent-attention', 'daemon.log');
function getLogFile(): fs.WriteStream {
  if (!_logFile || _logFile.destroyed) {
    try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch {}
    _logFile = fs.createWriteStream(LOG_PATH, { flags: 'a' });
    _logFile.on('error', () => { /* best-effort logging must never crash the daemon */ });
  }
  return _logFile;
}

/**
 * Rotate daemon.log if it has grown past LOG_MAX_LINES. Keeps the most
 * recent 80% of lines so a single rotation does not drop too much history.
 * Best-effort: any I/O failure is swallowed — logging must never crash
 * the daemon.
 */
function rotateDaemonLog(): void {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const content = fs.readFileSync(LOG_PATH, 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    if (lines.length <= LOG_MAX_LINES) return;
    const keep = Math.floor(lines.length * 0.8);
    fs.writeFileSync(LOG_PATH, lines.slice(-keep).join('\n') + '\n', 'utf-8');
  } catch {
    // best-effort
  }
}
export function daemonLog(msg: string, debug?: boolean): void {
  const ts = new Date().toISOString();
  try {
    getLogFile().write(`[${ts}] ${msg}\n`);
    rotateDaemonLog();
  } catch {}
  if (debug) console.error(`[daemon] ${msg}`);
}
export function closeDaemonLog(): void { try { _logFile?.end(); } catch {} }

/** Read tray PID from file. Returns null if missing or invalid. */
function readTrayPid(trayPidPath: string): number | null {
  try {
    const raw = fs.readFileSync(trayPidPath, 'utf-8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

/** Write tray PID to file. */
function writeTrayPid(trayPidPath: string, pid: number): void {
  fs.writeFileSync(trayPidPath, String(pid), 'utf-8');
}

/** Remove tray PID file. */
function clearTrayPid(trayPidPath: string): void {
  try { fs.unlinkSync(trayPidPath); } catch {}
}

export function createDaemon(options: DaemonOptions): Daemon {
  let trayProc: ChildProcess | null = null;
  let watcher: chokidar.FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pidCheckTimer: NodeJS.Timeout | null = null;
  let stopped = false;
  let lastStateHash = '';
  const stateDir = path.dirname(options.statePath);

  const log = (msg: string) => daemonLog(msg, options.debug);

  // AC-06: Periodic heartbeat log for observability
  const startTime = Date.now();
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const heartbeatLog = (entry: any): void => {
    try {
      const line = JSON.stringify(entry) + '\n';
      getLogFile().write('[heartbeat] ' + line);
    } catch {}
    // Also write to unified runtime log for cross-component correlation
    try {
      log(entry);
    } catch {}
  };
  const emitHeartbeat = (): void => {
    if (stopped) return;
    try {
      const state = readState(options.statePath);
      const uptimeMs = Date.now() - startTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const lastEvent = state.events[0] ? new Date(state.events[0].timestamp).toISOString() : 'never';
      heartbeatLog({
        component: 'daemon',
        level: 'INFO',
        event: 'heartbeat',
        message: `uptime=${uptimeSec}s events=${state.events.length} unread=${state.unreadCount} lastEvent=${lastEvent}`,
        context: { uptime_seconds: uptimeSec, event_count: state.events.length, unread_count: state.unreadCount, last_event_at: lastEvent },
      });
    } catch (err) {
      heartbeatLog({ component: 'daemon', level: 'WARN', event: 'heartbeat_failed', message: String(err) });
    }
    heartbeatTimer = setTimeout(emitHeartbeat, HEARTBEAT_INTERVAL_MS);
  };



  /** Compute a light hash of state so we only rewrite tray-state.json on real changes. */
  function stateHash(state: ReturnType<typeof readState>): string {
    return JSON.stringify({
      unreadCount: state.unreadCount,
      events: state.events.map(e => `${e.id}:${e.read}`),
    });
  }

  /** Write current state to the polling file that the C# tray reads. */
  const pushStateToTrayFile = (): void => {
    // P3-7 fix: guard against a debounced push landing after stop() began.
    // Without this, stop() deletes tray-state.json to signal the tray to
    // exit, and a late push silently recreates it → tray never exits.
    if (stopped) return;
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
      atomicWriteFileSync(options.trayStatePath, JSON.stringify(state, null, 2));
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

  log(`spawning UI host: ${options.uiExecutablePath}`);
  const registryPath = path.join(path.dirname(options.statePath), 'agents.json');
  const trayArgs = [
      '-StatePath', options.statePath,
      '-RegistryPath', registryPath,
      '-CliPath', options.cliPath,
      '-TrayStatePath', options.trayStatePath,
    ];
  if (options.trayPidPath) trayArgs.push('-TrayPidPath', options.trayPidPath);

  trayProc = spawn(
    options.uiExecutablePath,
    trayArgs,
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      detached: false,
    },
  );

    // Write PID file so orphan cleanup can target this exact process (issue #1)
    writeTrayPid(options.trayPidPath, trayProc.pid!);

    trayProc.on('exit', (code) => {
      log(`tray process exited with code ${code}`);
      clearTrayPid(options.trayPidPath);
      trayProc = null;
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
    emitNotification(stateDir, 'state-changed', { file: 'state', sha256: crypto.createHash('sha256').update(fs.readFileSync(options.statePath)).digest('hex') });
  });

  watcher.on('add', () => {
    log(`state.json added`);
    debouncedReload();
  });

  watcher.on('error', (err) => {
    log(`chokidar error: ${err}`);
  });

  // Start IPC server for C# UI mode (real-time state push)
  if (options.uiExecutablePath) {
    startPipeServer(stateDir);
    watchRegistryForNotifications(stateDir);
    // M6b: register IPC RPC command handlers
    registerRpcCommand("mark-all-read", async () => {
      const r = dispatchCommand("mark-all-read", []);
      emitNotification(stateDir, "state-changed", { file: "state", sha256: "" });
      return r;
    });
    registerRpcCommand("mark-event", async (args) => {
      return dispatchCommand("mark-event", args);
    });
    registerRpcCommand("jump", async (args) => {
      return dispatchCommand("jump", args);
    });
  }
  spawnTray();

  // Push initial state immediately
  setTimeout(() => {
    if (!stopped) { pushStateToTrayFile(); if (options.uiExecutablePath) { pushStateToClients(stateDir); } }
  }, 500);

  // Periodic tray liveness check
  pidCheckTimer = setInterval(checkTrayAlive, PID_CHECK_INTERVAL_MS);
    emitHeartbeat();

  return {
    stop: async () => {
      stopped = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pidCheckTimer) clearInterval(pidCheckTimer);
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }

      // ── Graceful tray shutdown ──────────────────────────────────
      // Delete the polling file FIRST so the tray's loop exits naturally.
      // On Windows, SIGTERM from Node.js maps to TerminateProcess() which
      // kills the process before it can run cleanup — causing ghost icons.
      // By removing the file first, the tray detects the signal and runs
      // Invoke-Exit which sets Visible=$false, making Windows immediately
      // reclaim the shell icon handle.
      try { fs.unlinkSync(options.trayStatePath); } catch {}
      stopPipeServer();
      clearTrayPid(options.trayPidPath);

      if (trayProc) {
        const pid = trayProc.pid!;
        trayProc = null;
        // Wait up to 5s for tray to exit gracefully after state-file deletion.
        // With the correct TrayStatePath (daemon deletes it, tray detects it),
        // the tray runs Invoke-Exit → sets Visible=$false → Windows immediately
        // reclaims the shell icon handle.  No SIGTERM needed.
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); } catch { break; } // gone
          await new Promise(r => setTimeout(r, 100));
        }
        // SIGTERM last resort — on Windows this is TerminateProcess (hard kill),
        // which cannot run cleanup.  If we reach here the graceful path failed.
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
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
  const trayPidPath   = path.join(stateDir, 'tray.pid');
  const daemonLockPath = path.join(stateDir, 'daemon.lock');
  // P1-5 fix: this module runs as dist/daemon.js, so daemon-cli.js is its
  // sibling at dist/daemon-cli.js. (The old '..\\dist\\daemon-cli.js'
  // resolved to dist/dist/daemon-cli.js, which never exists.)
  const cliPath        = path.join(__dirname, 'daemon-cli.js');

  const uiExecutablePath = resolveNativeUiPath();
  if (!uiExecutablePath) {
    console.error(
      'AgentAttention.UI.exe not found. Build it or set AGENT_ATTENTION_UI_EXE.'
    );
    process.exit(1);
  }

  const debug = process.env.AGENT_ATTENTION_DEBUG === '1';

  // -----------------------------------------------------------------------
  // P1-8 fix: the DAEMON itself owns the single-instance lock (not the
  // short-lived `daemon-cli start` process, which exits right after spawn).
  // Acquisition is atomic (O_EXCL via 'wx'); a lock whose recorded pid is
  // dead is treated as stale and stolen. This enforces daemon_instances=1
  // even under concurrent `daemon start` invocations.
  // -----------------------------------------------------------------------
  const acquireDaemonLock = (): 'acquired' | 'stolen' | 'busy' => {
    const writeLock = (): void => {
      const fd = fs.openSync(daemonLockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    };
    try {
      writeLock();
      return 'acquired';
    } catch (err: any) {
      if (!err || err.code !== 'EEXIST') throw err;
      // Lock exists — check whether the holder is still alive.
      try {
        const raw = fs.readFileSync(daemonLockPath, 'utf-8').trim();
        const pid = parseInt(raw, 10);
        if (!isNaN(pid) && pid > 0) {
          try { process.kill(pid, 0); return 'busy'; } catch { /* dead → steal */ }
        }
        // Stale or unreadable — steal atomically.
        fs.unlinkSync(daemonLockPath);
        writeLock();
        return 'stolen';
      } catch {
        return 'busy';
      }
    }
  };
  const releaseDaemonLock = (): void => {
    try {
      if (fs.existsSync(daemonLockPath)) {
        const raw = fs.readFileSync(daemonLockPath, 'utf-8').trim();
        if (raw === String(process.pid)) fs.unlinkSync(daemonLockPath);
      }
    } catch {}
  };

  try { fs.mkdirSync(stateDir, { recursive: true }); } catch {}
  let lockResult: 'acquired' | 'stolen' | 'busy' = 'busy';
  try { lockResult = acquireDaemonLock(); } catch (err) {
    daemonLog(`daemon lock acquisition failed: ${err}`, debug);
    process.exit(1);
  }
  if (lockResult === 'busy') {
    daemonLog('another daemon is already running — exiting', debug);
    console.error('Daemon already running (lock held). Use: agent-attention daemon status');
    process.exit(0);
  }
  if (lockResult === 'stolen') {
    daemonLog('stale daemon.lock stolen from dead holder', debug);
  }

  const daemon = createDaemon({
    statePath,
    trayStatePath,
    trayPidPath,
    cliPath,
    uiExecutablePath,
    debug,
  });

  const shutdown = (code: number): void => {
    daemon.stop().then(() => {
      releaseDaemonLock();
      process.exit(code);
    }).catch(() => {
      releaseDaemonLock();
      process.exit(code);
    });
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT',  () => shutdown(0));

  // On crash, log the error and clean up files so next start can recover
  process.on('uncaughtException', (err) => {
    try {
      const msg = err && err.stack ? err.stack : String(err);
      daemonLog(`FATAL uncaughtException: ${msg}`, debug);
      fs.unlinkSync(trayPidPath);
      fs.unlinkSync(trayStatePath);
    } catch {}
    releaseDaemonLock();
    process.exit(1);
  });
  process.on('beforeExit', () => {
    try { fs.unlinkSync(trayPidPath); } catch {}
    try { fs.unlinkSync(trayStatePath); } catch {}
    releaseDaemonLock();
    closeDaemonLog();
  });

  daemonLog(`started, watching ${statePath}`, debug);
  daemonLog(`tray polling file: ${trayStatePath}`, debug)  // C# tray reads this
}
