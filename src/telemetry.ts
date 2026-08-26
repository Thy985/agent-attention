/**
 * M7: Lightweight telemetry for the C# UI Host soak period.
 *
 * Collects metrics that are written to ~/.agent-attention/telemetry.json
 * after each run. This file is human-readable and machine-parseable.
 *
 * Metrics tracked:
 *   - crashes: count of unhandled exceptions in the Host process
 *   - handle_count: GUI handle count at last check (tray + center windows)
 *   - icon_state: last known tray icon state (visible/hidden, unread_count)
 *   - toast_activations: count of Toast View activations
 *   - rpc_commands: count of successful vs failed RPC command calls
 *   - ipc_connect_failures: count of IPC connection failures
 *   - restart_count: how many times the Host was restarted by daemon
 *
 * These metrics feed the M7 acceptance criterion:
 *   "一个版本周期内 P0/P1 为零，长跑 GUI 句柄稳定"
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const TELEMETRY_PATH = path.join(os.homedir(), '.agent-attention', 'telemetry.json');

interface TelemetrySnapshot {
  crashes: number;
  handleCount: number;
  iconState: string;
  toastActivations: number;
  rpcSuccess: number;
  rpcFailure: number;
  ipcConnectFailures: number;
  restartCount: number;
  lastCheck: string; // ISO timestamp
}

let _snapshot: TelemetrySnapshot = {
  crashes: 0,
  handleCount: 0,
  iconState: 'unknown',
  toastActivations: 0,
  rpcSuccess: 0,
  rpcFailure: 0,
  ipcConnectFailures: 0,
  restartCount: 0,
  lastCheck: new Date().toISOString(),
};

/** Load persisted telemetry from disk. */
export function loadTelemetry(): TelemetrySnapshot {
  try {
    const raw = fs.readFileSync(TELEMETRY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<TelemetrySnapshot>;
    return { ..._snapshot, ...parsed, lastCheck: _snapshot.lastCheck };
  } catch {
    return _snapshot;
  }
}

/** Persist current telemetry to disk. */
export function saveTelemetry(snapshot?: TelemetrySnapshot): void {
  const s = snapshot ?? _snapshot;
  s.lastCheck = new Date().toISOString();
  try {
    const tmp = TELEMETRY_PATH + `.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    try { fs.renameSync(tmp, TELEMETRY_PATH); } catch { fs.unlinkSync(tmp); }
  } catch { /* best-effort: telemetry must never crash the app */ }
}

/** Record a crash event. */
export function recordCrash(): void {
  _snapshot.crashes++;
  saveTelemetry();
}

/** Record a successful RPC command. */
export function recordRpcSuccess(): void {
  _snapshot.rpcSuccess++;
  saveTelemetry();
}

/** Record a failed RPC command. */
export function recordRpcFailure(): void {
  _snapshot.rpcFailure++;
  saveTelemetry();
}

/** Record an IPC connection failure. */
export function recordIpcConnectFailure(): void {
  _snapshot.ipcConnectFailures++;
  saveTelemetry();
}

/** Record a Toast View activation. */
export function recordToastActivation(): void {
  _snapshot.toastActivations++;
  saveTelemetry();
}

/** Record a daemon restart of the UI host. */
export function recordRestart(): void {
  _snapshot.restartCount++;
  saveTelemetry();
}

/** Update the icon state metric. */
export function recordIconState(visible: boolean, unreadCount: number): void {
  _snapshot.iconState = `${visible ? 'visible' : 'hidden'}:${unreadCount}`;
  saveTelemetry();
}

/** Set the handle count metric. */
export function recordHandleCount(count: number): void {
  _snapshot.handleCount = count;
  saveTelemetry();
}

/** Reset telemetry (for test isolation). */
export function resetTelemetry(): void {
  _snapshot = {
    crashes: 0,
    handleCount: 0,
    iconState: 'unknown',
    toastActivations: 0,
    rpcSuccess: 0,
    rpcFailure: 0,
    ipcConnectFailures: 0,
    restartCount: 0,
    lastCheck: new Date().toISOString(),
  };
  try { fs.unlinkSync(TELEMETRY_PATH); } catch {}
}
