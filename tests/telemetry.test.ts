import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadTelemetry,
  saveTelemetry,
  recordCrash,
  recordRpcSuccess,
  recordRpcFailure,
  recordIpcConnectFailure,
  recordToastActivation,
  recordRestart,
  recordIconState,
  recordHandleCount,
  resetTelemetry,
} from '../src/telemetry';

describe('telemetry (M7)', () => {
  const TELEMETRY_PATH = path.join(os.homedir(), '.agent-attention', 'telemetry.json');

  beforeEach(() => {
    resetTelemetry();
  });

  afterEach(() => {
    resetTelemetry();
  });

  it('starts with a clean default snapshot', () => {
    const snap = loadTelemetry();
    expect(snap.crashes).toBe(0);
    expect(snap.handleCount).toBe(0);
    expect(snap.iconState).toBe('unknown');
    expect(snap.toastActivations).toBe(0);
    expect(snap.rpcSuccess).toBe(0);
    expect(snap.rpcFailure).toBe(0);
    expect(snap.ipcConnectFailures).toBe(0);
    expect(snap.restartCount).toBe(0);
    expect(typeof snap.lastCheck).toBe('string');
  });

  it('persist and reload crashes count', () => {
    recordCrash();
    recordCrash();
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.crashes).toBe(2);
  });

  it('persist and reload rpc counts separately', () => {
    recordRpcSuccess();
    recordRpcSuccess();
    recordRpcFailure();
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.rpcSuccess).toBe(2);
    expect(snap.rpcFailure).toBe(1);
  });

  it('persist and reload ipc connect failures', () => {
    recordIpcConnectFailure();
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.ipcConnectFailures).toBe(1);
  });

  it('persist and reload toast activations', () => {
    recordToastActivation();
    recordToastActivation();
    recordToastActivation();
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.toastActivations).toBe(3);
  });

  it('persist and reload restart count', () => {
    recordRestart();
    recordRestart();
    recordRestart();
    recordRestart();
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.restartCount).toBe(4);
  });

  it('records icon state as "visible:N"', () => {
    recordIconState(true, 5);
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.iconState).toBe('visible:5');
  });

  it('records icon state as "hidden:0"', () => {
    recordIconState(false, 0);
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.iconState).toBe('hidden:0');
  });

  it('records handle count', () => {
    recordHandleCount(42);
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.handleCount).toBe(42);
  });

  it('resetTelemetry clears persisted file and resets state', () => {
    recordCrash();
    recordRpcSuccess();
    saveTelemetry();

    expect(fs.existsSync(TELEMETRY_PATH)).toBe(true);

    resetTelemetry();

    expect(fs.existsSync(TELEMETRY_PATH)).toBe(false);
    const snap = loadTelemetry();
    expect(snap.crashes).toBe(0);
    expect(snap.rpcSuccess).toBe(0);
  });

  it('lastCheck updates on each save', () => {
    saveTelemetry();
    const first = loadTelemetry().lastCheck;

    // Small delay to ensure timestamp changes
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    recordCrash();
    saveTelemetry();
    const second = loadTelemetry().lastCheck;

    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('loadTelemetry returns defaults when file missing', () => {
    // File already cleaned by resetTelemetry in beforeEach
    const snap = loadTelemetry();
    expect(snap.crashes).toBe(0);
    expect(snap.lastCheck).toBeTruthy();
  });

  it('saveTelemetry is idempotent — repeated saves don\'t double-count', () => {
    recordCrash();
    saveTelemetry();
    saveTelemetry();
    saveTelemetry();

    const snap = loadTelemetry();
    expect(snap.crashes).toBe(1); // only one crash recorded
  });
});
