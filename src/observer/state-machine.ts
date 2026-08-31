/**
 * Attention Observer — state machine core (pure function).
 *
 * Maps a single ObservationInput to a structured ObservationCandidate.
 * Pure: no I/O, no time source, fully deterministic given the input — so it
 * is trivially testable with the Deterministic Fake Agent scenarios.
 *
 * Candidate vocabulary:
 *   - working / waiting_for_input / waiting_for_permission  (live states)
 * *   - blocked_candidate / completed_candidate / failed_candidate (suspicion)
 *
 * Rules, in priority order:
 *   1. process exited + recent terminal event → completed/failed_candidate
 *   2. process alive + recent permission event → waiting_for_permission
 *   3. process alive + recent input event     → waiting_for_input
 *   4. process alive + recent activity (<30s) → working
 *   5. process alive + quiet >= 120s          → blocked_candidate
 *   6. process alive + no observations yet    → working (low confidence)
 *   7. process exited with no terminal event  → completed_candidate (E0)
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
    requires_human: null,
    observations,
    reason,
    timestamp: Date.now(),
  };
}

/**
 * Classify one agent's observed state. Pure and synchronous.
 */
export function observeAgent(input: ObservationInput): ObservationCandidate {
  // If no heartbeat recorded, treat as "unknown when last active" — use current
  // time as lower bound so silence detection can fire after the threshold.
  const quietMs = input.lastActivityAgeMs !== null
    ? input.lastActivityAgeMs
    : 0; // sentinel: will be treated as "no data yet" in rules below

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

  // 4. Recent activity (<30s) → working.
  if (input.lastActivityAgeMs !== null && quietMs <= T.ACTIVE_WINDOW_MS) {
    return buildCandidate(
      input,
      'working',
      0.82,
      'E1',
      [`activity_${Math.round(quietMs / 1000)}s_ago`, 'process_alive'],
      `agent active ${Math.round(quietMs / 1000)}s ago`,
    );
  }

  // 5. Quiet >= 120s OR no heartbeat recorded → blocked_candidate.
  if (quietMs >= T.BLOCKED_CANDIDATE_AFTER_MS || input.lastActivityAgeMs === null) {
    const silentFor = input.lastActivityAgeMs !== null
      ? Math.round(quietMs / 1000)
      : 'unknown';
    return buildCandidate(
      input,
      'blocked_candidate',
      input.lastActivityAgeMs !== null ? 0.71 : 0.55,
      'E0',
      ['process_alive', `no_activity_${silentFor}s`, `last_event=${input.lastEventType ?? 'none'}`],
      input.lastActivityAgeMs !== null
        ? `process alive with no observed activity for ${silentFor}s (candidate only)`
        : 'process alive with no activity recorded (candidate only)',
    );
  }

  // 6. Between 30s and 120s → working but getting quiet.
  return buildCandidate(
    input,
    'working',
    0.5,
    'E0',
    [`activity_${Math.round(quietMs / 1000)}s_ago`, 'process_alive'],
    `agent quiet for ${Math.round(quietMs / 1000)}s`,
  );
}
