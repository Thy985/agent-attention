/**
 * Claude Code hook handler.
 *
 * Claude Code invokes hooks by spawning the configured command and writing a
 * JSON event object to stdin (one line, newline-terminated). The hook process
 * must exit 0 within its timeout — stderr/stdout are ignored by the caller.
 *
 * Expected stdin shape (Claude Code "Stop" hook):
 *   {
 *     "sessionId": string,
 *     "exitStatus": 0 | 1 | 2,   // 0 = normal stop, 1 = error, 2 = user cancel
 *     "turns": number,            // how many turns in this session
 *     "agentId": string | null,  // injected if agent declared identity
 *     ...
 *   }
 *
 * This module reads that JSON, determines the notification event, and records
 * it via `recordEvent`. If stdin is not valid JSON or the shape is unrecognised,
 * the process exits 0 silently (hook failures must never crash Claude).
 *
 * The CLI subcommand is `agent-attention hook` — invoked with no extra args;
 * stdin is the hook payload.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordEvent } from './state/AttentionState';
import { autoDetectAndRegister } from './registry';
import { log, generateCorrelationId } from './logging';

const STATE_PATH = path.join(
  process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention'),
  'state.json',
);

interface ClaudeHookPayload {
  sessionId?: string;
  exitStatus?: number;
  turns?: number;
  agentId?: string;
  cwd?: string;
  [key: string]: unknown;
}

/**
 * Determine which event to emit based on the hook payload.
 *
 * Rules (detection-driven, not judgment-driven):
 *   - exitStatus === 0 and turns > 0 → completed (agent finished a session)
 *   - exitStatus === 2               → input_required (user cancelled, might need attention)
 *   - exitStatus === 1               → failed (agent encountered an error)
 *   - no exitStatus at all           → treat as completed if turns > 0, else ignore
 */
function inferEvent(payload: ClaudeHookPayload): { event: string; message: string } | null {
  const status = payload.exitStatus;
  const turns = payload.turns ?? 0;
  const sessionId = (payload.sessionId as string | undefined) ?? 'unknown';

  if (status === 0 && turns > 0) {
    return {
      event: 'completed',
      message: `Claude Code session ended cleanly (${turns} turn${turns > 1 ? 's' : ''}, session ${sessionId.slice(0, 8)})`,
    };
  }
  if (status === 1) {
    return {
      event: 'failed',
      message: `Claude Code session failed (exit=${status}, session ${sessionId.slice(0, 8)}`,
    };
  }
  if (status === 2) {
    return {
      event: 'input_required',
      message: `Claude Code session cancelled by user (session ${sessionId.slice(0, 8)})`,
    };
  }
  // No exitStatus — session may still be in progress; best-effort skip.
  return null;
}

function runHook(): void {
  let body = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    body += chunk;
  });
  process.stdin.on('end', () => {
    if (!body.trim()) {
      // Empty stdin — nothing to do.
      process.exit(0);
    }

    let payload: ClaudeHookPayload;
    try {
      payload = JSON.parse(body) as ClaudeHookPayload;
    } catch {
      // Malformed JSON — silent ignore.
      process.exit(0);
    }

    const resolved = autoDetectAndRegister();
    const agentId: string = String(payload.agentId ?? resolved.agentId);
    const agentName: string = String(payload.agentName ?? resolved.agentName ?? 'unknown');
    const eventInfo = inferEvent(payload);
    if (!eventInfo) {
      // No actionable event — nothing to notify.
      process.exit(0);
    }

    const correlationId = generateCorrelationId();
    try {
      recordEvent(STATE_PATH, {
        type: eventInfo.event as Parameters<typeof recordEvent>[1]['type'],
        priority: eventInfo.event === 'completed'
          ? 'P2'
          : eventInfo.event === 'failed'
            ? 'P1'
            : 'P0',
        agent_id: agentId,
        agent_name: agentName,
        title: `${agentName}: ${eventInfo.event}`,
        message: eventInfo.message,
        timestamp: Date.now(),
        correlation_id: correlationId,
      });
      log({
        component: 'hook',
        level: 'INFO',
        event: 'hook_handled',
        message: `${agentId} → ${eventInfo.event}: ${eventInfo.message}`,
        correlation_id: correlationId,
        context: { sessionId: payload.sessionId, exitStatus: payload.exitStatus, turns: payload.turns },
      });
    } catch (err) {
      // Best-effort: hook must never block Claude.
      log({
        component: 'hook',
        level: 'ERROR',
        event: 'hook_failed',
        message: `failed to record hook event: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    process.exit(0);
  });
}

function main(): void {
  runHook();
}

main();
