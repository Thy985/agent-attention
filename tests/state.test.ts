import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readState,
  recordEvent,
  clearUnread,
  clearAll,
  markRead,
  getEventsByAgent,
  countUnreadByAgent,
  markAgentEventsRead,
  RecordEventInput,
  State,
} from '../src/state/AttentionState';

describe('AttentionState', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-state-'));
    statePath = path.join(tmpDir, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readState', () => {
    it('returns default state when file is missing', () => {
      const state = readState(statePath);
      expect(state).toEqual({
        version: 1,
        updatedAt: expect.any(Number),
        unreadCount: 0,
        events: [],
        visible: false,
      });
    });

    // P1-7 regression: readState must NOT rewrite the file when nothing
    // changed — otherwise chokidar in daemon sees a 'change' event after
    // every readState call → infinite write loop.
    it('does not rewrite state.json when file is already consistent', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'first',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      // State file is consistent now. Capture its mtime.
      const mtimeBefore = fs.statSync(statePath).mtimeMs;

      // Read again — must be a no-op write.
      // Wait > 2ms so filesystem mtime resolution can detect a write.
      const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
      return wait(5).then(() => {
        readState(statePath);
        const mtimeAfter = fs.statSync(statePath).mtimeMs;
        expect(mtimeAfter).toBe(mtimeBefore);
      });
    });
  });

  describe('recordEvent', () => {
    it('writes a new event to empty state', () => {
      const input: RecordEventInput = {
        type: 'completed',
        message: 'task done',
        timestamp: 1724070000000,
        priority: 'P2',
        agent_id: 'codex',
        agent_name: 'Codex Agent',
        title: 'Codex Agent: completed',
      };
      const state = recordEvent(statePath, input);
      expect(state.events).toHaveLength(1);
      expect(state.events[0]).toMatchObject({
        type: 'completed',
        message: 'task done',
        timestamp: 1724070000000,
        priority: 'P2',
        agent_id: 'codex',
        agent_name: 'Codex Agent',
        title: 'Codex Agent: completed',
        read: false,
      });
      expect(state.events[0].id).toMatch(/^evt-1724070000000-[a-z0-9]{6}$/);
      expect(state.unreadCount).toBe(1);
    });

    it('persists state to disk', () => {
      recordEvent(statePath, {
        type: 'failed',
        message: 'build broken',
        timestamp: 1724070001000,
        priority: 'P1',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: failed',
      });
      const reloaded = readState(statePath);
      expect(reloaded.events).toHaveLength(1);
      expect(reloaded.events[0].message).toBe('build broken');
    });

    it('prepends new event (newest first)', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'first',
        timestamp: 100,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      recordEvent(statePath, {
        type: 'failed',
        message: 'second',
        timestamp: 200,
        priority: 'P1',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: failed',
      });
      const state = readState(statePath);
      expect(state.events[0].message).toBe('second');
      expect(state.events[1].message).toBe('first');
    });

    it('truncates to last 20 events', () => {
      for (let i = 0; i < 25; i++) {
        recordEvent(statePath, {
          type: 'completed',
          message: `msg ${i}`,
          timestamp: 1000 + i,
          priority: 'P2',
          agent_id: 'a',
          agent_name: 'A',
          title: 'A: completed',
        });
      }
      const state = readState(statePath);
      expect(state.events).toHaveLength(20);
      expect(state.events[0].message).toBe('msg 24');
      expect(state.events[19].message).toBe('msg 5');
    });

    it('increments unreadCount on each call', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'a',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      expect(readState(statePath).unreadCount).toBe(1);
      recordEvent(statePath, {
        type: 'failed',
        message: 'b',
        timestamp: 2,
        priority: 'P1',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: failed',
      });
      expect(readState(statePath).unreadCount).toBe(2);
    });
  });

  describe('atomic writes and concurrency', () => {
    it('writes to .tmp then renames (no partial file visible)', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'x',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      expect(fs.existsSync(`${statePath}.tmp`)).toBe(false);
      expect(fs.existsSync(statePath)).toBe(true);
    });

    it('does not corrupt state when read concurrently during write', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'baseline',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      const promises: Promise<State>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(
          Promise.resolve(
            recordEvent(statePath, {
              type: 'completed',
              message: `concurrent ${i}`,
              timestamp: 100 + i,
              priority: 'P2',
              agent_id: 'a',
              agent_name: 'A',
              title: 'A: completed',
            }),
          ),
        );
      }
      const reads: State[] = [];
      for (let i = 0; i < 5; i++) {
        reads.push(readState(statePath));
      }
      const finalState = readState(statePath);
      expect(finalState.events.length).toBeGreaterThanOrEqual(11);
      expect(finalState.events[0]).toBeDefined();
    });
  });

  describe('corrupted JSON', () => {
    it('returns default state when file is malformed JSON', () => {
      fs.writeFileSync(statePath, 'not valid json {{{', 'utf-8');
      const state = readState(statePath);
      expect(state.events).toEqual([]);
      expect(state.unreadCount).toBe(0);
    });

    it('recovers — next recordEvent overwrites corrupted file', () => {
      fs.writeFileSync(statePath, 'garbage', 'utf-8');
      recordEvent(statePath, {
        type: 'completed',
        message: 'recovery',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      const state = readState(statePath);
      expect(state.events).toHaveLength(1);
      expect(state.events[0].message).toBe('recovery');
    });
  });

  describe('clearUnread', () => {
    it('resets unreadCount to 0 but keeps events', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'x',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      recordEvent(statePath, {
        type: 'failed',
        message: 'y',
        timestamp: 2,
        priority: 'P1',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: failed',
      });
      const cleared = clearUnread(statePath);
      expect(cleared.unreadCount).toBe(0);
      expect(cleared.events).toHaveLength(2);
      const reloaded = readState(statePath);
      expect(reloaded.unreadCount).toBe(0);
      expect(reloaded.events).toHaveLength(2);
    });
  });

  describe('clearAll', () => {
    it('resets events and unreadCount', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'x',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      const cleared = clearAll(statePath);
      expect(cleared.events).toEqual([]);
      expect(cleared.unreadCount).toBe(0);
      const reloaded = readState(statePath);
      expect(reloaded.events).toEqual([]);
      expect(reloaded.unreadCount).toBe(0);
    });
  });

  describe('markRead', () => {
    it('marks an event as read and decrements unreadCount', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'test',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      const state = readState(statePath);
      expect(state.unreadCount).toBe(1);
      expect(state.events[0].read).toBe(false);

      const marked = require('../src/state/AttentionState').markRead(statePath, state.events[0].id);
      expect(marked.unreadCount).toBe(0);
      expect(marked.events[0].read).toBe(true);

      const reloaded = readState(statePath);
      expect(reloaded.unreadCount).toBe(0);
      expect(reloaded.events[0].read).toBe(true);
    });

    // B8 regression: calling markRead on an already-read event must be a no-op.
    it('is idempotent — calling markRead on an already-read event does not decrement unreadCount', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'test',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      const state = readState(statePath);
      expect(state.unreadCount).toBe(1);

      // Mark once — succeeds.
      const first = require('../src/state/AttentionState').markRead(statePath, state.events[0].id);
      expect(first.unreadCount).toBe(0);
      expect(first.events[0].read).toBe(true);

      // Mark again — must be a no-op; unreadCount stays at 0, not -1.
      const second = require('../src/state/AttentionState').markRead(statePath, state.events[0].id);
      expect(second.unreadCount).toBe(0);
      expect(second.events[0].read).toBe(true);

      const reloaded = readState(statePath);
      expect(reloaded.unreadCount).toBe(0);
    });

    it('returns current state unchanged when eventId does not exist', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'test',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'a',
        agent_name: 'A',
        title: 'A: completed',
      });
      const state = readState(statePath);
      expect(state.unreadCount).toBe(1);

      const marked = require('../src/state/AttentionState').markRead(statePath, 'nonexistent-id');
      expect(marked.unreadCount).toBe(1); // unchanged
    });
  });

  describe('getEventsByAgent', () => {
    beforeEach(() => {
      // Clear state before each test
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        updatedAt: 0,
        unreadCount: 0,
        events: [],
      }));
    });

    it('returns only events for the specified agent', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'a done',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      recordEvent(statePath, {
        type: 'failed',
        message: 'codex broke',
        timestamp: 2,
        priority: 'P1',
        agent_id: 'codex',
        agent_name: 'Codex',
        title: 'Codex: failed',
      });
      recordEvent(statePath, {
        type: 'completed',
        message: 'claude again',
        timestamp: 3,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });

      const claudeEvents = getEventsByAgent(statePath, 'claude');
      expect(claudeEvents).toHaveLength(2);
      expect(claudeEvents.every(e => e.agent_id === 'claude')).toBe(true);
      expect(claudeEvents.map(e => e.message)).toEqual(['claude again', 'a done']);
    });

    it('returns empty array when agent has no events', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'other',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'other',
        agent_name: 'Other',
        title: 'Other: completed',
      });
      const events = getEventsByAgent(statePath, 'nonexistent');
      expect(events).toEqual([]);
    });
  });

  describe('countUnreadByAgent', () => {
    beforeEach(() => {
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        updatedAt: 0,
        unreadCount: 0,
        events: [],
      }));
    });

    it('counts only unread events for the agent', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'unread',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      recordEvent(statePath, {
        type: 'completed',
        message: 'also unread',
        timestamp: 2,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      recordEvent(statePath, {
        type: 'completed',
        message: 'codex unread',
        timestamp: 3,
        priority: 'P2',
        agent_id: 'codex',
        agent_name: 'Codex',
        title: 'Codex: completed',
      });

      expect(countUnreadByAgent(statePath, 'claude')).toBe(2);
      expect(countUnreadByAgent(statePath, 'codex')).toBe(1);
      expect(countUnreadByAgent(statePath, 'nonexistent')).toBe(0);
    });

    it('excludes already-read events', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'unread',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      const state = readState(statePath);
      markRead(statePath, state.events[0].id);

      expect(countUnreadByAgent(statePath, 'claude')).toBe(0);
    });
  });

  describe('markAgentEventsRead', () => {
    beforeEach(() => {
      fs.writeFileSync(statePath, JSON.stringify({
        version: 1,
        updatedAt: 0,
        unreadCount: 0,
        events: [],
      }));
    });

    it('marks all events for an agent as read and decrements unreadCount', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'a',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      recordEvent(statePath, {
        type: 'completed',
        message: 'b',
        timestamp: 2,
        priority: 'P2',
        agent_id: 'codex',
        agent_name: 'Codex',
        title: 'Codex: completed',
      });
      recordEvent(statePath, {
        type: 'completed',
        message: 'c',
        timestamp: 3,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });

      const result = markAgentEventsRead(statePath, 'claude');
      expect(result.unreadCount).toBe(1); // only codex remains unread

      const reloaded = readState(statePath);
      const claudeEvents = reloaded.events.filter(e => e.agent_id === 'claude');
      expect(claudeEvents.every(e => e.read)).toBe(true);
      const codexEvents = reloaded.events.filter(e => e.agent_id === 'codex');
      expect(codexEvents.every(e => !e.read)).toBe(true);
    });

    it('does not affect other agents events', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'a',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      recordEvent(statePath, {
        type: 'completed',
        message: 'b',
        timestamp: 2,
        priority: 'P2',
        agent_id: 'codex',
        agent_name: 'Codex',
        title: 'Codex: completed',
      });

      markAgentEventsRead(statePath, 'claude');
      const reloaded = readState(statePath);
      const codexEvent = reloaded.events.find(e => e.agent_id === 'codex');
      expect(codexEvent!.read).toBe(false);
      expect(reloaded.unreadCount).toBe(1);
    });

    it('returns updated state even when agent has no events', () => {
      const result = markAgentEventsRead(statePath, 'nonexistent');
      expect(result.unreadCount).toBe(0);
      expect(result.events).toEqual([]);
    });

    // P2-2 regression: markAgentEventsRead must set `visible: false` when
    // ALL unread events are consumed — not when the events array still
    // has elements (events are kept on disk; only unread controls visibility).
    it('hides tray icon (visible=false) when all unread events become read', () => {
      recordEvent(statePath, {
        type: 'completed',
        message: 'x',
        timestamp: 1,
        priority: 'P2',
        agent_id: 'claude',
        agent_name: 'Claude',
        title: 'Claude: completed',
      });
      let s = readState(statePath);
      expect(s.unreadCount).toBe(1);
      expect(s.visible).toBe(true);

      const result = markAgentEventsRead(statePath, 'claude');
      expect(result.unreadCount).toBe(0);
      expect(result.visible).toBe(false); // ← was `events.length > 0` → always true

      s = readState(statePath);
      expect(s.visible).toBe(false);
    });
  });
});
