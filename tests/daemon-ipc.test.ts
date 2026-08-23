import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getUserToken, getPipePath, startPipeServer, pushStateToClients, stopPipeServer, emitNotification,
} from '../src/pipeline/ipc';

describe('ipc (pipeline)', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-m3-'));
  });

  afterEach(() => {
    stopPipeServer();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('getUserToken returns sanitized username', () => {
    const token = getUserToken();
    expect(token).toBeTruthy();
    expect(token).not.toContain('\\');
  });

  it('getPipePath produces valid pipe name', () => {
    const pipePath = getPipePath();
    expect(pipePath).toMatch(/^\\\\\.\\pipe\\agent-attention-/);
  });

  it('startPipeServer creates port file and can be stopped', async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, 'ipc-port.txt');
    expect(fs.existsSync(portFile)).toBe(true);
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    expect(port).toBeGreaterThan(0);
    stopPipeServer();
  });

  it('emitNotification sends state-changed to a connected client', async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, 'ipc-port.txt');
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    expect(port).toBeGreaterThan(0);

    const client = require('net').createConnection(port, '127.0.0.1');
    await new Promise<void>(resolve => client.once('connect', resolve));
    client.write(JSON.stringify({ type: 'subscribe' }) + '\n');

    // Drain the subscribe response (daemon-status + state)
    await new Promise<void>(resolve => {
      let buf = '';
      let gotTwo = 0;
      const handler = (data: Buffer) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) gotTwo++;
          if (gotTwo >= 2) {
            client.removeListener('data', handler);
            resolve();
            return;
          }
        }
      };
      client.on('data', handler);
      setTimeout(() => { client.removeListener('data', handler); resolve(); }, 2000);
    });

    // Now emit a notification directly to the subscribed client
    emitNotification(tmpDir, 'state-changed', { file: 'state', sha256: 'abc123' });

    const received = await new Promise<any>((resolve) => {
      let buf = '';
      const handler = (data: Buffer) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'state-changed') {
              client.removeListener('data', handler);
              resolve(msg.payload);
              return;
            }
          } catch {}
        }
      };
      client.on('data', handler);
      setTimeout(() => { client.removeListener('data', handler); resolve(null); }, 2000);
    });

    expect(received).not.toBeNull();
    expect(received.sha256).toBe('abc123');
    client.destroy();
    stopPipeServer();
  });

  it('emitNotification is safe when no server started', () => {
    expect(() => emitNotification(tmpDir, 'state-changed', {})).not.toThrow();
    expect(() => pushStateToClients(tmpDir)).not.toThrow();
  });
});
