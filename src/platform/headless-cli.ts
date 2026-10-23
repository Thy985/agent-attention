/** Lifecycle adapter only: runs the shared daemon, never installs a service or launches a desktop. */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { resolveStateDir } from '../paths';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function ownedPid(): number | null {
  const dir = resolveStateDir();
  try {
    const raw = fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim();
    const lock = fs.readFileSync(path.join(dir, 'daemon.lock'), 'utf8').trim();
    if (!/^\d+$/.test(raw) || lock !== raw || Number(raw) < 2) return null;
    const pid = Number(raw);
    process.kill(pid, 0);
    // Do not signal an unrelated reused PID. Linux is the supported headless lifecycle target.
    if (process.platform === 'linux') {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes(path.resolve(__dirname, '..', 'daemon.js')) && !cmd.includes(path.resolve(__dirname, '..', 'daemon-cli.js'))) return null;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return null;
    }
    return pid;
  } catch { return null; }
}
export async function headlessCommand(command: string): Promise<void> {
  if (process.platform !== 'linux' && command !== 'run') throw new Error('Headless background lifecycle is supported on Linux only; use the platform desktop lifecycle or foreground run');
  if (command === 'run') { require('../daemon').runDaemon(); return; }
  if (command === 'status') {
    const pid = ownedPid();
    console.log(JSON.stringify({ running: pid !== null, pid, mode: 'headless', startup: 'not-installed' })); return;
  }
  if (command === 'stop' || command === 'restart') {
    const pid = ownedPid();
    if (pid) {
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + 6000;
      while (ownedPid() === pid && Date.now() < deadline) await sleep(50);
      if (ownedPid() === pid) throw new Error('Daemon did not stop; no forced kill or replacement started');
    }
    if (command === 'stop') { console.log(JSON.stringify({ running: false, stopped: true })); return; }
  }
  if (command === 'start' || command === 'restart') {
    const existing = ownedPid();
    if (existing) { console.log(JSON.stringify({ running: true, pid: existing, alreadyRunning: true })); return; }
    const dir = resolveStateDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(dir, 'headless-launch.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'daemon.js')], {
      env: { ...process.env, AGENT_ATTENTION_MODE: 'headless' }, detached: true, stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    let failure: Error | undefined;
    child.on('error', err => { failure = err; });
    child.unref();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const pid = ownedPid();
      if (pid && fs.existsSync(path.join(dir, 'ipc-port.txt'))) { console.log(JSON.stringify({ running: true, pid, mode: 'headless' })); return; }
      // A zero-exit contender may have lost the daemon lock to another start.
      // Keep waiting for that owner's readiness instead of reporting a false
      // failure in the interval between lock acquisition and port publication.
      if (child.exitCode !== null && child.exitCode !== 0) break;
      await sleep(50);
    }
    // Startup timeout is not permission to launch a duplicate or kill another process.
    throw new Error('Daemon readiness not confirmed; inspect headless-launch.log before retrying');
  }
  throw new Error('Usage: daemon run|start|stop|restart|status --headless');
}
