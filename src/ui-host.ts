import * as fs from 'fs';
import * as path from 'path';

export type UiMode = 'csharp' | 'ps';

export function getUiMode(): UiMode {
  // M7: default is csharp; AGENT_ATTENTION_UI=ps rolls back to PowerShell
  return process.env.AGENT_ATTENTION_UI?.toLowerCase() === 'ps' ? 'ps' : 'csharp';
}

export function resolveNativeUiPath(): string | null {
  const override = process.env.AGENT_ATTENTION_UI_EXE;
  if (override) return fs.existsSync(override) ? override : null;

  const moduleName = 'AgentAttention.UI.exe';
  const roots = [
    __dirname,
    path.join(__dirname, '..'),
  ];
  const candidates = roots.flatMap((root) => [
    path.join(root, 'src', 'center', 'csharp', 'dist', 'win-x64', moduleName),
    path.join(root, 'src', 'center', 'csharp', 'AgentAttention.UI', 'bin', 'Release', 'net10.0-windows', moduleName),
    path.join(root, 'src', 'center', 'csharp', 'AgentAttention.UI', 'bin', 'Debug', 'net10.0-windows', moduleName),
  ]);

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
