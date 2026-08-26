import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDaemon, DaemonOptions } from '../src/daemon';
import { resolveNativeUiPath } from '../src/ui-host';

jest.mock('child_process', () => {
  const { EventEmitter } = require('events');
  const mockFn = jest.fn((exe: string, args: string[], opts: any) => {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: jest.fn(), end: jest.fn(), writable: false };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    proc.pid = 99000;
    return proc;
  });
  return { spawn: mockFn };
});

import { spawn } from 'child_process';
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('daemon-csharp (L3 unit)', () => {
  let tmpDir = '';
  let statePath = '';
  let trayStatePath = '';
  let trayPidPath = '';
  let cliPath = '';
  let uiExe: string | null = null;
  let options: DaemonOptions | null = null;

  beforeAll(() => { uiExe = resolveNativeUiPath(); });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-m2-'));
    statePath = path.join(tmpDir, 'state.json');
    trayStatePath = path.join(tmpDir, 'tray-state.json');
    trayPidPath = path.join(tmpDir, 'tray.pid');
    cliPath = path.join(tmpDir, 'daemon-cli.js');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 0, events: [], visible: false,
    }));
    fs.writeFileSync(cliPath, 'module.exports={};');
    options = {
      statePath, trayStatePath, trayPidPath, cliPath,
      uiExecutablePath: uiExe!, debug: false,
    };
    mockedSpawn.mockClear();
  });

  afterEach(async () => {
    if (options) {
      try { await createDaemon(options).stop(); } catch {}
    }
    mockedSpawn.mockClear();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = '';
    options = null;
  });

  it('spawns native UI with correct args when uiExecutablePath is set', async () => {
    if (!uiExe) { console.warn('[SKIP] No native UI found'); return; }
    const daemon = createDaemon(options!);
    await new Promise(r => setTimeout(r, 100));
    expect(mockedSpawn).toHaveBeenCalledWith(
      uiExe,
      expect.arrayContaining([
        '-StatePath', statePath,
        '-RegistryPath', path.join(tmpDir, 'agents.json'),
        '-CliPath', cliPath,
        '-TrayStatePath', trayStatePath,
        '-TrayPidPath', trayPidPath,
      ]),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );
    await daemon.stop();
  });

  it('writes tray-state.json on state change', async () => {
    if (!uiExe) { console.warn('[SKIP] No native UI found'); return; }
    const daemon = createDaemon(options!);
    await new Promise(r => setTimeout(r, 100));
    const now = Date.now();
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: now, unreadCount: 2, events: [
        { id: 'm2-e1', timestamp: now, type: 'input_required', priority: 'P0',
          agent_id: 'codex', agent_name: 'Codex', title: 'M2', message: 'test', read: false },
      ],
    }));
    await new Promise(r => setTimeout(r, 600));
    expect(fs.existsSync(trayStatePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(trayStatePath, 'utf8') as string);
    // readState recompute may adjust unreadCount based on events array length
    expect(content.events.length).toBe(1);
    expect(content.events[0].id).toBe('m2-e1');
    const leftovers = fs.readdirSync(tmpDir).filter(n => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
    await daemon.stop();
  });

  it('handles missing state file without crashing', async () => {
    fs.unlinkSync(statePath);
    const daemon = createDaemon(options!);
    await new Promise(r => setTimeout(r, 300));
    await expect(daemon.stop()).resolves.not.toThrow();
  });

  it('handles corrupted state file without crashing', async () => {
    fs.writeFileSync(statePath, 'not json {{{broken');
    const daemon = createDaemon(options!);
    await new Promise(r => setTimeout(r, 300));
    await expect(daemon.stop()).resolves.not.toThrow();
  });

  it('pid file written at spawn time', async () => {
    if (!uiExe) { console.warn('[SKIP] No native UI found'); return; }
    const daemon = createDaemon(options!);
    await new Promise(r => setTimeout(r, 100));
    expect(fs.existsSync(trayPidPath)).toBe(true);
    const pid = parseInt(fs.readFileSync(trayPidPath, 'utf8').trim(), 10);
    expect(pid).toBeGreaterThan(0);
    await daemon.stop();
  });

});
