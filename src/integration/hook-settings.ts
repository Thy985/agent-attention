import * as fs from 'fs';
import * as path from 'path';

/** All supported installers use the same observational, non-approving hooks. */
export function claudeHookEntries(hookPath: string): Record<string, any[]> {
  const mk = (matcher?: string) => [{
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: `node "${hookPath}" hook`, timeout: 10 }],
  }];
  return {
    SessionStart: mk(), Stop: mk(), // backwards-compatible no-op lifecycle observation
    Notification: mk('permission_prompt'), Elicitation: mk(), StopFailure: mk(),
  };
}
function withoutOwned(groups: any[], hookPath: string): any[] {
  const expected = `node "${hookPath}" hook`;
  const legacy = `node ${hookPath} hook`;
  return groups.flatMap((group: any) => {
    if (!group || !Array.isArray(group.hooks)) throw new Error('Invalid hook group; settings were not changed');
    const hooks = group.hooks.filter((h: any) => h?.command !== expected && h?.command !== legacy);
    // Preserve unrelated empty groups; drop only groups emptied by our removal.
    return hooks.length === 0 && hooks.length !== group.hooks.length ? [] : [{ ...group, hooks }];
  });
}
export function installClaudeHooks(projectDir: string, hookPath: string): string {
  const settings = path.join(projectDir, '.claude', 'settings.json');
  let config: any = {};
  if (fs.existsSync(settings)) {
    config = JSON.parse(fs.readFileSync(settings, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Claude settings object');
  }
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) {
    throw new Error('Invalid Claude hooks object');
  }
  config.hooks ??= {};
  for (const [name, entries] of Object.entries(claudeHookEntries(hookPath))) {
    const existing = config.hooks[name] ?? [];
    if (!Array.isArray(existing)) throw new Error(`Invalid hook groups: ${name}`);
    // Replace only our own command, retaining other hooks even within the same group.
    const preserved = withoutOwned(existing, hookPath);
    config.hooks[name] = [...preserved, ...entries];
  }
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify(config, null, 2) + '\n');
  return settings;
}

/** Remove only owned commands, never another hook sharing the same group. */
export function removeClaudeHooks(settings: string, hookPath: string): void {
  if (!fs.existsSync(settings)) return;
  const config = JSON.parse(fs.readFileSync(settings, 'utf8'));
  for (const name of Object.keys(claudeHookEntries(''))) {
    if (!Array.isArray(config.hooks?.[name])) continue;
    config.hooks[name] = withoutOwned(config.hooks[name], hookPath);
    if (!config.hooks[name].length) delete config.hooks[name];
  }
  fs.writeFileSync(settings, JSON.stringify(config, null, 2) + '\n');
}
