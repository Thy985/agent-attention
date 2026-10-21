import { EventName } from '../events';
export type DeliveryStatus = 'unsupported' | 'failed' | 'attempted';
export function isHeadless(): boolean { return process.env.AGENT_ATTENTION_MODE === 'headless'; }
export function getPlatformCapabilities() {
  const headless = isHeadless();
  const windows = process.platform === 'win32';
  const desktop = windows && !headless;
  return {
    platform: process.platform, mode: headless ? 'headless' : windows ? 'windows-desktop' : 'unsupported',
    eventStorage: true, query: true, markRead: true,
    notification: desktop ? 'windows-adapter' : 'unsupported',
    openUi: desktop ? 'windows-adapter' : 'unsupported',
    activateTarget: desktop ? 'windows-adapter' : 'unsupported',
    startup: desktop ? 'windows-legacy' : 'unsupported',
    observer: headless ? 'disabled' : windows ? 'legacy' : 'unsupported',
    deliveryGuarantee: 'retained-event-id deduplication only; no exactly-once display guarantee',
  };
}
/** The Windows adapter remains unchanged. A completed adapter call is not proof of a displayed toast. */
export async function deliver(event: EventName, message: string, sound: boolean): Promise<{ status: DeliveryStatus; reason?: string }> {
  if (getPlatformCapabilities().notification === 'unsupported') return { status: 'unsupported', reason: 'No desktop delivery in selected mode/platform; event remains recorded' };
  try {
    await (await import('../notification/win32')).notify(event, message, sound);
    return { status: 'attempted', reason: 'Windows adapter returned; display not independently confirmed' };
  } catch (err) { return { status: 'failed', reason: String(err) }; }
}

export function activateTarget(target: import('../jump').AgentTarget): import('../jump').JumpResult {
  if (isHeadless()) return { ok: false, reason: 'unsupported-platform', pid: target.pid };
  return require('../jump').jumpToTarget(target);
}
export function openUi(): { status: 'unsupported' | 'attempted' | 'failed'; reason?: string } {
  if (getPlatformCapabilities().openUi === 'unsupported') return { status: 'unsupported' };
  try {
    const exe = require('../ui-host').resolveNativeUiPath();
    if (!exe) return { status: 'failed', reason: 'Windows UI executable not found' };
    const path = require('path'); const { resolveStateDir } = require('../paths'); const dir = resolveStateDir();
    const child = require('child_process').spawn(exe, ['-StatePath', path.join(dir, 'state.json'), '-RegistryPath', path.join(dir, 'agents.json'), '-CliPath', path.resolve(__dirname, '..', 'daemon-cli.js'), '-TrayStatePath', path.join(dir, 'tray-state.json'), '-OpenCenter'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); child.unref();
    return { status: 'attempted' };
  } catch (err) { return { status: 'failed', reason: String(err) }; }
}
