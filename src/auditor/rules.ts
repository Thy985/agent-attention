/**
 * Attention Auditor — rules + data structures.
 *
 * The Auditor is a purely observational, read-only scanner that inspects the
 * existing state (events + registry) and emits *suspicion* records (not bugs).
 * It does not modify state.json, never calls agent-notify, and never decides
 * "this IS a bug" — it only says "this looks suspicious".
 *
 * Rules in Phase 1:
 *   FP-DUP-001   burst: same agent+type within short window, too many → duplicate_burst
 *   FP-MSG-002   trivial message: too short or known-stopword after critical event types
 *   FP-SEM-003   semantic mismatch: completed/failed but message contains running indicators
 *   FP-P0-004    priority abuse: agent sending >80% P0 over a window → priority_misuse_candidate
 *   FP-BURST-005 high throughput: single agent >N events/min → burst_candidate
 *   FN-EXIT-001  process exited without terminal attention event → possible_missed_notification
 *
 * All findings are *candidates*. Status defaults to 'open'. The human / the
 * Auditor's own confirm endpoint triages.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { StateEvent, readState } from '../state/AttentionState';
import { readRegistry } from '../registry';

export type FindingSeverity = 'info' | 'warning' | 'error';
export type FindingStatus = 'open' | 'confirmed' | 'rejected' | 'resolved' | 'ignored';

export interface AuditRule {
  id: string;
  type: 'false_positive' | 'missed_notification' | 'priority_misuse';
  check(events: StateEvent[], agents: import('../registry').Agent[]): AuditFinding[];
}

export interface AuditFinding {
  finding_id: string;
  rule_id: string;
  agent_id: string;
  event_id?: string;
  type: string; // descriptive noun, e.g. "duplicate_burst" / "semantic_mismatch"
  severity: FindingSeverity;
  confidence: number;
  evidence_strength: 'E0' | 'E1' | 'E2' | 'E3';
  status: FindingStatus;
  evidence: Record<string, unknown>;
  reason: string;
  timestamp: number;
  occurrences: number;
  first_seen: number;
  last_seen: number;
}

let _findingSeq = 0;

function nextId(ruleId: string): string {
  _findingSeq += 1;
  return `AF-${ruleId}-${_findingSeq.toString().padStart(4, '0')}`;
  // note: non-deterministic across runs but sufficient for a per-run scan
}

function stateDir(): string {
  return process.env.AGENT_ATTENTION_HOME
    ?? path.join(os.homedir(), '.agent-attention');
}

// ── FP-DUP-001: burst duplicates ────────────────────────────────────────────
export function checkDuplicateBurst(events: StateEvent[], agents: import('../registry').Agent[]): AuditFinding[] {
  const windowMs = 30_000;
  const threshold = 5;
  const findings: AuditFinding[] = [];
  const grouped = new Map<string, StateEvent[]>();
  for (const ev of events) {
    const key = `${ev.agent_id}|${ev.type}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(ev);
  }
  for (const [key, group] of grouped) {
    for (let i = 0; i < group.length; i++) {
      const window = group.filter((e, j) => j >= i && e.timestamp - group[i].timestamp <= windowMs);
      if (window.length < threshold) continue;
      const agentId = key.split('|')[0];
      const ev = group[i];
      findings.push({
        finding_id: nextId('FP-DUP-001'),
        rule_id: 'FP-DUP-001',
        agent_id: agentId,
        event_id: ev.id,
        type: 'duplicate_burst',
        severity: 'warning',
        confidence: Math.min(0.95, 0.6 + window.length * 0.05),
        evidence_strength: 'E1',
        status: 'open',
        evidence: { window_ms: windowMs, count: window.length, threshold },
        reason: `${window.length} ${group[i].type} events for ${agentId} within ${windowMs}ms`,
        timestamp: Date.now(),
        occurrences: window.length,
        first_seen: ev.timestamp,
        last_seen: window[window.length - 1].timestamp,
      });
      // skip ahead to avoid duplicates in same burst
      i += window.length - 1;
    }
  }
  return findings;
}

// ── FP-MSG-002: trivial / stopword message ──────────────────────────────────
export function checkTrivialMessage(events: StateEvent[], _agents: import('../registry').Agent[]): AuditFinding[] {
  const stopwords = new Set(['test', 'hello', 'hi', 'done', 'ok', '...', 'x', 'a']);
  return events
    .filter((e) => {
      if (e.read) return false; // only suspicious unread / unverified ones
      const words = e.message.trim().split(/\s+/);
      if (e.message.length < 3 && words.length <= 1) return true;
      if (stopwords.has(e.message.trim().toLowerCase())) return true;
      return false;
    })
    .map((e) => ({
      finding_id: nextId('FP-MSG-002'),
      rule_id: 'FP-MSG-002',
      agent_id: e.agent_id,
      event_id: e.id,
      type: 'trivial_message',
      severity: 'info',
      confidence: 0.55,
      evidence_strength: 'E0',
      status: 'open',
      evidence: { message_length: e.message.length, message: e.message.substring(0, 80) },
      reason: `trivial message: "${e.message.substring(0, 60)}"`,
      timestamp: Date.now(),
      occurrences: 1,
      first_seen: e.timestamp,
      last_seen: e.timestamp,
    }));
}

// ── FP-SEM-003: terminal event but message contains running indicators ──────
export function checkSemanticMismatch(events: StateEvent[], _agents: import('../registry').Agent[]): AuditFinding[] {
  const runningWords = ['running', 'starting', 'loading', 'processing', 'in progress', 'ongoing'];
  return events
    .filter((e) => {
      if (e.type !== 'completed' && e.type !== 'failed') return false;
      const lower = e.message.toLowerCase();
      return runningWords.some((w) => lower.includes(w));
    })
    .map((e) => ({
      finding_id: nextId('FP-SEM-003'),
      rule_id: 'FP-SEM-003',
      agent_id: e.agent_id,
      event_id: e.id,
      type: 'terminal_semantic_mismatch',
      severity: 'warning',
      confidence: 0.75,
      evidence_strength: 'E0',
      status: 'open',
      evidence: { type: e.type, message: e.message.substring(0, 120) },
      reason: `agent reports ${e.type} but message implies ongoing work`,
      timestamp: Date.now(),
      occurrences: 1,
      first_seen: e.timestamp,
      last_seen: e.timestamp,
    }));
}

// ── FP-P0-004: priority abuse ──────────────────────────────────────────────
export function checkPriorityAbuse(events: StateEvent[], agents: import('../registry').Agent[]): AuditFinding[] {
  const MIN = 5;
  const grouped = new Map<string, StateEvent[]>();
  for (const e of events) {
    if (!grouped.has(e.agent_id)) grouped.set(e.agent_id, []);
    grouped.get(e.agent_id)!.push(e);
  }
  const findings: AuditFinding[] = [];
  for (const [agentId, group] of grouped) {
    if (group.length < MIN) continue;
    const p0Count = group.filter((e) => e.priority === 'P0').length;
    const ratio = p0Count / group.length;
    if (ratio < 0.8) continue;
    findings.push({
      finding_id: nextId('FP-P0-004'),
      rule_id: 'FP-P0-004',
      agent_id: agentId,
      type: 'priority_misuse_candidate',
      severity: 'info',
      confidence: Math.min(0.9, ratio * 0.8),
      evidence_strength: 'E0',
      status: 'open',
      evidence: { p0_count: p0Count, total: group.length, ratio },
      reason: `${agentId}: ${Math.round(ratio * 100)}% P0 over ${group.length} events`,
      timestamp: Date.now(),
      occurrences: p0Count,
      first_seen: group[0].timestamp,
      last_seen: group[group.length - 1].timestamp,
    });
  }
  return findings;
}

// ── FP-BURST-005: throughput burst ──────────────────────────────────────────
export function checkThroughputBurst(events: StateEvent[], agents: import('../registry').Agent[]): AuditFinding[] {
  const perMin = 20;
  const grouped = new Map<string, StateEvent[]>();
  for (const e of events) {
    if (!grouped.has(e.agent_id)) grouped.set(e.agent_id, []);
    grouped.get(e.agent_id)!.push(e);
  }
  const findings: AuditFinding[] = [];
  for (const [agentId, group] of grouped) {
    if (group.length < perMin) continue;
    const spanSec = (group[group.length - 1].timestamp - group[0].timestamp) / 1000;
    if (spanSec <= 0) continue;
    const rate = group.length / (spanSec / 60);
    if (rate < perMin) continue;
    findings.push({
      finding_id: nextId('FP-BURST-005'),
      rule_id: 'FP-BURST-005',
      agent_id: agentId,
      type: 'burst_candidate',
      severity: 'warning',
      confidence: Math.min(0.9, rate / perMin * 0.6),
      evidence_strength: 'E1',
      status: 'open',
      evidence: { rate_per_min: Math.round(rate), window_sec: Math.round(spanSec) },
      reason: `${agentId}: ${Math.round(rate)} events/min over ${Math.round(spanSec)}s`,
      timestamp: Date.now(),
      occurrences: group.length,
      first_seen: group[0].timestamp,
      last_seen: group[group.length - 1].timestamp,
    });
  }
  return findings;
}

// ── FN-EXIT-001: process exited without terminal event ─────────────────────
export function checkMissedTerminal(events: StateEvent[], agents: import('../registry').Agent[]): AuditFinding[] {
  const windowMs = 10_000;
  const now = Date.now();
  const findings: AuditFinding[] = [];
  for (const a of agents) {
    const pid = a.target?.pid;
    if (!pid || pid <= 0) continue;
    try { process.kill(pid, 0); continue; } catch { /* exited */ }

    const agentEvents = events
      .filter((e) => e.agent_id === a.agent_id)
      .sort((x, y) => x.timestamp - y.timestamp);
    const lastEv = agentEvents[agentEvents.length - 1];
    if (!lastEv) continue;
    if (lastEv.type === 'completed' || lastEv.type === 'failed') continue;
    if (now - lastEv.timestamp > windowMs) continue; // too long ago, not relevant
    findings.push({
      finding_id: nextId('FN-EXIT-001'),
      rule_id: 'FN-EXIT-001',
      agent_id: a.agent_id,
      type: 'possible_missed_notification',
      severity: 'warning',
      confidence: 0.68,
      evidence_strength: 'E1',
      status: 'open',
      evidence: { pid, last_event: lastEv.type, last_event_at: lastEv.timestamp },
      reason: `agent ${a.agent_id} (pid=${pid}) exited with no terminal event within ${windowMs}ms`,
      timestamp: now,
      occurrences: 1,
      first_seen: now,
      last_seen: now,
    });
  }
  return findings;
}

