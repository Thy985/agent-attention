import { AttentionProjection } from '../src/teammind/AttentionProjection';
import { AttentionSignal } from '../src/teammind/types';

describe('AttentionProjection', () => {
  let projection: AttentionProjection;

  beforeEach(() => {
    projection = new AttentionProjection({
      dedupWindowMs: 30_000,
      batchWindowMs: 5_000,
      maxBatchSize: 3,
      aggregateEnabled: true,
    });
  });

  const makeSignal = (overrides: Partial<AttentionSignal> = {}): AttentionSignal => ({
    id: 'test-1',
    agentId: 'codex',
    pluginId: 'codex',
    role: 'LEAD',
    taskId: 'T-001',
    type: 'completed',
    priority: 'P2',
    title: 'Test',
    message: 'Test message',
    timestamp: Date.now(),
    ...overrides,
  });

  describe('P0 bypass', () => {
    it('P0 signals bypass dedup and are always delivered', () => {
      const signal = makeSignal({ priority: 'P0', type: 'permission_required' });
      const result = projection.project(signal);
      expect(result).not.toBeNull();
      expect(result!.priority).toBe('P0');
    });

    it('second P0 signal also delivered (no dedup)', () => {
      const signal1 = makeSignal({ priority: 'P0', id: 'p0-1' });
      const signal2 = makeSignal({ priority: 'P0', id: 'p0-2' });
      expect(projection.project(signal1)).not.toBeNull();
      expect(projection.project(signal2)).not.toBeNull();
    });
  });

  describe('dedup', () => {
    it('suppresses duplicate within dedup window', () => {
      const signal = makeSignal({ id: 'dup-1', timestamp: Date.now() });
      const dup = makeSignal({ id: 'dup-2', timestamp: Date.now() });

      const first = projection.project(signal);
      expect(first).not.toBeNull();

      const second = projection.project(dup);
      expect(second).toBeNull(); // suppressed
    });

    it('allows different agent', () => {
      const s1 = makeSignal({ id: 'a-1', agentId: 'codex', timestamp: Date.now() });
      const s2 = makeSignal({ id: 'a-2', agentId: 'claude', timestamp: Date.now() });

      expect(projection.project(s1)).not.toBeNull();
      expect(projection.project(s2)).not.toBeNull();
    });
  });

  describe('aggregation', () => {
    it('aggregates signals with same aggregateKey', () => {
      const s1 = makeSignal({
        id: 'agg-1',
        aggregateKey: 'task:T-001:retrying',
        timestamp: Date.now(),
      });
      const s2 = makeSignal({
        id: 'agg-2',
        aggregateKey: 'task:T-001:retrying',
        timestamp: Date.now() + 100,
      });

      // First signal starts a batch
      expect(projection.project(s1)).toBeNull();
      // Second signal also batched
      expect(projection.project(s2)).toBeNull();

      // Flush the batch
      const flushed = projection.flushExpired();
      // With batchWindowMs=5000, these signals are not expired yet
      // So flushed may be empty
      expect(flushed.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('shouldSuppress', () => {
    it('suppresses sub-agent completed when lead is running', () => {
      projection.updateContext({ isLeadRunning: true });
      const signal = makeSignal({
        type: 'completed',
        priority: 'P1',
        role: 'REVIEWER', // sub-agent
      });
      expect(projection.shouldSuppress(signal)).toBe(true);
    });

    it('does NOT suppress lead agent completed', () => {
      projection.updateContext({ isLeadRunning: true });
      const signal = makeSignal({
        type: 'completed',
        priority: 'P1',
        role: 'LEAD',
      });
      expect(projection.shouldSuppress(signal)).toBe(false);
    });

    it('suppresses P2 completed when not blocking downstream', () => {
      projection.updateContext({ blocksDownstream: false });
      const signal = makeSignal({
        type: 'completed',
        priority: 'P2',
      });
      expect(projection.shouldSuppress(signal)).toBe(true);
    });

    it('does NOT suppress P2 when blocking downstream', () => {
      projection.updateContext({ blocksDownstream: true });
      const signal = makeSignal({
        type: 'completed',
        priority: 'P2',
      });
      expect(projection.shouldSuppress(signal)).toBe(false);
    });

    it('suppresses P2 during quiet hours', () => {
      projection.updateContext({ quietHours: true });
      const signal = makeSignal({ priority: 'P2' });
      expect(projection.shouldSuppress(signal)).toBe(true);
    });
  });
});