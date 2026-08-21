import { mapTeamMindEvent, isAttentionRelevant } from '../src/teammind/EventAdapter';
import { EventType, TeamMindEvent } from '../src/teammind/types';

describe('mapTeamMindEvent', () => {
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

  describe('P0 events — always mapped', () => {
    it('maps DECISION_REQUIRES_APPROVAL to permission_required P0', () => {
      const event = baseEvent(EventType.DECISION_REQUIRES_APPROVAL, {
        metadata: { question: 'Execute git push?' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('permission_required');
      expect(result!.priority).toBe('P0');
      expect(result!.title).toContain('codex');
      expect(result!.message).toBe('Execute git push?');
    });

    it('maps PLUGIN_DOWN to plugin_down P0', () => {
      const event = baseEvent(EventType.PLUGIN_DOWN, {
        metadata: { reason: 'Process crashed' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('plugin_down');
      expect(result!.priority).toBe('P0');
    });

    it('maps ERROR_CRITICAL to failed P0', () => {
      const event = baseEvent(EventType.ERROR_CRITICAL, {
        metadata: { message: 'Out of memory' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('failed');
      expect(result!.priority).toBe('P0');
    });

    it('maps TASK_FAILED to failed P0', () => {
      const event = baseEvent(EventType.TASK_FAILED, {
        metadata: { error: 'Build failed' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('failed');
      expect(result!.priority).toBe('P0');
    });
  });

  describe('P1 events — mapped with context', () => {
    it('maps TASK_COMPLETED to completed P1', () => {
      const event = baseEvent(EventType.TASK_COMPLETED, {
        metadata: { summary: 'All tests passed' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('completed');
      expect(result!.priority).toBe('P1');
    });

    it('maps AGENT_COMPLETED to completed P1', () => {
      const event = baseEvent(EventType.AGENT_COMPLETED, {
        metadata: { summary: 'Code review done' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('completed');
      expect(result!.priority).toBe('P1');
    });

    it('maps TEST_FAILED to failed P1', () => {
      const event = baseEvent(EventType.TEST_FAILED, {
        metadata: { failed: 3 },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('failed');
      expect(result!.priority).toBe('P1');
    });

    it('maps EVIDENCE_FAILED to failed P1', () => {
      const event = baseEvent(EventType.EVIDENCE_FAILED, {
        metadata: { summary: 'Git diff mismatch' },
      });
      const result = mapTeamMindEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('failed');
      expect(result!.priority).toBe('P1');
    });
  });

  describe('Silent events — not mapped', () => {
    const silentTypes = [
      EventType.AGENT_CHUNK,
      EventType.TOOL_CALLED,
      EventType.FILE_CHANGED,
      EventType.AGENT_THINKING,
      EventType.AGENT_STARTED,
      EventType.EVIDENCE_VERIFIED,
      EventType.TEST_PASSED,
      EventType.ARTIFACT_CREATED,
      EventType.REVIEW_APPROVED,
      EventType.HANDOFF_REQUESTED,
    ];

    it.each(silentTypes)('silently drops %s', (type) => {
      const event = baseEvent(type);
      const result = mapTeamMindEvent(event);
      expect(result).toBeNull();
    });

    it('silently drops unknown event types', () => {
      const event = baseEvent('unknown.event.type');
      const result = mapTeamMindEvent(event);
      expect(result).toBeNull();
    });
  });

  describe('isAttentionRelevant', () => {
    it('returns true for P0/P1 events', () => {
      expect(isAttentionRelevant(EventType.DECISION_REQUIRES_APPROVAL)).toBe(true);
      expect(isAttentionRelevant(EventType.PLUGIN_DOWN)).toBe(true);
      expect(isAttentionRelevant(EventType.TASK_COMPLETED)).toBe(true);
    });

    it('returns false for progress events', () => {
      expect(isAttentionRelevant(EventType.AGENT_CHUNK)).toBe(false);
      expect(isAttentionRelevant(EventType.TOOL_CALLED)).toBe(false);
      expect(isAttentionRelevant(EventType.FILE_CHANGED)).toBe(false);
    });
  });
});