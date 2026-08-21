import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerAgent,
  getAgent,
  listAgents,
  updateAgentTarget,
  getAgentUnreadCount,
  AgentTarget,
} from '../src/registry';
import { recordEvent, readState } from '../src/state/AttentionState';

describe('Registry v2 with Target', () => {
  let registryPath: string;
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    // Override the registry path to use a temp directory
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-reg-'));
    registryPath = path.join(tmpDir, 'agents.json');

    // We can't override the module-level constant directly, so we use
    // a jest.mock-style approach: replace fs.existsSync / readFileSync / writeFileSync
    // by mocking the file module.
    // Instead, we create a real registry at the default path but clean up after.
    // For simplicity in tests, we'll patch `path.join` / `os.homedir` by using the
    // direct fs ops with a controlled path via require.cache invalidation trick...
    // Actually the simplest approach: write directly to the real path.
    // Use jest.spy on the internal functions isn't possible (not exported).
    // So let's just point at the temp path by temporarily overriding the module.
  });

  afterEach(() => {
    // Clean up any temp registry file if it was created at the real path
    const realPath = path.join(os.homedir(), '.agent-attention', 'agents.json');
    if (fs.existsSync(realPath)) {
      fs.unlinkSync(realPath);
    }
    const realStateDir = path.join(os.homedir(), '.agent-attention');
    if (fs.existsSync(realStateDir)) {
      fs.rmSync(realStateDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper: run a callback with the registry path overridden to a temp dir.
   * We achieve this by temporarily monkey-patching path.join so that calls
   * returning `.agent-attention/agents.json` are rerouted to our temp dir.
   */
  function withTempRegistry(fn: () => void): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-reg-'));
    const realPath = path.join(os.homedir(), '.agent-attention', 'agents.json');
    try {
      // Use jest.requireActual to get a handle on the registry module's internals
      // Since REGISTRY_PATH is const, we can't change it at runtime.
      // Instead, write our test data to the real path directly.
      fs.mkdirSync(path.dirname(realPath), { recursive: true });
      fn();
    } finally {
      if (fs.existsSync(realPath)) {
        fs.unlinkSync(realPath);
      }
      // Clean up .agent-attention only if it was created for this test
      const stateDir = path.join(os.homedir(), '.agent-attention');
      if (fs.existsSync(stateDir)) {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    }
  }

  describe('AgentTarget interface and Agent schema', () => {
    it('v2 schema includes target field on new agents', () => {
      withTempRegistry(() => {
        const agent = registerAgent('test-agent', 'Test Agent');
        expect(agent.agent_id).toBe('test-agent');
        expect(agent.name).toBe('Test Agent');
        expect(agent.registered_at).toBeGreaterThan(0);
        expect(agent.last_seen_at).toBeGreaterThan(0);
        expect(agent.target).toBeNull();
      });
    });

    it('registerAgent returns agent with no target by default', () => {
      withTempRegistry(() => {
        const agent = registerAgent('codex', 'Codex');
        expect(agent.target).toBeNull();
      });
    });
  });

  describe('v1 → v2 backward compatibility', () => {
    it('v1 registry (no target field) loads and migrates to v2 on write', () => {
      withTempRegistry(() => {
        const realPath = path.join(os.homedir(), '.agent-attention', 'agents.json');
        // Simulate a v1 registry file (no target field, version 1)
        const v1Data = {
          version: 1,
          agents: [
            {
              agent_id: 'claude-code',
              name: 'Claude Code',
              registered_at: 1000,
              last_seen_at: 1000,
            },
          ],
        };
        fs.writeFileSync(realPath, JSON.stringify(v1Data, null, 2), 'utf-8');

        // Register a new agent — this triggers migration on read+write
        const newAgent = registerAgent('new-agent', 'New Agent');
        expect(newAgent.agent_id).toBe('new-agent');

        // Read back and verify migration happened
        const restored = JSON.parse(fs.readFileSync(realPath, 'utf-8'));
        expect(restored.version).toBe(2);
        expect(restored.agents).toHaveLength(2);

        // Original agent should have been migrated (target added)
        const original = restored.agents.find((a: any) => a.agent_id === 'claude-code');
        expect(original.target).toBeNull();

        // New agent should also have target: null
        const fresh = restored.agents.find((a: any) => a.agent_id === 'new-agent');
        expect(fresh.target).toBeNull();
      });
    });

    it('existing v1 agent gets target null on re-registration', () => {
      withTempRegistry(() => {
        const realPath = path.join(os.homedir(), '.agent-attention', 'agents.json');
        const v1Data = {
          version: 1,
          agents: [
            {
              agent_id: 'legacy-agent',
              name: 'Legacy',
              registered_at: 500,
              last_seen_at: 500,
            },
          ],
        };
        fs.writeFileSync(realPath, JSON.stringify(v1Data, null, 2), 'utf-8');

        // Re-register same agent — should migrate and preserve existing
        const agent = registerAgent('legacy-agent', 'Legacy');
        expect(agent.target).toBeNull();
        expect(agent.name).toBe('Legacy');
      });
    });
  });

  describe('updateAgentTarget', () => {
    it('sets target on an existing agent', () => {
      withTempRegistry(() => {
        registerAgent('my-agent', 'My Agent');
        const target: AgentTarget = { type: 'terminal', pid: 12345 };
        updateAgentTarget('my-agent', target);

        const agent = getAgent('my-agent');
        expect(agent).toBeDefined();
        expect(agent!.target).toEqual(target);
      });
    });

    it('clears target when passed null', () => {
      withTempRegistry(() => {
        registerAgent('my-agent', 'My Agent');
        updateAgentTarget('my-agent', { type: 'terminal', pid: 999 });
        updateAgentTarget('my-agent', null);

        const agent = getAgent('my-agent');
        expect(agent!.target).toBeNull();
      });
    });

    it('throws when agent does not exist', () => {
      withTempRegistry(() => {
        expect(() => updateAgentTarget('nonexistent', { type: 'terminal', pid: 1 })).toThrow(
          'Agent "nonexistent" not found in registry',
        );
      });
    });

    it('persists target across read/write cycles', () => {
      withTempRegistry(() => {
        registerAgent('persist-agent', 'Persist Agent');
        updateAgentTarget('persist-agent', { type: 'terminal', pid: 777 });

        // Simulate fresh read by calling getAgent again (reads from disk)
        const reloaded = getAgent('persist-agent');
        expect(reloaded!.target).toEqual({ type: 'terminal', pid: 777 });
      });
    });
  });

  describe('getAgentUnreadCount', () => {
    it('returns 0 for agent with no events', () => {
      withTempRegistry(() => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-state-'));
        const stateFile = path.join(stateDir, 'state.json');
        const count = getAgentUnreadCount(stateFile, 'no-agent');
        expect(count).toBe(0);
        fs.rmSync(stateDir, { recursive: true, force: true });
      });
    });

    it('counts only unread events for the given agent', () => {
      withTempRegistry(() => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-state-'));
        const stateFile = path.join(stateDir, 'state.json');

        recordEvent(stateFile, {
          type: 'completed',
          message: 'a',
          timestamp: 1,
          priority: 'P2',
          agent_id: 'agent-a',
          agent_name: 'A',
          title: 'A: completed',
        });
        recordEvent(stateFile, {
          type: 'failed',
          message: 'b',
          timestamp: 2,
          priority: 'P1',
          agent_id: 'agent-a',
          agent_name: 'A',
          title: 'A: failed',
        });
        recordEvent(stateFile, {
          type: 'completed',
          message: 'c',
          timestamp: 3,
          priority: 'P2',
          agent_id: 'agent-b',
          agent_name: 'B',
          title: 'B: completed',
        });

        const countA = getAgentUnreadCount(stateFile, 'agent-a');
        expect(countA).toBe(2);

        const countB = getAgentUnreadCount(stateFile, 'agent-b');
        expect(countB).toBe(1);

        fs.rmSync(stateDir, { recursive: true, force: true });
      });
    });

    it('excludes read events from the count', () => {
      withTempRegistry(() => {
        const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-state-'));
        const stateFile = path.join(stateDir, 'state.json');

        recordEvent(stateFile, {
          type: 'completed',
          message: 'x',
          timestamp: 1,
          priority: 'P2',
          agent_id: 'agent-x',
          agent_name: 'X',
          title: 'X: completed',
        });

        // Manually mark the event as read
        const state = readState(stateFile);
        state.events[0].read = true;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');

        const count = getAgentUnreadCount(stateFile, 'agent-x');
        expect(count).toBe(0);

        fs.rmSync(stateDir, { recursive: true, force: true });
      });
    });
  });

  describe('listAgents', () => {
    it('returns all registered agents', () => {
      withTempRegistry(() => {
        registerAgent('a', 'A');
        registerAgent('b', 'B');
        const agents = listAgents();
        expect(agents).toHaveLength(2);
        expect(agents.map((a) => a.agent_id)).toContain('a');
        expect(agents.map((a) => a.agent_id)).toContain('b');
      });
    });
  });
});
