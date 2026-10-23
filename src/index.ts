#!/usr/bin/env node
import { resolveStateDir } from './paths';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { deliver } from './platform';
import { receiveEvent } from './core/receive';
import { loadConfig } from './config';
import { EventName, EVENT_PRIORITY } from './events';
import { recordEvent } from './state';
import { log, generateCorrelationId } from './logging';
import { autoDetectAndRegister } from './registry';
import { checkCompliance } from './discover';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const STATE_DIR = resolveStateDir();
const STATE_PATH = path.join(STATE_DIR, 'state.json');

/**
 * Extract positional args (event, message) from yargs result.
 * Supports both:
 *   - Positional: agent-notify completed "msg"
 *   - Flags:      agent-notify --event completed --message "msg"
 */
function extractArgs(argv: string[]): { event: string; message: string } {
  const parsed = yargs(argv)
    .version(false)
    .option('event', { alias: 'e', type: 'string' })
    .option('message', { alias: 'm', type: 'string' })
    .help(false)
    .parseSync();

  // First try flags
  let event = parsed.event as string | undefined;
  let message = parsed.message as string | undefined;

  // Fall back to positional (first two non-flag args)
  if (!event || !message) {
    const positional = (parsed._ as (string | number)[]).map(String);
    if (!event && positional.length > 0) event = positional[0];
    if (!message && positional.length > 1) message = positional[1];
  }

  return { event: event ?? '', message: message ?? '' };
}

async function main(): Promise<void> {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: agent-notify <event> <message>');
    console.log('Events: completed | permission_required | input_required | failed');
    console.log('Records an explicit task report. Desktop delivery depends on platform capability.');
    return;
  }
  const { event: eventName, message } = extractArgs(hideBin(process.argv));
  const correlationId = generateCorrelationId();

  if (!eventName || !message) {
    console.error('Usage: agent-notify <event> <message>');
    console.error('Events: completed | permission_required | input_required | failed');
    process.exit(1);
  }

  // Validate event type
  const validEvents = ['completed', 'permission_required', 'input_required', 'failed'] as const;
  if (!(validEvents as readonly string[]).includes(eventName)) {
    console.error(`Unknown event: "${eventName}". Valid: ${validEvents.join(', ')}`);
    process.exit(1);
  }

  // Load config (best-effort: proceed with defaults on failure)
  let config;
  try {
    config = loadConfig();
  } catch {
    config = { enabled: true, sound: { enabled: true }, events: {} as Record<string, boolean> };
  }

  if (!config.enabled) {
    log({ component: 'cli', level: 'INFO', event: 'gated', message: `notification suppressed: disabled`, correlation_id: correlationId, context: { event: eventName, reason: 'disabled' } });
    process.exit(0);
  }

  const eventEnabled = config.events?.[eventName] ?? true;
  if (!eventEnabled) {
    log({ component: 'cli', level: 'INFO', event: 'gated', message: `notification suppressed: ${eventName} disabled`, correlation_id: correlationId, context: { event: eventName, reason: 'event-disabled' } });
    process.exit(0);
  }

  // Auto-detect and register agent (AC-02) — per-process stable id
  const { agentId, agentName } = autoDetectAndRegister();
  // Warn if still using anonymous identity (AGENT_ID was not set)
  if (agentId === 'anonymous') {
    console.warn(
      '[agent-attention] WARNING: running as anonymous agent. ' +
      'Set AGENT_ID/AGENT_NAME env vars or run: agent-attention agent register <id> "<name>"',
    );
  }

  // Dedup check (best-effort) — AC-07: key includes agent+event+message
  const sessionId = process.env.AGENT_ATTENTION_SESSION_ID || undefined;
  const taskId = process.env.AGENT_ATTENTION_TASK_ID || undefined;
  const sourceEventId = process.env.AGENT_ATTENTION_EVENT_ID || undefined;
  const processExit = process.env.AGENT_ATTENTION_PROCESS_EXIT;
  const evidence = processExit
    ? { contract: 'process-exit/v1', mechanism: 'wrapper' as const, basis: 'process_observation' as const, scope: 'process' as const }
    : { contract: 'manual-cli/v1', mechanism: 'cli' as const, basis: 'explicit_report' as const, scope: 'task' as const };
  let duplicate = false;
  // P0 fix: state must be written BEFORE notify so a state-write failure
  // never produces an orphaned toast. Notification is best-effort: if the
  // toast fails the event is still recorded in state.json.
  try {
    // F2 (package smoke): ensure the state dir exists so agent-notify works on a
    // fresh install before the daemon/installer has ever run (AC-04).
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const priority = EVENT_PRIORITY[eventName as EventName];
    log({ component: 'cli', level: 'INFO', event: 'notify_called', message: `${eventName}: ${message.substring(0, 80)}`, correlation_id: correlationId, context: { agent_id: agentId, event: eventName, priority } });
    // AC-06: compliance tracking — log whether this notification follows the protocol
    const compliant = checkCompliance(agentId, eventName);
    log({ component: 'cli', level: compliant ? 'INFO' : 'WARN', event: 'compliance_check', message: `${agentName} notification ${eventName} is ${compliant ? 'valid' : 'unexpected'}`, correlation_id: correlationId, context: { agent_id: agentId, event: eventName, priority, compliant } });
    const receipt = receiveEvent(STATE_PATH, {
      type: eventName as EventName,
      priority,
      agent_id: agentId,
      agent_name: agentName,
      title: `${agentName}: ${eventName}`,
      message,
      timestamp: Date.now(),
      correlation_id: correlationId,
      session_id: sessionId, task_id: taskId, source_event_id: sourceEventId,
      source_event: processExit ? `process_exit(${processExit})` : 'manual_report', evidence,
    }, 30_000);
    duplicate = receipt.duplicate;
  } catch (stateErr) {
    console.error(`State write failed: ${stateErr instanceof Error ? stateErr.message : String(stateErr)}`);
    process.exit(1);
  }

  if (duplicate) {
    console.log(JSON.stringify({ recorded: true, delivery: 'suppressed', reason: 'retained-event-dedup' }));
    return;
  }

  try {
    const delivery = await deliver(eventName as EventName, message, config.sound?.enabled ?? true);
    console.log(JSON.stringify({ recorded: true, delivery: delivery.status, reason: delivery.reason }));
    log({ component: 'cli', level: 'INFO', event: 'exit_success', message: 'event recorded; platform delivery result reported' });
    process.exit(0);
  } catch (err) {
    log({ component: 'cli', level: 'WARN', event: 'notify_failed', message: `notification failed: ${err instanceof Error ? err.message : String(err)}`, correlation_id: correlationId });
    console.error(`Notification failed (event still recorded): ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }
}

main();
