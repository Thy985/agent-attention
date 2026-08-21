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

const REGISTRY_PATH = path.join(os.homedir(), '.agent-attention', 'agents.json');
const REGISTRY_VERSION = 2;

function readRegistry(): AgentRegistry {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
      return JSON.parse(raw) as AgentRegistry;
    }
  } catch {
    // Corrupted registry — return default
  }
  return { version: REGISTRY_VERSION, agents: [] };
}

function writeRegistry(registry: AgentRegistry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
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
 * Auto-detect agent from environment and register if needed.
 * Returns agent_id (used for dedup and state recording).
 */
export function autoDetectAndRegister(): string {
  // Try environment variables first
  const envAgentId = process.env.AGENT_ID;
  const envAgentName = process.env.AGENT_NAME;

  if (envAgentId) {
    return registerAgent(envAgentId, envAgentName || envAgentId).agent_id;
  }

  // Detect from process name / Claude Code pattern
  const detectedId = detectAgentId();
  const detectedName = detectAgentName();

  if (detectedId) {
    return registerAgent(detectedId, detectedName).agent_id;
  }

  // Fallback to generic agent
  return registerAgent('agent', 'Agent').agent_id;
}

function detectAgentId(): string | null {
  // Check for known agent environments
  if (process.env.CLAUDE_CODE) return 'claude-code';
  if (process.env.CODEx) return 'codex';
  if (process.env.OPENAI_WORKERS) return 'openai-agents';

  // Check process title (limited but better than nothing)
  const exe = process.execPath?.toLowerCase() || '';
  if (exe.includes('claude')) return 'claude-code';
  if (exe.includes('codex')) return 'codex';

  return null;
}

function detectAgentName(): string {
  const id = detectAgentId();
  const names: Record<string, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'openai-agents': 'OpenAI Agents',
  };
  return id ? (names[id] || id) : 'Agent';
}
