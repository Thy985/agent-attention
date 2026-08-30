/**
 * Integration Capability Catalog — Agent Attention v0.3
 *
 * Instead of per-agent Adapters, we define:
 *   1. Integration Mechanisms (Hook, Wrapper, Skill, Plugin, MCP, ACP, Native)
 *   2. Integration Manifests (per-agent capability declarations)
 *   3. Reliability Levels (how trustworthy the completion semantic is)
 *
 * Design Principles:
 *   - Agent-specific code lives in mechanism providers, not the core
 *   - New agents start at L1 (Skill) and upgrade as mechanisms become available
 *   - The runtime only speaks "Canonical Attention Events"
 *   - Raw lifecycle events are normalized, not assumed reliable
 */

/**
 * Integration Mechanisms — ordered by reliability (higher = more trustworthy)
 */
export enum IntegrationLevel {
  /** Manual: agent must explicitly call agent-notify */
  L0_CLI = 0,
  /** Skill: agent reads SKILL.md and follows instructions */
  L1_SKILL = 1,
  /** Wrapper: shell script injects identity + calls agent-notify on exit */
  L2_WRAPPER = 2,
  /** Hook: agent fires lifecycle events to stdin (Claude Code, Cline) */
  L3_HOOK = 3,
  /** Plugin: agent's native plugin system (OpenCode, etc.) */
  L4_PLUGIN = 4,
  /** MCP: Model Context Protocol server integration */
  L5_MCP = 5,
  /** ACP: Agent Client Protocol for editor integration */
  L6_ACP = 6,
  /** Native: deep integration via agent's internal API/event bus */
  L7_NATIVE = 7,
}

/**
 * How reliable is the completion signal from this integration?
 */
export enum CompletionReliability {
  /** Cannot determine completion — requires manual agent-notify call */
  Manual = 'manual',
  /** Best-effort inference from process exit / wrapper */
  BestEffort = 'best_effort',
  /** Probable completion (wrapper detected clean exit) */
  Probable = 'probable',
  /** Verified via structured event (hook with exitStatus) */
  Verified = 'verified',
}

/**
 * Canonical Attention Events (from events.ts)
 */
export type AttentionEvent = 'completed' | 'permission_required' | 'input_required' | 'failed';

/**
 * How well does this integration map to each canonical event?
 */
export type EventMapping = Partial<Record<AttentionEvent, CompletionReliability>>;

/**
 * Observable Interfaces — what entry points does this agent expose?
 */
export interface ObservableInterface {
  /** Hook events (stdin JSON) */
  hook?: string[];
  /** CLI modes (JSON output, etc.) */
  cli?: string[];
  /** Plugin API endpoints */
  plugin?: string[];
  /** Skill/manifest paths */
  skill?: string[];
  /** Environment variables for identity */
  env?: string[];
  /** Process lifecycle signals */
  process?: string[];
  /** MCP server capabilities */
  mcp?: string[];
  /** ACP mode */
  acp?: boolean;
  /** IDE extension hooks */
  ide?: string[];
}

/**
 * Integration Manifest — declares an agent's capabilities
 * One manifest per agent, stored in scripts/integrations/<id>.json
 */
export interface IntegrationManifest {
  /** Unique agent identifier (e.g., 'claude-code', 'aider', 'opencode') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this agent does */
  description: string;
  /** Binary patterns to detect installation */
  binaryPatterns: string[];
  /** Installation paths to check */
  installPaths?: string[];
  /** Highest integration level achieved */
  level: IntegrationLevel;
  /** Mechanism used for integration */
  mechanism: IntegrationMechanism;
  /** Observable interfaces this agent exposes */
  interfaces: ObservableInterface;
  /** Event mapping: which canonical events can be detected and how reliably */
  events: EventMapping;
  /** Installation instructions for users */
  installInstructions: string;
  /** Configuration file path (if applicable) */
  configFile?: string;
  /** Skills directory (if applicable) */
  skillsPath?: string;
  /** Whether to auto-inject AGENT_ID env var */
  injectAgentId?: boolean;
  /** Tags for searchability */
  tags?: string[];
  /** Links to documentation */
  docs?: string[];
  /** Status: experimental | stable | deprecated */
  status?: 'experimental' | 'stable' | 'deprecated';
}

/**
 * Integration Mechanism types
 */
export type IntegrationMechanism =
  | 'hook'         // Claude Code, Cline — lifecycle hooks
  | 'wrapper'      // Shell wrapper that calls agent-notify
  | 'skill'        // SKILL.md instruction following
  | 'plugin'       // Agent's native plugin system
  | 'mcp'          // Model Context Protocol
  | 'acp'          // Agent Client Protocol
  | 'native'       // Deep internal API integration
  | 'cli';         // Manual agent-notify CLI calls

/**
 * Integration Discovery Result
 */
export interface IntegrationResult {
  /** The manifest for this agent */
  manifest: IntegrationManifest;
  /** Is this agent installed on the system? */
  installed: boolean;
  /** What integration level can be achieved? */
  achievableLevel: IntegrationLevel;
  /** What mechanism should be used? */
  recommendedMechanism: IntegrationMechanism;
  /** Installation command for the user */
  installCommand?: string;
  /** Status message for the user */
  statusMessage: string;
}

/**
 * Canonical Attention Event — the unified event type the runtime understands
 */
export interface CanonicalAttentionEvent {
  /** The canonical event type */
  event: AttentionEvent;
  /** Original lifecycle event (for debugging) */
  sourceEvent?: string;
  /** Reliability of this detection */
  reliability: CompletionReliability;
  /** Agent identity */
  agentId: string;
  /** Agent display name */
  agentName: string;
  /** The message to show the user */
  message: string;
  /** Timestamp */
  timestamp: number;
  /** Additional context */
  context?: Record<string, unknown>;
}

/**
 * Integration Provider — implements a specific mechanism
 */
export interface IntegrationProvider {
  /** Mechanism type this provider handles */
  mechanism: IntegrationMechanism;
  /**
   * Parse raw lifecycle data into a CanonicalAttentionEvent
   * Returns null if the data doesn't map to a notification-worthy event
   */
  parseEvent(
    payload: unknown,
    manifest: IntegrationManifest,
  ): CanonicalAttentionEvent | null;
  /**
   * Install integration for this agent
   * Returns the path where integration was installed
   */
  install(manifest: IntegrationManifest): Promise<string> | string;
  /**
   * Uninstall integration
   */
  uninstall(manifest: IntegrationManifest): void;
  /**
   * Get installation instructions for display
   */
  getInstallInstructions(manifest: IntegrationManifest): string;
}

/**
 * List all known integration mechanisms
 */
export const INTEGRATION_MECHANISMS: IntegrationMechanism[] = [
  'cli',
  'skill',
  'wrapper',
  'hook',
  'plugin',
  'mcp',
  'acp',
  'native',
];

/**
 * Reliability ordering (higher = more trustworthy)
 */
export const RELIABILITY_ORDER: Record<CompletionReliability, number> = {
  [CompletionReliability.Manual]: 0,
  [CompletionReliability.BestEffort]: 1,
  [CompletionReliability.Probable]: 2,
  [CompletionReliability.Verified]: 3,
};
