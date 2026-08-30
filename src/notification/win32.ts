import * as path from 'path';
import * as os from 'os';
import notifier from 'node-notifier';
import { EventName, EVENT_PRIORITY } from '../events';
import { resolveNativeUiPath } from '../ui-host';

/** Title prefix shown on every Toast. */
const APP_NAME = 'Agent Attention';

/**
 * P2-12: Hard upper bound on how long `notify()` may wait for the toast
 * lifecycle (user click / dismiss / snoretoast exit). node-notifier's own
 * `wait`/`timeout` options are stripped on Windows (not in allowedToasterFlags),
 * so without our own guard `agent-notify` could hang indefinitely waiting for
 * the callback. Override with AGENT_ATTENTION_NOTIFY_TIMEOUT_MS (ms).
 */
export const DEFAULT_NOTIFY_TIMEOUT_MS = 30_000;

function resolveNotifyTimeoutMs(): number {
  const raw = process.env.AGENT_ATTENTION_NOTIFY_TIMEOUT_MS;
  if (!raw) return DEFAULT_NOTIFY_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_NOTIFY_TIMEOUT_MS;
}

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

/**
 * Send a Windows Toast notification with action buttons.
 * Clicking "View" opens the Center window; "Dismiss" marks all read.
 *
 * P2-12: Never blocks the caller indefinitely. node-notifier's `wait`/
 * `timeout` options are stripped on Windows, so the callback fires only when
 * snoretoast exits (user click / dismiss / system toast timeout) — an
 * unbounded wait. We race the notifier against a hard timeout so `agent-notify`
 * always returns (and exits) within a bounded window.
 *
 * Throws on permanent failure so the caller can decide how to surface it.
 */
export async function notify(
  event: EventName,
  message: string,
  soundEnabled: boolean,
  timeoutMs?: number,
): Promise<void> {
  const isUrgent = EVENT_PRIORITY[event] === 'P0';
  const cliPath = getDaemonCliPath();
  const stateDir   = path.join(os.homedir(), '.agent-attention');
  const hardTimeout = timeoutMs ?? resolveNotifyTimeoutMs();

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // P2-12: hard upper bound — never hang the CLI on toast interaction.
    const timer = setTimeout(() => {
      if (!settled) {
        try {
          console.warn(`[agent-notify] toast wait timed out after ${hardTimeout}ms (event still recorded)`);
        } catch { /* ignore */ }
      }
      done();
    }, hardTimeout);

    notifier.notify(
      {
        title: `${APP_NAME}: ${event}`,
        message,
        sound: isUrgent ? false : soundEnabled ? 'Notification.Default' : false,
        wait: true,  // prefer interactive toast when the user is around
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
            const uiExecutable = resolveNativeUiPath();
            if (!uiExecutable) throw new Error('AgentAttention.UI.exe not found');
            spawn(uiExecutable, [
              '-StatePath', path.join(stateDir, 'state.json'),
              '-RegistryPath', path.join(stateDir, 'agents.json'),
              '-CliPath', cliPath,
              '-TrayStatePath', path.join(stateDir, 'tray-state.json'),
              '-OpenCenter',
            ], { windowsHide: true });
          } catch (err) {
            console.warn(`[agent-notify] failed to open Center: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (action === 'dismiss') {
          // Mark all read on dismiss
          try {
            const { spawn } = require('child_process');
            spawn('node', [cliPath, 'mark-all-read'], { windowsHide: true });
          } catch (err) {
            console.warn(`[agent-notify] failed to mark-all-read: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        done();
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
