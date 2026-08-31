/**
 * Attention Observer — daemon sidecar.
 *
 * Runs continuously in the background while the daemon is alive.
 * Observes registered agents (registry + process lifecycle + activity heartbeat
 * + attention events) and writes structured Candidates to observe.jsonl.
 *
 * Design rules:
 *   - Observer writes to observe.jsonl (append-only for Auditor).
 *   - Observer NEVER writes state.json. When it needs to notify the user,
 *     it calls notify() directly (toast/sound only, no state mutation).
 *   - Observer NEVER decides requires_human — that's the Policy's job.
 *   - Observer NEVER re-notifies what the agent already self-reported.
 *     (P0 permission/input and P2 completed/failed with recentTerminalEvent
 *     mean the agent already called agent-notify → user already got toast.)
 *   - Observer ONLY triggers a toast for "missed signal" cases the agent
 *     itself cannot report:
 *       1. FN-EXIT: process exited without a terminal event
 *          (completed/failed_candidate + !recentTerminalEvent)
 *       2. P1 blocked: agent quiet beyond escalate threshold (240s) —
 *          no agent-side event exists for "I'm stuck".
 *   - Observer uses shouldNotify() dedup so each agent+state notifies at most
 *     once per DEDUP_TTL (30s), preventing 5s-poll spam.
 *   - If Observer crashes, daemon continues (best-effort).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { collectAll } from './collector';
import { observeAgent } from './state-machine';
import { evaluatePolicy } from './policy';
import { ObservationCandidate, ObservationInput } from './types';
import { log } from '../logging';
import { emitNotification } from '../pipeline/ipc';
import { notify } from '../notification/win32';
import { shouldNotify, getDedupAgentId } from '../dedup';
import { EventName } from '../events';

const OBSERVE_INTERVAL_MS = 5000;
const OBSERVE_JSONL_PATH = 'observe.jsonl';

function observeJsonlPath(stateDir: string): string {
  return path.join(stateDir, OBSERVE_JSONL_PATH);
}

interface ObservationSnapshot {
  timestamp: number;
  candidates: Array<{
    candidate: ObservationCandidate;
    policy: import('./policy').PolicyDecision;
  }>;
}

let _timer: NodeJS.Timeout | null = null;
let _running = false;

/**
 * One-shot signal dedup: a (agent_id, state) pair that has already fired a
 * toast is never fired again for the lifetime of the Observer process.
 * This prevents 30s-TTL re-notification loops for persistent conditions
 * (e.g. an exited agent stays completed_candidate forever).
 */
const _notifiedSignals = new Set<string>();
function signalKey(agentId: string, state: string): string {
  return `${agentId}:${state}`;
}

/**
 * Determine whether the Observer should fire a toast for this candidate.
 *
 * Only "missed signal" cases that the agent itself cannot report:
 *   - FN-EXIT: process exited WITHOUT ever reporting a terminal event
 *   - P1 blocked: sustained quiet beyond escalate threshold
 *
 * Self-reported signals are skipped:
 *   - P0 permission/input: agent called agent-notify → user already got toast.
 *   - P2 completed/failed: agent's LAST event was a terminal one → user
 *     already got the completion toast (regardless of event age).
 *
 * `lastEventType` is the agent's most recent event type in state.json.
 * We check "ever reported terminal" (lastEventType) rather than
 * "recently reported terminal" (recentTerminalEvent) so that a completion
 * toast is NOT re-fired after the event ages past TERMINAL_WINDOW_MS.
 */
function shouldObserverNotify(
  candidate: ObservationCandidate,
  policy: import('./policy').PolicyDecision,
  lastEventType: string | null,
): boolean {
  if (policy.action !== 'attention') return false;

  switch (candidate.state) {
    case 'waiting_for_permission':
    case 'waiting_for_input':
      // Agent already self-reported via agent-notify → user already got toast.
      return false;

    case 'completed_candidate':
    case 'failed_candidate':
      // Only notify if the agent NEVER reported a terminal event (FN-EXIT).
      // If lastEventType is completed/failed, the agent self-reported its
      // exit and the user already got the toast — do not re-fire.
      return lastEventType !== 'completed' && lastEventType !== 'failed';

    case 'blocked_candidate':
      // Only the P1 escalation (sustained >240s) is worth a toast.
      // P1 blocked cannot be self-reported (no agent-side event type exists).
      return policy.priority === 'P1';

    default:
      return false;
  }
}

/** Map an observer candidate to the notify() event name + message. */
function buildNotifyPayload(candidate: ObservationCandidate): {
  event: EventName;
  message: string;
} {
  switch (candidate.state) {
    case 'completed_candidate':
      return {
        event: 'completed',
        message: `[observer] ${candidate.agent_id} exited without reporting completion`,
      };
    case 'failed_candidate':
      return {
        event: 'failed',
        message: `[observer] ${candidate.agent_id} exited abnormally without reporting failure`,
      };
    case 'blocked_candidate': {
      // P1 blocked — no 'blocked' EventName exists; use 'failed' as the
      // "needs attention" signal with a clear message.
      const quietSec = candidate.observations
        .find((o) => o.startsWith('no_activity_'))
        ?.replace('no_activity_', '')
        .replace('s', '') ?? 'unknown';
      return {
        event: 'failed',
        message: `[observer] ${candidate.agent_id} appears blocked (no activity for ${quietSec}s)`,
      };
    }
    default:
      return {
        event: 'completed',
        message: `[observer] ${candidate.agent_id}: ${candidate.state}`,
      };
  }
}

