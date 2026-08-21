import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';

export type EventName = 'completed' | 'permission_required' | 'input_required' | 'failed';
export type EventPriority = 'P0' | 'P1' | 'P2';

export interface StateEvent {
  id: string;
  timestamp: number;
  type: EventName;         // AC-05: was "event", renamed to match spec
  priority: EventPriority;
  agent_id: string;        // AC-05: stable agent identifier
  agent_name: string;      // AC-05: display name
  title: string;           // AC-05: event title (often same as agent_name)
  message: string;
  read: boolean;           // AC-05: read/unread status
}

export interface State {
  version: 1;
  updatedAt: number;
  unreadCount: number;
  events: StateEvent[];
  visible: boolean; // whether the tray icon should be shown
}

export interface RecordEventInput {
  type: EventName;
  priority: EventPriority;
  agent_id: string;
  agent_name: string;
  title: string;
  message: string;
  timestamp: number;
}

const DEFAULT_STATE: State = {
  version: 1,
  updatedAt: 0,
  unreadCount: 0,
  events: [],
  visible: false, // hidden when nothing to show
};

export function readState(statePath: string): State {
  if (!fs.existsSync(statePath)) {
    return { ...DEFAULT_STATE, updatedAt: Date.now() };
  }
  try {
    let raw = fs.readFileSync(statePath, 'utf-8');
    // Strip UTF-8 BOM if present (PowerShell Set-Content adds one)
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw) as State;
    // Fix unreadCount: recompute from events (handles legacy data without 'read' field)
    const actualUnread = parsed.events.filter((e: StateEvent) => !e.read).length;
    if (actualUnread !== parsed.unreadCount) {
      parsed.unreadCount = actualUnread;
    }
    // Ensure visible is set based on events (backward-compat: old state files lack this field)
    if (parsed.visible === undefined) {
      parsed.visible = parsed.events.length > 0;
    }
    // Rewrite with corrected values to keep disk in sync
    const tmpPath = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf-8');
    fs.renameSync(tmpPath, statePath);
    return parsed;
  } catch {
    console.warn(`[agent-attention] state.json corrupted, using defaults`);
    return { ...DEFAULT_STATE, updatedAt: Date.now() };
  }
}

const MAX_EVENTS = 20;

function generateEventId(timestamp: number): string {
  const random = crypto.randomBytes(3).toString('hex');
  return `evt-${timestamp}-${random}`;
}

function atomicWrite(statePath: string, state: State): void {
  // Use a per-write random tmp name to avoid concurrent-writer collisions.
  // renameSync is atomic on Windows (same volume), so the pattern is safe
  // even when multiple agent-notify invocations race.
  const tmpPath = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  try {
    fs.renameSync(tmpPath, statePath);
  } catch (err: any) {
    // EPERM on Windows when another process (e.g. daemon with chokidar watch)
    // holds the file open. Fall back to direct write — safe because we hold
    // the file exclusively in this process.
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } else {
      throw err;
    }
  }
  try { fs.unlinkSync(tmpPath); } catch {}
}

export function recordEvent(statePath: string, input: RecordEventInput): State {
  const current = readState(statePath);
  const newEvent: StateEvent = {
    id: generateEventId(input.timestamp),
    timestamp: input.timestamp,
    type: input.type,
    priority: input.priority,
    agent_id: input.agent_id,
    agent_name: input.agent_name,
    title: input.title,
    message: input.message,
    read: false,
  };
  const events = [newEvent, ...current.events].slice(0, MAX_EVENTS);
  const next: State = {
    version: 1,
    updatedAt: input.timestamp,
    unreadCount: current.unreadCount + 1,
    events,
    visible: current.unreadCount + 1 > 0, // show icon when there are unread events
  };
  atomicWrite(statePath, next);
  return next;
}

export function clearUnread(statePath: string): State {
  const current = readState(statePath);
  // Also mark all events as read so unreadCount stays at 0
  const events = current.events.map((e) => ({ ...e, read: true }));
  const next: State = {
    ...current,
    updatedAt: Date.now(),
    unreadCount: 0,
    events,
    visible: 0 > 0, // hide icon when all events are read
  };
  atomicWrite(statePath, next);
  return next;
}

export function clearAll(statePath: string): State {
  const next: State = {
    version: 1,
    updatedAt: Date.now(),
    unreadCount: 0,
    events: [],
    visible: false, // no events → hide icon
  };
  atomicWrite(statePath, next);
  return next;
}

export function markRead(statePath: string, eventId: string): State {
  const current = readState(statePath);
  const event = current.events.find((e) => e.id === eventId);
  // If the event is already read (or missing), do not decrement unreadCount again.
  if (!event || event.read) {
    return current;
  }
  const events = current.events.map((e) =>
    e.id === eventId ? { ...e, read: true } : e,
  );
  const next: State = {
    ...current,
    updatedAt: Date.now(),
    unreadCount: Math.max(0, current.unreadCount - 1),
    events,
    visible: Math.max(0, current.unreadCount - 1) > 0,
  };
  atomicWrite(statePath, next);
  return next;
}

/**
 * Get all events for a specific agent.
 */
export function getEventsByAgent(statePath: string, agentId: string): StateEvent[] {
  const current = readState(statePath);
  return current.events.filter((e) => e.agent_id === agentId);
}

/**
 * Count unread events for a specific agent.
 */
export function countUnreadByAgent(statePath: string, agentId: string): number {
  const current = readState(statePath);
  return current.events.filter((e) => e.agent_id === agentId && !e.read).length;
}

/**
 * Mark all events for a specific agent as read, and update unreadCount.
 */
export function markAgentEventsRead(statePath: string, agentId: string): State {
  const current = readState(statePath);
  const agentEvents = current.events.filter((e) => e.agent_id === agentId);
  const unreadForAgent = agentEvents.filter((e) => !e.read).length;
  const events = current.events.map((e) =>
    e.agent_id === agentId ? { ...e, read: true } : e,
  );
  const next: State = {
    ...current,
    updatedAt: Date.now(),
    unreadCount: Math.max(0, current.unreadCount - unreadForAgent),
    events,
    visible: events.length > 0,
  };
  atomicWrite(statePath, next);
  return next;
}
