import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readState } from './state/AttentionState';

export interface AgentTarget {
  type: 'terminal';
  pid: number;
}

/**
 * Integration mode: how the Agent declares its presence to Runtime.
 *
 *  - "adapter": Agent uses a known adapter (e.g. claude-code). The
 *               `scripts/adapters/<id>.json` file describes its binary
 *               patterns and Skill installation path. `discover` finds it.
 *
 *  - "skill":   Agent self-registers after reading the agent-attention
 *               Skill. No adapter required; agent declares identity via
 *               `agent-attention agent register <id> <name>`.
 *
 *  - "none":    Identity is declared but no concrete integration path
 *               is known (legacy / unknown agent).
 *
 * Adapter helps discover and integrate Agent, but does NOT define Agent
 * identity. Identity is declared by the Agent/Host and persisted here.
 */
export type IntegrationMode = 'skill' | 'adapter' | 'none';

export interface Agent {
  agent_id: string;
  name: string;
  binary?: string | null;          // absolute path or basename; null = unknown
  integration?: IntegrationMode;   // see IntegrationMode above
  registered_at: number;           // epoch ms
  last_seen_at: number;            // epoch ms
  target?: AgentTarget | null;
}

export interface AgentRegistry {
  agents: Agent[];
  version: number;
}

/**
 * Current schema version. v3 adds binary + integration fields and folds
 * the old integrations.json into agents.json (see readRegistry).
 */
const REGISTRY_VERSION = 3;

function getRegistryPath(): string {
  return path.join(
    process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention'),
    'agents.json',
  );
}

function getIntegrationsPath(): string {
  return path.join(
    process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention'),
    'integrations.json',
  );
}

export function writeRegistry(registry: AgentRegistry): void {
  const registryPath = getRegistryPath();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  // P3-8 fix: use atomic write (tmp + rename) to prevent corruption from concurrent writes.
  // This matches the pattern used in AttentionState.atomicWrite.
  const tmpPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf-8');
    fs.renameSync(tmpPath, registryPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    // Fallback to direct write if rename fails (e.g., cross-device)
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
  }
}

/**
 * Old shape used by the now-removed integrations.json. Kept inline so the
 * migration path stays self-contained in this module.
 */
interface LegacyIntegrationEntry {
  id: string;
  name: string;
  binary: string;
  enabled: boolean;
  registered_at: number;
}
interface LegacyIntegrationConfig {
  version: number;
  agents: LegacyIntegrationEntry[];
}

function readLegacyIntegrations(): LegacyIntegrationConfig | null {
  const p = getIntegrationsPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as LegacyIntegrationConfig;
  } catch {
    return null;
  }
}

function deleteLegacyIntegrations(): void {
  try { fs.unlinkSync(getIntegrationsPath()); } catch {}
}

/**
 * Read the registry, applying any needed upgrades.
 *
 * Upgrade chain (idempotent):
 *  - v1 -> v2: ensure every agent has a `target` field.
 *  - v2 -> v3: ensure every agent has `binary` and `integration` fields.
 *  - integrations.json -> v3: fold enabled entries' binary/integration into
 *    the matching agent record, then delete the legacy file.
 */
export function readRegistry(): AgentRegistry {
  let registry: AgentRegistry | null = null;

  if (fs.existsSync(getRegistryPath())) {
    try {
      registry = JSON.parse(fs.readFileSync(getRegistryPath(), 'utf-8')) as AgentRegistry;
    } catch {
      registry = null;
    }
  }

  if (!registry || !Array.isArray(registry.agents)) {
    registry = { version: REGISTRY_VERSION, agents: [] };
  }

  // Fold legacy integrations.json into the registry, then delete it.
  const legacy = readLegacyIntegrations();
  if (legacy && Array.isArray(legacy.agents) && legacy.agents.length > 0) {
    for (const entry of legacy.agents) {
      if (!entry || !entry.id || entry.enabled === false) continue;
      const existing = registry.agents.find((a) => a.agent_id === entry.id);
      if (existing) {
        if (existing.binary === undefined || existing.binary === null) {
          existing.binary = entry.binary || null;
        }
        if (!existing.integration || existing.integration === 'none') {
          existing.integration = 'adapter';
        }
      } else {
        registry.agents.push({
          agent_id: entry.id,
          name: entry.name || entry.id,
          binary: entry.binary || null,
          integration: 'adapter',
          registered_at: entry.registered_at || Date.now(),
          last_seen_at: entry.registered_at || Date.now(),
          target: null,
        });
      }
    }
    deleteLegacyIntegrations();
  }

  let dirty = false;
  if (registry.version === 1) {
    registry.version = 2;
    for (const agent of registry.agents) {
      if (agent.target === undefined) agent.target = null;
    }
    dirty = true;
  }
  if (registry.version < 3) {
    for (const agent of registry.agents) {
      if (agent.binary === undefined) agent.binary = null;
      if (!agent.integration) agent.integration = 'none';
    }
    registry.version = 3;
    dirty = true;
  }

  if (dirty) writeRegistry(registry);
  return registry;
}

