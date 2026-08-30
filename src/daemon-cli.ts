#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { registerAgent, listAgents, getAgent, updateAgentTarget, AgentTarget, type Agent, readRegistry, writeRegistry } from './registry';
import { readLogs, findCorrelated, wipeLog } from './logging';
import { loadAdapters, discoverInstalled, type AgentAdapter } from './discover';
import { clearUnread, markRead } from './state/AttentionState';
import { resolveNativeUiPath } from './ui-host';

/** Run a PowerShell script from a temp file to avoid shell escaping issues. */
function runPs(script: string, timeoutMs = 5000): string {
  const tmp = path.join(os.tmpdir(), `ps-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, 'utf-8');
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, {
      encoding: 'utf-8', timeout: timeoutMs,
    }).toString();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/** Get PowerShell.exe PIDs whose command line contains the given pattern (PS5.1-safe).
 *  Excludes the current process to avoid self-matching. */
function getPsPids(pattern: string, excludeSelf = true): number[] {
  try {
    // A6 D18: validate pattern to prevent shell injection.
    // Invariant: no untrusted value may be interpolated into shell source.
    if (!/^[a-zA-Z0-9._-]+$/.test(pattern)) return [];
    const selfPid = excludeSelf ? String(process.pid) : '';
    const out = runPs(
      'get-ciminstance win32_process | where-object { $_.name -eq ' +
      "'powershell.exe' -and $_.commandline -like '*" + pattern + "*'" +
      (selfPid ? ' -and $_.processid -ne ' + selfPid : '') +
      '} | select-object -expandproperty processid',
    );
    return out.trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  } catch { return []; }
}

const STATE_DIR = path.join(os.homedir(), '.agent-attention');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
const TRAY_PID_FILE = path.join(STATE_DIR, 'tray.pid');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const STARTUP_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
);

interface DaemonStatus {
  running: boolean;
  pid: number | null;
  trayRunning: boolean;
  stateValid: boolean;
  startupHook: boolean;
}

function readPid(): number | null {
  try {
    if (fs.existsSync(PID_FILE)) {
      return parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    }
  } catch {
    // ignore
  }
  return null;
}

function writePid(pid: number): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
}

function clearPid(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // ignore
  }
}

/** Read tray PID from file. Returns null if missing or invalid. */
function readTrayPid(): number | null {
  try {
    const raw = fs.readFileSync(TRAY_PID_FILE, 'utf-8').trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch { return null; }
}

/** Kill the specific tray process tracked by tray.pid. Returns true if killed. */
function killTrayByPid(): boolean {
  const pid = readTrayPid();
  if (pid && isProcessRunning(pid)) {
    try { process.kill(pid, 'SIGTERM'); return true; } catch {}
  }
  return false;
}

/**
 * Kill all tray processes whose parent daemon is dead.
 * This is more precise than pattern matching — it checks if the parent
 * node process (the daemon) is still alive.
 */
function killOrphanTrayProcesses(): number {
  let killed = 0;
  try {
    // Get all TrayIcon.ps1 processes excluding our own
    const pids = getPsPids('TrayIcon.ps1');
    for (const trayPid of pids) {
      try {
        // Get parent PID via CIM
        const parent = runPs(
          'get-ciminstance win32_process | where-object { $_.processid -eq ' +
          trayPid + ' } | select-object -expandproperty parentprocessid',
        ).trim();
        const parentPid = parseInt(parent, 10);
        if (isNaN(parentPid) || parentPid === 0) continue; // init/system parent
        // Check if parent is an agent-attention daemon
        const parentCmd = runPs(
          'get-ciminstance win32_process | where-object { $_.processid -eq ' +
          parentPid + ' } | select-object -expandproperty commandline',
        ).trim();
        if (parentCmd.includes('daemon.js') && parentCmd.includes('agent-attention')) {
          if (isProcessRunning(parentPid)) continue; // parent alive — not orphan
        }
        // Parent is dead or not a daemon — this is an orphan
        try { process.kill(trayPid, 'SIGTERM'); killed++; } catch {}
      } catch {}
    }
  } catch {
    // fallback: just kill all matching pids
    for (const pid of getPsPids('TrayIcon.ps1')) {
      try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
    }
  }
  if (killed > 0) console.log(`Killed ${killed} orphan tray process(es)`);
  return killed;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // throws if not found
    return true;
  } catch {
    return false;
  }
}

function getStatus(): DaemonStatus {
  const pid = readPid();
  const running = pid !== null && isProcessRunning(pid);

  // Check if tray process exists via get-ciminstance (issue #14)
  let trayRunning = false;
  try {
    const pids = getPsPids('TrayIcon.ps1');
    trayRunning = pids.length > 0;
  } catch {
    trayRunning = false;
  }
  // Also check C# UI process via tray PID file
  if (!trayRunning) {
    const csharpPid = readTrayPid();
    if (csharpPid && isProcessRunning(csharpPid)) trayRunning = true;
  }

  const stateValid = fs.existsSync(STATE_PATH);
  const startupHook = fs.existsSync(path.join(STARTUP_DIR, 'agent-attention.vbs'));

  return { running, pid, trayRunning, stateValid, startupHook };
}

/** Get PIDs of all running agent-attention daemon node processes. */
function getDaemonPids(): number[] {
  try {
    const out = runPs(
      "get-ciminstance win32_process | where-object { " +
      "$_.name -eq 'node.exe' -and $_.commandline -like '*daemon.js*' " +
      "-and $_.commandline -like '*agent-attention*' " +
      `-and $_.processid -ne ${process.pid} } ` +
      '| select-object -expandproperty processid',
    );
    return out.trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  } catch { return []; }
}

function killExistingDaemon(): void {
  const pids = getDaemonPids();
  for (const pid of pids) {
    try {
      console.log(`Killing existing daemon pid=${pid}`);
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  // Also kill their tray children
  for (const pid of pids) {
    try {
      // P2-1 fix: the old script had a space between the pipeline variable
      // and its .name property, which is a PowerShell parser error.
      // Use the correct $var.property form throughout.
      runPs(
        `get-ciminstance win32_process | where-object { ` +
        `$_.name -eq 'powershell.exe' -and $_.parentprocessid -eq ${pid} ` +
        `-and $_.commandline -like '*TrayIcon.ps1*' } | ` +
        `foreach-object { stop-process -id $_.processid -force }`,
      );
    } catch {}
  }
}


/**
 * Register the Windows startup hook (VBS script) so the daemon auto-restarts on login.
 * A2 D5: ensures crash recovery — if daemon dies mid-session, next login re-registers and starts it.
 * Idempotent: overwrites existing .vbs with absolute paths so it survives upgrades.
 */
function registerStartupHook(): void {
  const STARTUP_DIR = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  );
  const vbsPath = path.join(STARTUP_DIR, 'agent-attention.vbs');
  const distDaemon = path.join(__dirname, '..', 'dist', 'daemon.js');
  try {
    if (!fs.existsSync(distDaemon)) return;
    const nodeExe  = process.execPath;
    const escapedNode     = nodeExe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedDaemon = distDaemon.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const vbsContent = [
      'Set WshShell = CreateObject("WScript.Shell")',
      `WshShell.Run Chr(34) & "${escapedNode}" & Chr(34) & " " & Chr(34) & "${escapedDaemon}" & Chr(34), 0, False`,
    ].join('\n');
    fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
    console.log(`Startup hook registered: ${vbsPath}`);
  } catch (err) {
    console.warn(`Failed to register startup hook: ${err}`);
  }
}

/**
 * C1: Show a one-time system notification on first daemon launch.
 * Tells the user about the tray icon and how to open the Center window.
 * Uses node-notifier (already a dependency) to send a Windows Toast.
 */
function showFirstLaunchNotification(): void {
  const flagPath = path.join(os.homedir(), '.agent-attention', '.first-launch-done');
  if (fs.existsSync(flagPath)) return; // already notified
  try {
    const notifier = require('node-notifier');
    notifier.notify({
      title: 'Agent Attention',
      message: 'Agent Attention is running in the system tray. Click the icon to open the Center, or double-click to mark all read.',
      sound: false,
      wait: false,
      timeout: 5,
    });
    fs.writeFileSync(flagPath, new Date().toISOString(), 'utf-8');
    console.log('First-launch notification sent.');
  } catch (err) {
    console.warn(`First-launch notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function startDaemon(): void {
  // Always clean up stale tray processes first — they may belong to a
  // crashed or previously-stopped daemon whose PID file was already removed.
  let staleKilled = 0;
  if (killTrayByPid()) staleKilled++;
  staleKilled += killOrphanTrayProcesses();

  // Kill any existing daemon processes (by process scan, not just PID file)
  // This handles the case where the PID file was removed but the daemon is
  // still running (e.g. crashed without cleanup).
  const existingPids = getDaemonPids();
  if (existingPids.length > 0) {
    console.log(`Found ${existingPids.length} existing daemon process(es), killing...`);
    killExistingDaemon();
    // Wait for them to die
    let waited = 0;
    while (getDaemonPids().length > 0 && waited < 3000) {
      // spin-wait
      waited += 100;
    }
    // Clean up any remaining orphan trays
    killOrphanTrayProcesses();
  }

  // Check if already running (after cleanup)
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Daemon already running (pid=${existingPid})`);
    return;
  }

  // P1-8 (revised): single-instance enforcement lives in the DAEMON itself
  // (daemon.ts acquires daemon.lock with atomic O_EXCL + stale-steal).
  // The starter CLI must NOT hold the lock — it exits right after spawn,
  // and a lock held by an exited process would block every future start.
  // Here we only remove a stale lock whose holder is already dead.
  try {
    const raw = fs.existsSync(LOCK_FILE) ? fs.readFileSync(LOCK_FILE, 'utf-8').trim() : '';
    const lockPid = parseInt(raw, 10);
    if (!raw || isNaN(lockPid) || lockPid <= 0 || !isProcessRunning(lockPid)) {
      try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  clearPid();

  // Use __dirname (not process.cwd()) so paths resolve correctly regardless
  // of where the user runs the CLI from (important for global npm installs).
  const distDaemon = path.join(__dirname, '..', 'dist', 'daemon.js');
  if (!fs.existsSync(distDaemon)) {
    console.error('Daemon not built. Run: npm run build');
    console.error(`Expected: ${distDaemon}`);
    process.exit(1);
  }

  const projectRoot = path.resolve(__dirname, '..');
  const daemon = spawn(process.execPath, [distDaemon], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: projectRoot,
  });

  daemon.unref();
  writePid(daemon.pid!);
  console.log(`Daemon started (pid=${daemon.pid})`);
  registerStartupHook(); // A2 D5: ensure crash-recovery hook is active after every start
  showFirstLaunchNotification(); // C1: one-time system notification on first daemon start
}

/**
 * Kill all stale tray processes left by previous daemon instances.
 * Uses get-ciminstance (PS5.1-safe). Returns the number of processes killed.
 */
function killStaleTrayProcesses(): number {
  let killed = 0;
  try {
    const pids = getPsPids('TrayIcon.ps1');
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
    }
    if (killed > 0) {
      console.log(`Killed ${killed} stale tray process(es)`);
    }
  } catch {
    // process query may fail on restricted systems
  }
  return killed;
}

function stopDaemon(graceful: boolean = true): void {
  const pid = readPid();
  if (!pid) {
    console.log('Daemon is not running');
    // Still clean up stale tray processes
    killStaleTrayProcesses();
    return;
  }

  if (graceful && isProcessRunning(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
      // Wait briefly for graceful shutdown (up to 5 seconds)
      const deadline = Date.now() + 5000;
      while (isProcessRunning(pid) && Date.now() < deadline) {
        const now = Date.now();
        while (Date.now() - now < 100 && isProcessRunning(pid) && Date.now() < deadline) {
          // spin
        }
      }
      if (isProcessRunning(pid)) {
        process.kill(pid, 'SIGKILL');
        console.log('Forcefully terminated daemon');
      } else {
        console.log('Daemon stopped gracefully');
      }
    } catch (err) {
      console.error(`Failed to stop daemon: ${err}`);
    }
  } else {
    console.log('Daemon was not running (stale PID file)');
  }

  // Always clean up stale tray processes
  killOrphanTrayProcesses();
  clearPid();
  // Cleanup semantics: `stop` unconditionally removes the lifecycle files.
  // The lock may belong to the (now dead) daemon — removing it is correct.
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  // Also remove tray lifecycle files. On Windows the daemon is hard-killed
  // by SIGTERM (TerminateProcess), so its own stop() cleanup never runs and
  // these files would otherwise linger until the next start.
  try { fs.unlinkSync(TRAY_PID_FILE); } catch { /* ignore */ }
  try {
    const trayStateFile = path.join(STATE_DIR, 'tray-state.json');
    if (fs.existsSync(trayStateFile)) fs.unlinkSync(trayStateFile);
  } catch { /* ignore */ }
}

function status(): void {
  const s = getStatus();
  const version = require('../package.json').version;

  console.log(`Agent Attention Daemon`);
  console.log(``);
  console.log(`PID:              ${s.pid ?? 'N/A'}`);
  console.log(`Status:           ${s.running ? 'running' : 'stopped'}`);
  console.log(`Tray process:     ${s.trayRunning ? 'ready' : 'not running'}`);
  console.log(`State file:       ${s.stateValid ? 'connected' : 'missing'}`);
  console.log(`Startup hook:     ${s.startupHook ? 'registered' : 'not installed'}`);
  console.log(`Version:          ${version}`);

  // Health check
  let health = 'OK';
  if (!s.running) health = 'WARN';
  if (!s.trayRunning && s.running) health = 'WARN';
  if (!s.stateValid) health = 'ERROR';

  console.log(``);
  console.log(`Health: ${health}`);

  if (health === 'WARN' || health === 'ERROR') {
    console.log(``);
    console.log(`Suggested action:`);
    if (!s.running) {
      console.log(`  agent-attention daemon start`);
    } else if (!s.trayRunning) {
      console.log(`  agent-attention daemon restart`);
    }
    if (health === 'ERROR') {
      console.log(`  Check state file: ${STATE_PATH}`);
    }
  }
}

function restart(): void {
  stopDaemon();
  // Wait for cleanup before starting
  setTimeout(() => startDaemon(), 1000);
}

function doctor(): void {
  console.log('Agent Attention Doctor');
  console.log('======================');
  console.log('');

  // Count running daemon and tray instances (issue #14: get-ciminstance, PS5.1-safe)
  // P2-3 fix: previously `daemonInstances` was hard-coded to ≤1, so doctor
  // could never detect multiple daemons. Now we enumerate actual daemon
  // processes (excluding this doctor process) so the count reflects reality.
  let daemonInstances = 0;
  let trayInstances = 0;
  // Start from PID file (fast path); add any extra daemons found by process scan
  const pid = readPid();
  if (pid && isProcessRunning(pid)) daemonInstances = 1;
  const liveDaemonPids = getDaemonPids();
  // liveDaemonPids already excludes self (process.pid).
  // PID file pid might not be in liveDaemonPids if it died but file wasn't cleaned.
  if (liveDaemonPids.length > 0) {
    // Take max to avoid double-counting the PID-file-tracked one.
    const uniquePids = new Set<number>(liveDaemonPids);
    if (pid && isProcessRunning(pid)) uniquePids.add(pid);
    daemonInstances = uniquePids.size;
  }

  // Try PID file first (exact match, no CIM needed)
  const trayPid = readTrayPid();
  if (trayPid && isProcessRunning(trayPid)) trayInstances = 1;
  else {
    // Fall back to get-ciminstance pattern match
    try {
      const out = runPs(
        'get-ciminstance win32_process | where-object { $_.name -eq ' +
        "'powershell.exe' -and $_.commandline -like '*TrayIcon.ps1*' } " +
        '| select-object -expandproperty processid',
      );
      trayInstances = out.trim().split('\n').filter(Boolean).length;
    } catch { trayInstances = 0; }
  }

  const checks = [
    {
      name: 'CLI',
      ok: true,
      detail: 'dist/index.js exists',
    },
    {
      name: 'Daemon',
      ok: fs.existsSync(path.join(__dirname, '..', 'dist', 'daemon.js')),
      detail: 'dist/daemon.js exists',
    },
    {
      name: 'UI executable',
      ok: resolveNativeUiPath() !== null,
      detail: resolveNativeUiPath() !== null ? 'AgentAttention.UI.exe found' : 'NOT FOUND — run npm run build:ui && npm run publish:ui',
    },
    {
      name: 'State file',
      ok: fs.existsSync(STATE_PATH),
      detail: fs.existsSync(STATE_PATH) ? `unreadCount=${JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')).unreadCount}` : 'missing',
    },
    {
      name: 'Windows Toast',
      ok: process.platform === 'win32' && fs.existsSync(path.join(__dirname, '..', 'dist', 'notification', 'win32.js')),
      detail: process.platform === 'win32'
        ? (fs.existsSync(path.join(__dirname, '..', 'dist', 'notification', 'win32.js')) ? 'available (snoretoast)' : 'node-notifier module missing')
        : `not on Windows (${process.platform})`,
    },
    {
      name: 'Sound',
      ok: process.platform === 'win32',  // PowerShell SystemSounds always available on Windows
      detail: process.platform === 'win32' ? 'available (SystemSounds)' : `not on Windows (${process.platform})`,
    },
    {
      name: 'Daemon PID',
      ok: false,
      detail: 'N/A',
    },
    {
      name: 'Daemon instances',
      ok: daemonInstances <= 1,
      detail: `${daemonInstances} instance(s)`,
    },
    {
      name: 'Tray instances',
      ok: trayInstances <= 1,
      detail: `${trayInstances} instance(s)`,
    },
  ];

  const status = getStatus();
  checks[6] = {
    name: 'Daemon PID',
    ok: status.running,
    detail: status.pid ? `${status.pid} (${status.running ? 'alive' : 'dead'})` : 'not found',
  };

  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? '✅' : '❌';
    console.log(`${icon} ${check.name.padEnd(15)} ${check.detail}`);
    if (!check.ok) allOk = false;
  }

  console.log('');
  
  // Runtime log diagnostics
  const logPath = path.join(os.homedir(), '.agent-attention', 'logs', 'runtime.jsonl');
  console.log('');
  console.log('Runtime Log:');
  if (fs.existsSync(logPath)) {
    try {
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter((l: string) => l.trim());
      const entries = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (entries.length === 0) {
        console.log('  (empty)');
      } else {
        const errors = entries.filter((e: any) => e.level === 'ERROR' || e.level === 'FATAL');
        const warns = entries.filter((e: any) => e.level === 'WARN');
        const recent = entries.slice(-5);
        console.log('  ' + entries.length + ' entries total');
        if (errors.length > 0) console.log('  ' + errors.length + ' error(s)');
        if (warns.length > 0) console.log('  ' + warns.length + ' warning(s)');
        console.log('  Recent:');
        for (const entry of recent) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          console.log('    [' + time + '] [' + entry.level + '] [' + entry.component + '] ' + entry.event + ': ' + entry.message);
        }
        console.log('  See all: agent-attention logs ' + Math.min(entries.length, 20));
      }
    } catch {
      console.log('  (read error)');
    }
  } else {
    console.log('  (no runtime log yet - first notification will create it)');
  }

