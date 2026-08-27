import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface AgentAdapter {
  id: string;
  name: string;
  binaryPatterns: string[];
  skillPath?: string;   // e.g. "~/.claude/skills" or "~/.codex/skills"
  injectAgentId?: boolean; // whether to auto-set AGENT_ID in shell config
}

export interface IntegrationConfig {
  version: number;
  agents: IntegrationAgent[];
}

export interface IntegrationAgent {
  id: string;
  name: string;
  binary: string;
  enabled: boolean;
  registered_at: number;
}

const ADAPTERS_DIR = path.join(__dirname, '..', 'scripts', 'adapters');
const INTEGRATIONS_PATH = path.join(os.homedir(), '.agent-attention', 'integrations.json');

/** Load all known agent adapters from the adapters registry. */
export function loadAdapters(): AgentAdapter[] {
  const adapters: AgentAdapter[] = [];
  try {
    if (!fs.existsSync(ADAPTERS_DIR)) return adapters;
    const files = fs.readdirSync(ADAPTERS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const adapter = JSON.parse(fs.readFileSync(path.join(ADAPTERS_DIR, file), 'utf-8')) as AgentAdapter;
        adapters.push(adapter);
      } catch {}
    }
  } catch {}
  return adapters;
}

/** Find which adapters are installed on PATH. */
export function discoverInstalled(adapters: AgentAdapter[]): string[] {
  const found: string[] = [];
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);

  for (const adapter of adapters) {
    for (const pattern of adapter.binaryPatterns) {
      for (const dir of pathDirs) {
        const binPath = path.join(dir, pattern);
        try {
          fs.accessSync(binPath, fs.constants.X_OK);
          found.push(adapter.id);
          break;
        } catch {}
      }
      if (found.includes(adapter.id)) break;
    }
  }
  return found;
}

/** Get already-integrated agent IDs. */
export function getIntegratedAgents(): string[] {
  try {
    if (!fs.existsSync(INTEGRATIONS_PATH)) return [];
    const config = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf-8')) as IntegrationConfig;
    return config.agents
      .filter(a => a.enabled)
      .map(a => a.id);
  } catch {
    return [];
  }
}

/** Register an agent integration. */
export function integrateAgent(adapter: AgentAdapter): IntegrationAgent {
  let config: IntegrationConfig;
  try {
    config = fs.existsSync(INTEGRATIONS_PATH)
      ? JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf-8'))
      : { version: 1, agents: [] };
  } catch {
    config = { version: 1, agents: [] };
  }

  // Remove existing entry for same agent
  config.agents = config.agents.filter(a => a.id !== adapter.id);

  // Add new entry
  config.agents.push({
    id: adapter.id,
    name: adapter.name,
    binary: adapter.binaryPatterns[0],
    enabled: true,
    registered_at: Date.now(),
  });

  fs.mkdirSync(path.dirname(INTEGRATIONS_PATH), { recursive: true });
  fs.writeFileSync(INTEGRATIONS_PATH, JSON.stringify(config, null, 2), 'utf-8');
  return config.agents[config.agents.length - 1];
}

/** Check if a given agent_id is already registered in integrations.json. */
export function isIntegrated(agentId: string): boolean {
  try {
    if (!fs.existsSync(INTEGRATIONS_PATH)) return false;
    const config = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf-8')) as IntegrationConfig;
    return config.agents.some(a => a.id === agentId && a.enabled);
  } catch {
    return false;
  }
}

/**
 * Check if an agent notification complies with the expected protocol.
 * This is a best-effort heuristic — it checks whether the event type
 * matches what the agent's adapter declares as valid.
 */
export function checkCompliance(agentId: string, eventType: string): boolean {
  const adapters = loadAdapters();
  const adapter = adapters.find(a => a.id === agentId);
  if (!adapter) return true; // unknown agent, skip compliance check

  const validEvents = ['completed', 'permission_required', 'input_required', 'failed'];
  return validEvents.includes(eventType);
}
