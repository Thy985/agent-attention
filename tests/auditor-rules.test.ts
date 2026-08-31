/**
 * Attention Auditor — rules unit tests.
 *
 * Tests the 6 Phase-1 rules against synthetic event streams. No real process
 * / filesystem needed except the test temp dir for audit.jsonl.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  checkDuplicateBurst,
  checkTrivialMessage,
  checkSemanticMismatch,
  checkPriorityAbuse,
  checkThroughputBurst,
} from '../src/auditor/rules';
import { StateEvent } from '../src/state/AttentionState';
import { Agent } from '../src/registry';

function makeEvents(overrides: Partial<StateEvent>[]): StateEvent[] {
  return overrides.map((o, i) => ({
    id: `evt-${i}`,
    timestamp: Date.now(),
    type: 'completed' as const,
    priority: 'P2' as const,
    agent_id: 'test-agent',
    agent_name: 'Test Agent',
    title: '',
    message: '',
    read: false,
    ...o,
  }));
}

const AGENT: Agent = {
  agent_id: 'test-agent',
  name: 'Test Agent',
  binary: null,
  integration: 'skill',
  registered_at: Date.now(),
  last_seen_at: Date.now(),
  target: null,
};

describe('FP-DUP-001: burst duplicate', () => {
  it('fires when 5+ identical events in 30s window', () => {
    const events = makeEvents(
      Array.from({ length: 6 }, () => ({
        type: 'completed',
        agent_id: 'dup-agent',
        message: 'same message',
      })),
    );
    const results = checkDuplicateBurst(events, [AGENT]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rule_id).toBe('FP-DUP-001');
    expect(results[0].type).toBe('duplicate_burst');
    expect(results[0].evidence_strength).toBe('E1');
    expect(results[0].status).toBe('open');
  });

  it('does not fire below threshold', () => {
    const events = makeEvents(
      Array.from({ length: 3 }, () => ({
        type: 'completed',
        agent_id: 'dup-agent',
        message: 'same',
      })),
    );
    expect(checkDuplicateBurst(events, [AGENT]).length).toBe(0);
  });
});

describe('FP-MSG-002: trivial message', () => {
  it('flags short message on critical event types', () => {
    const events = makeEvents([
      { type: 'completed', agent_id: 'x', message: 'test', read: false },
      { type: 'completed', agent_id: 'x', message: 'hello', read: false },
      { type: 'completed', agent_id: 'x', message: 'done', read: false },
    ]);
    const results = checkTrivialMessage(events, [AGENT]);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.rule_id).toBe('FP-MSG-002');
      expect(r.type).toBe('trivial_message');
      expect(r.evidence_strength).toBe('E0');
      expect(r.status).toBe('open');
    }
  });

  it('does not flag substantive messages', () => {
    const events = makeEvents([{ type: 'completed', agent_id: 'x', message: 'Task completed successfully after 47 steps' }]);
    expect(checkTrivialMessage(events, [AGENT]).length).toBe(0);
  });
});

describe('FP-SEM-003: semantic mismatch', () => {
  it('flags completed with running-indicator message', () => {
    const events = makeEvents([
      { type: 'completed', agent_id: 'sem', message: 'Task is still running' },
      { type: 'failed', agent_id: 'sem', message: 'Loading output from remote system...' },
    ]);
    const results = checkSemanticMismatch(events, [AGENT]);
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.rule_id).toBe('FP-SEM-003');
      expect(r.type).toBe('terminal_semantic_mismatch');
      expect(r.evidence_strength).toBe('E0');
    }
  });

  it('does not flag normal completed messages', () => {
    const events = makeEvents([{ type: 'completed', agent_id: 'sem', message: 'Task finished successfully' }]);
    expect(checkSemanticMismatch(events, [AGENT]).length).toBe(0);
  });
});

describe('FP-P0-004: priority abuse', () => {
  it('flags agent with >80% P0', () => {
    const events = makeEvents(
      Array.from({ length: 10 }, (_, i) => ({
        type: 'completed',
        agent_id: 'p0-abuser',
        message: `event ${i}`,
        priority: i < 9 ? 'P0' : 'P2',
      })),
    );
    const results = checkPriorityAbuse(events, [AGENT]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rule_id).toBe('FP-P0-004');
    expect(results[0].type).toBe('priority_misuse_candidate');
    expect((results[0].evidence as unknown as Record<string, number>).ratio).toBeGreaterThan(0.8);
  });

  it('does not flag healthy mix', () => {
    const events = makeEvents(
      Array.from({ length: 10 }, (_, i) => ({
        type: 'completed',
        agent_id: 'normal',
        message: `event ${i}`,
        priority: i % 3 === 0 ? 'P0' : 'P2',
      })),
    );
    expect(checkPriorityAbuse(events, [AGENT]).length).toBe(0);
  });
});

describe('FP-BURST-005: throughput burst', () => {
  it('flags >20 events/min', () => {
    const base = Date.now() - 60_000;
    const events = makeEvents(
      Array.from({ length: 25 }, (_, i) => ({
        agent_id: 'burst',
        message: `event ${i}`,
        timestamp: base + i * 2000, // every 2s, 25 events in 60s = ~25/min
      })),
    );
    const results = checkThroughputBurst(events, [AGENT]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rule_id).toBe('FP-BURST-005');
    expect(results[0].evidence_strength).toBe('E1');
  });
});

describe('Rule table structure', () => {
  it('contains exactly 6 rules with deterministic IDs', () => {
    const { RULES } = require('../src/auditor/rules');
    const ids = RULES.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual(['FN-EXIT-001', 'FP-BURST-005', 'FP-DUP-001', 'FP-MSG-002', 'FP-P0-004', 'FP-SEM-003']);
  });

  it('each rule exposes a .check method', () => {
    const { RULES } = require('../src/auditor/rules');
    for (const rule of RULES) {
      expect(typeof rule.check).toBe('function');
      expect(typeof rule.id).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
    }
  });
});