console.log(allOk ? 'All checks passed!' : 'Some checks failed. Run agent-attention daemon restart to fix.');
}

function markAllRead(): void {
  if (!fs.existsSync(STATE_PATH)) {
    console.log('No state file found.');
    return;
  }
  clearUnread(STATE_PATH);
  console.log('All events marked as read.');
}

/** Print the last N lines of the daemon log. */
function logs(n: number = 50, extraArgs: string[] = []): void {
  // Also support --correlation <id> to filter by correlation ID
  const args = extraArgs.length > 0 ? extraArgs : process.argv.slice(2);
  // Parse --correlation FIRST (before consuming n), so `logs --correlation xxx` works
  const corrIdx = args.indexOf('--correlation');
  let correlationId: string | undefined;
  if (corrIdx >= 0 && args[corrIdx + 1]) {
    correlationId = args[corrIdx + 1];
  }

  if (correlationId) {
    const entries = findCorrelated(correlationId);
    if (entries.length === 0) {
      console.log(`No log entries found for correlation ID: ${correlationId}`);
      return;
    }
    console.log(`Correlation chain [${correlationId}]: ${entries.length} entries`);
    console.log('');
    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      console.log(`[${time}] [${entry.level}] [${entry.component}] ${entry.event}: ${entry.message}`);
      if (entry.context) {
        for (const [k, v] of Object.entries(entry.context)) {
          console.log(`  ${k}: ${JSON.stringify(v)}`);
        }
      }
    }
    return;
  }

  // Read the unified runtime JSONL log
  const entries = readLogs(n);
  if (entries.length === 0) {
    console.log('No log entries found.');
    return;
  }
  for (const entry of entries) {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const corr = entry.correlation_id ? ` [${entry.correlation_id.substring(0, 12)}]` : '';
    console.log(`[${time}] [${entry.level.padEnd(5)}] [${entry.component.padEnd(8)}] ${entry.event}${corr}: ${entry.message}`);
  }
}

