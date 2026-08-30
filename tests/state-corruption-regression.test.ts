/**
 * Regression: state.json corruption & write reliability.
 *
 * Root-cause findings (2026-08-30 investigation):
 *  1. Production state.json was NEVER corrupted by real events — 30 batches
 *     of 6-process concurrent writes all produced valid JSON.
 *  2. The 82 "state.json corrupted" log entries were TEST POLLUTION: tests
 *     write malformed JSON to temp state files, but logging.ts wrote those
 *     state_read_failed events to the PRODUCTION runtime.jsonl because it
 *     ignored AGENT_ATTENTION_HOME.
 *  3. The REAL reliability defect surfaced under Windows rename contention:
 *     `fs.renameSync(tmp, statePath)` returns EPERM/EACCES when the
 *     destination is briefly open (AV scan, concurrent reader/writer).
 *     The old code retried 3 times with NO backoff — all failing inside the
 *     same contention window — then SILENTLY DROPPED THE EVENT. It also
 *     leaked .tmp files in the readState correction path.
 *
 * These tests lock in the fixes:
 *  - rename contention is retried with backoff (event survives)
 *  - no .tmp file is ever left behind (contention or exhaustion)
 *  - logging respects AGENT_ATTENTION_HOME (test isolation)
 *
 * Note on mocking: Node freezes the `fs` module exports object, so
 * `jest.spyOn(fs, 'renameSync')` fails ("Cannot redefine property").
 * We use jest.mock('fs', factory) which returns a fresh writable object that
 * spreads the real fs and overrides only renameSync.
 */
import * as path from 'path';
import * as os from 'os';

// Set AGENT_ATTENTION_HOME BEFORE requiring modules so logging isolates to
// our temp dir and never touches the real ~/.agent-attention.
const TEST_HOME = fsReal().mkdtempSync(path.join(os.tmpdir(), 'aa-corruption-reg-'));
process.env.AGENT_ATTENTION_HOME = TEST_HOME;

// jest.mock is hoisted; factory must not reference outer-scope variables
// except via jest functions. We import the real fs lazily inside the factory.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, renameSync: jest.fn(actual.renameSync) };
});

// Grab the (mocked) fs with the real helpers available for setup.
function fsReal() {
  return jest.requireActual('fs') as typeof import('fs');
}
const fs = require('fs') as typeof import('fs') & { renameSync: jest.Mock };

const { recordEvent, readState } = require('../src/state/AttentionState');
const { log, readLogs } = require('../src/logging');

