import * as path from 'path';
import * as os from 'os';
import notifier from 'node-notifier';
import { EventName, EVENT_PRIORITY } from '../events';
import { getUiMode, resolveNativeUiPath } from '../ui-host';

/** Title prefix shown on every Toast. */
const APP_NAME = 'Agent Attention';

/**
 * Resolve the daemon CLI path for toast action callbacks.
 * Used for "Mark all read" / "Mark event read" actions invoked from toast.
 */
function getDaemonCliPath(): string {
  const envPath = process.env.AGENT_ATTENTION_CLI;
  if (envPath) return envPath;
  // At runtime this module lives at dist/notification/win32.js, so
  // daemon-cli.js sits ONE level up at dist/daemon-cli.js.
  // (P1-4 fix: the old '..\\dist\\daemon-cli.js' resolved to
  //  dist/dist/daemon-cli.js which never exists.)
  const local = path.join(__dirname, '..', 'daemon-cli.js');
  if (require('fs').existsSync(local)) return local;
  return local;
}

/** Resolve the CenterWindow.ps1 path. */
function getCenterPath(): string {
  const envPath = process.env.AGENT_ATTENTION_CENTER;
  if (envPath) return envPath;
  // After build, dist/notification/win32.js lives at dist/notification/win32.js.
  // CenterWindow.ps1 is shipped under src/center/ via package.json "files".
  // So from dist/notification/ we need to go up two levels to reach src/center/.
  const local = path.join(__dirname, '..', '..', 'src', 'center', 'CenterWindow.ps1');
  if (require('fs').existsSync(local)) return local;
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
  const centerPath = getCenterPath();
  const stateDir   = path.join(os.homedir(), '.agent-attention');

  await new Promise<void>((resolve, reject) => {
    notifier.notify(
      {
        title: `${APP_NAME}: ${event}`,
        message,
        sound: isUrgent ? false : soundEnabled ? 'Notification.Default' : false,
        wait: true,  // block until user interacts with the toast
        // P1-1 fix: actions MUST be a string array (snoretoast -b expects
        // "label1;label2"). Passing object arrays results in
        // "[object Object];[object Object]" via Array.prototype.toString.
        actions: ['View', 'Dismiss'],
      } as any,
      (_err: Error | null, response: any) => {
        // node-notifier lowercases the activationType (button label) before
        // delivery. Click on body → 'activate'. Click on "View" → 'view'.
        // Click on "Dismiss" → 'dismiss'.
        const action = typeof response === 'string'
          ? response.toLowerCase().trim()
          : '';

        if (action === 'view' || action === 'activate') {
          // Open Center window on toast click or "View" button
          try {
            const { spawn } = require('child_process');
            if (getUiMode() === 'csharp') {
              const uiExecutable = resolveNativeUiPath();
              if (!uiExecutable) throw new Error('AgentAttention.UI.exe not found');
              spawn(uiExecutable, [
                '-StatePath', path.join(stateDir, 'state.json'),
                '-RegistryPath', path.join(stateDir, 'agents.json'),
                '-CliPath', cliPath,
                '-TrayStatePath', path.join(stateDir, 'tray-state.json'),
                '-OpenCenter',
              ], { windowsHide: true });
            } else {
              spawn('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass',
                '-File', centerPath,
                '-StatePath', path.join(stateDir, 'state.json'),
                '-RegistryPath', path.join(stateDir, 'agents.json'),
              ], { windowsHide: true });
            }
          } catch (err) {
            try { console.warn(`[agent-notify] failed to open Center: ${err instanceof Error ? err.message : String(err)}`); } catch {}
          }
        } else if (action === 'dismiss') {
          // Mark all read on dismiss
          try {
            const { spawn } = require('child_process');
            spawn('node', [cliPath, 'mark-all-read'], { windowsHide: true });
          } catch (err) {
            try { console.warn(`[agent-notify] failed to mark-all-read: ${err instanceof Error ? err.message : String(err)}`); } catch {}
          }
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