function markEvent(eventId: string): void {
  if (!fs.existsSync(STATE_PATH)) {
    console.log('No state file found.');
    return;
  }
  markRead(STATE_PATH, eventId);
  console.log(`Event ${eventId} marked as read.`);
}

function printAgents(): void {
  const agents = listAgents();
  if (agents.length === 0) {
    console.log('No agents registered.');
    return;
  }
  console.log('Registered agents:');
  console.log('');
  for (const agent of agents) {
    const targetInfo = agent.target
      ? `target=terminal:pid=${agent.target.pid}`
      : 'target=(none)';
    const shortId = agent.agent_id.length > 24
      ? agent.agent_id.slice(0, 20) + '...'
      : agent.agent_id;
    console.log(`  [${shortId}] ${agent.name}`);
    console.log(`    registered_at: ${new Date(agent.registered_at).toISOString()}`);
    console.log(`    last_seen_at:  ${new Date(agent.last_seen_at).toISOString()}`);
    console.log(`    ${targetInfo}`);
  }
}

function cleanupAgents(): void {
  const registry = readRegistry();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const before = registry.agents.length;
  registry.agents = registry.agents.filter((a: Agent) => a.last_seen_at > cutoff);
  const removed = before - registry.agents.length;
  if (removed > 0) {
    writeRegistry(registry);
    console.log(`Removed ${removed} stale agent(s) (no activity in 7 days). ${registry.agents.length} remaining.`);
  } else {
    console.log(`No stale agents to remove. ${registry.agents.length} agent(s) registered.`);
  }
}