/** Run one observation pass and append to observe.jsonl. */
export function runObservationPass(stateDir: string): void {
  try {
    const snapshot = collectAll();
    const rowsWithInput: Array<{
      input: ObservationInput;
      candidate: ObservationCandidate;
      policy: import('./policy').PolicyDecision;
    }> = snapshot.map(({ input }) => {
      const candidate = observeAgent(input);
      const policy = evaluatePolicy(candidate);
      return { input, candidate, policy };
    });

    if (rowsWithInput.length === 0) return;

    const record: ObservationSnapshot = {
      timestamp: Date.now(),
      candidates: rowsWithInput.map(({ candidate, policy }) => ({ candidate, policy })),
    };

    const p = observeJsonlPath(stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf-8');

    // Process attention decisions: log, dedup-gate, fire toast, emit IPC.
    for (const { input, candidate, policy } of rowsWithInput) {
      if (policy.action !== 'attention') continue;

      // Log every attention decision.
      log({
        component: 'observer',
        level: policy.priority === 'P0' ? 'INFO' : 'DEBUG',
        event: 'observation_attention',
        message: `${candidate.agent_id}: ${candidate.state} → ${policy.priority ?? 'silent'} [${policy.rule}]`,
        context: {
          agent_id: candidate.agent_id,
          state: candidate.state,
          confidence: candidate.confidence,
          policy_action: policy.action,
          policy_priority: policy.priority,
          rule: policy.rule,
        },
      });

      // Emit IPC notification for ALL attention decisions (Center can display).
      try {
        emitNotification(stateDir, 'state-changed', {
          type: 'observer-candidate',
          agent_id: candidate.agent_id,
          state: candidate.state,
          priority: policy.priority,
          candidate_id: candidate.candidate_id,
        });
      } catch { /* best-effort */ }

      // Only fire a real toast for "missed signal" cases (see shouldObserverNotify).
      if (!shouldObserverNotify(candidate, policy, input.lastEventType)) continue;

      // One-shot signal dedup: never re-fire the same agent+state.
      const key = signalKey(candidate.agent_id, candidate.state);
      if (_notifiedSignals.has(key)) continue;
      _notifiedSignals.add(key);

      const { event, message } = buildNotifyPayload(candidate);
      // Extra belt-and-suspenders: shouldNotify() 30s TTL guard.
      const dedupAgent = `${getDedupAgentId()}-observer`;
      if (!shouldNotify(dedupAgent, event, message)) continue;

      // Test/CI guard: never fire real Windows toasts under Jest
      // (node-notifier hangs waiting for the snoretoast binary there).
      // Override with AGENT_ATTENTION_OBSERVER_TOAST=1 to force on.
      const underTest = process.env.NODE_ENV === 'test';
      const toastOverride = process.env.AGENT_ATTENTION_OBSERVER_TOAST === '1';
      if (underTest && !toastOverride) {
        log({
          component: 'observer',
          level: 'DEBUG',
          event: 'observer_toast_suppressed',
          message: `Toast suppressed (NODE_ENV=test): ${candidate.agent_id} (${candidate.state})`,
          context: { agent_id: candidate.agent_id, state: candidate.state },
        });
        continue;
      }

      // Fire toast (fire-and-forget; notify() is async and may wait for
      // toast callback up to 30s — don't block the 5s poll loop).
      const soundEnabled = policy.priority === 'P1'; // P1 blocked → sound
      notify(event, message, soundEnabled).catch((e) => {
        log({
          component: 'observer',
          level: 'WARN',
          event: 'observer_notify_failed',
          message: String(e),
          context: { agent_id: candidate.agent_id, event },
        });
      });

      log({
        component: 'observer',
        level: 'INFO',
        event: 'observer_triggered_toast',
        message: `Fired toast: ${candidate.agent_id} (${candidate.state}) [${policy.priority}]`,
        context: {
          agent_id: candidate.agent_id,
          state: candidate.state,
          priority: policy.priority,
          event_name: event,
        },
      });
    }
  } catch (err) {
    log({
      component: 'observer',
      level: 'ERROR',
      event: 'observation_failed',
      message: String(err),
    });
  }
}

/**
 * Start the Observer sidecar. Called once from daemon startup.
 * Returns a stop function.
 */
export function startObserver(stateDir: string): () => void {
  if (_running) return () => {}; // already running

  _running = true;

  // Run immediately, then on interval.
  runObservationPass(stateDir);
  _timer = setInterval(() => runObservationPass(stateDir), OBSERVE_INTERVAL_MS);

  log({
    component: 'observer',
    level: 'INFO',
    event: 'observer_started',
    message: `Observer sidecar started (interval=${OBSERVE_INTERVAL_MS}ms)`,
  });

  return () => stopObserver();
}

/** Stop the Observer sidecar. */
export function stopObserver(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _running = false;
  log({
    component: 'observer',
    level: 'INFO',
    event: 'observer_stopped',
    message: 'Observer sidecar stopped',
  });
}

/** Read recent observations from observe.jsonl. */
export function readObservations(limit: number = 50): ObservationSnapshot[] {
  const p = observeJsonlPath(os.homedir());
  const dir = path.dirname(p);
  const fullPath = path.join(dir, path.basename(p));
  if (!fs.existsSync(fullPath)) return [];
  try {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const snapshots: ObservationSnapshot[] = [];
    for (const line of lines) {
      try { snapshots.push(JSON.parse(line) as ObservationSnapshot); } catch { /* skip corrupt lines */ }
    }
    return snapshots.slice(-limit).reverse();
  } catch {
    return [];
  }
}
