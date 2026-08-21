import * as path from 'path';
import * as os from 'os';
import notifier from 'node-notifier';
import { EventName, EVENT_PRIORITY } from '../events';

/** Title prefix shown on every Toast. */
const APP_NAME = 'Agent Attention';

/** Resolve the daemon CLI path for toast action callbacks. */
function getDaemonCliPath(): string {
  const envPath = process.env.AGENT_ATTENTION_CLI;
  if (envPath) return envPath;
  const local = path.join(__dirname, '..', 'dist', 'daemon-cli.js');
  if (require('fs').existsSync(local)) return local;
  // Fallback for global installs
  return local;
}

/**
 * Send a Windows Toast notification with action buttons.
 * Clicking "View" opens the Center window; "Dismiss" marks all read.
 * Throws on permanent failure so the caller can decide how to surface it.
 */
export async function notify(
  event: EventName,
  message: string,
  soundEnabled: boolean,
): Promise<void> {
  const isUrgent = EVENT_PRIORITY[event] === 'P0';
  const cliPath = getDaemonCliPath();
  const centerPath = path.join(__dirname, '..', 'src', 'center', 'CenterWindow.ps1');
  const stateDir   = path.join(os.homedir(), '.agent-attention');

  await new Promise<void>((resolve, reject) => {
    notifier.notify(
      {
        title: `${APP_NAME}: ${event}`,
        message,
        sound: isUrgent ? false : soundEnabled ? 'Notification.Default' : false,
        wait: true,  // block until user interacts with the toast
        actions: [
          { action: 'activate', arguments: 'center', content: 'View' },
          { action: 'dismiss',  arguments: '',       content: 'Dismiss' },
        ],
      } as any,
      (_err: Error | null, response: any) => {
        if (response === 'activate') {
          // Open Center window on toast click
          try {
            const { spawn } = require('child_process');
            spawn('powershell', [
              '-NoProfile', '-ExecutionPolicy', 'Bypass',
              '-File', centerPath,
              '-StatePath', path.join(stateDir, 'state.json'),
              '-RegistryPath', path.join(stateDir, 'agents.json'),
            ], { windowsHide: true });
          } catch {}
        } else if (response === 'dismiss') {
          // Mark all read on dismiss
          try {
            const { spawn } = require('child_process');
            spawn('node', [cliPath, 'mark-all-read'], { windowsHide: true });
          } catch {}
        }
        resolve();
      },
    );
  });

  // --- Additional loud system sounds for urgent events (fire-and-forget) ---
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
    // Use spawn with explicit 'powershell' — process.execPath is Node, not PS.
    spawn('powershell', [
      '-NoProfile', '-Command', soundScript,
    ], { windowsHide: true });
    // Fire-and-forget — swallow errors silently; sound is best-effort
  } catch {
    // suppress
  }
}