function setAgentTarget(agentId: string, pid: number): void {
  if (getAgent(agentId) === undefined) {
    console.error(`Agent "${agentId}" not found. Register first: agent register <id> <name>`);
    process.exit(1);
  }
  updateAgentTarget(agentId, { type: 'terminal', pid });
  console.log(`Set target for "${agentId}" → terminal:${pid}`);
}

function clearAgentTarget(agentId: string): void {
  if (getAgent(agentId) === undefined) {
    console.error(`Agent "${agentId}" not found.`);
    process.exit(1);
  }
  updateAgentTarget(agentId, null);
  console.log(`Cleared target for "${agentId}"`);
}

function jumpToAgent(agentId: string): void {
  const agent = getAgent(agentId);
  if (agent === undefined) {
    console.error(`Agent "${agentId}" not found. Register first: agent-attention agent register <id> <name>`);
    process.exit(1);
  }
  if (!agent.target) {
    console.error(`Agent "${agentId}" has no target. Set one with: agent-attention agent target set <id> --pid <pid>`);
    process.exit(1);
  }
  // P1-14 fix: previously jumpToTarget was exported but never called.
  // Now the CLI exposes `agent-attention jump <agent_id>` so users (and
  // automation) can trigger focus via the registered target.
  const { jumpToTarget } = require('./jump');
  jumpToTarget(agent.target);
  console.log(`Jumped to agent "${agentId}" → terminal PID ${agent.target.pid}`);
}

