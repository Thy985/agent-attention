import { spawnSync } from 'child_process';
jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
// Override only for an ORIGINAL-source reproduction, never for the shipped tests.
const { jumpToTarget } = require(process.env.AA_JUMP_MODULE || '../src/jump');
const spawn = spawnSync as unknown as jest.Mock;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const good = { ok: true, reason: 'focused', pid: 123, hwnd: '456', foregroundAfter: '456', setForegroundReturned: true };
const result = (value: any, status = 0) => ({ stdout: JSON.stringify(value), stderr: '', status, signal: null });
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  spawn.mockReset();
});
afterEach(() => Object.defineProperty(process, 'platform', originalPlatform));
it('rejects a missing target explicitly', () => expect(jumpToTarget(null)).toEqual({ ok: false, reason: 'no-target' }));
it.each([0, -1, 1.5, NaN, Infinity, 4294967296])('rejects invalid PID %s without running PowerShell', (pid) => {
  expect(jumpToTarget({ type: 'terminal', pid })).toEqual({ ok: false, reason: 'invalid-pid' });
  expect(spawn).not.toHaveBeenCalled();
});
it('rejects non-Windows platforms without spawning', () => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  expect(jumpToTarget({ type: 'terminal', pid: 123 }).reason).toBe('unsupported-platform');
  expect(spawn).not.toHaveBeenCalled();
});
it('does not equate a zero subprocess exit with successful foreground activation', () => {
  spawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  expect(jumpToTarget({ type: 'terminal', pid: 123 })).toMatchObject({ ok: false, reason: 'invalid-response' });
});
it('returns Windows foreground denial instead of success', () => {
  spawn.mockReturnValue(result({ ...good, ok: false, reason: 'foreground-denied-or-changed', foregroundAfter: '789' }, 1));
  expect(jumpToTarget({ type: 'terminal', pid: 123 })).toMatchObject({ ok: false, reason: 'foreground-denied-or-changed' });
});
it('accepts success only when the measured foreground matches a nonzero target HWND', () => {
  spawn.mockReturnValue(result(good));
  expect(jumpToTarget({ type: 'terminal', pid: 123 })).toEqual(good);
});
it.each([
  { ...good, foregroundAfter: '789' }, { ...good, hwnd: '0', foregroundAfter: '0' },
  { ...good, hwnd: undefined, foregroundAfter: undefined },
])('rejects a success claim without matching window evidence', (value) => {
  spawn.mockReturnValue(result(value));
  expect(jumpToTarget({ type: 'terminal', pid: 123 }).ok).toBe(false);
});
it('rejects a success result from a failed process', () => {
  spawn.mockReturnValue(result(good, 1));
  expect(jumpToTarget({ type: 'terminal', pid: 123 }).ok).toBe(false);
});
it('rejects a result for another process', () => {
  spawn.mockReturnValue(result({ ...good, pid: 999 }));
  expect(jumpToTarget({ type: 'terminal', pid: 123 }).reason).toBe('invalid-response');
});
it.each([{ error: new Error('timeout') }, { signal: 'SIGTERM' }])('fails on spawn/timeout/signal errors', (value) => {
  spawn.mockReturnValue(value);
  expect(jumpToTarget({ type: 'terminal', pid: 123 }).ok).toBe(false);
});
it('preserves here-string newlines and avoids synthetic input or focus policy bypasses', () => {
  spawn.mockReturnValue(result(good));
  jumpToTarget({ type: 'terminal', pid: 123 });
  const [exe, args, options] = spawn.mock.calls[0];
  expect(exe).toBe('powershell');
  expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(args[3], 'base64').toString('utf16le');
  expect(script).toContain('@"\nusing System;');
  expect(script).toContain('\n"@\n');
  expect(script).toContain('GetForegroundWindow');
  expect(script).not.toMatch(/SendKeys|AttachThreadInput|SPI_SETFOREGROUNDLOCKTIMEOUT/);
  expect(options.stdio).not.toBe('ignore');
});
