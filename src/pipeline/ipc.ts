import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { StringDecoder } from 'string_decoder';
import { log } from '../logging';

const AUTH_SECRET_PATH = 'ipc-auth.secret';
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
  connections: Set<net.Socket>;
  stopped: boolean;
  token: string;
}

type RpcHandler = (args: string[]) => Promise<{ ok: boolean; code: number; error?: string }>;

let _state: PipeState | null = null;
let _port = 0;
const _handlers = new Map<string, RpcHandler>();

/** Register a command handler for IPC RPC (M6b). */
export function registerRpcCommand(name: string, handler: RpcHandler): void {
  _handlers.set(name, handler);
}

/** Unregister a command handler. */
export function unregisterRpcCommand(name: string): void {
  _handlers.delete(name);
}

/** Execute a command via IPC and return the ack result. */
export async function executeRpcCommand(
  stateDir: string,
  command: string,
  args: string[],
): Promise<{ ok: boolean; code: number; error?: string }> {
  if (!_state?.server || _state.stopped || _port === 0) {
    return { ok: false, code: 1, error: 'IPC not available' };
  }
  const handler = _handlers.get(command);
  if (!handler) {
    return { ok: false, code: 1, error: `Unknown command: ${command}` };
  }
  try {
    return await handler(args);
  } catch (err) {
    return { ok: false, code: 1, error: String(err) };
  }
}

/** Authenticated loopback TCP for Windows desktop or explicitly selected headless mode. */
export function startPipeServer(stateDir: string): void {
  _state = null;
  _port = 0;
  const statePath = path.join(stateDir, 'state.json');

  _state = { server: null, clients: new Map(), connections: new Set(), stopped: false, token: crypto.randomBytes(32).toString('hex') };

  const isWindows = process.platform === 'win32';

  if (isWindows || process.env.AGENT_ATTENTION_MODE === 'headless') {
    try {
      const token = getUserToken();
      const port = isWindows ? 35000 + Math.floor(Math.random() * 10000) : 0;

      const sessionState = _state;
      const server = net.createServer((socket: net.Socket) => {
        const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
        sessionState.connections.add(socket);
        socket.setTimeout(5000, () => socket.destroy());
        let authorized = false;
        let rejected = false;
        let pending = '';
        const decoder = new StringDecoder('utf8');
        const maxFrameBytes = 1024 * 1024;
        const reject = (): void => {
          rejected = true;
          sessionState.clients.delete(clientId);
          // No command, state snapshot or broadcast is allowed before authentication.
          socket.end(JSON.stringify({ type: 'auth-rejected' }) + '\n');
          socket.setTimeout(500, () => socket.destroy());
        };
        daemonLog(`ipc client connected: ${clientId}`);

        const handleFrame = (line: string): void => {
          let msg: any;
          try { msg = JSON.parse(line); }
          catch { reject(); return; }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) { reject(); return; }
          if (!authorized) {
            if (msg.type !== 'hello' || msg.token !== sessionState.token) {
              log({ component: 'ipc', level: 'ERROR', event: 'auth_failed', message: 'IPC auth rejected', context: { client: clientId } });
              reject();
              return;
            }
            authorized = true;
            socket.setTimeout(0);
            log({ component: 'ipc', level: 'INFO', event: 'auth_ok', message: 'IPC auth successful', context: { client: clientId } });
            return;
          }
          try {
            if (msg.type === 'subscribe') {
              sessionState.clients.set(clientId, socket);
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
            } else if (msg.type === 'cmd' && msg.requestId && msg.command) {
              // M6b: handle RPC command
              const handler = _handlers.get(msg.command);
              if (!handler) {
                const nack = JSON.stringify({
                  type: 'cmd-ack', requestId: msg.requestId,
                  ok: false, code: 1, error: `Unknown command: ${msg.command}`,
                });
                socket.write(nack + '\n');
                return;
              }
              if (msg.args !== undefined && (!Array.isArray(msg.args) || !msg.args.every((arg: unknown) => typeof arg === 'string'))) {
                socket.write(JSON.stringify({ type: 'cmd-ack', requestId: msg.requestId, ok: false, code: 1, error: 'args must be an array of strings' }) + '\n');
                return;
              }
              Promise.resolve().then(() => handler(msg.args ?? [])).then(result => {
                const ack = JSON.stringify({
                  type: 'cmd-ack', requestId: msg.requestId, ...result,
                });
                socket.write(ack + '\n');
              }).catch(err => {
                const nack = JSON.stringify({
                  type: 'cmd-ack', requestId: msg.requestId,
                  ok: false, code: 1, error: String(err),
                });
                socket.write(nack + '\n');
              });
            }
          } catch (err) { daemonLog(`ipc frame failed: ${err}`); }
        };

        socket.on('data', (data: Buffer) => {
          if (rejected) return;
          pending += decoder.write(data);
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) { reject(); return; }
            if (line.trim()) handleFrame(line);
            if (rejected) return;
          }
          if (Buffer.byteLength(pending, 'utf8') > maxFrameBytes) reject();
        });

        socket.on('close', () => {
          sessionState.clients.delete(clientId);
          sessionState.connections.delete(socket);
        });

        socket.on('error', () => {
          sessionState.clients.delete(clientId);
          sessionState.connections.delete(socket);
        });
      });

      server.on('error', err => { daemonLog(`ipc listen failed: ${err}`); stopPipeServer(); });
      server.listen(port, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        _port = addr.port;
        try {
          const authFile = path.join(stateDir, AUTH_SECRET_PATH);
          fs.writeFileSync(authFile, _state!.token, { mode: 0o600 });
          fs.chmodSync(authFile, 0o600);
          const portFile = path.join(stateDir, 'ipc-port.txt');
          fs.writeFileSync(portFile, String(addr.port), { mode: 0o600 });
          fs.chmodSync(portFile, 0o600);
        } catch (err) { daemonLog(`ipc discovery write failed: ${err}`); stopPipeServer(); return; }
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
          socket.write(msg + '\n');
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
  if (!_state) return;
  emitNotification('', 'daemon-status', { status: 'stopping' });
  _state.stopped = true;
  for (const socket of _state.connections) {
    try { socket.destroy(); } catch {}
  }
  _state.clients.clear();
  _state.connections.clear();
  if (_state.server) {
    _state.server.close();
    _state.server = null;
  }
  _port = 0;
}

export { _state as pipeState };
