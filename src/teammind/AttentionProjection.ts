/**
 * AttentionProjection — 投影层
 *
 * 聚合、去重、批处理 AttentionSignal。
 *
 * 职责：
 * - 聚合：多个同类型信号合并为一条（"3 agents completed"）
 * - 去重：同一 Agent + 同一类型 + 同一 key 在窗口内只通知一次
 * - 批处理：短时间窗口内的信号合并
 * - 静默判断：子 Agent 完成但 Lead 还在运行 → 不通知
 */

import { AttentionSignal, AttentionPriority, DedupEntry } from './types';
import type { ProjectionContext } from './types';

// ─── Configuration ──────────────────────────────────────────────────────────

export interface ProjectionConfig {
  dedupWindowMs: number;        // 去重窗口（默认 30s）
  batchWindowMs: number;        // 批处理窗口（默认 5s）
  maxBatchSize: number;         // 最大批量（默认 10）
  aggregateEnabled: boolean;    // 是否启用聚合
}

export const DEFAULT_PROJECTION_CONFIG: ProjectionConfig = {
  dedupWindowMs: 30_000,
  batchWindowMs: 5_000,
  maxBatchSize: 10,
  aggregateEnabled: true,
};

// ─── AttentionProjection ────────────────────────────────────────────────────

export class AttentionProjection {
  private config: ProjectionConfig;
  private dedupMap = new Map<string, DedupEntry>();
  private batchBuffer = new Map<string, AttentionSignal[]>();
  private context: ProjectionContext;

  constructor(config: Partial<ProjectionConfig> = {}) {
    this.config = { ...DEFAULT_PROJECTION_CONFIG, ...config };
    this.context = this.defaultContext();
  }

  private defaultContext(): ProjectionContext {
    return {
      isLeadRunning: false,
      blocksDownstream: false,
      completedCount: 0,
      quietHours: false,
    };
  }

  /** Update the projection context (called by AttentionPipeline) */
  updateContext(ctx: Partial<ProjectionContext>): void {
    this.context = { ...this.context, ...ctx };
  }

  /**
   * Project a raw AttentionSignal through dedup + aggregation + batching.
   * Returns the final signal to deliver, or null if it should be suppressed.
   */
  project(signal: AttentionSignal): AttentionSignal | null {
    // 1. P0 signals bypass dedup — always deliver immediately
    if (signal.priority === 'P0') {
      return signal;
    }

    // 2. Dedup check
    const dedupKey = this.makeDedupKey(signal);
    const now = signal.timestamp;
    const existing = this.dedupMap.get(dedupKey);

    if (existing && now - existing.timestamp < this.config.dedupWindowMs) {
      // Within dedup window — increment count, suppress
      existing.count++;
      return null;
    }

    // 3. Aggregation check — same type + same agent within batch window
    if (this.config.aggregateEnabled && signal.aggregateKey) {
      const batchKey = `batch:${signal.aggregateKey}`;
      const batch = this.batchBuffer.get(batchKey) || [];

      // Check if any batch entry is still within the batch window
      const activeBatch = batch.filter(s => now - s.timestamp < this.config.batchWindowMs);

      if (activeBatch.length > 0) {
        // Merge into existing batch
        activeBatch.push(signal);
        this.batchBuffer.set(batchKey, activeBatch);

        // If batch is full, flush
        if (activeBatch.length >= this.config.maxBatchSize) {
          return this.flushBatch(batchKey, activeBatch);
        }

        // Otherwise suppress — wait for batch to fill or expire
        return null;
      }

      // Start new batch
      this.batchBuffer.set(batchKey, [signal]);
      return null;
    }

    // 4. Non-aggregatable signal — record dedup and deliver
    this.dedupMap.set(dedupKey, { key: dedupKey, timestamp: now, count: 1 });
    this.cleanupDedup(now);

    return signal;
  }

  /**
   * Flush a batch and produce an aggregated signal.
   */
  private flushBatch(batchKey: string, signals: AttentionSignal[]): AttentionSignal {
    this.batchBuffer.delete(batchKey);

    if (signals.length === 1) {
      return signals[0];
    }

    // Aggregate: count + merge messages
    const first = signals[0];
    const count = signals.length;
    const agentIds = [...new Set(signals.map(s => s.agentId))];

    return {
      ...first,
      id: `aggregate:${batchKey}:${first.timestamp}`,
      title: `${count} agents completed`,
      message: agentIds.join(', '),
      count,
      aggregateKey: batchKey,
      sourceEventTypes: [...new Set(signals.map(s => s.sourceEventTypes?.[0]).filter(Boolean) as string[])],
    };
  }

  /**
   * Check if a signal should be suppressed based on context.
   * E.g. subagent completed but lead agent still running → silent.
   */
  shouldSuppress(signal: AttentionSignal): boolean {
    // Sub-agent completion while lead is still running → suppress
    if (signal.type === 'completed' && this.context.isLeadRunning) {
      // Check if this is a sub-agent (not the lead)
      if (signal.role !== 'LEAD') {
        return true;
      }
    }

    // Task completed but doesn't block downstream → suppress P2
    if (signal.type === 'completed' && signal.priority === 'P2' && !this.context.blocksDownstream) {
      return true;
    }

    // Quiet hours → suppress P2
    if (signal.priority === 'P2' && this.context.quietHours) {
      return true;
    }

    return false;
  }

  /**
   * Compute dedup key for a signal.
   */
  private makeDedupKey(signal: AttentionSignal): string {
    if (signal.aggregateKey) {
      return `dedup:${signal.aggregateKey}`;
    }
    return `dedup:${signal.agentId}:${signal.type}:${signal.taskId}`;
  }

  /**
   * Clean up expired dedup entries.
   */
  private cleanupDedup(now: number): void {
    for (const [key, entry] of this.dedupMap) {
      if (now - entry.timestamp > this.config.dedupWindowMs * 2) {
        this.dedupMap.delete(key);
      }
    }
  }

  /**
   * Flush any pending batches that have expired.
   * Called periodically or on shutdown.
   */
  flushExpired(): AttentionSignal[] {
    const now = Date.now();
    const result: AttentionSignal[] = [];

    for (const [batchKey, signals] of this.batchBuffer) {
      const active = signals.filter(s => now - s.timestamp < this.config.batchWindowMs);
      if (active.length === 0) {
        this.batchBuffer.delete(batchKey);
      } else if (now - active[0].timestamp >= this.config.batchWindowMs) {
        result.push(this.flushBatch(batchKey, active));
      }
    }

    return result;
  }
}