// CLI entry point

/**
 * Guided setup flow for first-time users.
 */

/** Discover agents installed on PATH. */
function runDiscover(): void {
  const adapters = loadAdapters();
  const installed = discoverInstalled(adapters);

  // 'Integrated' sources from registry's integration field, not a
  // separate integrations.json (folded into agents.json v3).
  const registry = readRegistry();
  const integratedIds = registry.agents
    .filter((a) => a.integration === 'adapter')
    .map((a) => a.agent_id);

  console.log('Agent Attention -- Discovery');
  console.log('');

  if (adapters.length === 0) {
    console.log('No agent adapters registered.');
    return;
  }

  console.log('Scanning PATH for known agents...');
  console.log('');

  for (const adapter of adapters) {
    const isFound = installed.includes(adapter.id);
    const isInt = integratedIds.includes(adapter.id);
    const status = isInt ? '[x] Integrated' : isFound ? '[ ] Found' : '[ ] Not found';
    console.log('  ' + adapter.name.padEnd(20) + status);
    if (isFound && !isInt) {
      console.log('    ID: ' + adapter.id + '  Binary: ' + adapter.binaryPatterns.join(', '));
    }
  }

  console.log('');
  const pending = installed.filter((id) => !integratedIds.includes(id));
  if (pending.length > 0) {
    console.log('Agents found but not yet integrated: ' + pending.join(', '));
    console.log('  Run: agent-attention integrate <id>   (installs Skill + prints register command)');
  } else if (installed.length === 0) {
    console.log('No known agents found on PATH.');
    console.log('  Install Claude Code, Codex, or Aider to enable integration.');
    console.log('  Or self-register any Agent: agent-attention agent register <id> "<name>"');
  } else {
    console.log('All found agents are already integrated.');
  }
}

function findBinaryOnPath(adapter: AgentAdapter): string | null {
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  for (const pattern of adapter.binaryPatterns) {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, pattern);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

function installAdapterSkill(adapter: AgentAdapter): string | null {
  if (!adapter.skillPath) return null;
  const resolved = adapter.skillPath
    .replace(/^~(?=[\\\\\/]|$)/, os.homedir())
    .replace(/^~/, os.homedir());
  const source = path.join(__dirname, '..', 'skills', 'agent-attention', 'skill.md');
  if (!fs.existsSync(source)) return null;
  const dest = path.join(resolved, 'agent-attention', 'skill.md');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    return dest;
  } catch (err) {
    console.warn('Failed to install skill: ' + err);
    return null;
  }
}

/**
 * Run adapter-specific bootstrap for an Agent. Does NOT register the Agent.
 * Registration is the Agent's responsibility via 'agent register'.
 *
 * Idempotent: safe to re-run; only installs Skill files when missing.
 */
