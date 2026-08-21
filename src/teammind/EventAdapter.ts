/**
 * TeamMind Event Adapter
 *
 * Maps TeamMind RuntimeEvent (50+ types) to Attention-relevant events.
 * Events not matching any rule are silently dropped (not every RuntimeEvent
 * deserves human attention).
 */

import { EventType, TeamMindEvent, AttentionType } from './types';

/**
 * Result of mapping a TeamMindEvent — null means "not attention-relevant".
 */
export interface MappedEvent {
  type: AttentionType;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  message: string;
  sourceEventType: string;
}

/**
 * Maps a TeamMind RuntimeEvent to an Attention-relevant event.
 * Returns null when the event does not warrant human attention
 * (e.g. agent.chunk, tool.called, file.changed — these are progress events).
 */
export function mapTeamMindEvent(event: TeamMindEvent): MappedEvent | null {
  const type = event.type as EventType;
  const pluginName = event.pluginId || event.agentId || 'Agent';
  const meta = event.metadata || {};

  switch (type) {
    // ── P0: Always notify ──────────────────────────────────────────────
    case EventType.DECISION_REQUIRES_APPROVAL:
    case EventType.APPROVAL_REQUIRED:
      return {
        type: 'permission_required',
        priority: 'P0',
        title: `${pluginName} needs your attention`,
        message: meta.question || meta.context?.question || 'Permission required',
        sourceEventType: type,
      };

    case EventType.PLUGIN_DOWN:
      return {
        type: 'plugin_down',
        priority: 'P0',
        title: `${pluginName} is down`,
        message: meta.reason || 'Plugin failed',
        sourceEventType: type,
      };

    case EventType.PLUGIN_UNHEALTHY:
      return {
        type: 'plugin_down',
        priority: 'P0',
        title: `${pluginName} is unhealthy`,
        message: meta.reason || 'Plugin degraded',
        sourceEventType: type,
      };

    case EventType.ERROR_CRITICAL:
      return {
        type: 'failed',
        priority: 'P0',
        title: `${pluginName} critical error`,
        message: meta.message || 'Critical failure',
        sourceEventType: type,
      };

    case EventType.TASK_FAILED:
      return {
        type: 'failed',
        priority: 'P0',
        title: `Task failed`,
        message: meta.error || meta.message || 'Task execution failed',
        sourceEventType: type,
      };

    case EventType.AGENT_FAILED:
      return {
        type: 'failed',
        priority: 'P0',
        title: `${pluginName} failed`,
        message: meta.errorMessage || meta.error || meta.message || 'Agent failed',
        sourceEventType: type,
      };

    // ── P1: Notify with context ────────────────────────────────────────
    case EventType.TASK_COMPLETED:
      return {
        type: 'completed',
        priority: 'P1',
        title: `Task completed`,
        message: meta.summary || meta.result || 'Task finished',
        sourceEventType: type,
      };

    case EventType.AGENT_COMPLETED:
      return {
        type: 'completed',
        priority: 'P1',
        title: `${pluginName} completed`,
        message: meta.summary || 'Agent finished',
        sourceEventType: type,
      };

    case EventType.EVIDENCE_FAILED:
      return {
        type: 'failed',
        priority: 'P1',
        title: `Evidence verification failed`,
        message: meta.summary || 'Verification failed',
        sourceEventType: type,
      };

    case EventType.TEST_FAILED:
      return {
        type: 'failed',
        priority: 'P1',
        title: `Tests failed`,
        message: `${meta.failed || 0} tests failed`,
        sourceEventType: type,
      };

    case EventType.REVIEW_REJECTED:
      return {
        type: 'warning',
        priority: 'P1',
        title: `Review rejected`,
        message: meta.issues || 'Review did not pass',
        sourceEventType: type,
      };

    case EventType.FINDING_CREATED:
      if (meta.severity === 'CRITICAL' || meta.severity === 'HIGH') {
        return {
          type: 'warning',
          priority: 'P1',
          title: `${meta.severity} finding`,
          message: meta.title || meta.description || 'New finding',
          sourceEventType: type,
        };
      }
      return null; // LOW/MEDIUM findings don't need attention

    // ── P2: Aggregate / low priority ───────────────────────────────────
    case EventType.TASK_RETRYING:
      return {
        type: 'completed',
        priority: 'P2',
        title: `Retrying task`,
        message: `Attempt ${meta.attemptNumber || '?'} of ${meta.maxAttempts || '?'}`,
        sourceEventType: type,
      };

    // ── Silent: progress events, no notification needed ────────────────
    case EventType.TASK_STARTED:
    case EventType.AGENT_STARTED:
    case EventType.AGENT_THINKING:
    case EventType.AGENT_IDLE:
    case EventType.AGENT_HANDOFF:
    case EventType.AGENT_CHUNK:
    case EventType.TOOL_CALLED:
    case EventType.TOOL_RESULT:
    case EventType.FILE_CHANGED:
    case EventType.COMMAND_RUNNING:
    case EventType.ARTIFACT_CREATED:
    case EventType.ARTIFACT_UPDATED:
    case EventType.EVIDENCE_VERIFYING:
    case EventType.EVIDENCE_VERIFIED:
    case EventType.TEST_STARTED:
    case EventType.TEST_PASSED:
    case EventType.TEST_RESULT:
    case EventType.REVIEW_REQUESTED:
    case EventType.REVIEW_STARTED:
    case EventType.FINDING_RESOLVED:
    case EventType.REVIEW_COMPLETED:
    case EventType.REVIEW_APPROVED:
    case EventType.DECISION_MADE:
    case EventType.APPROVAL_GRANTED:
    case EventType.APPROVAL_DENIED:
    case EventType.APPROVAL_AUTO_APPROVED:
    case EventType.ROUTING_DECIDED:
    case EventType.ROUTING_SKIPPED:
    case EventType.HANDOFF_REQUESTED:
    case EventType.HANDOFF_ACCEPTED:
    case EventType.ERROR_RECOVERABLE:
    case EventType.RETRY_INITIATED:
    case EventType.FALLBACK_TRIGGERED:
    case EventType.PROFILE_UPDATED:
    case EventType.DRIFT_DETECTED:
    case EventType.RECOMMENDATION_GENERATED:
    case EventType.LESSON_LEARNED:
    case EventType.TASK_STATE_CHANGED:
    case EventType.DEPENDENCY_CHANGED:
    case EventType.PACKAGE_INSTALLED:
    case EventType.COMMAND_EXITED:
    case EventType.ENV_VAR_MODIFIED:
    case EventType.PROCESS_STARTED:
    case EventType.FILE_DELETED:
    default:
      return null;
  }
}

/**
 * Check if a TeamMindEvent type is one that could potentially warrant attention.
 * Fast-path filter before full mapping.
 */
export function isAttentionRelevant(type: EventType | string): boolean {
  const relevant = new Set<EventType>([
    EventType.DECISION_REQUIRES_APPROVAL,
    EventType.APPROVAL_REQUIRED,
    EventType.PLUGIN_DOWN,
    EventType.PLUGIN_UNHEALTHY,
    EventType.ERROR_CRITICAL,
    EventType.TASK_FAILED,
    EventType.AGENT_FAILED,
    EventType.TASK_COMPLETED,
    EventType.AGENT_COMPLETED,
    EventType.EVIDENCE_FAILED,
    EventType.TEST_FAILED,
    EventType.REVIEW_REJECTED,
    EventType.TASK_RETRYING,
  ]);
  return relevant.has(type as EventType);
}