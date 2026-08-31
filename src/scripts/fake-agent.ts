#!/usr/bin/env node
/**
 * Deterministic Fake Agent — validates the Observer state machine with
 * controlled scenarios, so "is the algorithm right?" is decoupled from
 * "is the real-agent integration working?".
 *
 * Usage:
 *   fake-agent --scenario working --sleep 10
 *   fake-agent --scenario waiting-input --sleep 30
 *   fake-agent --scenario permission --sleep 30
 *   fake-agent --scenario blocked --sleep 60
 *   fake-agent --scenario completed
 *   fake-agent --scenario failed
 *
 * What each scenario does:
 *   working         — registers + writes an activity heartbeat every 2s,
 *                      never emits a terminal event, exits 0 after --sleep.
 *   waiting-input   — emits input_required, then stays alive (no activity)
 *                      until --sleep elapses, exits 0.
 *   permission      — emits permission_required, then stays alive until sleep.
 *   blocked        — registers, then stays completely silent (no heartbeat,
 *                      no event) until --sleep elapses, exits 0.
 *   completed      — emits completed, exits 0 immediately.
 *   failed         — emits failed, exits 1 immediately.
 *
 * The Fake Agent writes heartbeats to observed/<agent_id>.jsonl, which the
 * Observer's collector reads. It does NOT write to state.json directly — it
 * uses the normal agent-notify entry point so the event path is realistic.
 */
import * as path from 'path';
import * as os from 'os';
import { registerAgent, updateAgentTarget, AgentTarget } from '../registry';
import { appendHeartbeat } from '../observer/collector';
import { recordEvent } from '../state';
import { log } from '../logging';

const STATE_DIR = process.env.AGENT_ATTENTION_HOME
  ?? path.join(os.homedir(), '.agent-attention');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

interface ParsedArgs {
  scenario: string;
  sleep: number;
  agentId: string;
  agentName: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const scenarioIdx = argv.indexOf('--scenario');
  const sleepIdx = argv.indexOf('--sleep');
  const idIdx = argv.indexOf('--agent-id');
  const nameIdx = argv.indexOf('--agent-name');
  const scenario = scenarioIdx >= 0 ? argv[scenarioIdx + 1] : 'working';
  const sleep = sleepIdx >= 0 ? parseInt(argv[sleepIdx + 1] ?? '10', 10) : 10;
  const agentId = idIdx >= 0 ? argv[idIdx + 1] : 'fake-agent';
  const agentName = nameIdx >= 0 ? argv[nameIdx + 1] : 'Fake Agent';
  return { scenario, sleep, agentId, agentName };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function emitEvent(type: 'completed' | 'failed' | 'input_required' | 'permission_required', message: string): void {
  const priority = type === 'failed' ? 'P1' : type === 'completed' ? 'P2' : 'P0';
  recordEvent(STATE_PATH, {
    type,
    priority: priority as 'P0' | 'P1' | 'P2',
    agent_id: process.env.FAKE_AGENT_ID ?? 'fake-agent',
    agent_name: 'Fake Agent',
    title: `Fake Agent: ${type}`,
    message,
    timestamp: Date.now(),
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const validScenarios = ['working', 'waiting-input', 'permission', 'blocked', 'completed', 'failed'];
  if (!validScenarios.includes(args.scenario)) {
    console.error(`Unknown scenario: ${args.scenario}. Valid: ${validScenarios.join(', ')}`);
    process.exit(2);
  }

  // Register self + set target.pid so the Observer can track the process.
  registerAgent(args.agentId, args.agentName, { integration: 'skill' });
  const target: AgentTarget = { type: 'terminal', pid: process.pid };
  updateAgentTarget(args.agentId, target);

  // The Fake Agent env so emitEvent reads the right id.
  process.env.FAKE_AGENT_ID = args.agentId;

  log({ component: 'fake-agent', level: 'INFO', event: 'scenario_start', message: `${args.agentId} scenario=${args.scenario} sleep=${args.sleep}s pid=${process.pid}` });

  switch (args.scenario) {
    case 'working': {
      // Heartbeat every 2s to simulate tool activity; never emit terminal.
      const end = Date.now() + args.sleep * 1000;
      while (Date.now() < end) {
        appendHeartbeat(args.agentId, 'tool_call');
        await sleep(2000);
      }
      log({ component: 'fake-agent', level: 'INFO', event: 'scenario_end', message: 'working done' });
      process.exit(0);
    }

    case 'waiting-input': {
      emitEvent('input_required', `Fake Agent needs input (scenario: waiting-input)`);
      await sleep(args.sleep * 1000);
      process.exit(0);
    }

    case 'permission': {
      emitEvent('permission_required', `Fake Agent needs permission (scenario: permission)`);
      await sleep(args.sleep * 1000);
      process.exit(0);
    }

    case 'blocked': {
      // Completely silent — no heartbeat, no event. Process stays alive.
      await sleep(args.sleep * 1000);
      log({ component: 'fake-agent', level: 'INFO', event: 'scenario_end', message: 'blocked done' });
      process.exit(0);
    }

    case 'completed': {
      emitEvent('completed', `Fake Agent completed (scenario: completed)`);
      process.exit(0);
    }

    case 'failed': {
      emitEvent('failed', `Fake Agent failed (scenario: failed)`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(`fake-agent failed: ${err}`);
  process.exit(1);
});
