/** Valid event names for agent notifications. */
export type EventName = 'completed' | 'permission_required' | 'input_required' | 'failed';

/** Event → priority mapping (P0 = highest). */
export const EVENT_PRIORITY: Record<EventName, 'P0' | 'P1' | 'P2'> = {
  completed: 'P2',
  permission_required: 'P0',
  input_required: 'P0',
  failed: 'P1',
};

/** Reverse lookup: priority → human-readable label. */
export const PRIORITY_LABEL: Record<string, string> = {
  P0: 'CRITICAL',
  P1: 'HIGH',
  P2: 'NORMAL',
};
