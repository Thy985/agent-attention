import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
/** HOME is canonical; STATE_DIR remains a lower-priority legacy MCP alias. */
export function resolveStateDir(): string {
  return path.resolve(process.env.AGENT_ATTENTION_HOME || process.env.AGENT_ATTENTION_STATE_DIR || path.join(os.homedir(), '.agent-attention'));
}
export function resolveStatePath(): string { return path.join(resolveStateDir(), 'state.json'); }

/**
 * libuv's Windows fs-event backend can abort (not throw) when the watched
 * directory uses an 8.3 name but GetLongPathNameW returns a long name. Expand
 * the existing ancestor before registering a native watch, including when the
 * state file has not been created yet. Keep the configured storage path intact.
 * See nodejs/node#19170 and nodejs/node commit 670b3665c0.
 */
export function resolveNativeWatchPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return filePath;
  const paths = path.win32;
  let ancestor = paths.resolve(filePath);
  const missing: string[] = [];
  for (;;) {
    try {
      return paths.join(fs.realpathSync.native(ancestor), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Access failures must surface, not silently register the unsafe alias.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = paths.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(paths.basename(ancestor));
      ancestor = parent;
    }
  }
}
