/**
 * Observer state machine unit tests.
 *
 * These verify the pure state-machine logic against deterministic inputs
 * that mirror the Fake Agent scenarios, so "is the algorithm right?" is
 * decoupled from "is the real-agent integration working?".
 *
 * Acceptance: 6 states recognized, each carries confidence + evidence_strength
 * + observations[] + reason, and requires_human is ALWAYS null (Observer
 * never decides human intervention — that is the Policy's job).
 */
import { observeAgent } from '../src/observer/state-machine';
import { evaluatePolicy } from '../src/observer/policy';
import { ObservationInput, ObservationCandidate, OBSERVER_THRESHOLDS as T } from '../src/observer/types';

const NOW = 1788200000000;

function baseInput(overrides: Partial<ObservationInput>): ObservationInput {
  return {
    agentId: 'fake-agent',
    pidAlive: true,
    lastActivityAgeMs: 5000,
    lastEventType: null,
    lastEventAgeMs: null,
    recentPermissionEvent: false,
    recentInputEvent: false,
    recentTerminalEvent: false,
    exitCode: null,
    ...overrides,
  };
}

function assertCandidate(c: ObservationCandidate, state: string, evidence: string[]) {
  expect(c.state).toBe(state);
  expect(c.confidence).toBeGreaterThan(0);
  expect(c.confidence).toBeLessThanOrEqual(1);
  expect(c.evidence_strength).toMatch(/^E[0-4]$/);
  expect(c.observations.length).toBeGreaterThan(0);
  expect(c.reason).toBeTruthy();
  // The Observer MUST NOT decide human intervention.
  expect(c.requires_human).toBeNull();
}

describe('observeAgent state machine', () => {
  it('WORKING: recent activity → working', () => {
    const c = observeAgent(baseInput({ lastActivityAgeMs: 3000, pidAlive: true }));
    assertCandidate(c, 'working', ['activity']);
    expect(c.confidence).toBeGreaterThan(0.7);
  });

  it('WAITING_FOR_PERMISSION: recent permission event', () => {
    const c = observeAgent(baseInput({
      recentPermissionEvent: true,
      lastEventType: 'permission_required',
      lastEventAgeMs: 5000,
    }));
    assertCandidate(c, 'waiting_for_permission', ['permission_requested']);
    expect(c.evidence_strength).toBe('E1');
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it('WAITING_FOR_INPUT: recent input event', () => {
    const c = observeAgent(baseInput({
      recentInputEvent: true,
      lastEventType: 'input_required',
      lastEventAgeMs: 8000,
    }));
    assertCandidate(c, 'waiting_for_input', ['input_requested']);
    expect(c.evidence_strength).toBe('E1');
  });

  it('BLOCKED_CANDIDATE: quiet beyond threshold', () => {
    const quiet = T.BLOCKED_CANDIDATE_AFTER_MS + 10_000;
    const c = observeAgent(baseInput({
      lastActivityAgeMs: quiet,
      lastEventType: null,
      lastEventAgeMs: null,
    }));
    assertCandidate(c, 'blocked_candidate', ['no_activity']);
    expect(c.evidence_strength).toBe('E0');
    // Must be a candidate label, never a hard "blocked".
    expect(c.state).toBe('blocked_candidate');
  });

  it('COMPLETED_CANDIDATE: process exited with terminal event', () => {
    const c = observeAgent(baseInput({
      pidAlive: false,
      exitCode: 0,
      recentTerminalEvent: true,
      lastEventType: 'completed',
      lastEventAgeMs: 3000,
    }));
    assertCandidate(c, 'completed_candidate', ['process_exited']);
    expect(c.evidence_strength).toBe('E1');
  });

  it('FAILED_CANDIDATE: process exited with failure', () => {
    const c = observeAgent(baseInput({
      pidAlive: false,
      exitCode: 1,
      recentTerminalEvent: true,
      lastEventType: 'failed',
      lastEventAgeMs: 2000,
    }));
    assertCandidate(c, 'failed_candidate', ['process_exited']);
    expect(c.evidence_strength).toBe('E1');
  });

  it('possible_missed_notification: exited with no terminal event', () => {
    const c = observeAgent(baseInput({
      pidAlive: false,
      exitCode: null,
      recentTerminalEvent: false,
      lastEventType: 'input_required',
      lastEventAgeMs: 15_000,
    }));
    expect(c.state).toBe('completed_candidate');
    expect(c.observations).toContain('possible_missed_notification');
    expect(c.confidence).toBeLessThan(0.5);
  });

  it('working (low confidence): alive, no recent activity', () => {
    const c = observeAgent(baseInput({
      lastActivityAgeMs: 60_000, // 1 minute quiet
      lastEventType: null,
    }));
    assertCandidate(c, 'working', ['activity']);
    expect(c.confidence).toBeLessThan(0.6);
  });

  it('blocked_candidate: alive with >120s silence', () => {
    const c = observeAgent(baseInput({
      lastActivityAgeMs: 180_000, // 3 minutes quiet
      lastEventType: null,
    }));
    expect(c.state).toBe('blocked_candidate');
    expect(c.evidence_strength).toBe('E0');
    expect(c.observations).toContain('no_activity_180s');
  });

  it('priority: permission beats input beats working', () => {
    const perm = observeAgent(baseInput({
      recentPermissionEvent: true,
      recentInputEvent: true,
      lastActivityAgeMs: 1000,
    }));
    expect(perm.state).toBe('waiting_for_permission');
  });
});

describe('evaluatePolicy (candidate → attention/silent)', () => {
  it('P0 attention for waiting_for_permission', () => {
    const c = observeAgent(baseInput({ recentPermissionEvent: true, lastEventType: 'permission_required', lastEventAgeMs: 5000 }));
    const d = evaluatePolicy(c);
    expect(d.action).toBe('attention');
    expect(d.priority).toBe('P0');
    expect(d.requires_human).toBe(true);
  });

  it('P0 attention for waiting_for_input', () => {
    const c = observeAgent(baseInput({ recentInputEvent: true, lastEventType: 'input_required', lastEventAgeMs: 5000 }));
    const d = evaluatePolicy(c);
    expect(d.action).toBe('attention');
    expect(d.priority).toBe('P0');
    expect(d.requires_human).toBe(true);
  });

  it('SILENT for working', () => {
    const c = observeAgent(baseInput({ lastActivityAgeMs: 3000 }));
    const d = evaluatePolicy(c);
    expect(d.action).toBe('silent');
    expect(d.requires_human).toBe(false);
  });

  it('SILENT for blocked_candidate below escalate threshold', () => {
    const c = observeAgent(baseInput({ lastActivityAgeMs: T.BLOCKED_CANDIDATE_AFTER_MS + 1000 }));
    const d = evaluatePolicy(c);
    expect(d.action).toBe('silent');
    expect(d.priority).toBeNull();
  });

  it('P1 attention for blocked_candidate beyond escalate threshold (240s)', () => {
    const c = observeAgent(baseInput({ lastActivityAgeMs: 250_000 }));
    const d = evaluatePolicy(c);
    expect(d.action).toBe('attention');
    expect(d.priority).toBe('P1');
    expect(d.requires_human).toBe(true);
  });

  it('P2 attention for completed', () => {
    const c = observeAgent(baseInput({ pidAlive: false, exitCode: 0, recentTerminalEvent: true, lastEventType: 'completed', lastEventAgeMs: 1000 }));
    const d = evaluatePolicy(c);
    expect(d.action).toBe('attention');
    expect(d.priority).toBe('P2');
  });
});
