/**
 * Attention Observer — lightweight Policy.
 *
 * Takes a Candidate and decides: ATTENTION or SILENT. The Observer NEVER
 * makes this call — that is the entire point of the Candidate/Policy split.
 *
 * Policy rules (Phase 1, deliberately tiny):
 *   P0:   permission / input requested (process waiting on human)
 *   P1:   blocked_candidate sustained beyond ESCALATE_AFTER_MS (default 240s)
 *   P2:   completed / failed (informational)
 *   SILENT: working, ordinary idle, grace-period blocked_candidate
 *
 * The blocked escalation requires a *sustained* quiet window so the system
 * never pesters the user just because an agent paused for 20 seconds. This
 * matches the product principle: reduce attention cost, not maximize notifications.
 */
import { ObservationCandidate } from './types';

export const POLICY_THRESHOLDS = {
  /** A blocked_candidate only escalates to P1 attention after this sustained quiet. */
  ESCALATE_AFTER_MS: 240_000,
} as const;

export type AttentionPriority = 'P0' | 'P1' | 'P2';

export interface PolicyDecision {
  action: 'attention' | 'silent';
  priority: AttentionPriority | null;
  requires_human: boolean;
  rule: string;
  reason: string;
}

/** Parse "no_activity_<N>s" out of observations, if present. */
function parseQuietSeconds(candidate: ObservationCandidate): number | null {
  for (const o of candidate.observations) {
    const m = o.match(/^no_activity_(\d+)s$/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

export function evaluatePolicy(candidate: ObservationCandidate): PolicyDecision {
  switch (candidate.state) {
    case 'waiting_for_permission':
      return {
        action: 'attention',
        priority: 'P0',
        requires_human: true,
        rule: 'POLICY-PERM-001',
        reason: 'agent is waiting for permission',
      };

    case 'waiting_for_input':
      return {
        action: 'attention',
        priority: 'P0',
        requires_human: true,
        rule: 'POLICY-INPUT-001',
        reason: 'agent is waiting for user input',
      };

    case 'blocked_candidate': {
      const quiet = parseQuietSeconds(candidate);
      if (quiet !== null && quiet * 1000 >= POLICY_THRESHOLDS.ESCALATE_AFTER_MS) {
        return {
          action: 'attention',
          priority: 'P1',
          requires_human: true,
          rule: 'POLICY-BLOCKED-002',
          reason: `agent blocked for ${quiet}s (sustained beyond escalate threshold)`,
        };
      }
      return {
        action: 'silent',
        priority: null,
        requires_human: false,
        rule: 'POLICY-BLOCKED-001',
        reason: 'blocked candidate below escalate threshold — observing',
      };
    }

    case 'completed_candidate':
      return {
        action: 'attention',
        priority: 'P2',
        requires_human: false,
        rule: 'POLICY-COMPLETED-001',
        reason: 'agent completed',
      };

    case 'failed_candidate':
      return {
        action: 'attention',
        priority: 'P2',
        requires_human: false,
        rule: 'POLICY-FAILED-001',
        reason: 'agent failed',
      };

    case 'working':
      return {
        action: 'silent',
        priority: null,
        requires_human: false,
        rule: 'POLICY-WORKING-001',
        reason: 'agent is actively working',
      };

    default:
      return {
        action: 'silent',
        priority: null,
        requires_human: false,
        rule: 'POLICY-DEFAULT',
        reason: 'unknown state — defaulting to silent',
      };
  }
}
