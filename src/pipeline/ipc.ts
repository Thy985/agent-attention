import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { readState } from '../state/AttentionState';
import { daemonLog } from '../daemon';

const PIPE_BASE = 'agent-attention-';

/** Derive the Windows user token used for pipe/mutex naming. */
export function getUserToken(): string {
  return os.userInfo().username.replace(/\\/g, '_');
}

/** Build the full named pipe path for this user (documented; TCP used at runtime). */
export function getPipePath(): string {
  return `\\\\.\\pipe\\${PIPE_BASE}${getUserToken()}`;
}

/** SHA-256 of file contents — used for dedup in state-changed notifications. */
function fileSha256(filePath: string): string {
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
  catch { return ''; }
}

interface PipeState {
  server: net.Server | null;
  clients: Map<string, net.Socket>;
  stopped: boolean;
}

let _state: PipeState | null = null;
let _port = 0;

/** Start the IPC server. On Windows uses Named Pipes; elsewhere uses TCP. */
export function startPipeServer(stateDir: string): void {
  _state = null;
  _port = 0;
  const statePath = path.join(stateDir, 'state.json');

  _state = { server: null, clients: new Map(), stopped: false };

  const isWindows = process.platform === 'win32';

  if (isWindows) {
    try {
      const token = getUserToken();
      const basePort = 29876;
      const port = basePort + (token.charCodeAt(0) % 100);

      const server = net.createServer((socket: net.Socket) => {
        const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
        _state!.clients.set(clientId, socket);
        daemonLog(`ipc client connected: ${clientId}`);

        socket.on('data', (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'subscribe') {
              // M5: send daemon-status:alive then full state snapshot
              try {
                const aliveMsg = JSON.stringify({
                  type: 'daemon-status',
                  payload: { status: 'alive', pid: process.pid },
                });
                socket.write(aliveMsg + '\n');
              } catch (err) {
                daemonLog(`ipc daemon-status write failed: ${err}`);
              }
              try {
                const st = readState(statePath);
                const reply = JSON.stringify({ type: 'state', state: st });
                socket.write(reply + '\n');
              } catch (err) {
                daemonLog(`ipc initial state read failed: ${err}`);
              }
            }
          } catch {}
        });

        socket.on('close', () => {
          _state!.clients.delete(clientId);
        });

        socket.on('error', () => {
          _state!.clients.delete(clientId);
        });
      });

      server.on('error', (err) => {
        daemonLog(`ipc server error: ${err.message}`);
      });

      server.listen(port, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        _port = addr.port;
        try {
          const portFile = path.join(stateDir, 'ipc-port.txt');
          fs.writeFileSync(portFile, String(addr.port));
        } catch {}
        daemonLog(`ipc listening on 127.0.0.1:${addr.port}`);
        _state!.server = server;
      });

      _state.server = server;
      return;
    } catch {}
  }

  daemonLog('ipc: no server started (non-Windows or port conflict)');
}

/**
 * Broadcast a notification to all connected IPC clients.
 *
 * Notification types (M5 contract):
 *   - "state"          : full state snapshot (pushStateToClients legacy path)
 *   - "state-changed"  : lightweight SHA-256 pointer; UI reads state.json for content
 *   - "registry-changed": agents.json changed; UI reloads agent list
 *   - "daemon-status"  : daemon lifecycle signal (alive / stopping)
 */
export function emitNotification(
  stateDir: string,
  type: 'state' | 'state-changed' | 'registry-changed' | 'daemon-status',
  payload: unknown,
): void {
  if (!_state?.server || _state.stopped || _port === 0) return;
  const msg = JSON.stringify({ type, payload });
  for (const [id, socket] of _state.clients) {
    try {
      if (!socket.destroyed && socket.writable) {
        socket.write(msg + '\n');
      }
    } catch (err) {
      daemonLog(`ipc notify send failed (${id}): ${err}`);
      _state.clients.delete(id);
    }
  }
}

/** Push full state snapshot to all connected IPC clients (legacy path). */
export function pushStateToClients(stateDir: string): void {
  if (!_state?.server || _state.stopped || _port === 0) return;
  const statePath = path.join(stateDir, 'state.json');
  try {
    const state = readState(statePath);
    const msg = JSON.stringify({ type: 'state', state });
    for (const [id, socket] of _state.clients) {
      try {
        if (!socket.destroyed && socket.writable) {
          const client = net.createConnection(_port, '127.0.0.1');
          client.once('connect', () => {
            client.write(msg + '\n');
            client.end();
          });
          client.once('error', () => {});
          client.setTimeout(500, () => { client.destroy(); });
        }
      } catch {}
    }
  } catch (err) {
    daemonLog(`ipc push failed: ${err}`);
  }
}

/**
 * Watch agents.json and emit registry-changed notifications when it changes.
 * Called by daemon.ts after startPipeServer().
 */
export function watchRegistryForNotifications(stateDir: string): void {
  if (!_state?.server || _state.stopped || _port === 0) return;
  const registryPath = path.join(stateDir, 'agents.json');
  let lastHash = '';
  try {
    lastHash = fileSha256(registryPath);
  } catch {}

  const check = (): void => {
    if (_state?.stopped) return;
    try {
      const hash = fileSha256(registryPath);
      if (hash !== lastHash && hash !== '') {
        lastHash = hash;
        emitNotification(stateDir, 'registry-changed', { file: 'agents', sha256: hash });
      }
    } catch {}
    setTimeout(check, 1000);
  };
  setTimeout(check, 500);
}

/** Stop the IPC server. */
export function stopPipeServer(): void {
  _port = 0;
  if (!_state) return;
  _state.stopped = true;
  emitNotification('', 'daemon-status', { status: 'stopping' });
  for (const [, socket] of _state.clients) {
    try { socket.destroy(); } catch {}
  }
  _state.clients.clear();
  if (_state.server) {
    _state.server.close(() => { _state!.server = null; });
    _state.server = null;
  }
  _port = 0;
}

export { _state as pipeState };
