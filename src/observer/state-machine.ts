/**
 * Attention Observer — state machine core (pure function).
 *
 * Maps a single ObservationInput to a structured ObservationCandidate.
 * Pure: no I/O, no time source, fully deterministic given the input — so it
 * is trivially testable with the Deterministic Fake Agent scenarios.
 *
 * Candidate vocabulary:
 *   - working / waiting_for_input / waiting_for_permission  (live states)
 *   - blocked_candidate / completed_candidate / failed_candidate (suspicion)
 *
 * Rules, in priority order:
 *   1. process exited + recent terminal event → completed/failed_candidate
 *   2. process alive + recent permission event → waiting_for_permission
 *   3. process alive + recent input event     → waiting_for_input
 *   4. process alive + recent activity        → working
 *   5. process alive + quiet >= BLOCKED_CANDIDATE_AFTER_MS → blocked_candidate
 *   6. process alive, no observations at all  → working (low confidence)
 *   7. process exited with no terminal event  → completed_candidate (low, E0)
 *
 * Confidence is higher for deterministic signals (permission/input/terminal
 * events = E1) than for purely temporal inference (quiet = E0).
 */
import {
  ObservationInput,
  ObservationCandidate,
  ObservedState,
  EvidenceStrength,
  OBSERVER_THRESHOLDS as T,
} from './types';

let _counter = 0;

function nextCandidateId(): string {
  _counter += 1;
  return `oc_${Date.now().toString(36)}_${_counter}`;
}

/** Build a candidate from raw fields, filling shared metadata. */
function buildCandidate(
  input: ObservationInput,
  state: ObservedState,
  confidence: number,
  evidenceStrength: EvidenceStrength,
  observations: string[],
  reason: string,
): ObservationCandidate {
  return {
    candidate_id: nextCandidateId(),
    agent_id: input.agentId,
    state,
    confidence,
    evidence_strength: evidenceStrength,
    requires_human: null, // not the Observer's call — Policy decides
    observations,
    reason,
    timestamp: Date.now(),
  };
}

function activeAge(ms: number | null): number | null {
  return ms === null ? null : ms;
}

/**
 * Classify one agent's observed state. Pure and synchronous.
 */
export function observeAgent(input: ObservationInput): ObservationCandidate {
  const activityAge = activeAge(input.lastActivityAgeMs);
  const quietMs = activityAge === null ? null : activityAge;

  // 1. Process exited.
  if (!input.pidAlive) {
    if (input.recentTerminalEvent) {
      const isFailed = input.lastEventType === 'failed' || (input.exitCode !== null && input.exitCode !== 0);
      const state: ObservedState = isFailed ? 'failed_candidate' : 'completed_candidate';
      return buildCandidate(
        input,
        state,
        0.85,
        'E1',
        ['process_exited', input.exitCode !== null ? `exit_code=${input.exitCode}` : 'exit_code=unknown', `last_event=${input.lastEventType ?? 'none'}`],
        `process exited with ${isFailed ? 'failure' : 'completion'} signal (exit code ${input.exitCode ?? 'unknown'})`,
      );
    }
    // Exited but no terminal attention event → possible missed terminal event.
    return buildCandidate(
      input,
      'completed_candidate',
      0.4,
      'E0',
      ['process_exited', 'no_terminal_event', 'possible_missed_notification'],
      'process exited without a terminal attention event (candidate only)',
    );
  }

  // 2. Recent permission request (deterministic event).
  if (input.recentPermissionEvent) {
    return buildCandidate(
      input,
      'waiting_for_permission',
      0.95,
      'E1',
      ['permission_requested', 'process_alive'],
      'agent requested permission and is waiting',
    );
  }

  // 3. Recent input request.
  if (input.recentInputEvent) {
    return buildCandidate(
      input,
      'waiting_for_input',
      0.9,
      'E1',
      ['input_requested', 'process_alive'],
      'agent asked for input and is waiting',
    );
  }

  // 4. Recent activity → working.
  if (quietMs !== null && quietMs <= T.ACTIVE_WINDOW_MS) {
    return buildCandidate(
      input,
      'working',
      0.82,
      'E1',
      [`activity_${Math.round(quietMs / 1000)}s_ago`, 'process_alive'],
      `agent active ${Math.round(quietMs / 1000)}s ago`,
    );
  }

  // 5. Quiet beyond the blocked-candidate threshold.
  if (quietMs !== null && quietMs >= T.BLOCKED_CANDIDATE_AFTER_MS) {
    return buildCandidate(
      input,
      'blocked_candidate',
      0.71,
      'E0',
      ['process_alive', `no_activity_${Math.round(quietMs / 1000)}s`, `last_event=${input.lastEventType ?? 'none'}`],
      `process alive with no observed activity for ${Math.round(quietMs / 1000)}s (candidate only)`,
    );
  }

  // 6. Alive but nothing observed yet — early grace period.
  return buildCandidate(
    input,
    'working',
    0.3,
    'E0',
    ['process_alive', 'no_observations_yet'],
    'process alive with no observations yet',
  );
}
