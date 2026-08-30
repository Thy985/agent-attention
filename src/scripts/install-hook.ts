/**
 * Install Claude Code hooks for Agent Attention.
 *
 * Writes a hooks.json into the project's .claude/ directory (project-level,
 * scoped to the current repo) and an optional global one in ~/.claude/ if
 * --global is passed.
 *
 * Usage:
 *   node dist/scripts/install-hook.js [--global] [--project <path>]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOOKS_FILENAME = 'hooks.json';
const CLAUDE_DIR_NAME = '.claude';

/** Read a JSON file; returns null if missing or invalid. */
function readJson(filePath: string): any | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write obj as compact JSON to filePath. */
function writeJson(filePath: string, obj: any): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

interface InstalledHook {
  type: string;
  command: string;
  statusMessage?: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: InstalledHook[];
}

interface HooksConfig {
  hooks: Record<string, HookEntry[]>;
}

/** Build the hooks.json content. */
function buildHooksConfig(hookPath: string): HooksConfig {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hookPath}"`,
              statusMessage: 'Agent Attention — recording session end',
              timeout: 5,
            },
          ],
        },
      ],
      SessionStart: [
        {
          hooks: [
            {
              type: 'command',
              command: `node "${hookPath}" --session-start`,
              statusMessage: 'Agent Attention — session started',
              timeout: 3,
            },
          ],
        },
      ],
    },
  };
}

function installHook(targetDir: string, hookPath: string): { installed: boolean; path: string } {
  const hooksDir = path.join(targetDir, CLAUDE_DIR_NAME);
  const hooksFile = path.join(hooksDir, HOOKS_FILENAME);

  const existing = readJson(hooksFile);
  const newConfig = buildHooksConfig(hookPath);

  // Merge with existing hooks (don't clobber other plugins).
  let merged: HooksConfig = { hooks: {} };
  if (existing && typeof existing === 'object' && 'hooks' in existing) {
    merged = existing as HooksConfig;
  }

  // Deep-merge: for each event type, append our hook if not already present.
  for (const eventType of Object.keys(newConfig.hooks)) {
    if (!merged.hooks[eventType]) {
      merged.hooks[eventType] = [];
    }
    const newHooks = newConfig.hooks[eventType];
    const existingHooks = merged.hooks[eventType] as HookEntry[];
    for (const newEntry of newHooks) {
      // Check if we already have this hook (match on command prefix).
      const alreadyHas = existingHooks.some((e: HookEntry) =>
        e.hooks.some((h) => h.command.includes('agent-attention') || h.command.includes(hookPath)),
      );
      if (!alreadyHas) {
        existingHooks.push(newEntry);
      }
    }
  }

  writeJson(hooksFile, merged);
  return { installed: true, path: hooksFile };
}

function main(): void {
  const args = process.argv.slice(2);
  const isGlobal = args.includes('--global');
  const projectArgIdx = args.indexOf('--project');
  const customProject = projectArgIdx >= 0 ? args[projectArgIdx + 1] : undefined;

  // Resolve the hook command path: use dist/daemon-cli.js directly.
  const distPath = path.resolve(__dirname, '..', 'daemon-cli.js');
  const hookPath = `"${distPath}"`;

  const targets: { dir: string; label: string }[] = [];
  if (isGlobal) {
    targets.push({ dir: path.join(os.homedir(), CLAUDE_DIR_NAME), label: 'global' });
  } else if (customProject) {
    targets.push({ dir: customProject, label: `project (${customProject})` });
  } else {
    // Default: install to current working directory (project-scoped).
    targets.push({ dir: process.cwd(), label: 'current project' });
  }

  for (const t of targets) {
    try {
      const result = installHook(t.dir, hookPath);
      console.log(`Installed Agent Attention hook (${t.label}): ${result.path}`);
    } catch (err) {
      console.error(`Failed to install hook at ${t.dir}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}

main();
