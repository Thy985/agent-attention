/**
 * Attention Observer — observation collector.
 *
 * Gathers the raw facts the state machine needs, WITHOUT understanding any
 * natural language:
 *   - registry → agent_id, target.pid
 *   - process → is pid alive?
 *   - activity heartbeat file → last observed activity timestamp
 *   - state.json → last attention event for this agent (type + age)
 *
 * The heartbeat file is `observed/<agent_id>.jsonl` under the state dir.
 * Each line: {"ts": <epoch_ms>, "kind": "tool_call" | "prompt" | "permission"}
 * The Fake Agent writes these; real agents will write them via hook/wrapper
 * adapters in Phase 2. Absence of the file just means "no activity observed".
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Agent, readRegistry } from '../registry';
import { readState, StateEvent } from '../state/AttentionState';
import { OBSERVER_THRESHOLDS as T } from './types';

function stateDir(): string {
  return process.env.AGENT_ATTENTION_HOME
    ?? path.join(os.homedir(), '.agent-attention');
}

function activityPath(agentId: string): string {
  return path.join(stateDir(), 'observed', `${agentId}.jsonl`);
}

export interface ActivityHeartbeat {
  lastTs: number;
  lastKind: string;
}

/** Read the most recent heartbeat for an agent, if any. */
export function readActivityHeartbeat(agentId: string): ActivityHeartbeat | null {
  const p = activityPath(agentId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return { lastTs: last.ts, lastKind: last.kind ?? 'unknown' };
  } catch {
    return null;
  }
}

/** Append a heartbeat line. Used by the Fake Agent (and future adapters). */
export function appendHeartbeat(agentId: string, kind: string): void {
  const p = activityPath(agentId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: Date.now(), kind }) + '\n', 'utf-8');
}

/** Test whether a process is alive. `process.kill(pid, 0)` is the portable check. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Last attention event of a given agent in state.json, if any. */
function lastEventForAgent(events: StateEvent[], agentId: string): StateEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].agent_id === agentId) return events[i];
  }
  return null;
}

/** Build a complete ObservationInput for one agent at the current moment. */
export function collectObservation(
  agent: Agent,
  stateEvents: StateEvent[],
  now: number,
): import('./types').ObservationInput {
  const pid = agent.target?.pid ?? null;
  // If no explicit target.pid, use current process as fallback (for testing).
  const effectivePid = pid ?? process.pid;
  const pidAlive = effectivePid > 0 && isProcessAlive(effectivePid);

  const hb = readActivityHeartbeat(agent.agent_id);
  const lastActivityAgeMs = hb ? now - hb.lastTs : null;

  const lastEvent = lastEventForAgent(stateEvents, agent.agent_id);
  const lastEventType = lastEvent?.type ?? null;
  const lastEventAgeMs = lastEvent ? now - lastEvent.timestamp : null;

  const recentPermissionEvent = !!(lastEvent
    && lastEvent.type === 'permission_required'
    && lastEventAgeMs !== null && lastEventAgeMs <= T.PERMISSION_WINDOW_MS);
  const recentInputEvent = !!(lastEvent
    && lastEvent.type === 'input_required'
    && lastEventAgeMs !== null && lastEventAgeMs <= T.INPUT_WINDOW_MS);
  const recentTerminalEvent = !!(lastEvent
    && (lastEvent.type === 'completed' || lastEvent.type === 'failed')
    && lastEventAgeMs !== null && lastEventAgeMs <= T.TERMINAL_WINDOW_MS);

  return {
    agentId: agent.agent_id,
    pidAlive,
    lastActivityAgeMs: hb ? now - hb.lastTs : null,
    lastEventType: lastEvent?.type ?? null,
    lastEventAgeMs: lastEvent ? now - lastEvent.timestamp : null,
    recentPermissionEvent,
    recentInputEvent,
    recentTerminalEvent,
    exitCode: null, // not observable without a wrapper; left null for Phase 1
  };
}

/** Snapshot every registered agent's observation input at once. */
export function collectAll(now: number = Date.now()): {
  agent: Agent;
  input: import('./types').ObservationInput;
}[] {
  const registry = readRegistry();
  const state = readState(path.join(stateDir(), 'state.json'));
  return registry.agents.map((agent) => ({
    agent,
    input: collectObservation(agent, state.events, now),
  }));
}
