/**
 * Integration Providers — one per mechanism type
 *
 * Each provider handles:
 *   1. Parsing raw lifecycle data → CanonicalAttentionEvent
 *   2. Installing the integration
 *   3. Generating install instructions
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  IntegrationManifest,
  IntegrationProvider,
  CanonicalAttentionEvent,
  CompletionReliability,
  IntegrationMechanism,
} from './types';
import { recordEvent } from '../state/AttentionState';
import { autoDetectAndRegister } from '../registry';
import { log, generateCorrelationId } from '../logging';

// Hook Provider — handles Claude Code / Cline style hooks
export class HookProvider implements IntegrationProvider {
  mechanism: IntegrationMechanism = 'hook';

  parseEvent(payload: unknown, manifest: IntegrationManifest): CanonicalAttentionEvent | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;

    const exitStatus = p.exitStatus as number | undefined;
    const turns = (p.turns as number) ?? 0;
    const sessionId = (p.sessionId as string) ?? 'unknown';
    const agentId = (p.agentId as string) ?? manifest.id;

    if (exitStatus === undefined) return null; // No actionable event

    let event: string;
    let reliability: CompletionReliability;
    let message: string;

    if (exitStatus === 0 && turns > 0) {
      event = 'completed';
      reliability = CompletionReliability.Verified;
      message = `${manifest.name} session ended cleanly (${turns} turn${turns > 1 ? 's' : ''}, session ${sessionId.slice(0, 8)})`;
    } else if (exitStatus === 1) {
      event = 'failed';
      reliability = CompletionReliability.Verified;
      message = `${manifest.name} session failed (exit=${exitStatus}, session ${sessionId.slice(0, 8)})`;
    } else if (exitStatus === 2) {
      event = 'input_required';
      reliability = CompletionReliability.Verified;
      message = `${manifest.name} session cancelled by user (session ${sessionId.slice(0, 8)})`;
    } else {
      return null;
    }

    return {
      event: event as any,
      sourceEvent: `Stop(exitStatus=${exitStatus})`,
      reliability,
      agentId,
      agentName: manifest.name,
      message,
      timestamp: Date.now(),
      context: { sessionId, turns, exitStatus },
    };
  }

  install(manifest: IntegrationManifest): string {
    const hooksDir = path.join(process.cwd(), '.claude');
    const hooksFile = path.join(hooksDir, 'hooks.json');
    fs.mkdirSync(hooksDir, { recursive: true });

    const existing = this.readJson(hooksFile);
    const hookEntry = {
      type: 'command' as const,
      command: `node "${path.join(__dirname, '..', '..', 'dist', 'daemon-cli.js')}" hook`,
      statusMessage: `${manifest.name} — recording session end`,
      timeout: 5,
    };

    const config = existing && existing.hooks
      ? existing
      : { hooks: {} };

    if (!config.hooks.Stop) config.hooks.Stop = [];
    if (!Array.isArray(config.hooks.Stop)) config.hooks.Stop = [config.hooks.Stop];

    // Avoid duplicates
    const alreadyHas = config.hooks.Stop.some((e: any) =>
      e.hooks?.some((h: any) => h.command?.includes('daemon-cli'))
    );
    if (!alreadyHas) {
      config.hooks.Stop.push({ hooks: [hookEntry] });
    }

    fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return hooksFile;
  }

  uninstall(manifest: IntegrationManifest): void {
    const hooksFile = path.join(process.cwd(), '.claude', 'hooks.json');
    if (!fs.existsSync(hooksFile)) return;

    const config = this.readJson(hooksFile);
    if (config?.hooks?.Stop) {
      config.hooks.Stop = config.hooks.Stop.filter((e: any) =>
        !e.hooks?.some((h: any) => h.command?.includes('daemon-cli'))
      );
      fs.writeFileSync(hooksFile, JSON.stringify(config, null, 2), 'utf-8');
    }
  }

  getInstallInstructions(manifest: IntegrationManifest): string {
    return `Run: agent-attention integration install ${manifest.id}\n\nThis creates .claude/hooks.json with Stop and SessionStart hooks.`;
  }

  private readJson(filePath: string): any | null {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return null;
    }
  }
}

// Wrapper Provider — shell script that wraps agent execution
export class WrapperProvider implements IntegrationProvider {
  mechanism: IntegrationMechanism = 'wrapper';

  parseEvent(payload: unknown, manifest: IntegrationManifest): CanonicalAttentionEvent | null {
    // Wrapper events come from process exit, not stdin JSON
    // This is a best-effort inference
    if (typeof payload === 'number') {
      const exitCode = payload;
      if (exitCode === 0) {
        return {
          event: 'completed',
          sourceEvent: `process_exit(0)`,
          reliability: CompletionReliability.Probable,
          agentId: manifest.id,
          agentName: manifest.name,
          message: `${manifest.name} session finished (wrapper detected clean exit)`,
          timestamp: Date.now(),
        };
      } else {
        return {
          event: 'failed',
          sourceEvent: `process_exit(${exitCode})`,
          reliability: CompletionReliability.BestEffort,
          agentId: manifest.id,
          agentName: manifest.name,
          message: `${manifest.name} session failed (exit code ${exitCode})`,
          timestamp: Date.now(),
        };
      }
    }
    return null;
  }

  install(manifest: IntegrationManifest): string {
    const wrapperName = `agent-${manifest.id}-wrapper`;
    const wrapperPath = path.join(os.homedir(), `.agent-attention`, 'wrappers', `${wrapperName}.sh`);
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });

    const script = `#!/bin/bash
# Agent Attention Wrapper for ${manifest.name}
# Generated by agent-attention integration install ${manifest.id}

export AGENT_ID=${manifest.id}
export AGENT_NAME="${manifest.name}"

# Run the agent with all arguments
"$@"
exit_code=$?

# Send notification based on exit code
if [ $exit_code -eq 0 ]; then
  agent-notify completed "${manifest.name} session finished"
else
  agent-notify failed "${manifest.name} session failed (exit=$exit_code)"
fi

exit $exit_code
`;

    fs.writeFileSync(wrapperPath, script, 'utf-8');
    fs.chmodSync(wrapperPath, '755');
    return wrapperPath;
  }

  uninstall(manifest: IntegrationManifest): void {
    const wrapperPath = path.join(os.homedir(), `.agent-attention`, 'wrappers', `agent-${manifest.id}-wrapper.sh`);
    try { fs.unlinkSync(wrapperPath); } catch {}
  }

  getInstallInstructions(manifest: IntegrationManifest): string {
    return `Run: agent-attention integration install ${manifest.id}\n\nThis creates ~/.agent-attention/wrappers/agent-${manifest.id}-wrapper.sh\nUse it instead of direct agent invocation:`;
  }
}

// Skill Provider — reads SKILL.md and follows instructions
export class SkillProvider implements IntegrationProvider {
  mechanism: IntegrationMechanism = 'skill';

  parseEvent(payload: unknown, manifest: IntegrationManifest): CanonicalAttentionEvent | null {
    // Skill-based agents don't have structured events
    // They rely on the agent voluntarily calling agent-notify
    return null;
  }

  install(manifest: IntegrationManifest): string {
    const skillsDir = manifest.skillsPath
      ? path.join(os.homedir(), manifest.skillsPath.replace('~', ''))
      : path.join(process.cwd(), '.claude', 'skills');
    const skillDir = path.join(skillsDir, 'agent-attention');
    const skillFile = path.join(skillDir, 'SKILL.md');

    fs.mkdirSync(skillDir, { recursive: true });

    const skillContent = `---
name: agent-attention
description: Local notification center for AI agents. Notify when tasks complete, need approval, or fail.
triggers:
  - "agent task completed"
  - "need user approval"
  - "waiting for input"
  - "agent failed"
---

# Agent Attention — ${manifest.name} Integration

${manifest.installInstructions}

When you finish a task, call:
\`\`\`
agent-notify completed "Task summary"
\`\`\`

When you need approval:
\`\`\`
agent-notify permission_required "What needs approval"
\`\`\`

When you fail:
\`\`\`
agent-notify failed "What failed and why"
\`\`\`
`;

    fs.writeFileSync(skillFile, skillContent, 'utf-8');
    return skillFile;
  }

  uninstall(manifest: IntegrationManifest): void {
    const skillFile = path.join(process.cwd(), '.claude', 'skills', 'agent-attention', 'SKILL.md');
    try { fs.unlinkSync(skillFile); } catch {}
  }

  getInstallInstructions(manifest: IntegrationManifest): string {
    return `Run: agent-attention integration install ${manifest.id}\n\nThis installs skill.md to .claude/skills/agent-attention/\nThe agent should read this skill and follow the notification protocol.`;
  }
}

// Plugin Provider — for agents with native plugin systems (OpenCode)
export class PluginProvider implements IntegrationProvider {
  mechanism: IntegrationMechanism = 'plugin';

  parseEvent(payload: unknown, manifest: IntegrationManifest): CanonicalAttentionEvent | null {
    // Plugin events depend on the specific plugin API
    // This is a generic parser; each plugin provider should override
    if (typeof payload === 'object' && payload !== null) {
      const p = payload as Record<string, unknown>;
      const event = p.event as string | undefined;
      const status = p.status as string | undefined;

      if (status === 'completed' || status === 'success') {
        return {
          event: 'completed',
          sourceEvent: event,
          reliability: CompletionReliability.Probable,
          agentId: manifest.id,
          agentName: manifest.name,
          message: `${manifest.name} completed ${event ?? 'session'}`,
          timestamp: Date.now(),
          context: p,
        };
      }
      if (status === 'failed' || status === 'error') {
        return {
          event: 'failed',
          sourceEvent: event,
          reliability: CompletionReliability.BestEffort,
          agentId: manifest.id,
          agentName: manifest.name,
          message: `${manifest.name} failed: ${p.message ?? 'unknown error'}`,
          timestamp: Date.now(),
          context: p,
        };
      }
    }
    return null;
  }

  install(manifest: IntegrationManifest): string {
    // Plugin installation is agent-specific
    // Return placeholder; actual implementation per agent
    return `Plugin installation for ${manifest.id} requires manual setup.\nSee: ${manifest.docs?.[0] ?? 'documentation'}`;
  }

  uninstall(manifest: IntegrationManifest): void {
    // Plugin uninstallation is agent-specific
  }

  getInstallInstructions(manifest: IntegrationManifest): string {
    return manifest.installInstructions;
  }
}

// Factory function to get provider for a mechanism
export function getProvider(mechanism: IntegrationMechanism): IntegrationProvider {
  switch (mechanism) {
    case 'hook': return new HookProvider();
    case 'wrapper': return new WrapperProvider();
    case 'skill': return new SkillProvider();
    case 'plugin': return new PluginProvider();
    default:
      throw new Error(`Unknown integration mechanism: ${mechanism}`);
  }
}
