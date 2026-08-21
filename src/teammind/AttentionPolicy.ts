/**
 * AttentionPolicy — 规则引擎
 *
 * 决定一个 RuntimeEvent 是否值得占用人类注意力。
 * TeamMind 已经知道 Agent 状态，Policy 只判断"值不值得告诉人"。
 */

import { TeamMindEvent, AttentionPolicyRule, AttentionCondition, AttentionSignal, EventType } from './types';
import { MappedEvent } from './EventAdapter';

// ─── Condition evaluator ────────────────────────────────────────────────────

function evaluateCondition(cond: AttentionCondition, event: TeamMindEvent, mapped: MappedEvent): boolean {
  const value = getFieldValue(cond.field, event, mapped);
  switch (cond.operator) {
    case 'eq': return value === cond.value;
    case 'ne': return value !== cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(value);
    case 'notIn': return Array.isArray(cond.value) && !cond.value.includes(value);
    case 'contains': return String(value).includes(String(cond.value));
    case 'exists': return value !== undefined && value !== null;
    case 'gt': return Number(value) > Number(cond.value);
    case 'lt': return Number(value) < Number(cond.value);
    default: return false;
  }
}

function getFieldValue(field: string, event: TeamMindEvent, mapped: MappedEvent): any {
  if (event.metadata && field in event.metadata) return event.metadata[field];
  if (field in event) return (event as any)[field];
  if (field in mapped) return (mapped as any)[field];
  return undefined;
}

// ─── Default rules ──────────────────────────────────────────────────────────

export const DEFAULT_ATTENTION_RULES: AttentionPolicyRule[] = [
  // ── P0: Always notify ──────────────────────────────────────────────────
  {
    id: 'R1-permission-required',
    match: {
      eventTypes: [EventType.DECISION_REQUIRES_APPROVAL, EventType.APPROVAL_REQUIRED],
    },
    action: 'notify',
    priority: 'P0',
    template: '{pluginName} needs your attention',
    urgent: true,
  },
  {
    id: 'R2-plugin-down',
    match: {
      eventTypes: [EventType.PLUGIN_DOWN, EventType.PLUGIN_UNHEALTHY],
    },
    action: 'notify',
    priority: 'P0',
    template: '{pluginName} is {state}',
    urgent: true,
  },
  {
    id: 'R3-critical-error',
    match: {
      eventTypes: [EventType.ERROR_CRITICAL],
    },
    action: 'notify',
    priority: 'P0',
    template: '{pluginName} critical error',
    urgent: true,
  },
  {
    id: 'R4-task-failed',
    match: {
      eventTypes: [EventType.TASK_FAILED],
    },
    action: 'notify',
    priority: 'P0',
    template: 'Task failed',
    urgent: true,
  },
  {
    id: 'R5-agent-failed',
    match: {
      eventTypes: [EventType.AGENT_FAILED],
    },
    action: 'notify',
    priority: 'P0',
    template: '{pluginName} failed',
    urgent: true,
  },

  // ── P1: Notify with context ────────────────────────────────────────────
  {
    id: 'R6-task-completed',
    match: {
      eventTypes: [EventType.TASK_COMPLETED],
    },
    action: 'notify',
    priority: 'P1',
    template: 'Task completed',
  },
  {
    id: 'R7-agent-completed',
    match: {
      eventTypes: [EventType.AGENT_COMPLETED],
    },
    action: 'notify',
    priority: 'P1',
    template: '{pluginName} completed',
  },
  {
    id: 'R8-evidence-failed',
    match: {
      eventTypes: [EventType.EVIDENCE_FAILED],
    },
    action: 'notify',
    priority: 'P1',
    template: 'Evidence verification failed',
  },
  {
    id: 'R9-test-failed',
    match: {
      eventTypes: [EventType.TEST_FAILED],
    },
    action: 'notify',
    priority: 'P1',
    template: 'Tests failed',
  },
  {
    id: 'R10-review-rejected',
    match: {
      eventTypes: [EventType.REVIEW_REJECTED],
    },
    action: 'notify',
    priority: 'P1',
    template: 'Review rejected',
  },
  {
    id: 'R11-critical-finding',
    match: {
      eventTypes: [EventType.FINDING_CREATED],
    },
    action: 'notify',
    priority: 'P1',
    template: '{severity} finding',
  },

  // ── P2: Aggregate / low priority ───────────────────────────────────────
  {
    id: 'R12-task-retrying',
    match: {
      eventTypes: [EventType.TASK_RETRYING],
    },
    action: 'aggregate',
    priority: 'P2',
    template: 'Retrying task',
    aggregateKey: 'task:{taskId}:retrying',
  },

  // ── Silent: everything else ────────────────────────────────────────────
  {
    id: 'R99-default-silent',
    match: {},
    action: 'silent',
    priority: 'P2',
    template: '',
  },
];

// ─── AttentionPolicy ────────────────────────────────────────────────────────

export class AttentionPolicy {
  private rules: AttentionPolicyRule[];

  constructor(rules: AttentionPolicyRule[] = DEFAULT_ATTENTION_RULES) {
    this.rules = [...rules].sort((a, b) => {
      if (a.urgent && !b.urgent) return -1;
      if (!a.urgent && b.urgent) return 1;
      const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
      return order[a.priority] - order[b.priority];
    });
  }

  evaluate(event: TeamMindEvent, mapped: MappedEvent | null): AttentionSignal | null {
    if (!mapped) return null;

    for (const rule of this.rules) {
      if (this.matches(rule, event, mapped)) {
        return this.buildSignal(rule, event, mapped);
      }
    }
    return null;
  }

  private matches(rule: AttentionPolicyRule, event: TeamMindEvent, mapped: MappedEvent): boolean {
    const match = rule.match;

    if (match.eventTypes && match.eventTypes.length > 0) {
      if (!match.eventTypes.includes(event.type as EventType)) {
        return false;
      }
    }

    if (match.eventContains && match.eventContains.length > 0) {
      const typeStr = String(event.type);
      if (!match.eventContains.some(s => typeStr.includes(s))) {
        return false;
      }
    }

    if (match.conditions && match.conditions.length > 0) {
      for (const cond of match.conditions) {
        if (!evaluateCondition(cond, event, mapped)) {
          return false;
        }
      }
    }

    return true;
  }

  private buildSignal(
    rule: AttentionPolicyRule,
    event: TeamMindEvent,
    mapped: MappedEvent,
  ): AttentionSignal {
    const template = rule.template || mapped.title;
    const title = this.interpolate(template, event, mapped);

    return {
      id: `${rule.id}:${event.taskId}:${event.timestamp}`,
      agentId: event.agentId,
      pluginId: event.pluginId,
      role: event.role,
      taskId: event.taskId,
      type: mapped.type,
      priority: rule.priority,
      title,
      message: mapped.message,
      timestamp: event.timestamp,
      aggregateKey: rule.aggregateKey ? this.interpolate(rule.aggregateKey, event, mapped) : undefined,
      sourceEventTypes: [String(event.type)],
    };
  }

  private interpolate(template: string, event: TeamMindEvent, mapped: MappedEvent): string {
    return template
      .replace(/\{pluginName\}/g, event.pluginId || event.agentId || 'Agent')
      .replace(/\{taskId\}/g, event.taskId)
      .replace(/\{agentId\}/g, event.agentId)
      .replace(/\{role\}/g, event.role)
      .replace(/\{severity\}/g, String(event.metadata?.severity || ''))
      .replace(/\{state\}/g, String(event.metadata?.reason ? 'down' : 'unhealthy'));
  }
}