// ── rule table ────────────────────────────────────────────────────────────────
export const RULES: AuditRule[] = [
  { id: 'FP-DUP-001', type: 'false_positive', check: checkDuplicateBurst },
  { id: 'FP-MSG-002', type: 'false_positive', check: checkTrivialMessage },
  { id: 'FP-SEM-003', type: 'false_positive', check: checkSemanticMismatch },
  { id: 'FP-P0-004', type: 'priority_misuse', check: checkPriorityAbuse },
  { id: 'FP-BURST-005', type: 'false_positive', check: checkThroughputBurst },
  { id: 'FN-EXIT-001', type: 'missed_notification', check: checkMissedTerminal },
];

/**
 * Scan state.json + agents.json against all rules and return raw findings.
 * Appends them (or re-opens existing open findings) to audit.jsonl.
 */
export function runAudit(opts: { merge?: boolean } = {}): AuditFinding[] {
  const stateDirPath = stateDir();
  const state = readState(path.join(stateDirPath, 'state.json'));
  const registry = readRegistry();
  let all = RULES.flatMap((r) => r.check(state.events, registry.agents));
  if (!opts.merge) return all;

  // Merge: replace already-open findings with the same rule_id + event_id
  const existing: AuditFinding[] = [];
  try {
    const raw = fs.readFileSync(path.join(stateDirPath, 'audit.jsonl'), 'utf-8');
    for (const line of raw.split('\n').filter((l) => l.trim())) {
      try { existing.push(JSON.parse(line) as AuditFinding); } catch { /* skip */ }
    }
  } catch { /* no file yet */ }
  const existingKey = (f: AuditFinding) => `${f.rule_id}|${f.event_id ?? 'n/a'}`;
  const byKey = new Map(existing.map((f) => [existingKey(f), f]));
  // Only keep current findings that don't already exist open
  const newOnly = all.filter((f) => {
    const k = existingKey(f);
    const prev = byKey.get(k);
    if (prev && prev.status !== 'resolved' && prev.status !== 'rejected') return false;
    return true;
  });
  // Append any new + bump occurrences on matches
  const merged = [...existing];
  for (const n of newOnly) merged.push(n);
  const p = path.join(stateDirPath, 'audit.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, merged.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  return merged;
}

export function readFindings(): AuditFinding[] {
  const p = path.join(stateDir(), 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditFinding);
  } catch { return []; }
}
