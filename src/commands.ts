/**
 * Command handlers shared between the CLI (daemon-cli.ts) and the IPC RPC layer.
 * M6b: these functions are called both by the Node CLI and by the daemon's
 * in-process IPC command handlers.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { clearUnread, markRead } from './state/AttentionState';
import { getAgent } from './registry';
import { jumpToTarget } from './jump';
import { AgentTarget } from './jump';

const STATE_DIR = path.join(os.homedir(), '.agent-attention');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

/**
 * Mark all events as read. Returns { ok, code }.
 */
export function cmdMarkAllRead(): { ok: boolean; code: number } {
  if (!fs.existsSync(STATE_PATH)) {
    return { ok: false, code: 1 };
  }
  clearUnread(STATE_PATH);
  return { ok: true, code: 0 };
}

/**
 * Mark a single event as read. Returns { ok, code }.
 */
export function cmdMarkEvent(eventId: string): { ok: boolean; code: number } {
  if (!fs.existsSync(STATE_PATH)) {
    return { ok: false, code: 1 };
  }
  markRead(STATE_PATH, eventId);
  return { ok: true, code: 0 };
}

/**
 * Jump to an agent's terminal target. Returns { ok, code, error? }.
 */
export function cmdJump(agentId: string): { ok: boolean; code: number; error?: string } {
  const agent = getAgent(agentId);
  if (agent === undefined) {
    return { ok: false, code: 1, error: `Agent "${agentId}" not found` };
  }
  if (!agent.target) {
    return { ok: false, code: 1, error: `Agent "${agentId}" has no target` };
  }
  jumpToTarget(agent.target);
  return { ok: true, code: 0 };
}

/** Dispatch a command by name and args. Used by IPC RPC handler. */
export async function dispatchCommand(
  command: string,
  args: string[],
): Promise<{ ok: boolean; code: number; error?: string }> {
  switch (command) {
    case 'mark-all-read':
      return cmdMarkAllRead();
    case 'mark-event': {
      const eventId = args[0];
      if (!eventId) return { ok: false, code: 1, error: 'Missing event id' };
      return cmdMarkEvent(eventId);
    }
    case 'jump': {
      const agentId = args[0];
      if (!agentId) return { ok: false, code: 1, error: 'Missing agent id' };
      return cmdJump(agentId);
    }
    default:
      return { ok: false, code: 1, error: `Unknown command: ${command}` };
  }
}
