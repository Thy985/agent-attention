/**
 * NotificationSink — 通知投递
 *
 * 将 AttentionSignal 投递到各个通道：Toast、Sound、Tray。
 * 复用 v0.1 的 win32 通知逻辑，扩展为多通道投递。
 */

import { AttentionSignal, AttentionPriority } from './types';
import type { NotificationSink as ISink } from './types';

// ─── Re-use v0.1 notification backend ───────────────────────────────────────

// We import the existing notify function from v0.1
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { notify: notifyWin32 } = require('../notification/win32');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EVENT_PRIORITY } = require('../events');

// ─── Sound ──────────────────────────────────────────────────────────────────

/**
 * Play a sound based on priority.
 * P0 → urgent (asterisk + hand)
 * P1 → normal (exclamation)
 * P2 → gentle (asterisk)
 */
function playSound(priority: AttentionPriority): void {
  try {
    const { exec } = require('child_process');
    const soundMap: Record<AttentionPriority, string> = {
      P0: '[System.Media.SystemSounds]::Asterisk.Play(); [System.Media.SystemSounds]::Hand.Play()',
      P1: '[System.Media.SystemSounds]::Exclamation.Play()',
      P2: '[System.Media.SystemSounds]::Asterisk.Play()',
    };
    exec(
      `powershell -NoProfile -Command "${soundMap[priority]}"`,
      { windowsHide: true },
      () => {},
    );
  } catch {
    // suppress — sound is best-effort
  }
}

// ─── NotificationSink implementation ────────────────────────────────────────

export class ToastSink implements ISink {
  async deliver(signal: AttentionSignal): Promise<void> {
    const eventName = this.mapToEventName(signal.type);
    try {
      await notifyWin32(eventName, signal.message, true);
    } catch (err) {
      // Best-effort: notification failure must not crash the pipeline
      console.error(`[NotificationSink] Toast failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private mapToEventName(type: string): 'completed' | 'permission_required' | 'input_required' | 'failed' {
    switch (type) {
      case 'permission_required': return 'permission_required';
      case 'failed': return 'failed';
      case 'completed': return 'completed';
      case 'blocked': return 'failed';
      case 'aggregate': return 'completed';
      case 'warning': return 'failed';
      case 'plugin_down': return 'failed';
      default: return 'completed';
    }
  }
}

export class SoundSink implements ISink {
  async deliver(signal: AttentionSignal): Promise<void> {
    playSound(signal.priority);
  }
}

export class CompositeSink implements ISink {
  private sinks: ISink[];

  constructor(sinks: ISink[] = [new ToastSink(), new SoundSink()]) {
    this.sinks = sinks;
  }

  async deliver(signal: AttentionSignal): Promise<void> {
    // Run all sinks in parallel — one failure doesn't affect others
    await Promise.allSettled(this.sinks.map(s => s.deliver(signal)));
  }
}

/**
 * Create a default sink with Toast + Sound.
 */
export function createDefaultSink(): CompositeSink {
  return new CompositeSink([new ToastSink(), new SoundSink()]);
}