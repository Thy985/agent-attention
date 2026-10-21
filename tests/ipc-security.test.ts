/**
 * M8 P0: IPC Security Verification
 *
 * Tests the TCP IPC channel security after adding token-based authentication.
 *
 * Security model:
 *   - daemon generates random 256-bit token on startup
 *   - token written to ipc-auth.secret (mode 0o600)
 *   - C# UI Host reads token and sends it in "hello" handshake
 *   - daemon rejects connections without valid token
 *   - 127.0.0.1 binding prevents remote network attacks
 *
 * CRITICAL FINDING: Without token auth, any local process could execute commands.
 * After fix: only processes that can read ipc-auth.secret can authenticate.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as child_process from 'child_process';

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ipc-security-'));
const DAEMON_ENV = { ...process.env, AGENT_ATTENTION_HOME: STATE_DIR, AGENT_ATTENTION_MODE: 'headless' };
const PORT_FILE = path.join(STATE_DIR, 'ipc-port.txt');
const AUTH_FILE = path.join(STATE_DIR, 'ipc-auth.secret');
const DAEMON_CLI = path.join(__dirname, '..', 'dist', 'daemon-cli.js');

jest.setTimeout(30000);

async function getDaemonPort(): Promise<number | null> {
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(PORT_FILE)) {
      const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
      const port = parseInt(raw, 10);
      if (!isNaN(port) && port > 0) return port;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

async function readAuthSecret(): Promise<string | null> {
  if (!fs.existsSync(AUTH_FILE)) return null;
  return fs.readFileSync(AUTH_FILE, 'utf8').trim();
}

let daemonChild: child_process.ChildProcess | null = null;
let daemonStderr = '';
function ensureDaemonRunning(): void {
  daemonChild = child_process.spawn(process.execPath, [DAEMON_CLI, 'daemon', 'run', '--headless'], {
    env: DAEMON_ENV, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemonChild.stderr!.on('data', data => { daemonStderr += data.toString(); });
}

/** Buffered newline framing; complete only on rejection or this command's ACK. */
async function tcpSendWithAuth(
  port: number, token: string | null, frame: { requestId: string; [key: string]: unknown }, timeoutMs = 5000,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const lines: string[] = [];
    let buffer = '', settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); client.destroy();
      if (error) reject(error); else resolve(lines);
    };
    const timer = setTimeout(() => finish(new Error(`Missing ACK/rejection; daemon exit=${daemonChild?.exitCode} ${daemonStderr}`)), timeoutMs);
    client.on('error', error => finish(error));
    client.on('end', () => finish(new Error(`Daemon closed before ACK/rejection: ${daemonStderr}`)));
    client.connect(port, '127.0.0.1', () => {
      // Server explicitly supports consecutive hello+command frames on one stream.
      client.write(JSON.stringify({ type: 'hello', token: token ?? '' }) + '\n' + JSON.stringify(frame) + '\n');
    });
    client.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        lines.push(line);
        const msg = JSON.parse(line);
        if (msg.type === 'auth-rejected' || (msg.type === 'cmd-ack' && msg.requestId === frame.requestId)) {
          finish(); return;
        }
      }
    });
  });
}

