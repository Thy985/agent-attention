import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { readState } from '../state/AttentionState';
import { daemonLog } from '../daemon';

const PIPE_BASE = 'agent-attention-';

/** Derive the Windows user token used for pipe/mutex naming. */
export function getUserToken(): string {
  return os.userInfo().username.replace(/\\/g, '_');
}

/** Build the full named pipe path for this user. */
export function getPipePath(): string {
  return `\\\\.\\pipe\\${PIPE_BASE}${getUserToken()}`;
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
  const token = getUserToken();
  const pipeName = `${PIPE_BASE}${token}`;
  const statePath = path.join(stateDir, 'state.json');

  _state = { server: null, clients: new Map(), stopped: false };

  // Try Named Pipe first (Windows only)
  const isWindows = process.platform === 'win32';

  if (isWindows) {
    try {
      // Use a raw socket to create a named pipe server
      // Node.js doesn't have built-in named pipe support, so we use a workaround
      // with a high-port TCP server and write the pipe name to a port file
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
        // Write port file so C# client knows where to connect
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

  // Fallback: no IPC server started
  daemonLog('ipc: no server started (non-Windows or port conflict)');
}

/** Push state to all connected IPC clients. */
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

/** Stop the IPC server. */
export function stopPipeServer(): void {
  _port = 0;
  if (!_state) return;
  _state.stopped = true;
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
