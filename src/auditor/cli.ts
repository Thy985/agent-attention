/**
 * `agent-attention audit` — Phase 1 CLI for the Attention Auditor.
 *
 * Scan state.json + agents.json against a small set of heuristic rules and
 * write structured *findings* (suspicious, not decided) to audit.jsonl.
 *
 * Usage:
 *   agent-attention audit               # one-shot scan, print to stdout
 *   agent-attention audit --merge       # merge with existing open findings
 *   agent-attention audit list          # print current findings
 *   agent-attention audit show <id>     # inspect one finding
 *   agent-attention audit confirm <id>  # mark confirmed
 *   agent-attention audit reject <id>   # mark rejected
 *   agent-attention audit resolved <id> # mark resolved
 *   agent-attention audit ignore <id>   # mark ignored
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runAudit, readFindings, AuditFinding } from './rules';

export function runAuditCli(args: string[]): void {
  const action = args[0];

  if (!action || action === '--merge') {
    // default: run scan
    const merge = args.includes('--merge');
    const findings = runAudit({ merge });
    printFindings(findings);
    return;
  }

  if (action === 'list') {
    printFindings(readFindings());
    return;
  }

  const idActions = ['show', 'confirm', 'reject', 'resolved', 'ignore'];
  if (!idActions.includes(action)) {
    console.error(`Unknown audit subcommand: ${action}. Valid: ${idActions.join(', ')}, list, --merge`);
    process.exit(1);
  }

  const id = args[1];
  if (!id) {
    console.error(`Usage: agent-attention audit ${action} <finding-id>`);
    process.exit(1);
  }
  const all = readFindings();
  const idx = all.findIndex((f) => f.finding_id === id);
  if (idx < 0) {
    console.error(`Finding ${id} not found.`);
    process.exit(1);
  }
  if (action === 'show') {
    printOne(all[idx]);
    return;
  }
  const statusMap: Record<string, AuditFinding['status']> = {
    confirm: 'confirmed',
    reject: 'rejected',
    resolved: 'resolved',
    ignore: 'ignored',
  };
  const newStatus = statusMap[action];
  all[idx] = { ...all[idx], status: newStatus };
  const p = path.join(os.homedir(), '.agent-attention', 'audit.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, all.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  console.log(`Updated ${id} → ${newStatus}`);
}

function printOne(f: AuditFinding): void {
  console.log(`${f.finding_id}  ${f.status.toUpperCase()}  ${f.rule_id}  ${f.type}`);
  console.log(`  agent:      ${f.agent_id}`);
  console.log(`  severity:   ${f.severity}  confidence: ${f.confidence.toFixed(2)}  evidence: ${f.evidence_strength}`);
  console.log(`  reason:     ${f.reason}`);
  console.log(`  evidence:   ${JSON.stringify(f.evidence)}`);
  console.log(`  occ:        ${f.occurrences}  first: ${new Date(f.first_seen).toISOString()}  last: ${new Date(f.last_seen).toISOString()}`);
}

function printFindings(findings: AuditFinding[]): void {
  if (findings.length === 0) {
    console.log('No findings.');
    return;
  }
  console.log(`Findings (${findings.length}):\n`);
  const summaryByType = new Map<string, number>();
  for (const f of findings) summaryByType.set(f.type, (summaryByType.get(f.type) ?? 0) + 1);
  console.log('Summary:');
  for (const [t, n] of summaryByType) console.log(`  ${t.padEnd(30)} ${n}`);
  console.log('\n---\n');
  for (const f of findings) {
    printOne(f);
    console.log('');
  }
}
