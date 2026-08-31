/**
 * Attention Observer — daemon sidecar.
 *
 * Runs continuously in the background while the daemon is alive.
 * Observes registered agents (registry + process lifecycle + activity heartbeat
 * + attention events) and writes structured Candidates to observe.jsonl.
 *
 * Design rules (from Phase 2 spec):
 *   - Observer NEVER writes state.json or calls agent-notify.
 *   - Observer NEVER decides requires_human — that's the Policy's job.
 *   - Observations are append-only JSONL for the Auditor to inspect later.
 *   - If Observer crashes, daemon continues (best-effort).
 *
 * Lifecycle:
 *   - Start: immediately run one scan, then schedule periodic scans.
 *   - Poll interval: POLL_INTERVAL_MS (default 5s) — fast enough to catch
 *     state transitions, slow enough to not thrash.
 *   - Stop: clear the observation stream marker, let next start resume.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readRegistry } from '../registry';
import { readState } from '../state/AttentionState';
import { collectAll } from './collector';
import { observeAgent } from './state-machine';
import { evaluatePolicy } from './policy';
import { ObservationCandidate } from './types';
import { log } from '../logging';

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

/** Run one observation pass and append to observe.jsonl. */
export function runObservationPass(stateDir: string): void {
  try {
    const snapshot = collectAll();
    const rows: ObservationSnapshot['candidates'] = snapshot.map(({ input }) => {
      const candidate = observeAgent(input);
      const policy = evaluatePolicy(candidate);
      return { candidate, policy };
    });

    if (rows.length === 0) return;

    const record: ObservationSnapshot = {
      timestamp: Date.now(),
      candidates: rows,
    };

    const p = observeJsonlPath(stateDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf-8');

    // Log high-confidence attention decisions for visibility
    for (const { candidate, policy } of rows) {
      if (policy.action === 'attention' && candidate.confidence > 0.7) {
        log({
          component: 'observer',
          level: 'INFO',
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
      }
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

  // Run immediately, then on interval
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
