/**
 * Regression tests for daemon single-instance lock (P1-8) and
 * killExistingDaemon PowerShell syntax (P2-1).
 *
 * Design (revised): the DAEMON process owns daemon.lock — acquired with
 * atomic O_EXCL ('wx') + stale-holder steal — because `daemon-cli start`
 * exits right after spawning and cannot hold a lock. The CLI start path
 * only removes a provably-stale lock; the stop path removes lifecycle
 * files unconditionally.
 */

import * as fs from 'fs';

describe('daemon single-instance lock ownership (P1-8)', () => {
  it('daemon.ts acquires daemon.lock with wx flag in its main block', () => {
    const src = fs.readFileSync('src/daemon.ts', 'utf8');
    expect(src).toMatch(/openSync\(daemonLockPath,\s*['"]wx['"]\)/);
  });

  it('daemon.ts steals a stale lock whose holder pid is dead', () => {
    const src = fs.readFileSync('src/daemon.ts', 'utf8');
    expect(src).toMatch(/stale daemon\.lock stolen/);
    expect(src).toMatch(/acquireDaemonLock/);
    expect(src).toMatch(/releaseDaemonLock/);
  });

  it('daemon.ts releases the lock on SIGTERM/SIGINT/crash/beforeExit', () => {
    const src = fs.readFileSync('src/daemon.ts', 'utf8');
    // SIGTERM/SIGINT route through shutdown(), which releases the lock.
    expect(src).toMatch(/const shutdown = \(code: number\): void => \{[\s\S]*?releaseDaemonLock\(\);[\s\S]*?\};/);
    expect(src).toMatch(/process\.on\('SIGTERM', \(\) => shutdown\(0\)\)/);
    expect(src).toMatch(/process\.on\('SIGINT',\s+\(\) => shutdown\(0\)\)/);
    // uncaughtException releases before exiting
    expect(src).toMatch(/uncaughtException[\s\S]*?releaseDaemonLock\(\);[\s\S]*?process\.exit\(1\)/);
    // beforeExit handler also releases
    expect(src).toMatch(/beforeExit[\s\S]*?releaseDaemonLock\(\);/);
  });

  it('daemon-cli start no longer holds the lock itself (would block future starts)', () => {
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    expect(src).not.toMatch(/function acquireLock/);
    expect(src).not.toMatch(/Another daemon start is in progress/);
  });

  it('daemon-cli stop removes lifecycle files unconditionally', () => {
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    expect(src).toMatch(/unlinkSync\(LOCK_FILE\)/);
    expect(src).toMatch(/unlinkSync\(TRAY_PID_FILE\)/);
  });

  it('daemon pushStateToTrayFile has a stopped guard (P3-7)', () => {
    const src = fs.readFileSync('src/daemon.ts', 'utf8');
    const fnIdx = src.indexOf('const pushStateToTrayFile');
    const body = src.slice(fnIdx, fnIdx + 400);
    expect(body).toMatch(/if \(stopped\) return;/);
  });
});

describe('killExistingDaemon PowerShell syntax (P2-1)', () => {
  it('does NOT contain the spaced pipeline-variable form (parser error)', () => {
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    expect(src).not.toMatch(/\$_\s+\.name/);
  });

  it('uses $_.name (no space) inside the kill-children PS script', () => {
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    expect(src).toMatch(/\$_\.name/);
  });
});

describe('restart waits for old daemon to exit (P3-9)', () => {
  it('restart polls for daemon exit instead of a fixed 1s setTimeout', () => {
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    // Extract the restart function body.
    const fnIdx = src.indexOf('function restart(): void');
    const body = src.slice(fnIdx, fnIdx + 900);
    expect(body).toMatch(/getDaemonPids\(\)\.length > 0/);
    expect(body).toMatch(/sleepSync\(100\)/);
    // Must NOT blindly start after a fixed 1s delay.
    expect(body).not.toMatch(/setTimeout\(\(\) => startDaemon\(\), 1000\)/);
    // Still starts the replacement daemon.
    expect(body).toMatch(/startDaemon\(\)/);
  });

  it('bounded: warns and starts anyway if old daemon lingers', () => {
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    const fnIdx = src.indexOf('function restart(): void');
    const body = src.slice(fnIdx, fnIdx + 900);
    expect(body).toMatch(/Old daemon did not exit within 8s/);
  });
});
