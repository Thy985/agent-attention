/**
 * Tests for the Claude Code hook handler (agent-attention hook command).
 *
 * Covers:
 *  - exitStatus 0 → completed event
 *  - exitStatus 1 → failed event
 *  - exitStatus 2 → input_required event
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

  it('exitStatus 0 → completed event', async () => {
    const { exitCode } = await runHook(JSON.stringify({ sessionId: 's1', exitStatus: 0, turns: 3, agentId: 'claude-code' }));
    expect(exitCode).toBe(0);
    const state = readState();
    expect(state.events.length).toBeGreaterThan(0);
    const last = state.events[0];
    expect(last.type).toBe('completed');
    expect(last.agent_id).toBe('claude-code');
    expect(last.message).toContain('session ended cleanly');
    expect(last.priority).toBe('P2');
  });

  it('exitStatus 1 → failed event', async () => {
    const { exitCode } = await runHook(JSON.stringify({ sessionId: 's2', exitStatus: 1, agentId: 'codex' }));
    expect(exitCode).toBe(0);
    const state = readState();
    const last = state.events[0];
    expect(last.type).toBe('failed');
    expect(last.priority).toBe('P1');
    expect(last.agent_id).toBe('codex');
  });

  it('exitStatus 2 → input_required event', async () => {
    const { exitCode } = await runHook(JSON.stringify({ sessionId: 's3', exitStatus: 2, agentId: 'claude-code' }));
    expect(exitCode).toBe(0);
    const state = readState();
    const last = state.events[0];
    expect(last.type).toBe('input_required');
    expect(last.priority).toBe('P0');
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

  it('autoDetectAndRegister when agentId is missing', async () => {
    const before = readState().events.length;
    await runHook(JSON.stringify({ sessionId: 's5', exitStatus: 0, turns: 2 }));
    const state = readState();
    const last = state.events[0];
    expect(last.agent_id).toBeTruthy(); // registered via autoDetectAndRegister
    expect(last.type).toBe('completed');
  });
});