function runIntegrate(agentId: string): void {
  const adapters = loadAdapters();
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) {
    console.error('Unknown adapter: ' + agentId);
    console.error('Available: ' + (adapters.length === 0 ? '(none)' : adapters.map((a) => a.id).join(', ')));
    console.error('You can still self-register without an adapter:');
    console.error('  agent-attention agent register <id> "<name>"');
    process.exit(1);
  }

  const installedBinary = findBinaryOnPath(adapter);
  const skillInstalled = installAdapterSkill(adapter);

  console.log('Adapter bootstrap for: ' + adapter.name + ' (' + agentId + ')');
  console.log('');
  if (installedBinary) {
    console.log('  [OK] binary found: ' + installedBinary);
  } else {
    console.log('  [--] binary not found on PATH (searched: ' + adapter.binaryPatterns.join(', ') + ')');
  }
  if (skillInstalled) {
    console.log('  [OK] skill installed at: ' + skillInstalled);
  } else if (adapter.skillPath) {
    console.log('  [--] skill not installed (no skillPath declared by adapter)');
  } else {
    console.log('  [--] adapter declares no skillPath');
  }
  console.log('');
  console.log('Next step: have the Agent itself run register:');
  console.log('  agent-attention agent register ' + agentId + ' "' + adapter.name + '" \\');
  if (installedBinary) {
    console.log('    --binary "' + installedBinary + '" \\');
  }
  console.log('    --integration adapter');
  console.log('');
  console.log('Or set AGENT_ID in the Agent shell before calling agent-notify:');
  if (adapter.injectAgentId) {
    console.log('  export AGENT_ID=' + agentId);
    console.log('  export AGENT_NAME="' + adapter.name + '"');
  } else {
    console.log('  export AGENT_ID=' + agentId);
  }
}
function runSetup(): void {
  console.log('Agent Attention -- Setup');
  console.log('');
  const status = getStatus();
  if (status.running) {
    console.log('[OK]  Daemon running (pid=' + status.pid + ')');
  } else {
    console.log('[--]  Daemon not running');
    console.log('      Run: agent-attention daemon start');
  }
  console.log('');
  const agents = listAgents();
  if (agents.length === 0) {
    console.log('[--]  No agents registered');
    console.log('      Register one:');
    console.log('      agent-attention agent register claude-code "Claude Code"');
  } else {
    console.log('[OK]  ' + agents.length + ' agent(s) registered');
    for (const a of agents) {
      console.log('      ' + a.agent_id + '  ' + a.name);
    }
  }
  console.log('');
  const statePath = path.join(STATE_DIR, 'state.json');
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      console.log('Events: ' + (state.events ? state.events.length : 0) + ' total, ' + state.unreadCount + ' unread');
    } catch {}
  }
  console.log('');
  if (!status.running) {
    console.log('Next: agent-attention daemon start');
  } else if (agents.length === 0) {
    console.log('Next: agent-attention agent register <id> "<name>"');
  } else {
    console.log('Next: AGENT_ID=' + agents[0].agent_id + ' agent-notify completed "test"');
  }
}


