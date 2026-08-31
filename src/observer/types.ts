/**
 * Attention Observer — types.
 *
 * The Observer watches a Main Agent's *observable state* (process lifecycle,
 * activity heartbeat, self-reported attention events) and produces a
 * structured Candidate. It NEVER decides whether to notify the human —
 * that is the Policy's job. It never writes state.json, never calls
 * agent-notify, and never touches the Main Agent.
 *
 * Design rules (from the Phase 1 spec):
 *   - Observer output carries state + confidence + evidence_strength +
 *     observations[] + reason, so the Auditor can later ask "why did the
 *     Observer think that?"
 *   - requires_human is NOT produced by the Observer — it is null here and
 *     decided by the Policy.
 *   - BLOCKED is only ever a *candidate* ("process alive, no activity for
 *     T"), never a direct "human must intervene" verdict.
 */

/** Observed state (output vocabulary). */
export type ObservedState =
  | 'working'
  | 'waiting_for_input'
  | 'waiting_for_permission'
  | 'blocked_candidate'
  | 'completed_candidate'
  | 'failed_candidate';

/** Evidence strength, mirroring the project's E0–E4 ladder. */
export type EvidenceStrength = 'E0' | 'E1' | 'E2' | 'E3' | 'E4';

/**
 * What the Observer reads about ONE agent at one point in time.
 * All inputs are facts the Observer can observe without understanding
 * natural language.
 */
export interface ObservationInput {
  agentId: string;
  /** Whether the target process is currently alive. */
  pidAlive: boolean;
  /** ms since the agent's last observed activity (heartbeat / hook / tool). null = never observed. */
  lastActivityAgeMs: number | null;
  /** Type of the agent's most recent attention event in state.json (completed/failed/input_required/permission_required). null = none. */
  lastEventType: string | null;
  /** ms since that last attention event. null = no events. */
  lastEventAgeMs: number | null;
  /** Whether a permission_required event was emitted recently (within PERMISSION_WINDOW). */
  recentPermissionEvent: boolean;
  /** Whether an input_required event was emitted recently. */
  recentInputEvent: boolean;
  /** Whether a terminal event (completed/failed) was emitted recently. */
  recentTerminalEvent: boolean;
  /** Process exit code, when the process has exited. null while alive. */
  exitCode: number | null;
}

/** A structured observation candidate produced by the state machine. */
export interface ObservationCandidate {
  candidate_id: string;
  agent_id: string;
  /** Output state — note blocked/completed/failed are always *_candidate. */
  state: ObservedState;
  confidence: number;
  evidence_strength: EvidenceStrength;
  /** Human-intervention verdict is NOT the Observer's to make. */
  requires_human: null;
  /** Short human-readable strings, e.g. ["process_alive","no_activity_120s"]. */
  observations: string[];
  reason: string;
  timestamp: number;
}

/** Thresholds used by the state machine (exported for tests/overrides). */
export const OBSERVER_THRESHOLDS = {
  /** Activity within this window counts as "recent" → working. */
  ACTIVE_WINDOW_MS: 30_000,
  /** Process quiet for this long → blocked_candidate. */
  BLOCKED_CANDIDATE_AFTER_MS: 120_000,
  /** A permission event within this window counts as waiting_for_permission. */
  PERMISSION_WINDOW_MS: 60_000,
  /** An input event within this window counts as waiting_for_input. */
  INPUT_WINDOW_MS: 60_000,
  /** A terminal event within this window counts as just-completed/failed. */
  TERMINAL_WINDOW_MS: 60_000,
} as const;
