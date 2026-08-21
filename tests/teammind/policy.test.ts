import { AttentionPolicy, DEFAULT_ATTENTION_RULES } from '../../src/teammind/AttentionPolicy';
import { mapTeamMindEvent } from '../../src/teammind/EventAdapter';
import { EventType, TeamMindEvent } from '../../src/teammind/types';

describe('AttentionPolicy', () => {
  const baseEvent = (type: EventType | string, overrides: Partial<TeamMindEvent> = {}): TeamMindEvent => ({
    type,
    timestamp: Date.now(),
    taskId: 'T-001',
    pluginId: 'codex',
    agentId: 'codex',
    role: 'LEAD',
    metadata: {},
    ...overrides,
  });

  let policy: AttentionPolicy;

  beforeEach(() => {
    policy = new AttentionPolicy();
  });

  describe('default rules', () => {
    it('has 13 default rules', () => {
      expect(DEFAULT_ATTENTION_RULES.length).toBeGreaterThanOrEqual(13);
    });

    it('includes P0 rules for permission, plugin down, critical error', () => {
      const p0Rules = DEFAULT_ATTENTION_RULES.filter(r => r.priority === 'P0' as any);
      expect(p0Rules.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('evaluate 鈥?P0 events', () => {
    it('returns signal for permission_required', () => {
      const event = baseEvent(EventType.DECISION_REQUIRES_APPROVAL, {
        metadata: { question: 'Execute git push?' },
      });
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P0');
      expect(signal!.type).toBe('permission_required');
    });

    it('returns signal for plugin_down', () => {
      const event = baseEvent(EventType.PLUGIN_DOWN);
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P0');
    });

    it('returns signal for critical error', () => {
      const event = baseEvent(EventType.ERROR_CRITICAL, {
        metadata: { message: 'OOM' },
      });
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P0');
    });
  });

  describe('evaluate 鈥?P1 events', () => {
    it('returns signal for task_completed', () => {
      const event = baseEvent(EventType.TASK_COMPLETED);
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P1');
    });

    it('returns signal for agent_completed', () => {
      const event = baseEvent(EventType.AGENT_COMPLETED);
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped);
      expect(signal).not.toBeNull();
      expect(signal!.priority).toBe('P1');
    });
  });

  describe('evaluate 鈥?silent events', () => {
    it('returns null for agent.chunk (progress event)', () => {
      const event = baseEvent(EventType.AGENT_CHUNK);
      const mapped = mapTeamMindEvent(event);
      expect(mapped).toBeNull();
      const signal = policy.evaluate(event, mapped);
      expect(signal).toBeNull();
    });

    it('returns null for tool.called', () => {
      const event = baseEvent(EventType.TOOL_CALLED);
      const mapped = mapTeamMindEvent(event);
      expect(mapped).toBeNull();
    });
  });

  describe('template interpolation', () => {
    it('interpolates pluginName in template', () => {
      const event = baseEvent(EventType.DECISION_REQUIRES_APPROVAL, {
        pluginId: 'claude-code',
        agentId: 'claude-code',
        metadata: { question: 'Allow?' },
      });
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped)!;
      expect(signal.title).toContain('claude-code');
    });

    it('interpolates taskId in aggregateKey', () => {
      const event = baseEvent(EventType.TASK_RETRYING, {
        taskId: 'T-42',
        metadata: { attemptNumber: 2, maxAttempts: 3 },
      });
      const mapped = mapTeamMindEvent(event)!;
      const signal = policy.evaluate(event, mapped)!;
      expect(signal.aggregateKey).toContain('T-42');
    });
  });

  describe('rule ordering', () => {
    it('P0 rules are evaluated before P1 rules', () => {
      const rules = DEFAULT_ATTENTION_RULES;
      let lastP0Index = -1;
      let firstP1Index = -1;
      let lastP1Index = -1;
      let firstP2Index = -1;

      for (let i = 0; i < rules.length; i++) {
        if (rules[i].priority === 'P0' && lastP0Index === -1) lastP0Index = i;
        if (rules[i].priority === 'P0') lastP0Index = Math.max(lastP0Index, i);
        if (rules[i].priority === 'P1' && firstP1Index === -1) firstP1Index = i;
        if (rules[i].priority === 'P1') lastP1Index = i;
        if (rules[i].priority === 'P2' && firstP2Index === -1) firstP2Index = i;
      }

      // All P0 before all P1 before all P2
      if (lastP0Index >= 0 && firstP1Index >= 0) {
        expect(lastP0Index).toBeLessThan(firstP1Index);
      }
      if (lastP1Index >= 0 && firstP2Index >= 0) {
        expect(lastP1Index).toBeLessThan(firstP2Index);
      }
    });
  });
});
