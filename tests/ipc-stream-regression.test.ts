import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { startPipeServer, stopPipeServer, registerRpcCommand, unregisterRpcCommand, emitNotification, pushStateToClients, pipeState } from '../src/pipeline/ipc';

// Exercise the real TCP server on Linux too, without claiming Windows UI coverage.
jest.mock('../src/daemon', () => ({ daemonLog: jest.fn() }));

describe('IPC authenticated stream regression', () => {
  let dir: string;
  let port: number;
  let token: string;
  const sockets: net.Socket[] = [];
  const handler = jest.fn(async (_args: string[]) => ({ ok: true, code: 0 }));
  const frame = (message: unknown) => JSON.stringify(message) + '\n';

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-stream-'));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, updatedAt: 1, events: [], unreadCount: 0 }));
    handler.mockClear();
    registerRpcCommand('probe', handler);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      startPipeServer(dir);
    } finally { Object.defineProperty(process, 'platform', platform); }
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(path.join(dir, 'ipc-port.txt'))) {
      if (Date.now() > deadline) throw new Error('IPC listener did not start');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    port = Number(fs.readFileSync(path.join(dir, 'ipc-port.txt'), 'utf8'));
    token = fs.readFileSync(path.join(dir, 'ipc-auth.secret'), 'utf8');
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    stopPipeServer();
    unregisterRpcCommand('probe');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function connect() {
    const socket = net.createConnection(port, '127.0.0.1');
    sockets.push(socket);
    const messages: any[] = [];
    let pending = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line) messages.push(JSON.parse(line));
      }
    });
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    async function waitFor(predicate: (m: any) => boolean) {
      const deadline = Date.now() + 1000;
      while (!messages.some(predicate)) {
        if (Date.now() > deadline) throw new Error('Expected IPC response not received');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return messages.find(predicate);
    }
    return { socket, messages, waitFor };
  }

  it('rejects a command sent without hello and never calls its handler', async () => {
    const c = await connect();
    c.socket.write(frame({ type: 'cmd', requestId: 'unauth', command: 'probe', args: [] }));
    await c.waitFor(m => m.type === 'auth-rejected');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(handler).not.toHaveBeenCalled();
    expect(c.messages.some(m => m.type === 'cmd-ack')).toBe(false);
  });

  it('does not dispatch a command pipelined after a rejected hello', async () => {
    const c = await connect();
    c.socket.write(frame({ type: 'hello', token: 'invalid' }) +
      frame({ type: 'cmd', requestId: 'bypass', command: 'probe', args: [] }));
    await c.waitFor(m => m.type === 'auth-rejected');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(handler).not.toHaveBeenCalled();
    expect(c.messages.some(m => m.type === 'cmd-ack')).toBe(false);
  });

  it('does not leak broadcasts to a connected unauthenticated socket', async () => {
    const c = await connect();
    emitNotification(dir, 'registry-changed', { private: 'sentinel' });
    // Barrier: if a broadcast was written, it precedes this same-socket rejection.
    c.socket.write(frame({ type: 'hello', token: 'invalid' }));
    await c.waitFor(m => m.type === 'auth-rejected');
    expect(c.messages.map(m => m.type)).toEqual(['auth-rejected']);
  });

  it('accepts coalesced hello, subscribe and two commands without sleeps', async () => {
    const c = await connect();
    c.socket.write(frame({ type: 'hello', token }) + frame({ type: 'subscribe' }) +
      frame({ type: 'cmd', requestId: 'one', command: 'probe', args: ['a'] }) +
      frame({ type: 'cmd', requestId: 'two', command: 'probe', args: ['b'] }));
    await c.waitFor(m => m.requestId === 'two');
    expect(c.messages.map(m => m.type)).toEqual(['daemon-status', 'state', 'cmd-ack', 'cmd-ack']);
    expect(handler.mock.calls).toEqual([['a'], ['b']].map(args => [args]));
  });

  it('reassembles fragmented hello and UTF-8 command arguments', async () => {
    const c = await connect();
    const hello = frame({ type: 'hello', token });
    c.socket.write(hello.slice(0, 9));
    await new Promise(resolve => setTimeout(resolve, 10));
    c.socket.write(hello.slice(9));
    const command = Buffer.from(frame({ type: 'cmd', requestId: 'split', command: 'probe', args: ['中文'] }));
    const split = command.indexOf(Buffer.from('中')) + 1;
    c.socket.write(command.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 10));
    c.socket.write(command.subarray(split));
    const ack = await c.waitFor(m => m.requestId === 'split');
    expect(ack.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith(['中文']);
  });

  it('rejects oversized incomplete frames without executing commands', async () => {
    const c = await connect();
    c.socket.write('x'.repeat(1024 * 1024 + 1));
    await c.waitFor(m => m.type === 'auth-rejected');
    expect(handler).not.toHaveBeenCalled();
  });

  it('validates command args before dispatch', async () => {
    const c = await connect();
    c.socket.write(frame({ type: 'hello', token }) + frame({ type: 'cmd', requestId: 'badargs', command: 'probe', args: 'not-an-array' }));
    const ack = await c.waitFor(m => m.requestId === 'badargs');
    expect(ack.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns synchronous handler throws into a negative ack', async () => {
    registerRpcCommand('probe', () => { throw new Error('probe failure'); });
    const c = await connect();
    c.socket.write(frame({ type: 'hello', token }) + frame({ type: 'cmd', requestId: 'throws', command: 'probe', args: [] }));
    const ack = await c.waitFor(m => m.requestId === 'throws');
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain('probe failure');
  });

  it('pushes the legacy snapshot on the subscribed socket, not a new inbound connection', async () => {
    const c = await connect();
    c.socket.write(frame({ type: 'hello', token }) + frame({ type: 'subscribe' }));
    await c.waitFor(m => m.type === 'state');
    c.messages.length = 0;
    pushStateToClients(dir);
    await c.waitFor(m => m.type === 'state');
    expect(c.messages[0].state.events).toEqual([]);
    expect(pipeState?.clients.size).toBe(1);
  });
});
