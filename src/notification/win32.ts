import notifier from 'node-notifier';
import { EventName, EVENT_PRIORITY } from '../events';

/** Title prefix shown on every Toast. */
const APP_NAME = 'Agent Attention';

/**
 * Send a Windows Toast notification and optionally play a sound.
 * Throws on permanent failure so the caller can decide how to surface it.
 *
 * Sound strategy:
 * - All events: use node-notifier's built-in sound (atomic with Toast)
 * - P0 events: also fire SystemSounds asynchronously for louder emphasis
 *   (executed in parallel, doesn't block Toast return)
 */
export async function notify(
  event: EventName,
  message: string,
  soundEnabled: boolean,
): Promise<void> {
  const isUrgent = EVENT_PRIORITY[event] === 'P0';

  // --- Windows Toast (atomic with built-in sound) ---
  await new Promise<void>((resolve, reject) => {
    notifier.notify(
      {
        title: `${APP_NAME}: ${event}`,
        message,
        // node-notifier built-in sound fires synchronously with Toast appearance
        sound: soundEnabled,
        wait: false,
      },
      (error: Error | null) => {
        if (error) {
          reject(new Error(`Toast failed: ${error.message}`));
        } else {
          resolve();
        }
      },
    );
  });

  // --- Additional loud system sound for urgent events (fire-and-forget) ---
  // Uses async exec so it doesn't block CLI exit; the sound plays in parallel
  // with the Toast, eliminating perceptible delay.
  if (soundEnabled && isUrgent) {
    playUrgentSoundAsync();
  }
}

/**
 * Fire an additional loud system sound for urgent (P0) events.
 * Async/non-blocking — returns immediately while sound plays in background.
 */
function playUrgentSoundAsync(): void {
  try {
    const { spawn } = require('child_process');
    const soundScript = '[System.Media.SystemSounds]::Asterisk.Play(); [System.Media.SystemSounds]::Hand.Play()';
    // Use spawn with explicit process.execPath to bypass .ps1 file association
    // which may be hijacked by VS Code/Codex (prevents accidental editor launch)
    spawn(process.execPath, [
      'powershell', '-NoProfile', '-Command', soundScript,
    ], { windowsHide: true });
    // Fire-and-forget — swallow errors silently; sound is best-effort
  } catch {
    // suppress
  }
}
