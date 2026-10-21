import * as os from 'os';
import * as path from 'path';
/** HOME is canonical; STATE_DIR remains a lower-priority legacy MCP alias. */
export function resolveStateDir(): string {
  return path.resolve(process.env.AGENT_ATTENTION_HOME || process.env.AGENT_ATTENTION_STATE_DIR || path.join(os.homedir(), '.agent-attention'));
}
export function resolveStatePath(): string { return path.join(resolveStateDir(), 'state.json'); }
