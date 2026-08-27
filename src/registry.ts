import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readState } from './state/AttentionState';

export interface AgentTarget {
  type: 'terminal';
  pid: number;
}

export interface Agent {
  agent_id: string;
  name: string;
  registered_at: number; // epoch ms
  last_seen_at: number;  // epoch ms
  target?: AgentTarget | null;
}

export interface AgentRegistry {
  agents: Agent[];
  version: number;
}

const REGISTRY_VERSION = 2;

/**
 * Resolve registry path. AGENT_ATTENTION_HOME overrides the base directory
 * (same convention as src/dedup/index.ts) so tests can isolate from the real
 * user dir instead of writing/deleting ~/.agent-attention.
 */
function getRegistryPath(): string {
  return path.join(
    process.env.AGENT_ATTENTION_HOME || path.join(os.homedir(), '.agent-attention'),
    'agents.json',
  );
}

export function readRegistry(): AgentRegistry {
  try {
    if (fs.existsSync(getRegistryPath())) {
      const raw = fs.readFileSync(getRegistryPath(), 'utf-8');
      return JSON.parse(raw) as AgentRegistry;
    }
  } catch {
    // Corrupted registry — return default
  }
  return { version: REGISTRY_VERSION, agents: [] };
}

export function writeRegistry(registry: AgentRegistry): void {
  fs.mkdirSync(path.dirname(getRegistryPath()), { recursive: true });
  fs.writeFileSync(getRegistryPath(), JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * Register an agent. If agent_id already exists, updates last_seen_at only.
 * Returns the registered agent.
 */
export function registerAgent(agentId: string, name: string): Agent {
  const registry = readRegistry();

  // Migrate from v1 to v2: ensure every agent has a version field on write
  if (registry.version === 1) {
    registry.version = 2;
    for (const agent of registry.agents) {
      if (agent.target === undefined) {
        agent.target = null;
      }
    }
  }

  const now = Date.now();

  // Find existing agent
  const existing = registry.agents.find((a) => a.agent_id === agentId);
  if (existing) {
    existing.last_seen_at = now;
    // Update name if it changed
    if (existing.name !== name) {
      existing.name = name;
    }
    // Ensure target field is preserved (migrate v1 entries)
    if (existing.target === undefined) {
      existing.target = null;
    }
    writeRegistry(registry);
    return existing;
  }

  // New agent
  const agent: Agent = {
    agent_id: agentId,
    name,
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
 * Computes from the events array directly so the registry module
 * does not need to import the full state module at call time.
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
export function autoDetectAndRegister(): string {
  const envAgentId = process.env.AGENT_ID;
  const envAgentName = process.env.AGENT_NAME;

  // Explicit AGENT_ID — Agent declared identity, register silently
  if (envAgentId) {
    return registerAgent(envAgentId, envAgentName || envAgentId).agent_id;
  }

  // No identity declared — anonymous fallback with warning
  // Agents MUST set AGENT_ID for proper grouping in Center
  const fallbackId = "anonymous";
  console.warn(
    "[agent-attention] WARNING: AGENT_ID not set. Using anonymous identity.\n" +
    '  Run: agent-attention agent register <id> "<name>"\n' +
    "  Or set AGENT_ID / AGENT_NAME environment variables.",
  );
  return registerAgent(fallbackId, "anonymous").agent_id;
}

