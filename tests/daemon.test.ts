import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';
import { createDaemon, DaemonOptions } from '../src/daemon';

// Mock child_process.spawn so tests don't actually run PowerShell
jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: jest.fn(), end: jest.fn(), writable: true };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    return proc;
  }),
}));

import { spawn } from 'child_process';
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('daemon', () => {
  let tmpDir: string;
  let statePath: string;
  let daemon: { stop: () => Promise<void> } | null = null;
  const options: DaemonOptions = {
    statePath: '',
    powerShellPath: 'powershell',
    trayScriptPath: 'src/center/TrayIcon.ps1',
    debug: false,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-daemon-'));
    statePath = path.join(tmpDir, 'state.json');
    options.statePath = statePath;
    mockedSpawn.mockClear();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('spawns TrayIcon.ps1 show on start', async () => {
    daemon = createDaemon(options);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedSpawn).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining(['-File', 'src/center/TrayIcon.ps1', 'show']),
      expect.any(Object),
    );
  });

  it('reloads state and pushes to tray on file change', async () => {
    daemon = createDaemon(options);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: 1, unreadCount: 1,
      events: [{ id: 'evt-1-aaa', timestamp: 1, type: 'completed', priority: 'P2', message: 'a', agent_id: 'x', agent_name: 'X', title: 'X: completed', read: false }],
    }));

    await new Promise((r) => setTimeout(r, 500));

    const lastCall = mockedSpawn.mock.results[mockedSpawn.mock.results.length - 1];
    const proc = lastCall.value as any;
    expect(proc.stdin.write).toHaveBeenCalled();
    const writtenArg = proc.stdin.write.mock.calls[0][0];
    expect(writtenArg).toContain('"message":"a"');
  });

  it('does not crash on corrupted state.json', async () => {
    daemon = createDaemon(options);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(statePath, 'not valid json {{{');
    await new Promise((r) => setTimeout(r, 300));

    await expect(daemon.stop()).resolves.not.toThrow();
  });

  it('debounces multiple rapid changes', async () => {
    daemon = createDaemon(options);
    await new Promise((r) => setTimeout(r, 50));

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1, updatedAt: i, unreadCount: i,
        events: [],
      }));
    }

    await new Promise((r) => setTimeout(r, 500));

    const lastCall = mockedSpawn.mock.results[mockedSpawn.mock.results.length - 1];
    const proc = lastCall.value as any;
    const writeCount = proc.stdin.write.mock.calls.length;
    expect(writeCount).toBeLessThanOrEqual(2);
  });

  it('cleans up chokidar on stop', async () => {
    daemon = createDaemon(options);
    await new Promise((r) => setTimeout(r, 50));
    await daemon.stop();
    daemon = null;

    mockedSpawn.mockClear();
    fs.writeFileSync(statePath, JSON.stringify({ version: 1, updatedAt: 1, unreadCount: 0, events: [] }));
    await new Promise((r) => setTimeout(r, 300));

    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('handles stop gracefully', async () => {
    daemon = createDaemon(options);
    await new Promise((r) => setTimeout(r, 50));

    await expect(daemon.stop()).resolves.not.toThrow();
  });
});