/**
 * TeamMind Attention Layer — Public API
 *
 * v0.2: TeamMind RuntimeEvent → AttentionPipeline → agent-notify
 *
 * @example
 * ```typescript
 * import { AttentionPipeline, EventType } from './teammind';
 *
 * const pipeline = new AttentionPipeline();
 *
 * // Simulate a TeamMind RuntimeEvent
 * await pipeline.handleEvent({
 *   type: EventType.DECISION_REQUIRES_APPROVAL,
 *   timestamp: Date.now(),
 *   taskId: 'T-001',
 *   pluginId: 'codex',
 *   agentId: 'codex',
 *   role: 'LEAD',
 *   metadata: { question: 'Execute git push?' },
 * });
 * ```
 */

export {
  // Types
  EventType,
  TeamMindEvent,
  InvocationState,
  TaskExecutionState,
  AttentionType,
  AttentionPriority,
  AttentionSignal,
  AttentionAction,
  AttentionPolicyRule,
  AttentionCondition,
  ProjectionContext,
  DedupEntry,
  NotificationSink,
  AttentionPipeline as IAttentionPipeline,
} from './types';

// Event Adapter
export { mapTeamMindEvent, isAttentionRelevant, MappedEvent } from './EventAdapter';

// Policy
export { AttentionPolicy, DEFAULT_ATTENTION_RULES } from './AttentionPolicy';

// Projection
export { AttentionProjection, ProjectionConfig, DEFAULT_PROJECTION_CONFIG } from './AttentionProjection';

// Sink
export { ToastSink, SoundSink, CompositeSink, createDefaultSink } from './NotificationSink';

// Pipeline
export { AttentionPipeline, PipelineStats } from './AttentionPipeline';