export interface RegisterOptions {
  /** Absolute path or basename of the Agent binary. */
  binary?: string | null;
  /** How this Agent integrates. Defaults to "skill". */
  integration?: IntegrationMode;
}

/**
 * Register an agent. If agent_id already exists, updates last_seen_at,
 * name, binary, and integration as needed. Returns the registered agent.
 *
 * Identity contract: Agent identity is declared by the Agent/Host, never
 * inferred by the Runtime. The Agent supplies its own agent_id + name;
 * binary/integration are optional metadata for tooling.
 */
export function registerAgent(
  agentId: string,
  name: string,
  options?: RegisterOptions,
): Agent {
  const registry = readRegistry();
  const now = Date.now();
  const incomingBinary = options?.binary !== undefined ? options.binary : undefined;
  const incomingIntegration = options?.integration;

  const existing = registry.agents.find((a) => a.agent_id === agentId);
  if (existing) {
    existing.last_seen_at = now;
    if (existing.name !== name) existing.name = name;
    if (existing.target === undefined) existing.target = null;
    if (existing.binary === undefined) existing.binary = null;
    if (!existing.integration) existing.integration = 'none';
    if (incomingBinary !== undefined && incomingBinary !== null) {
      existing.binary = incomingBinary;
    }
    if (incomingIntegration) {
      existing.integration = incomingIntegration;
    }
    writeRegistry(registry);
    return existing;
  }

  const agent: Agent = {
    agent_id: agentId,
    name,
    binary: incomingBinary !== undefined ? incomingBinary : null,
    integration: incomingIntegration || 'skill',
    registered_at: now,
    last_seen_at: now,
    target: null,
  };
  registry.agents.push(agent);
  writeRegistry(registry);
  return agent;
}

/**
 * Get agent info by agent_id. Returns undefined if not found.
 */
export function getAgent(agentId: string): Agent | undefined {
  const registry = readRegistry();
  return registry.agents.find((a) => a.agent_id === agentId);
}

/**
 * Update an agent's target (e.g., terminal PID for Target Jump).
 * Pass `null` to clear the target.
 * Throws if the agent does not exist.
 */
export function updateAgentTarget(agentId: string, target: AgentTarget | null): void {
  const registry = readRegistry();
  const agent = registry.agents.find((a) => a.agent_id === agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found in registry`);
  }
  agent.target = target;
  writeRegistry(registry);
}

/**
 * Get the unread event count for a given agent from the state file.
 */
export function getAgentUnreadCount(statePath: string, agentId: string): number {
  const state = readState(statePath);
  return state.events.filter((e) => e.agent_id === agentId && !e.read).length;
}

/**
 * List all registered agents.
 */
export function listAgents(): Agent[] {
  return readRegistry().agents;
}

/**
 * Resolve the agent identity from environment and register if needed.
 * Returns agent_id (used for dedup and state recording).
 *
 * Identity sources (in priority order):
 * 1. AGENT_ID env var — Agent explicitly declares its identity.
 *    This is the ONLY authoritative source. Runtime does NOT guess.
 * 2. Anonymous fallback — emitted with a warning when AGENT_ID is missing.
 *
 * Per Agent Attention Integration Protocol v1:
 * "Agent identity is declared by the Agent, never inferred by the Runtime."
 */
export function autoDetectAndRegister(): { agentId: string; agentName: string } {
  const envAgentId = process.env.AGENT_ID;
  const envAgentName = process.env.AGENT_NAME;

  // Explicit AGENT_ID — Agent declares identity, register silently
  if (envAgentId) {
    const registered = registerAgent(envAgentId, envAgentName || envAgentId);
    return { agentId: registered.agent_id, agentName: registered.name };
  }

  // No identity declared — anonymous fallback with warning
  // Agents MUST set AGENT_ID for proper grouping in Center
  const fallbackId = "anonymous";
  console.warn(
    "[agent-attention] WARNING: AGENT_ID not set. Using anonymous identity.\n" +
    '  Run: agent-attention agent register <id> "<name>"\n' +
    "  Or set AGENT_ID / AGENT_NAME environment variables.",
  );
  return { agentId: fallbackId, agentName: fallbackId };
}
