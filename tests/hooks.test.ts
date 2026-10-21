/**
 * Tests for the Claude Code hook handler (agent-attention hook command).
 *
 * Covers:
 *  - legacy exitStatus never proves task outcome
 *  - no exitStatus → ignored
 *  - malformed JSON → silent ignore (exit 0)
 *  - empty stdin → silent ignore (exit 0)
 *  - agent_id propagation from payload
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('hook handler', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-hook-'));
    statePath = path.join(tmpDir, 'state.json');
    // Seed an empty state so readState has something to work with.
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: 0, unreadCount: 0, events: [], visible: true,
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run the hook command by piping `stdinData` into node dist/daemon-cli.js hook. */
  function runHook(stdinData: string): Promise<{ exitCode: number; stderr: string }> {
    return new Promise((resolve) => {
      const { spawn } = require('child_process');
      const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'daemon-cli.js'), 'hook'], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, AGENT_ATTENTION_HOME: tmpDir },
      });
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code: number | null) => resolve({ exitCode: code ?? 0, stderr }));
      proc.stdin.write(stdinData + '\n');
      proc.stdin.end();
    });
  }

  function readState() {
    return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  }

  it.each([0, 1, 2])('legacy exitStatus %i is ignored without supported evidence', async (exitStatus) => {
    const { exitCode } = await runHook(JSON.stringify({ sessionId: 's1', exitStatus, turns: 3, agentId: 'claude-code' }));
    expect(exitCode).toBe(0);
    expect(readState().events).toHaveLength(0);
  });

  it('no exitStatus → ignored (no new event)', async () => {
    const before = readState().events.length;
    await runHook(JSON.stringify({ sessionId: 's4', turns: 1 }));
    const after = readState().events.length;
    expect(after).toBe(before);
  });

  it('malformed JSON → silent ignore (exit 0, no crash)', async () => {
    const { exitCode } = await runHook('not json at all!!!');
    expect(exitCode).toBe(0);
  });

  it('empty stdin → silent ignore (exit 0)', async () => {
    const { exitCode } = await runHook('');
    expect(exitCode).toBe(0);
  });

  it('documented source identity overrides invented camelCase payload identity', async () => {
    await runHook(JSON.stringify({ session_id: 's5', hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Please approve', agentId: 'spoof' }));
    const last = readState().events[0];
    expect(last.agent_id).toBe('claude-code');
    expect(last.type).toBe('permission_required');
    expect(last.session_id).toBe('s5');
  });
});
