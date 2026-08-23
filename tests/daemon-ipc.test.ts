import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getUserToken, getPipePath, startPipeServer, pushStateToClients, stopPipeServer,
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

  it('pushStateToClients sends state to a connected client', async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, 'ipc-port.txt');
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    expect(port).toBeGreaterThan(0);

    // Start a client that connects and receives initial state
    const received: any[] = [];
    const client = require('net').createConnection(port, '127.0.0.1');
    await new Promise<void>(resolve => client.once('connect', resolve));
    client.write(JSON.stringify({ type: 'subscribe' }) + '\n');

    // Push state from daemon side
    const statePath = path.join(tmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 1, events: [
        { id: 'm3-e1', timestamp: Date.now(), type: 'completed', priority: 'P2',
          agent_id: 'codex', agent_name: 'Codex', title: 'M3 test', message: 'hello', read: false },
      ],
    }));
    pushStateToClients(tmpDir);

    // Receive the pushed state
    await new Promise<void>(resolve => {
      client.once('data', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'state') received.push(msg.state);
        resolve();
      });
    });

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].unreadCount).toBe(1);
    expect(received[0].events[0].id).toBe('m3-e1');
    client.destroy();
    stopPipeServer();
  });

  it('pushStateToClients is safe when no server started', () => {
    expect(() => pushStateToClients(tmpDir)).not.toThrow();
  });
});

