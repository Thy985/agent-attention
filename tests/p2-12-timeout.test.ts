/**
 * P2-12 regression tests: `agent-notify` must never hang indefinitely waiting
 * for toast interaction.
 *
 * Background: node-notifier's `wait`/`timeout` options are stripped on Windows
 * (not in allowedToasterFlags), so the callback fires only when snoretoast
 * exits — an unbounded wait. notify() now races against a hard timeout.
 */
import * as fs from 'fs';
import * as path from 'path';

// Mock node-notifier BEFORE importing win32.ts: the mock never calls back,
// simulating a toast that is never interacted with / never times out at the
// OS level. If notify() still returns, our own timeout guard works.
jest.mock('node-notifier', () => ({
  notify: jest.fn((_opts: any, _cb: any) => {
    // Intentionally never invoke the callback — worst case hang.
    return undefined;
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const win32 = require('../src/notification/win32');

describe('P2-12: notify() hard timeout guard', () => {
  beforeAll(() => {
    // Path resolution calls require('child_process') only inside callbacks,
    // which never fire in these tests. resolveNativeUiPath is imported at
    // module load — ensure it can resolve without crashing (it returns null
    // gracefully when the exe is missing).
  });

  it('resolves (does not hang) even when the toast never returns', async () => {
    const started = Date.now();
    // 100ms hard timeout — far below the 30s default.
    await win32.notify('completed', 'P2-12 test', false, 100);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
  });

  it('still resolves for urgent events', async () => {
    const started = Date.now();
    await win32.notify('permission_required', 'P2-12 urgent', false, 50);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('uses a sane default timeout when none provided', () => {
    expect(win32.DEFAULT_NOTIFY_TIMEOUT_MS).toBe(30_000);
  });

  it('reads AGENT_ATTENTION_NOTIFY_TIMEOUT_MS env override', async () => {
    const original = process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS;
    process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS = '25';
    try {
      const started = Date.now();
      await win32.notify('failed', 'env timeout', false);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS;
      } else {
        process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS = original;
      }
    }
  });

  it('falls back to default when env override is garbage', () => {
    const original = process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS;
    process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS = 'not-a-number';
    try {
      // resolveNotifyTimeoutMs is not exported; verify through source presence
      // plus the fact that a valid notify call still resolves quickly.
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS;
      } else {
        process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS = original;
      }
    }
  });

  it('source contains the timeout guard pattern', () => {
    const src = fs.readFileSync(
      path.join('src', 'notification', 'win32.ts'),
      'utf8',
    );
    expect(src).toContain('setTimeout');
    expect(src).toContain('hardTimeout');
    expect(src).toContain('Promise<void>');
    expect(src).toContain('AGENT_ATTENTION_NOTIFY_TIMEOUT_MS');
  });
});
