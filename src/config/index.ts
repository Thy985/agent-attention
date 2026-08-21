import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SoundConfig {
  enabled: boolean;
}

export interface EventConfig {
  [key: string]: boolean;
}

export interface AgentAttentionConfig {
  enabled: boolean;
  sound: SoundConfig;
  events: EventConfig;
}

const DEFAULT_CONFIG: AgentAttentionConfig = {
  enabled: true,
  sound: { enabled: true },
  events: {
    completed: true,
    permission_required: true,
    input_required: true,
    failed: true,
  },
};

/**
 * Load config from ~/.agent-attention/config.yaml.
 * Returns defaults on any error (missing file, parse error, etc.).
 */
export function loadConfig(): AgentAttentionConfig {
  const dir = path.join(os.homedir(), '.agent-attention');
  const filePath = path.join(dir, 'config.yaml');

  if (!fs.existsSync(filePath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const yaml = require('js-yaml');
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(content) as Partial<AgentAttentionConfig>;
    return { ...DEFAULT_CONFIG, ...parsed } as AgentAttentionConfig;
  } catch {
    return DEFAULT_CONFIG;
  }
}
