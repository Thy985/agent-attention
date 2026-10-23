import { readState, recordEvent, RecordEventInput, State } from '../state/AttentionState';
import { withFileLock } from '../state/file-lock';
/** Retained identity is idempotent; unkeyed CLI reports retain legacy 30s scoped message dedup.
 * The state transaction completes before any desktop delivery. Storage errors propagate.
 */
export function receiveEvent(statePath: string, input: RecordEventInput, messageTtlMs = 0): { state: State; duplicate: boolean } {
  return withFileLock(statePath, () => {
    const before = readState(statePath);
    const same = before.events.find(e => e.agent_id === input.agent_id && e.type === input.type &&
      e.session_id === input.session_id && e.task_id === input.task_id &&
      e.source_event === input.source_event && e.evidence?.contract === input.evidence?.contract &&
      (input.source_event_id ? e.source_event_id === input.source_event_id :
        !e.source_event_id && e.message === input.message && input.timestamp - e.timestamp >= 0 && input.timestamp - e.timestamp <= messageTtlMs));
    if (same) return { state: before, duplicate: true };
    return { state: recordEvent(statePath, input), duplicate: false };
  });
}