/** Wipe the runtime log file (for testing). */
function wipeLogs(): void {
  wipeLog();
  console.log('Runtime log wiped.');
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];

  if (!command) {
    console.log('Usage: agent-attention <command> [args]');
    console.log('');
    console.log('Commands:');
    console.log('  daemon start     Start the daemon in background');
    console.log('  daemon stop      Stop the daemon');
    console.log('  daemon restart   Restart the daemon');
    console.log('  daemon status    Show daemon status');
    console.log('  mark-all-read    Mark all events as read');
    console.log('  mark-event <id>  Mark a single event as read');
    console.log('  jump <agent-id>  Focus the terminal target of an agent');
    console.log('  agent register <id> <name>  Register an agent');
    console.log('  agent list                           List all agents');
    console.log('  agent cleanup                        Remove agents inactive for 7+ days');
    console.log('  agent target set <id> --pid <n>      Set target terminal pid');
    console.log('  agent target clear <id>              Clear target');
    console.log('  logs [n]         Show last N lines of daemon log');
    console.log('  doctor           Run health checks');
    console.log('  setup            Quick setup: install daemon + register agent');
    console.log('  discover         Scan PATH for installed agents');
    console.log('  integrate <id>   Enable integration for a discovered agent');
    console.log('  hook             Handle Claude Code hook stdin (internal — do not call manually)');
    process.exit(0);
  }

  if (command === 'setup') { runSetup(); return; }
  if (command === 'discover') { runDiscover(); return; }
  if (command === 'integrate') { runIntegrate(args[1] || ''); return; }

  // New: Integration management commands
  if (command === 'integration') {
    const subcommand = args[1];
    const agentId = args[2];
    if (!subcommand) {
      console.log('Usage: agent-attention integration <list|install|uninstall|status> [agent-id]');
      console.log('');
      console.log('Commands:');
      console.log('  list              List all known integrations and their status');
      console.log('  install <id>      Install integration for an agent');
      console.log('  uninstall <id>    Remove integration for an agent');
      console.log('  status <id>       Show integration status for an agent');
      process.exit(0);
    }
    if (subcommand === 'list') { runIntegrationList(); return; }
    if (subcommand === 'install') {
      if (!agentId) {
        console.log('Usage: agent-attention integration install <agent-id>');
        process.exit(1);
      }
      runIntegrationInstall(agentId); return;
    }
    if (subcommand === 'uninstall') {
      if (!agentId) {
        console.log('Usage: agent-attention integration uninstall <agent-id>');
        process.exit(1);
      }
      runIntegrationUninstall(agentId); return;
    }
    if (subcommand === 'status') {
      if (!agentId) {
        console.log('Usage: agent-attention integration status <agent-id>');
        process.exit(1);
      }
      runIntegrationStatus(agentId); return;
    }
    console.log(`Unknown integration subcommand: ${subcommand}`);
    process.exit(1);
  }

  if (command === 'hook') { runHook(); return; }

  if (command === 'daemon') {
    if (!subcommand) {
      console.log('Usage: agent-attention daemon <start|stop|restart|status>');
      process.exit(1);
    }
    if (subcommand === 'wipe') { wipeLogs(); return; }
    switch (subcommand) {
      case 'start': startDaemon(); break;
      case 'stop': stopDaemon(); break;
      case 'restart': restart(); break;
      case 'status': status(); break;
      default:
        console.log(`Unknown daemon subcommand: ${subcommand}`);
        process.exit(1);
    }
  } else if (command === 'mark-all-read') {
    markAllRead();
  } else if (command === 'mark-event') {
    const eventId = args[1];
    if (!eventId) {
      console.log('Usage: agent-attention mark-event <event-id>');
      process.exit(1);
    }
    markEvent(eventId);
  } else if (command === 'logs') {
    // Handle: logs [--correlation <id>] [n]
    // Check --correlation FIRST before parsing n, so `logs --correlation xxx` works
    const corrIdx2 = args.indexOf('--correlation');
    if (corrIdx2 >= 0) {
      const corrVal = args[corrIdx2 + 1];
      const numArg = args[0] !== '--correlation' ? args[0] : undefined;
      const n2 = numArg ? parseInt(numArg, 10) : 50;
      if (!isNaN(n2) && n2 > 0) {
        logs(n2, args.slice(1));
      } else {
        logs(50, args.slice(1));
      }
    } else {
      const n = args[1] ? parseInt(args[1], 10) : 50;
      if (args[1] && isNaN(n)) { console.log('Usage: agent-attention logs [n]'); process.exit(1); }
      logs(n, args.slice(2));
    }
  } else if (command === 'doctor') {
    doctor();
  } else if (command === 'jump') {
    const agentId = args[1];
    if (!agentId) {
      console.log('Usage: agent-attention jump <agent-id>');
      process.exit(1);
    }
    jumpToAgent(agentId);
  } else if (command === 'agent') {
    const sub1 = args[1];
    const sub2 = args[2];

    if (!sub1) {
      console.log('Usage: agent-attention agent <register|list|target>');
      process.exit(1);
    }

    if (sub1 === 'register') {
      const id = args[2];
      const name = args[3];
      const binaryIdx = args.indexOf('--binary', 4);
      const integrationIdx = args.indexOf('--integration', 4);
      const binary = binaryIdx >= 0 ? args[binaryIdx + 1] : undefined;
      const integration = integrationIdx >= 0 ? args[integrationIdx + 1] : undefined;
      if (!id || !name) {
        console.log('Usage: agent-attention agent register <id> <name> [--binary <path>] [--integration skill|adapter|none]');
        process.exit(1);
      }
      if (integration && !['skill', 'adapter', 'none'].includes(integration)) {
        console.error('Invalid --integration: ' + integration + '. Must be: skill, adapter, or none');
        process.exit(1);
      }
      const agent = registerAgent(id, name, {
        binary: binary || null,
        integration: integration as import('./registry').IntegrationMode | undefined,
      });
      const modeLabel = agent.integration === 'adapter' ? '[adapter]' : agent.integration === 'skill' ? '[skill]' : '[none]';
      console.log(`Registered agent: ${agent.agent_id} (${agent.name}) ${modeLabel}`);
      if (agent.binary) console.log(`  binary: ${agent.binary}`);
    } else if (sub1 === 'list') {
      printAgents();
    } else if (sub1 === 'cleanup') {
      cleanupAgents();
    } else if (sub1 === 'target') {
    } else if (sub1 === 'target') {
      if (!sub2) {
        console.log('Usage: agent-attention agent target <set|clear> <id> [--pid <n>]');
        process.exit(1);
      }
      if (sub2 === 'set') {
        const id = args[3];
        const pidIndex = args.indexOf('--pid', 3);
        if (!id) {
          console.log('Usage: agent-attention agent target set <id> --pid <n>');
          process.exit(1);
        }
        if (pidIndex === -1 || !args[pidIndex + 1]) {
          console.log('Usage: agent-attention agent target set <id> --pid <n>');
          process.exit(1);
        }
        const pid = parseInt(args[pidIndex + 1], 10);
        if (isNaN(pid)) {
          console.error('--pid must be a number');
          process.exit(1);
        }
        setAgentTarget(id, pid);
      } else if (sub2 === 'clear') {
        const id = args[3];
        if (!id) {
          console.log('Usage: agent-attention agent target clear <id>');
          process.exit(1);
        }
        clearAgentTarget(id);
      } else {
        console.log(`Unknown agent subcommand: agent target ${sub2}`);
        process.exit(1);
      }
    } else {
      console.log(`Unknown agent subcommand: ${sub1}`);
      process.exit(1);
    }
  } else {
    console.log(`Unknown command: ${command}`);
    process.exit(1);
  }
}

/**
 * Integration management commands
 */
