/**
 * AttentionPipeline — 编排器
 *
 * 订阅 TeamMind RuntimeEvent → AttentionPolicy → AttentionProjection → NotificationSink
 *
 * 这是 v0.2 的核心入口。它消费 TeamMind Runtime 的事件流，
 * 经过 Policy 判断 + Projection 聚合后，投递到通知通道。
 */

import { TeamMindEvent, AttentionSignal, NotificationSink } from './types';
import type { ProjectionContext } from './types';
import { MappedEvent, mapTeamMindEvent } from './EventAdapter';
import { AttentionPolicy } from './AttentionPolicy';
import { AttentionProjection } from './AttentionProjection';
import { createDefaultSink } from './NotificationSink';

export interface PipelineStats {
  eventsReceived: number;
  eventsMapped: number;
  signalsGenerated: number;
  signalsDelivered: number;
  signalsSuppressed: number;
}

export class AttentionPipeline {
  private policy: AttentionPolicy;
  private projection: AttentionProjection;
  private sink: NotificationSink;
  private stats: PipelineStats;
  private context: ProjectionContext;

  constructor() {
    this.policy = new AttentionPolicy();
    this.projection = new AttentionProjection();
    this.sink = createDefaultSink();
    this.stats = {
      eventsReceived: 0,
      eventsMapped: 0,
      signalsGenerated: 0,
      signalsDelivered: 0,
      signalsSuppressed: 0,
    };
    this.context = {
      isLeadRunning: false,
      blocksDownstream: false,
      completedCount: 0,
      quietHours: false,
    };
  }

  /**
   * Process a single TeamMind RuntimeEvent through the full pipeline.
   *
   * @param event - The TeamMind RuntimeEvent
   * @returns The delivered AttentionSignal, or null if suppressed
   */
  async handleEvent(event: TeamMindEvent): Promise<AttentionSignal | null> {
    this.stats.eventsReceived++;

    // 1. Map TeamMindEvent → MappedEvent (filter out non-attention events)
    const mapped = mapTeamMindEvent(event);
    if (!mapped) {
      return null; // Not attention-relevant
    }
    this.stats.eventsMapped++;

    // 2. Update context based on event
    this.updateContext(event, mapped);

    // 3. Policy: should we notify?
    const signal = this.policy.evaluate(event, mapped);
    if (!signal) {
      this.stats.signalsSuppressed++;
      return null;
    }
    this.stats.signalsGenerated++;

    // 4. Context-based suppression (sub-agent while lead running, etc.)
    if (this.projection.shouldSuppress(signal)) {
      this.stats.signalsSuppressed++;
      return null;
    }

    // 5. Projection: dedup + aggregate + batch
    const projected = this.projection.project(signal);
    if (!projected) {
      this.stats.signalsSuppressed++;
      return null;
    }

    // 6. Deliver
    await this.sink.deliver(projected);
    this.stats.signalsDelivered++;

    return projected;
  }

  /**
   * Process a batch of events.
   */
  async handleBatch(events: TeamMindEvent[]): Promise<AttentionSignal[]> {
    const results: AttentionSignal[] = [];
    for (const event of events) {
      const signal = await this.handleEvent(event);
      if (signal) results.push(signal);
    }
    // Flush any pending batches
    const flushed = this.projection.flushExpired();
    for (const signal of flushed) {
      await this.sink.deliver(signal);
      results.push(signal);
    }
    return results;
  }

  /**
   * Update the projection context based on the current event.
   */
  private updateContext(event: TeamMindEvent, mapped: any): void {
    // Track lead agent running status
    if (event.role === 'LEAD') {
      if (event.type === 'agent.started' || event.type === 'agent.thinking') {
        this.context.isLeadRunning = true;
      } else if (event.type === 'agent.completed' || event.type === 'agent.failed') {
        this.context.isLeadRunning = false;
      }
    }

    // Track completed count
    if (event.type === 'agent.completed') {
      this.context.completedCount++;
    }
  }

  /** Update projection context externally (e.g. from Task DAG info) */
  setContext(ctx: Partial<ProjectionContext>): void {
    this.context = { ...this.context, ...ctx };
    this.projection.updateContext(ctx);
  }

  /** Get pipeline statistics */
  getStats(): PipelineStats {
    return { ...this.stats };
  }

  /** Get the underlying policy (for rule inspection/testing) */
  getPolicy(): AttentionPolicy {
    return this.policy;
  }

  /** Get the underlying projection (for config/testing) */
  getProjection(): AttentionProjection {
    return this.projection;
  }
}