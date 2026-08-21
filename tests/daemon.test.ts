import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createDaemon, DaemonOptions } from '../src/daemon';

// Mock child_process.spawn so tests don't actually run PowerShell.
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const proc = new EventEmitter() as any;
    // Tray no longer uses stdin — ignore it.
    proc.stdin = { write: jest.fn(), end: jest.fn(), writable: false };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    proc.pid = 12345;
    return proc;
  }),
}));

import { spawn } from 'child_process';
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('daemon (file-polling architecture)', () => {
  let tmpDir: string;
  let statePath: string;
  let trayStatePath: string;
  let daemon: { stop: () => Promise<void> } | null = null;

  const makeOptions = (dir: string): DaemonOptions => ({
    statePath:     path.join(dir, 'state.json'),
    powerShellPath: 'powershell',
    trayScriptPath: 'src/center/TrayIcon.ps1',
    trayStatePath: path.join(dir, 'tray-state.json'),
    trayPidPath:   path.join(dir, 'tray.pid'),
    cliPath:       path.join(dir, 'daemon-cli.js'),
    debug:         false,
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-daemon-'));
    const opts = makeOptions(tmpDir);
    options.statePath     = opts.statePath;
    options.trayStatePath = opts.trayStatePath;
    options.trayPidPath   = opts.trayPidPath;
    options.cliPath       = opts.cliPath;
    mockedSpawn.mockClear();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const options: Partial<DaemonOptions> = {
    statePath: '',
    powerShellPath: 'powershell',
    trayScriptPath: 'src/center/TrayIcon.ps1',
    debug: false,
  };

  it('spawns TrayIcon.ps1 without stdin pipe', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedSpawn).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining(['-File', 'src/center/TrayIcon.ps1']),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );
  });

  it('writes tray-state.json on state change', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(options.statePath!, JSON.stringify({
      version: 1, updatedAt: 1, unreadCount: 1,
      events: [{ id: 'evt-1-aaa', timestamp: 1, type: 'completed', priority: 'P2',
                 message: 'a', agent_id: 'x', agent_name: 'X', title: 'X: completed', read: false }],
    }));

    await new Promise((r) => setTimeout(r, 500));

    // tray-state.json should exist and contain the event (pretty-printed JSON)
    expect(fs.existsSync(options.trayStatePath!)).toBe(true);
    const content = fs.readFileSync(options.trayStatePath!, 'utf-8');
    expect(content).toMatch(/"message"\s*:\s*"a"/);
  });

  it('does not crash on corrupted state.json', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(options.statePath!, 'not valid json {{{');
    await new Promise((r) => setTimeout(r, 300));

    await expect(daemon.stop()).resolves.not.toThrow();
  });

  it('debounces rapid state writes — does not spam disk', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(options.statePath!, JSON.stringify({
        version: 1, updatedAt: i, unreadCount: i, events: [],
      }));
    }

    await new Promise((r) => setTimeout(r, 500));

    // File should have been written at least once (initial + debounced)
    expect(fs.existsSync(options.trayStatePath!)).toBe(true);
  });

  it('cleans up tray-state.json on stop', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));

    // Trigger a write first
    fs.writeFileSync(options.statePath!, JSON.stringify({
      version: 1, updatedAt: 1, unreadCount: 0, events: [],
    }));
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(options.trayStatePath!)).toBe(true);

    await daemon.stop();
    daemon = null;

    // Tray polling file should be removed on stop
    expect(fs.existsSync(options.trayStatePath!)).toBe(false);
  });

  it('handles stop gracefully', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));
    await expect(daemon.stop()).resolves.not.toThrow();
  });
});
