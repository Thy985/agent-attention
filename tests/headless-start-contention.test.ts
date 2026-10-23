import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => Object.assign(new EventEmitter(), { exitCode: 0, unref: jest.fn() })),
}));
import { spawn } from 'child_process';
import { headlessCommand } from '../src/platform/headless-cli';

test('a zero-exit lock contender waits for the winning owner to publish readiness', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-start-contention-'));
  const previous = process.env.AGENT_ATTENTION_HOME;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  process.env.AGENT_ATTENTION_HOME = home;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  const originalRead = fs.readFileSync;
  const read = jest.spyOn(require('fs'), 'readFileSync').mockImplementation(((file: any, options: any) => {
    if (file === `/proc/${process.pid}/cmdline`) return path.resolve(__dirname, '../src/daemon.js');
    if (file === `/proc/${process.pid}/stat`) return `${process.pid} (node) S`;
    return originalRead(file, options);
  }) as any);
  const output = jest.spyOn(console, 'log').mockImplementation(() => {});
  const publish = setTimeout(() => {
    fs.writeFileSync(path.join(home, 'daemon.pid'), String(process.pid));
    fs.writeFileSync(path.join(home, 'daemon.lock'), String(process.pid));
    fs.writeFileSync(path.join(home, 'ipc-port.txt'), '12345');
  }, 100);
  try {
    await expect(headlessCommand('start')).resolves.toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ running: true, pid: process.pid, mode: 'headless' });
  } finally {
    clearTimeout(publish); read.mockRestore(); output.mockRestore();
    Object.defineProperty(process, 'platform', platform);
    if (previous === undefined) delete process.env.AGENT_ATTENTION_HOME; else process.env.AGENT_ATTENTION_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
