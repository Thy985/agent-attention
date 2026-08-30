/**
 * Tests for Integration Capability Catalog
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadCatalog,
  getManifest,
  isAgentInstalled,
  discoverIntegrations,
  addManifest,
  removeManifest,
  getEffectiveReliability,
  listManifests,
} from '../src/integration/catalog';
import {
  IntegrationManifest,
  IntegrationLevel,
  CompletionReliability,
} from '../src/integration/types';
import { getProvider, HookProvider, WrapperProvider, SkillProvider } from '../src/integration/providers';

describe('Integration Catalog', () => {
  describe('loadCatalog', () => {
    it('loads all manifests from scripts/integrations/', () => {
      const manifests = loadCatalog();
      expect(manifests.length).toBeGreaterThan(0);
      // Verify known agents exist
      const ids = manifests.map((m) => m.id);
      expect(ids).toContain('claude-code');
      expect(ids).toContain('aider');
      expect(ids).toContain('codex');
      expect(ids).toContain('opencode');
      expect(ids).toContain('cline');
    });

    it('each manifest has required fields', () => {
      const manifests = loadCatalog();
      for (const m of manifests) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(m.level).toBeDefined();
        expect(m.mechanism).toBeDefined();
        expect(m.events).toBeDefined();
      }
    });
  });

  describe('getManifest', () => {
    it('returns manifest for known agent', () => {
      const m = getManifest('claude-code');
      expect(m).not.toBeNull();
      expect(m!.id).toBe('claude-code');
      expect(m!.level).toBe(IntegrationLevel.L3_HOOK);
    });

    it('returns null for unknown agent', () => {
      expect(getManifest('unknown-agent')).toBeNull();
    });
  });

  describe('getEffectiveReliability', () => {
    it('returns highest reliability across events', () => {
      const manifest: IntegrationManifest = {
        id: 'test',
        name: 'Test Agent',
        description: 'Test',
        binaryPatterns: [],
        level: 3,
        mechanism: 'hook',
        interfaces: {},
        events: {
          completed: CompletionReliability.Verified,
          failed: CompletionReliability.Probable,
        },
        installInstructions: '',
        injectAgentId: false,
      };
      const reliability = getEffectiveReliability(manifest);
      expect(reliability).toBe(CompletionReliability.Verified);
    });

    it('returns Manual when no events', () => {
      const manifest: IntegrationManifest = {
        id: 'test',
        name: 'Test Agent',
        description: 'Test',
        binaryPatterns: [],
        level: 0,
        mechanism: 'cli',
        interfaces: {},
        events: {},
        installInstructions: '',
        injectAgentId: false,
      };
      expect(getEffectiveReliability(manifest)).toBe(CompletionReliability.Manual);
    });
  });

  describe('addManifest / removeManifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-integration-'));
    const originalCatalogDir = path.join(__dirname, '..', 'scripts', 'integrations');

    afterEach(() => {
      // Clean up temp file
      try { fs.unlinkSync(path.join(tmpDir, 'test-agent.json')); } catch {}
    });

    it('can add and remove a manifest', () => {
      const manifest: IntegrationManifest = {
        id: 'test-agent',
        name: 'Test Agent',
        description: 'Test',
        binaryPatterns: [],
        level: IntegrationLevel.L1_SKILL,
        mechanism: 'skill',
        interfaces: {},
        events: { completed: CompletionReliability.BestEffort },
        installInstructions: '',
        injectAgentId: false,
      };

      addManifest(manifest);
      const retrieved = getManifest('test-agent');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('Test Agent');

      removeManifest('test-agent');
      expect(getManifest('test-agent')).toBeNull();
    });
  });

  describe('listManifests', () => {
    it('returns simplified manifest info', () => {
      const list = listManifests();
      expect(list.length).toBeGreaterThan(0);
      const claude = list.find((m) => m.id === 'claude-code');
      expect(claude).toBeDefined();
      expect(claude!.level).toBe(IntegrationLevel.L3_HOOK);
      expect(claude!.status).toBe('stable');
    });
  });
});

describe('Integration Providers', () => {
  const testManifest: IntegrationManifest = {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code',
    binaryPatterns: ['claude'],
    level: IntegrationLevel.L3_HOOK,
    mechanism: 'hook',
    interfaces: {
      hook: ['Stop', 'SessionStart'],
      env: ['AGENT_ID'],
    },
    events: {
      completed: CompletionReliability.Verified,
      failed: CompletionReliability.Verified,
      permission_required: CompletionReliability.Verified,
      input_required: CompletionReliability.Verified,
    },
    installInstructions: 'Run agent-attention integration install claude-code',
    injectAgentId: true,
  };

  describe('HookProvider', () => {
    const provider = new HookProvider();

    it('parses Stop with exitStatus=0 → completed', () => {
      const event = provider.parseEvent(
        { sessionId: 's1', exitStatus: 0, turns: 5, agentId: 'test' },
        testManifest,
      );
      expect(event).not.toBeNull();
      expect(event!.event).toBe('completed');
      expect(event!.reliability).toBe(CompletionReliability.Verified);
      expect(event!.agentId).toBe('test');
    });

    it('parses Stop with exitStatus=1 → failed', () => {
      const event = provider.parseEvent(
        { sessionId: 's2', exitStatus: 1 },
        testManifest,
      );
      expect(event).not.toBeNull();
      expect(event!.event).toBe('failed');
    });

    it('parses Stop with exitStatus=2 → input_required', () => {
      const event = provider.parseEvent(
        { sessionId: 's3', exitStatus: 2 },
        testManifest,
      );
      expect(event).not.toBeNull();
      expect(event!.event).toBe('input_required');
    });

    it('returns null for undefined exitStatus', () => {
      expect(provider.parseEvent({ sessionId: 's4', turns: 1 }, testManifest)).toBeNull();
    });

    it('returns null for empty payload', () => {
      expect(provider.parseEvent(null, testManifest)).toBeNull();
    });
  });

  describe('WrapperProvider', () => {
    const provider = new WrapperProvider();

    it('parses exit code 0 → completed', () => {
      const event = provider.parseEvent(0, testManifest);
      expect(event).not.toBeNull();
      expect(event!.event).toBe('completed');
      expect(event!.reliability).toBe(CompletionReliability.Probable);
    });

    it('parses non-zero exit code → failed', () => {
      const event = provider.parseEvent(1, testManifest);
      expect(event).not.toBeNull();
      expect(event!.event).toBe('failed');
      expect(event!.reliability).toBe(CompletionReliability.BestEffort);
    });
  });

  describe('SkillProvider', () => {
    const provider = new SkillProvider();

    it('always returns null (no structured events)', () => {
      expect(provider.parseEvent({}, testManifest)).toBeNull();
      expect(provider.parseEvent(null, testManifest)).toBeNull();
    });
  });

  describe('getProvider factory', () => {
    it('returns correct provider for hook mechanism', () => {
      expect(getProvider('hook')).toBeInstanceOf(HookProvider);
    });
    it('returns correct provider for wrapper mechanism', () => {
      expect(getProvider('wrapper')).toBeInstanceOf(WrapperProvider);
    });
    it('returns correct provider for skill mechanism', () => {
      expect(getProvider('skill')).toBeInstanceOf(SkillProvider);
    });
    it('throws for unknown mechanism', () => {
      expect(() => getProvider('unknown' as any)).toThrow('Unknown integration mechanism');
    });
  });
});

describe('Integration Level Semantics', () => {
  it('L0_CLI has Manual reliability', () => {
    const manifest: IntegrationManifest = {
      id: 'manual', name: 'Manual', description: '',
      binaryPatterns: [], level: IntegrationLevel.L0_CLI,
      mechanism: 'cli', interfaces: {}, events: {},
      installInstructions: '', injectAgentId: false,
    };
    expect(getEffectiveReliability(manifest)).toBe(CompletionReliability.Manual);
  });

  it('L3_HOOK with verified events has Verified reliability', () => {
    const manifest: IntegrationManifest = {
      id: 'hook', name: 'Hook', description: '',
      binaryPatterns: [], level: IntegrationLevel.L3_HOOK,
      mechanism: 'hook', interfaces: {},
      events: { completed: CompletionReliability.Verified },
      installInstructions: '', injectAgentId: false,
    };
    expect(getEffectiveReliability(manifest)).toBe(CompletionReliability.Verified);
  });

  it('L2_WRAPPER with probable events has Probable reliability', () => {
    const manifest: IntegrationManifest = {
      id: 'wrapper', name: 'Wrapper', description: '',
      binaryPatterns: [], level: IntegrationLevel.L2_WRAPPER,
      mechanism: 'wrapper', interfaces: {},
      events: { completed: CompletionReliability.Probable },
      installInstructions: '', injectAgentId: false,
    };
    expect(getEffectiveReliability(manifest)).toBe(CompletionReliability.Probable);
  });
});
