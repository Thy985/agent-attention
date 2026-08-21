import { AttentionPipeline } from '../src/teammind/AttentionPipeline';
import { EventType, TeamMindEvent } from '../src/teammind/types';

// Mock the notification sink to avoid actual Toast/Sound calls
jest.mock('../src/teammind/NotificationSink', () => ({
  ToastSink: class {
    async deliver() {}
  },
  SoundSink: class {
    async deliver() {}
  },
  CompositeSink: class {
    async deliver() {}
  },
  createDefaultSink: () => ({
    deliver: jest.fn().mockResolvedValue(undefined),
  }),
}));

describe('AttentionPipeline', () => {
  let pipeline: AttentionPipeline;

  beforeEach(() => {
    pipeline = new AttentionPipeline();
  });

  const makeEvent = (type: EventType | string, overrides: Partial<TeamMindEvent> = {}): TeamMindEvent => ({
    type,
    timestamp: Date.now(),
    taskId: 'T-001',
    pluginId: 'codex',
    agentId: 'codex',
    role: 'LEAD',
    metadata: {},
    ...overrides,
  });

  describe('handleEvent', () => {
    it('delivers P0 permission_required event', async () => {
      const event = makeEvent(EventType.DECISION_REQUIRES_APPROVAL, {
        metadata: { question: 'Execute git push?' },
      });
      const signal = await pipeline.handleEvent(event);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P0');
      expect(signal!.type).toBe('permission_required');
    });

    it('delivers P1 task_completed event', async () => {
      const event = makeEvent(EventType.TASK_COMPLETED);
      const signal = await pipeline.handleEvent(event);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P1');
    });

    it('silently drops progress events (agent.chunk)', async () => {
      const event = makeEvent(EventType.AGENT_CHUNK, {
        metadata: { content: 'Working...' },
      });
      const signal = await pipeline.handleEvent(event);
      expect(signal).toBeNull();
    });

    it('silently drops tool.called', async () => {
      const event = makeEvent(EventType.TOOL_CALLED);
      const signal = await pipeline.handleEvent(event);
      expect(signal).toBeNull();
    });

    it('silently drops file.changed', async () => {
      const event = makeEvent(EventType.FILE_CHANGED);
      const signal = await pipeline.handleEvent(event);
      expect(signal).toBeNull();
    });
  });

  describe('handleBatch', () => {
    it('processes multiple events and returns delivered signals', async () => {
      const events = [
        makeEvent(EventType.DECISION_REQUIRES_APPROVAL, {
          metadata: { question: 'Allow?' },
        }),
        makeEvent(EventType.TASK_COMPLETED),
        makeEvent(EventType.AGENT_CHUNK), // should be dropped
      ];

      const results = await pipeline.handleBatch(events);
      expect(results.length).toBe(2); // permission + completed
    });
  });

  describe('stats', () => {
    it('tracks events received and delivered', async () => {
      // Reset stats
      const p = new AttentionPipeline();

      await p.handleEvent(makeEvent(EventType.DECISION_REQUIRES_APPROVAL, {
        metadata: { question: 'Test?' },
      }));
      await p.handleEvent(makeEvent(EventType.AGENT_CHUNK)); // dropped

      const stats = p.getStats();
      expect(stats.eventsReceived).toBe(2);
      expect(stats.signalsDelivered).toBe(1);
    });
  });

  describe('context updates', () => {
    it('updates context via setContext', () => {
      pipeline.setContext({ isLeadRunning: true, blocksDownstream: true });
      // No assertion needed — just verify it doesn't throw
    });
  });
});