describe('IPC Security Verification (M8 P0)', () => {
  beforeAll(async () => {
    ensureDaemonRunning();
    const port = await getDaemonPort();
    if (port === null) throw new Error(`Isolated daemon did not start: ${daemonStderr}`);
    const token = await readAuthSecret();
    if (!token) throw new Error('Isolated daemon auth secret missing');
    // Readiness is an actual authenticated response, not a fixed sleep/port file.
    const lines = await tcpSendWithAuth(port, token, { type: 'cmd', requestId: 'ready', command: 'unknown-command', args: [] });
    expect(lines.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ type: 'cmd-ack', requestId: 'ready', ok: false }));
  });

  afterAll(async () => {
    if (daemonChild && daemonChild.exitCode === null && daemonChild.signalCode === null) {
      const exited = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Isolated daemon did not exit')), 5000);
        daemonChild!.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      daemonChild.kill('SIGTERM');
      await exited;
    }
    // Remove only after the isolated process has released its watches and files.
    fs.rmSync(STATE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe('IPC-001: bind 127.0.0.1 only', () => {
    it('source code binds to 127.0.0.1, not 0.0.0.0', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'ipc.ts'), 'utf8');
      expect(src).toContain("server.listen(port, '127.0.0.1'");
      expect(src).not.toContain("server.listen(port)");
      expect(src).not.toContain("server.listen(port, '0.0.0.0'");
    });

    it('source code does not expose server on all interfaces', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'ipc.ts'), 'utf8');
      const listenCalls = src.match(/server\.listen\([^)]+\)/g) || [];
      for (const call of listenCalls) expect(call).toContain('127.0.0.1');
    });
  });

  describe('IPC-002: Windows preferred range / Linux allocated port', () => {
    it('source generates port in correct range', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'ipc.ts'), 'utf8');
      expect(src).toContain('35000 + Math.floor(Math.random() * 10000)');
    });

    it('headless runtime uses a valid allocated loopback port', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    });
  });

  describe('IPC-003: ipc-port.txt format', () => {
    it('ipc-port.txt exists when daemon is running', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      expect(fs.existsSync(PORT_FILE)).toBe(true);
      const content = fs.readFileSync(PORT_FILE, 'utf8').trim();
      expect(content).toMatch(/^\d+$/);
      expect(parseInt(content, 10)).toBe(port);
    });
  });

  describe('IPC-004: token authentication (FIXED)', () => {
    it('authorized client (valid token) can send commands', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      const token = await readAuthSecret();
      if (!token) throw new Error('Isolated daemon auth secret missing');
      const lines = await tcpSendWithAuth(port, token, {
        type: 'cmd', requestId: 'p0-auth-' + Date.now(),
        command: 'jump', args: ['nonexistent-agent'],
      });
      // Auth passed if we received any response (cmd-ack with error is expected
      // since the agent doesn't exist, but the connection was authenticated)
      const hasAck = lines.some(l => { try { return JSON.parse(l).type === 'cmd-ack'; } catch { return false; } });
      expect(hasAck).toBe(true);
      if (hasAck) {
        const ack = JSON.parse(lines.find(l => JSON.parse(l).type === 'cmd-ack')!);
        expect(ack.ok).toBe(false);
        expect(ack.error).toBeTruthy();
      }
      // An explicit failed command ack proves auth; silence is not success.
    });

    it('unauthorized client (wrong token) is rejected', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      const lines = await tcpSendWithAuth(port, 'wrong-token-0000000000000000000000000000', {
        type: 'cmd', requestId: 'p0-unauth-' + Date.now(),
        command: 'jump', args: ['x'],
      });
      // Silence/connection failure is not evidence of authentication enforcement.
      expect(lines.some(l => JSON.parse(l).type === 'auth-rejected')).toBe(true);
    });

    it('unauthorized client (empty token) is rejected', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      const lines = await tcpSendWithAuth(port, '', {
        type: 'cmd', requestId: 'p0-unauth2-' + Date.now(),
        command: 'mark-all-read', args: [],
      });
      expect(lines.some(l => JSON.parse(l).type === 'auth-rejected')).toBe(true);
    });

    it('no-token connection (raw cmd without hello) is rejected', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      return new Promise<void>(resolve => {
        const client = new net.Socket();
        client.connect(port, '127.0.0.1', () => {
          client.write(JSON.stringify({ type: 'cmd', command: 'jump', args: ['x'] }) + '\n');
        });
        client.on('data', (data: Buffer) => {
          const text = data.toString();
          // Should get nothing or auth-rejected, not a cmd-ack
          expect(text.includes('cmd-ack')).toBe(false);
          client.destroy();
          resolve();
        });
        client.on('error', () => { client.destroy(); resolve(); });
        setTimeout(() => { client.destroy(); resolve(); }, 1000);
      });
    });
  });

  describe('IPC-005: daemon restart → UI reconnects with new port', () => {
    it('UI client re-reads port from ipc-port.txt on reconnect', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'center', 'csharp', 'AgentAttention.UI', 'IpcClient.cs'),
        'utf8',
      );
      expect(src).toContain('ReadPort(_stateDir)');
    });

    it('UI client reads a fresh auth secret for command and subscription connections', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'center', 'csharp', 'AgentAttention.UI', 'IpcClient.cs'),
        'utf8',
      );
      // The executable ipc-client-harness additionally verifies token rotation on real TCP.
      expect(src.match(/ReadAuthSecret\(_stateDir\)/g)?.length).toBe(2);
      expect(src).not.toContain('_token=ReadAuthSecret');
    });
  });

  describe('IPC-006: port collision handling', () => {
    it('daemon logs error on EADDRINUSE (no retry in current impl)', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'pipeline', 'ipc.ts'), 'utf8');
      expect(src).toContain("server.on('error'");
      expect(src).not.toContain('retry');
    });
  });

  describe('Attack surface: port exposure', () => {
    it('daemon port is reachable from localhost', async () => {
      const port = await getDaemonPort();
      if (port === null) throw new Error('Isolated headless daemon did not start');
      const client = new net.Socket();
      await new Promise<void>((resolve, reject) => {
        client.connect(port, '127.0.0.1', () => resolve());
        client.once('error', err => reject(err));
      });
      client.destroy();
    });


  });

  describe('Data plane: state.json unchanged', () => {
    it('state.json schema is not modified by auth changes', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'state', 'AttentionState.ts'),
        'utf8',
      );
      expect(src).toContain('unreadCount');
      expect(src).toContain('events');
    });
  });
});
