import { CanonicalAttentionEvent, CompletionReliability, IntegrationManifest } from './types';

/** Fields checked against @anthropic-ai/claude-agent-sdk 0.3.306 sdk.d.ts.
 * Verified means the signal was validated, NEVER independent business acceptance.
 * Raw tool inputs, transcript paths, URLs and error_details are deliberately not retained.
 */
export const CLAUDE_CONTRACT = 'claude-agent-sdk@0.3.306/hooks-v1';
export function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
}
export function parseClaudeHook(payload: unknown, manifest: IntegrationManifest): CanonicalAttentionEvent | null {
  if (manifest.id !== 'claude-code' || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (!text(p.session_id) || !text(p.hook_event_name)) return null;
  const name = p.hook_event_name;
  let event: CanonicalAttentionEvent['event'];
  let message: string;
  let scope: 'request' | 'turn';
  if (name === 'PermissionRequest' && text(p.tool_name) && Object.prototype.hasOwnProperty.call(p, 'tool_input')) {
    event = 'permission_required'; scope = 'request';
    message = `${manifest.name} requests permission to use ${p.tool_name}`;
  } else if (name === 'Notification' && p.notification_type === 'permission_prompt' && text(p.message)) {
    event = 'permission_required'; scope = 'request';
    message = `${manifest.name}: permission prompt is waiting`;
  } else if (name === 'Elicitation' && text(p.mcp_server_name) && text(p.message) &&
      (p.mode === undefined || p.mode === 'form' || p.mode === 'url')) {
    event = 'input_required'; scope = 'request';
    message = `${manifest.name}: ${p.mcp_server_name} requests input`;
  } else if (name === 'StopFailure' && text(p.error)) {
    event = 'failed'; scope = 'turn';
    message = `${manifest.name} response failed (task outcome unknown)`;
  } else {
    // Stop/SessionEnd/TaskCompleted are pre-acceptance or lifecycle signals.
    // idle_prompt, cancellation, process exit and tool success prove no task outcome.
    return null;
  }
  return {
    event, message, sourceEvent: name, reliability: CompletionReliability.Verified,
    agentId: manifest.id, agentName: manifest.name, timestamp: Date.now(),
    sessionId: p.session_id,
    // Only elicitation_id is a documented delivery identity in the selected inputs.
    sourceEventId: name === 'Elicitation' && text(p.elicitation_id) ? p.elicitation_id : undefined,
    evidence: { contract: CLAUDE_CONTRACT, mechanism: 'hook', basis: 'structured_signal', scope },
  };
}
