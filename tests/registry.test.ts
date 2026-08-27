import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  registerAgent,
  getAgent,
  listAgents,
  updateAgentTarget,
  getAgentUnreadCount,
  autoDetectAndRegister,
  AgentTarget,
} from '../src/registry';
import { recordEvent, readState } from '../src/state/AttentionState';

describe('Registry v2 with Target', () => {
  let tmpHome: string;

  beforeEach(() => {
    // Isolate the registry from the REAL user dir (~/.agent-attention) via
    // AGENT_ATTENTION_HOME — same convention as src/dedup/index.ts. This
    // prevents tests from touching/deleting real daemon state and avoids
    // tripping the sandbox bulk-delete guard on recursive rm of user dirs.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-home-'));
    process.env.AGENT_ATTENTION_HOME = tmpHome;
  });

  afterEach(() => {
    delete process.env.AGENT_ATTENTION_HOME;
    if (tmpHome && fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  /**
   * Helper: run a callback with the registry path overridden to a temp dir.
   * We achieve this by temporarily monkey-patching path.join so that calls
   * returning `.agent-attention/agents.json` are rerouted to our temp dir.
   */
  // With AGENT_ATTENTION_HOME set in beforeEach, every registry write lands
  // in the per-test temp home. This wrapper now only runs the callback —
  // cleanup is handled by afterEach (temp home removal).
  function withTempRegistry(fn: () => void): void {
    fn();
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
        const realPath = path.join(tmpHome, 'agents.json');
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
        const realPath = path.join(tmpHome, 'agents.json');
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

  // B3 regression: autoDetectAndRegister must not scan process/execPath.
  describe('autoDetectAndRegister (B3)', () => {
    it('uses AGENT_ID env var when set', () => {
      const original = process.env.AGENT_ID;
      const originalName = process.env.AGENT_NAME;
      try {
        process.env.AGENT_ID = 'my-agent';
        process.env.AGENT_NAME = 'My Agent';
        const id = autoDetectAndRegister();
        expect(id).toBe('my-agent');
        const agent = getAgent('my-agent');
        expect(agent).toBeDefined();
        expect(agent!.name).toBe('My Agent');
      } finally {
        if (original === undefined) {
          delete process.env.AGENT_ID;
        } else {
          process.env.AGENT_ID = original;
        }
        if (originalName === undefined) {
          delete process.env.AGENT_NAME;
        } else {
          process.env.AGENT_NAME = originalName;
        }
      }
    });

    it('uses anonymous fallback with warning when no AGENT_ID is set', () => {
      const original = process.env.AGENT_ID;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        delete process.env.AGENT_ID;
        delete process.env.AGENT_NAME;
        const id = autoDetectAndRegister();
        // Anonymous fallback — real agents must set AGENT_ID for stable identity
        expect(id).toBe('anonymous');
        // Warning must be emitted to alert about missing identity
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        if (original !== undefined) {
          process.env.AGENT_ID = original;
        }
        warnSpy.mockRestore();
      }
    });


  });
});