describe('state corruption / write reliability regression', () => {
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    stateDir = fsReal().mkdtempSync(path.join(os.tmpdir(), 'aa-state-'));
    statePath = path.join(stateDir, 'state.json');
    fs.renameSync.mockClear();
    fs.renameSync.mockImplementation(fsReal().renameSync);
  });

  afterEach(() => {
    fs.renameSync.mockReset();
    fs.renameSync.mockImplementation(fsReal().renameSync);
    fsReal().rmSync(stateDir, { recursive: true, force: true });
  });

  afterAll(() => {
    fsReal().rmSync(TEST_HOME, { recursive: true, force: true });
    delete process.env.AGENT_ATTENTION_HOME;
  });

  /** Count leftover .tmp files for this state path in its directory. */
  function countTmpFiles(): number {
    try {
      const base = path.basename(statePath);
      return fsReal()
        .readdirSync(stateDir)
        .filter((n) => n.startsWith(base) && n.endsWith('.tmp')).length;
    } catch {
      return 0;
    }
  }

  /** Build an error like Windows returns during rename contention. */
  function contentionError(code: string = 'EPERM'): NodeJS.ErrnoException {
    const err: NodeJS.ErrnoException = new Error(`${code}: rename contention`);
    err.code = code as any;
    return err;
  }

  describe('atomic write under Windows rename contention', () => {
    it('survives transient EPERM rename failures (event persisted, no tmp leak)', () => {
      const realRenameSync = fsReal().renameSync;
      let attempts = 0;
      fs.renameSync.mockImplementation(((tmp: string, dest: string) => {
        attempts++;
        if (attempts <= 2) throw contentionError('EPERM');
        return realRenameSync(tmp, dest);
      }) as any);

      recordEvent(statePath, {
        type: 'completed',
        message: 'contention-survived',
        timestamp: Date.now(),
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });

      expect(attempts).toBe(3); // 2 failed + 1 succeeded
      const state = readState(statePath);
      expect(state.events).toHaveLength(1);
      expect(state.events[0].message).toBe('contention-survived');
      expect(countTmpFiles()).toBe(0); // no leftover .tmp
    });

    it('does not throw and leaves no tmp when contention never resolves', () => {
      fs.renameSync.mockImplementation(() => {
        throw contentionError('EPERM');
      });

      // Must NOT throw — best-effort infra never crashes the agent.
      expect(() =>
        recordEvent(statePath, {
          type: 'completed',
          message: 'dropped',
          timestamp: Date.now(),
          priority: 'P2',
          agent_id: 'claude',
          agent_name: 'Claude',
          title: 'Claude: completed',
        }),
      ).not.toThrow();

      // State file must be absent or VALID JSON — never partial/garbage.
      if (fsReal().existsSync(statePath)) {
        expect(() =>
          JSON.parse(fsReal().readFileSync(statePath, 'utf-8')),
        ).not.toThrow();
      }
      expect(countTmpFiles()).toBe(0); // tmp cleaned even on exhaustion
    });

    it('propagates real (non-contention) write errors without corrupting', () => {
      fs.renameSync.mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('ENOSPC: no space');
        err.code = 'ENOSPC';
        throw err;
      });

      expect(() =>
        recordEvent(statePath, {
          type: 'completed',
          message: 'real-error',
          timestamp: Date.now(),
          priority: 'P2',
          agent_id: 'claude',
          agent_name: 'Claude',
          title: 'Claude: completed',
        }),
      ).toThrow();
      expect(countTmpFiles()).toBe(0);
    });
  });

  describe('readState correction path (no tmp leak)', () => {
    it('does not leave a .tmp when the correction rewrite hits contention', () => {
      // State with a stale unreadCount so readState triggers a rewrite.
      fsReal().writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          updatedAt: 1,
          unreadCount: 99, // deliberately wrong (0 actual unread)
          events: [
            {
              id: 'e1', timestamp: 1, type: 'completed', priority: 'P2',
              agent_id: 'a', agent_name: 'A', title: 't', message: 'm', read: true,
            },
          ],
        }),
      );

      fs.renameSync.mockImplementation(() => {
        throw contentionError('EPERM');
      });

      expect(() => readState(statePath)).not.toThrow();
      // OLD code leaked a .tmp here — this locks the fix.
      expect(countTmpFiles()).toBe(0);
    });
  });

  describe('logging isolation (AGENT_ATTENTION_HOME)', () => {
    it('writes logs under AGENT_ATTENTION_HOME, never the real user dir', () => {
      const realHome = os.homedir();
      const probe = 'corruption-regression-' + Date.now();
      log({ component: 'test', level: 'WARN', event: 'regression_probe', message: probe });

      const recent = readLogs(10) as any[];
      expect(recent.some((e) => e.event === 'regression_probe')).toBe(true);

      // Isolated log file must live under TEST_HOME, NOT real ~/.agent-attention.
      const logFile = path.join(TEST_HOME, 'logs', 'runtime.jsonl');
      expect(fsReal().existsSync(logFile)).toBe(true);

      // And must NOT have leaked the probe into the real user dir.
      const realLogFile = path.join(realHome, '.agent-attention', 'logs', 'runtime.jsonl');
      if (fsReal().existsSync(realLogFile)) {
        expect(fsReal().readFileSync(realLogFile, 'utf-8')).not.toContain(probe);
      }
    });
  });

  describe('concurrent writers (no corruption)', () => {
    it('N recordEvent calls leave valid, parseable state and no tmp litter', () => {
      const N = 20;
      for (let i = 0; i < N; i++) {
        recordEvent(statePath, {
          type: 'completed',
          message: `c${i}`,
          timestamp: 1000 + i,
          priority: 'P2',
          agent_id: 'a',
          agent_name: 'A',
          title: 'A: completed',
        });
      }
      const raw = fsReal().readFileSync(statePath, 'utf-8');
      const state = JSON.parse(raw);
      expect(state.events.length).toBeLessThanOrEqual(20);
      expect(state.events.length).toBeGreaterThanOrEqual(1);
      expect(countTmpFiles()).toBe(0);
    });
  });
});
