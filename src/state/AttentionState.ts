import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import { log, generateCorrelationId, type LogEntry } from '../logging';

export type EventName = 'completed' | 'permission_required' | 'input_required' | 'failed';
export type EventPriority = 'P0' | 'P1' | 'P2';

export interface StateEvent {
  id: string;
  timestamp: number;
  type: EventName;
  priority: EventPriority;
  agent_id: string;
  agent_name: string;
  title: string;
  message: string;
  read: boolean;
  correlation_id?: string; // AC-06: links this event to its source notification chain
}

export interface State {
  version: 1;
  updatedAt: number;
  unreadCount: number;
  events: StateEvent[];
  visible: boolean;
}

export interface RecordEventInput {
  type: EventName;
  priority: EventPriority;
  agent_id: string;
  agent_name: string;
  title: string;
  message: string;
  timestamp: number;
  correlation_id?: string; // AC-06: optional, auto-generated if missing
}

const DEFAULT_STATE: State = {
  version: 1,
  updatedAt: 0,
  unreadCount: 0,
  events: [],
  visible: true,
};

export function readState(statePath: string): State {
  if (!fs.existsSync(statePath)) {
    return { ...DEFAULT_STATE, updatedAt: Date.now() };
  }
  let parsed: State;
  try {
    let raw = fs.readFileSync(statePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    parsed = JSON.parse(raw) as State;
  } catch {
    log({ component: 'state', level: 'ERROR', event: 'state_read_failed', message: 'state.json corrupted, using defaults' });
    return { ...DEFAULT_STATE, updatedAt: Date.now() };
  }
  const actualUnread = parsed.events.filter((e: StateEvent) => !e.read).length;
  const unreadChanged = actualUnread !== parsed.unreadCount;
  if (unreadChanged) {
    parsed.unreadCount = actualUnread;
  }
  let visibleChanged = false;
  if (parsed.visible === undefined) {
    parsed.visible = true;
    visibleChanged = true;
  }
  if (unreadChanged || visibleChanged) {
    try {
      const tmpPath = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf-8");
      fs.renameSync(tmpPath, statePath);
    } catch {
      log({ component: 'state', level: 'WARN', event: 'state_rewrite_failed', message: 'could not persist corrected values', context: { path: statePath } });
    }
  }
  return parsed;
}

const MAX_EVENTS = 20;

function generateEventId(timestamp: number): string {
  return `evt-${timestamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function atomicWrite(statePath: string, state: State): void {
  const tmpPath = `${statePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.renameSync(tmpPath, statePath);
      return;
    } catch (err: any) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw err;
      }
      try { fs.unlinkSync(tmpPath); } catch {}
      if (attempt < 2) {
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
      }
    }
  }
  log({ component: 'state', level: 'ERROR', event: 'state_write_failed', message: 'atomic write failed after 3 retries', context: { path: statePath } });
  try { fs.unlinkSync(tmpPath); } catch {}
}

export function recordEvent(statePath: string, input: RecordEventInput): State {
  const current = readState(statePath);

  // Generate correlation_id if not provided
  const correlationId = input.correlation_id || generateCorrelationId();

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
    correlation_id: correlationId,
  };

  log({
    component: 'state',
    level: 'INFO',
    event: 'event_recorded',
    message: `${input.agent_id} → ${input.type}: ${input.message.substring(0, 80)}`,
    correlation_id: correlationId,
    context: { event_id: newEvent.id, type: input.type, priority: input.priority, agent_id: input.agent_id },
  });

  const events = [newEvent, ...current.events].slice(0, MAX_EVENTS);
  const next: State = {
    version: 1,
    updatedAt: input.timestamp,
    unreadCount: current.unreadCount + 1,
    events,
    visible: true,
  };
  atomicWrite(statePath, next);
  return next;
}

export function clearUnread(statePath: string): State {
  const current = readState(statePath);
  const events = current.events.map((e) => ({ ...e, read: true }));
  const next: State = {
    ...current,
    updatedAt: Date.now(),
    unreadCount: 0,
    events,
    visible: true,
  };
  atomicWrite(statePath, next);
  log({ component: 'state', level: 'INFO', event: 'clear_unread', message: 'all events marked as read' });
  return next;
}

export function clearAll(statePath: string): State {
  const next: State = {
    version: 1,
    updatedAt: Date.now(),
    unreadCount: 0,
    events: [],
    visible: true,
  };
  atomicWrite(statePath, next);
  log({ component: 'state', level: 'INFO', event: 'clear_all', message: 'all events cleared' });
  return next;
}

export function markRead(statePath: string, eventId: string): State {
  const current = readState(statePath);
  const event = current.events.find((e) => e.id === eventId);
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
    visible: true,
  };
  atomicWrite(statePath, next);
  log({ component: 'state', level: 'INFO', event: 'mark_read', message: `event ${eventId} marked read`, correlation_id: event.correlation_id });
  return next;
}

export function getEventsByAgent(statePath: string, agentId: string): StateEvent[] {
  const current = readState(statePath);
  return current.events.filter((e) => e.agent_id === agentId);
}

export function countUnreadByAgent(statePath: string, agentId: string): number {
  const current = readState(statePath);
  return current.events.filter((e) => e.agent_id === agentId && !e.read).length;
}

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
    visible: true,
  };
  atomicWrite(statePath, next);
  log({ component: 'state', level: 'INFO', event: 'mark_agent_read', message: `${agentId} events marked read`, context: { agent_id: agentId, count: unreadForAgent } });
  return next;
}
