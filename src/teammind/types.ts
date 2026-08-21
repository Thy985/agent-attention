/**
 * TeamMind Runtime Event → Attention Signal types.
 *
 * These types define the contract between TeamMind RuntimeEvent (50+ types)
 * and the Attention Layer (AttentionPolicy → AttentionProjection → NotificationSink).
 */

// ─── TeamMind EventType (mirrors Java EventType enum) ───────────────────────

export enum EventType {
  // Lifecycle
  TASK_STARTED = 'task.started',
  TASK_COMPLETED = 'task.completed',
  TASK_FAILED = 'task.failed',
  TASK_CANCELLED = 'task.cancelled',
  TASK_RETRYING = 'task.retrying',

  // Agent state
  AGENT_STARTED = 'agent.started',
  AGENT_THINKING = 'agent.thinking',
  AGENT_IDLE = 'agent.idle',
  AGENT_COMPLETED = 'agent.completed',
  AGENT_FAILED = 'agent.failed',
  AGENT_HANDOFF = 'agent.handoff',

  // Execution detail
  AGENT_CHUNK = 'agent.chunk',
  TOOL_CALLED = 'tool.called',
  TOOL_RESULT = 'tool.result',
  FILE_CHANGED = 'file.changed',
  COMMAND_RUNNING = 'command.running',

  // Artifact
  ARTIFACT_CREATED = 'artifact.created',
  ARTIFACT_UPDATED = 'artifact.updated',

  // Evidence
  EVIDENCE_VERIFYING = 'evidence.verifying',
  EVIDENCE_VERIFIED = 'evidence.verified',
  EVIDENCE_FAILED = 'evidence.failed',
  TEST_STARTED = 'test.started',
  TEST_PASSED = 'test.passed',
  TEST_FAILED = 'test.failed',
  TEST_RESULT = 'test.result',

  // Review
  REVIEW_REQUESTED = 'review.requested',
  REVIEW_STARTED = 'review.started',
  FINDING_CREATED = 'finding.created',
  FINDING_RESOLVED = 'finding.resolved',
  REVIEW_COMPLETED = 'review.completed',
  REVIEW_APPROVED = 'review.approved',
  REVIEW_REJECTED = 'review.rejected',

  // Decision
  DECISION_MADE = 'decision.made',
  DECISION_REQUIRES_APPROVAL = 'decision.requires_approval',
  APPROVAL_REQUIRED = 'approval.required',
  APPROVAL_GRANTED = 'approval.granted',
  APPROVAL_DENIED = 'approval.denied',
  APPROVAL_AUTO_APPROVED = 'approval.auto_approved',

  // Routing
  ROUTING_DECIDED = 'routing.decided',
  ROUTING_SKIPPED = 'routing.skipped',
  HANDOFF_REQUESTED = 'handoff.requested',
  HANDOFF_ACCEPTED = 'handoff.accepted',

  // Error
  ERROR_CRITICAL = 'error.critical',
  ERROR_RECOVERABLE = 'error.recoverable',
  RETRY_INITIATED = 'retry.initiated',
  FALLBACK_TRIGGERED = 'fallback.triggered',
  PLUGIN_UNHEALTHY = 'plugin.unhealthy',
  PLUGIN_DOWN = 'plugin.down',

  // Evolution
  PROFILE_UPDATED = 'profile.updated',
  DRIFT_DETECTED = 'drift.detected',
  RECOMMENDATION_GENERATED = 'recommendation.generated',
  LESSON_LEARNED = 'lesson.learned',

  // State transition
  TASK_STATE_CHANGED = 'task.state.changed',

  // Environment
  DEPENDENCY_CHANGED = 'dependency.changed',
  PACKAGE_INSTALLED = 'package.installed',
  COMMAND_EXITED = 'command.exited',
  ENV_VAR_MODIFIED = 'env.var.modified',
  PROCESS_STARTED = 'process.started',
  FILE_DELETED = 'file.deleted',
}

// ─── TeamMind RuntimeEvent (minimal contract) ──────────────────────────────

export interface TeamMindEvent {
  type: EventType | string;
  timestamp: number;           // epoch ms
  taskId: string;
  stepId?: string;
  pluginId: string;            // which Agent Plugin triggered this
  agentId: string;             // alias for pluginId
  role: string;                // LEAD / REVIEWER / TESTER / ...
  metadata: Record<string, any>;
}

// ─── AgentInvocation state (mirrors Java InvocationState) ───────────────────

export enum InvocationState {
  INIT = 'INIT',
  RUNNING = 'RUNNING',
  DONE = 'DONE',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT',
  CANCELLED = 'CANCELLED',
  WAITING_FOR_PERMISSION = 'WAITING_FOR_PERMISSION',
}

// ─── TaskExecution state ────────────────────────────────────────────────────

export enum TaskExecutionState {
  NEW = 'NEW',
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  DONE = 'DONE',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  NEEDS_APPROVAL = 'NEEDS_APPROVAL',
}

// ─── AttentionSignal (output of AttentionPolicy + AttentionProjection) ──────

export type AttentionType =
  | 'completed'
  | 'permission_required'
  | 'input_required'
  | 'failed'
  | 'blocked'
  | 'aggregate'
  | 'warning'
  | 'plugin_down';

export type AttentionPriority = 'P0' | 'P1' | 'P2';

export interface AttentionAction {
  label: string;
  action: 'allow' | 'deny' | 'later' | 'view';
  style?: 'primary' | 'danger' | 'default';
}

export interface AttentionSignal {
  id: string;
  agentId: string;
  pluginId: string;
  role: string;
  taskId: string;
  type: AttentionType;
  priority: AttentionPriority;
  title: string;
  message: string;
  timestamp: number;
  actions?: AttentionAction[];
  aggregateKey?: string;
  count?: number;
  sourceEventTypes?: string[];
}

// ─── AttentionPolicy ────────────────────────────────────────────────────────

export interface AttentionPolicyRule {
  id: string;
  match: {
    eventTypes?: EventType[];
    eventContains?: string[];
    agentStates?: InvocationState[];
    taskStates?: TaskExecutionState[];
    roles?: string[];
    conditions?: AttentionCondition[];
  };
  action: 'notify' | 'silent' | 'aggregate';
  priority: AttentionPriority;
  template: string;
  aggregateKey?: string;
  /** If true, this rule is evaluated before all others (P0-first) */
  urgent?: boolean;
}

export interface AttentionCondition {
  field: string;
  operator: 'eq' | 'ne' | 'in' | 'notIn' | 'contains' | 'exists' | 'gt' | 'lt';
  value: any;
}

// ─── AttentionProjection ────────────────────────────────────────────────────

export interface ProjectionContext {
  /** Is the lead agent for this task still running? */
  isLeadRunning: boolean;
  /** Does this task block any downstream tasks? */
  blocksDownstream: boolean;
  /** Number of agents completed for this task in the current window */
  completedCount: number;
  /** Quiet hours active? */
  quietHours: boolean;
}

export interface DedupEntry {
  key: string;
  timestamp: number;
  count: number;
}

// ─── NotificationSink ───────────────────────────────────────────────────────

export interface NotificationSink {
  deliver(signal: AttentionSignal): Promise<void>;
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export interface AttentionPipeline {
  handleEvent(event: TeamMindEvent): Promise<AttentionSignal | null>;
}