function runIntegrationList(): void {
  const { discoverIntegrations } = require('./integration/catalog');
  const results = discoverIntegrations();
  console.log('Agent Attention — Integration Capability Catalog\n');
  console.log('┌───────────────────┬──────────┬──────────────┬─────────────────┐');
  console.log('│ Agent             │ Level    │ Mechanism    │ Status          │');
  console.log('├───────────────────┼──────────┼──────────────┼─────────────────┤');
  for (const r of results) {
    const installed = r.installed ? '✓' : '✗';
    const levelNames: Record<number, string> = {
      0: 'L0 CLI', 1: 'L1 Skill', 2: 'L2 Wrapper', 3: 'L3 Hook',
      4: 'L4 Plugin', 5: 'L5 MCP', 6: 'L6 ACP', 7: 'L7 Native',
    };
    const level = levelNames[r.achievableLevel] ?? 'L?';
    console.log(`│ ${r.manifest.name.padEnd(15)} │ ${level.padEnd(8)} │ ${r.recommendedMechanism.padEnd(12)} │ ${installed} ${r.manifest.status ?? 'experimental'} │`);
  }
  console.log('└───────────────────┴──────────┴──────────────┴─────────────────┘');
}

function runIntegrationInstall(agentId: string): void {
  const { getManifest, isAgentInstalled } = require('./integration/catalog');
  const { getProvider } = require('./integration/providers');
  const manifest = getManifest(agentId);
  if (!manifest) {
    console.error(`Unknown agent: ${agentId}`);
    console.log('Run: agent-attention integration list');
    process.exit(1);
  }
  const installed = isAgentInstalled(manifest);
  if (!installed) {
    console.error(`Agent "${manifest.name}" is not installed.`);
    console.log('Install it first, then run this command again.');
    process.exit(1);
  }
  const provider = getProvider(manifest.mechanism);
  try {
    const installPath = provider.install(manifest);
    console.log(`Installed ${manifest.mechanism} integration for ${manifest.name}`);
    console.log(`  Path: ${installPath}`);
    console.log('\nInstructions:');
    console.log(provider.getInstallInstructions(manifest));
  } catch (err) {
    console.error(`Failed to install integration: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function runIntegrationUninstall(agentId: string): void {
  const { getManifest } = require('./integration/catalog');
  const { getProvider } = require('./integration/providers');
  const manifest = getManifest(agentId);
  if (!manifest) {
    console.error(`Unknown agent: ${agentId}`);
    process.exit(1);
  }
  const provider = getProvider(manifest.mechanism);
  provider.uninstall(manifest);
  console.log(`Uninstalled ${manifest.mechanism} integration for ${manifest.name}`);
}

function runIntegrationStatus(agentId: string): void {
  const { getManifest, isAgentInstalled, getEffectiveReliability, getSupportedEvents } = require('./integration/catalog');
  const manifest = getManifest(agentId);
  if (!manifest) {
    console.error(`Unknown agent: ${agentId}`);
    process.exit(1);
  }
  const installed = isAgentInstalled(manifest);
  const reliability = getEffectiveReliability(manifest);
  const events = getSupportedEvents(manifest);
  console.log(`Agent: ${manifest.name}`);
  console.log(`  ID: ${manifest.id}`);
  console.log(`  Installed: ${installed ? 'Yes' : 'No'}`);
  console.log(`  Level: L${manifest.level} (${manifest.mechanism})`);
  console.log(`  Reliability: ${reliability}`);
  console.log(`  Events: ${events.join(', ') || 'none'}`);
  console.log(`  Status: ${manifest.status ?? 'experimental'}`);
}

/**
 * Claude Code hook handler: read JSON from stdin, record an attention event.
 * Used as `command` in hooks.json. Never called directly by users.
 */
function runHook(): void {
  const { recordEvent } = require('./state/AttentionState');
  const { autoDetectAndRegister } = require('./registry');
  const { log, generateCorrelationId } = require('./logging');
  const os = require('os');
  const path = require('path');

  const statePath = path.join(
    process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention'),
    'state.json',
  );

  let body = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => { body += chunk; });
  process.stdin.on('end', () => {
    if (!body.trim()) { process.exit(0); return; }
    let payload: any;
    try { payload = JSON.parse(body); } catch { process.exit(0); return; }

    const status = payload.exitStatus;
    const turns = payload.turns ?? 0;
    const sessionId = (payload.sessionId as string | undefined) ?? 'unknown';
    let event: string;
    let message: string;
    let priority: 'P0' | 'P1' | 'P2';

    if (status === 0 && turns > 0) {
      event = 'completed'; priority = 'P2';
      message = `Claude Code session ended cleanly (${turns} turn${turns > 1 ? 's' : ''}, session ${sessionId.slice(0, 8)})`;
    } else if (status === 1) {
      event = 'failed'; priority = 'P1';
      message = `Claude Code session failed (exit=${status}, session ${sessionId.slice(0, 8)})`;
    } else if (status === 2) {
      event = 'input_required'; priority = 'P0';
      message = `Claude Code session cancelled by user (session ${sessionId.slice(0, 8)})`;
    } else {
      process.exit(0); return;
    }

    const agentId = payload.agentId ?? autoDetectAndRegister();
    const correlationId = generateCorrelationId();
    try {
      recordEvent(statePath, {
        type: event as any,
        priority,
        agent_id: agentId,
        agent_name: agentId,
        title: `${agentId}: ${event}`,
        message,
        timestamp: Date.now(),
        correlation_id: correlationId,
      });
      log({ component: 'hook', level: 'INFO', event: 'hook_handled', message: `${agentId} → ${event}`, correlation_id: correlationId, context: { sessionId: payload.sessionId, exitStatus: status, turns } });
    } catch (err) {
      log({ component: 'hook', level: 'ERROR', event: 'hook_failed', message: `failed to record hook event: ${err instanceof Error ? err.message : String(err)}` });
    }
    process.exit(0);
  });
}

main();

