import * as fs from 'fs';
import * as path from 'path';

/**
 * Adapter definition (project-bundled, static). These describe known
 * Agent binaries and their Skill installation paths so `discover` and
 * `integrate` can offer best-effort bootstrap.
 *
 * IMPORTANT: An adapter is OPTIONAL. An Agent that self-registers via
 * `agent-attention agent register <id> <name>` does not need one.
 */
export interface AgentAdapter {
  id: string;
  name: string;
  binaryPatterns: string[];
  skillPath?: string;        // e.g. "~/.claude/skills" or "~/.codex/skills"
  injectAgentId?: boolean;   // whether to suggest `export AGENT_ID=...`
}

const ADAPTERS_DIR = path.join(__dirname, '..', 'scripts', 'adapters');

/** Load all known agent adapters from the project adapter directory. */
export function loadAdapters(): AgentAdapter[] {
  const adapters: AgentAdapter[] = [];
  try {
    if (!fs.existsSync(ADAPTERS_DIR)) return adapters;
    const files = fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const adapter = JSON.parse(
          fs.readFileSync(path.join(ADAPTERS_DIR, file), 'utf-8'),
        ) as AgentAdapter;
        adapters.push(adapter);
      } catch {
        // Skip malformed adapter files silently — discover is best-effort.
      }
    }
  } catch {
    // Directory unreadable — treat as no adapters available.
  }
  return adapters;
}

/** Find which adapter IDs are installed on PATH (best-effort). */
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
        } catch {
          // Try next directory.
        }
      }
      if (found.includes(adapter.id)) break;
    }
  }
  return found;
}

/**
 * Best-effort compliance check: does the agent_id exist as a known
 * adapter, and does the event_type look like a protocol event?
 *
 * Unknown agents are treated as compliant (we don't have an adapter to
 * check against). This intentionally avoids rejecting legitimate
 * self-registered agents.
 */
export function checkCompliance(agentId: string, eventType: string): boolean {
  const adapters = loadAdapters();
  const adapter = adapters.find((a) => a.id === agentId);
  if (!adapter) return true; // unknown agent, skip compliance check

  const validEvents = ['completed', 'permission_required', 'input_required', 'failed'];
  return validEvents.includes(eventType);
}
