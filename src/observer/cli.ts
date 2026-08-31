/**
 * `agent-attention observe` — Phase 1 one-shot / watch CLI.
 *
 * Snapshot (default): print each agent's observed state + candidate + policy.
 * --watch: re-run every interval, so the user can see state transitions
 *   WORKING → BLOCKED_CANDIDATE → (escalated) over time, without entering
 *   the daemon — this is a *validation harness*, not a resident supervisor.
 *
 * Output goes to stdout (human) and observe.jsonl (machine, for the Auditor).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { collectAll } from './collector';
import { observeAgent } from './state-machine';
import { evaluatePolicy } from './policy';

function stateDir(): string {
  return process.env.AGENT_ATTENTION_HOME
    ?? path.join(os.homedir(), '.agent-attention');
}

function observeJsonlPath(): string {
  return path.join(stateDir(), 'observe.jsonl');
}

interface ObserveRecord {
  timestamp: number;
  candidates: CombinedRow[];
}

type CombinedRow = {
  candidate: import('./types').ObservationCandidate;
  policy: import('./policy').PolicyDecision;
};

export function runObserve(args: string[]): void {
  const watch = args.includes('--watch') || args.includes('-w');
  const intervalArg = args.indexOf('--interval');
  const intervalMs = intervalArg >= 0 && args[intervalArg + 1]
    ? Math.max(1000, parseInt(args[intervalArg + 1], 10) || 5000)
    : 2000;

  const runOnce = () => {
    const snapshot = collectAll();
    const rows: CombinedRow[] = snapshot.map(({ input }) => {
      const candidate = observeAgent(input);
      const policy = evaluatePolicy(candidate);
      return { candidate, policy };
    });
    printHuman(rows);
    appendJsonl(rows);
  };

  if (!watch) {
    runOnce();
    return;
  }

  // --watch: keep running; Ctrl+C exits.
  console.log('Observing (Ctrl+C to stop)...\n');
  runOnce();
  const timer = setInterval(() => {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen
    runOnce();
  }, intervalMs);
  process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
}

function printHuman(rows: CombinedRow[]): void {
  if (rows.length === 0) {
    console.log('No agents registered.\n  Run: agent-attention agent register <id> "<name>"');
    return;
  }
  console.log('Agent Attention Observer\n');
  for (const { candidate, policy } of rows) {
    const stateLabel = candidate.state.replace(/_/g, ' ').toUpperCase();
    const action = policy.action === 'attention'
      ? `${policy.action.toUpperCase()} (${policy.priority})`
      : 'silent';
    console.log(`${candidate.agent_id}`);
    console.log(`  state:     ${stateLabel}`);
    console.log(`  confidence: ${candidate.confidence.toFixed(2)}  evidence: ${candidate.evidence_strength}`);
    console.log(`  evidence:  ${candidate.observations.join(', ')}`);
    console.log(`  reason:    ${candidate.reason}`);
    console.log(`  policy:    ${action}  [${policy.rule}]${policy.requires_human ? '  ⚠ requires human' : ''}`);
    console.log('');
  }
}

function appendJsonl(rows: CombinedRow[]): void {
  const p = observeJsonlPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const record = {
    timestamp: Date.now(),
    candidates: rows.map(({ candidate, policy }) => ({ candidate, policy })),
  };
  fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf-8');
}
