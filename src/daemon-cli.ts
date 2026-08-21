import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync, spawn } from 'child_process';
import { registerAgent, listAgents, getAgent, updateAgentTarget, AgentTarget } from './registry';
import { clearUnread } from './state/AttentionState';

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

/** Get PowerShell.exe PIDs whose exe path contains the given pattern (PS5.1-safe). */
function getPsPids(pattern: string): number[] {
  try {
    const out = runPs(
      'get-ciminstance win32_process | where-object { $_.name -eq ' +
      "'powershell.exe' -and $_.path -like '*" + pattern + "*' } " +
      '| select-object -expandproperty processid',
    );
    return out.trim().split('\n').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  } catch { return []; }
}

const STATE_DIR = path.join(os.homedir(), '.agent-attention');
const PID_FILE = path.join(STATE_DIR, 'daemon.pid');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
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

  const stateValid = fs.existsSync(STATE_PATH);
  const startupHook = fs.existsSync(path.join(STARTUP_DIR, 'agent-attention.vbs'));

  return { running, pid, trayRunning, stateValid, startupHook };
}

function startDaemon(): void {
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.log(`Daemon already running (pid=${existingPid})`);
    return;
  }

  // Clean up stale lock/pid files
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
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
}

/**
 * Kill all stale tray processes left by previous daemon instances.
 * Returns the number of processes killed.
 */
function killStaleTrayProcesses(): number {
  let killed = 0;
  try {
    const pids = getPsPids('TrayIcon.ps1');
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    killed = pids.length;
    if (killed > 0) {
      console.log(`Killed ${killed} stale tray process(es)`);
    }
  } catch {
    // WMI may not be available
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
  killStaleTrayProcesses();
  clearPid();
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
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
  let daemonInstances = 0;
  let trayInstances = 0;
  try {
    const out = runPs(
      "get-ciminstance win32_process | where-object { $_.name -eq 'node.exe' " +
      "-and $_.commandline -like '*daemon.js*' -and $_.commandline -like '*agent-attention*' } " +
      "| select-object -expandproperty processid",
    );
    daemonInstances = out.trim().split('\n').filter(Boolean).length;
  } catch { daemonInstances = 0; }

  try {
    const out = runPs(
      "get-ciminstance win32_process | where-object { $_.name -eq 'powershell.exe' " +
      "-and $_.path -like '*TrayIcon.ps1*' } " +
      "| select-object -expandproperty processid",
    );
    trayInstances = out.trim().split('\n').filter(Boolean).length;
  } catch { trayInstances = 0; }

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
      name: 'Tray script',
      ok: fs.existsSync(path.join(__dirname, '..', 'src', 'center', 'TrayIcon.ps1')),
      detail: 'src/center/TrayIcon.ps1 exists',
    },
    {
      name: 'State file',
      ok: fs.existsSync(STATE_PATH),
      detail: fs.existsSync(STATE_PATH) ? `unreadCount=${JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')).unreadCount}` : 'missing',
    },
    {
      name: 'Windows Toast',
      ok: process.platform === 'win32',
      detail: process.platform === 'win32' ? 'available' : `not on Windows (${process.platform})`,
    },
    {
      name: 'Sound',
      ok: true,
      detail: 'play-sound dependency present',
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
    console.log(`  ${agent.agent_id} (${agent.name})`);
    console.log(`    registered_at: ${new Date(agent.registered_at).toISOString()}`);
    console.log(`    last_seen_at:  ${new Date(agent.last_seen_at).toISOString()}`);
    console.log(`    ${targetInfo}`);
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

// CLI entry point
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
    console.log('  agent register <id> <name>  Register an agent');
    console.log('  agent list                           List all agents');
    console.log('  agent target set <id> --pid <n>      Set target terminal pid');
    console.log('  agent target clear <id>              Clear target');
    console.log('  doctor           Run health checks');
    process.exit(0);
  }

  if (command === 'daemon') {
    if (!subcommand) {
      console.log('Usage: agent-attention daemon <start|stop|restart|status>');
      process.exit(1);
    }
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
  } else if (command === 'doctor') {
    doctor();
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
      if (!id || !name) {
        console.log('Usage: agent-attention agent register <id> <name>');
        process.exit(1);
      }
      const agent = registerAgent(id, name);
      console.log(`Registered agent: ${agent.agent_id} (${agent.name})`);
    } else if (sub1 === 'list') {
      printAgents();
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

main();