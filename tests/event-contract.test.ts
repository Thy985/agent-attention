import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { HookProvider, WrapperProvider, PluginProvider } from '../src/integration/providers';
import { getManifest, getEffectiveReliability } from '../src/integration/catalog';
import { CompletionReliability } from '../src/integration/types';
import { recordEvent, markRead, readState } from '../src/state/AttentionState';
import { installClaudeHooks, removeClaudeHooks } from '../src/integration/hook-settings';

const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-hooks', name + '.json'), 'utf8'));
const manifest = getManifest('claude-code')!;
const provider = new HookProvider();

describe('evidence contract: official SDK 0.3.306/documentation fixtures', () => {
  test.each([['PermissionRequest', 'permission_required'], ['Notification', 'permission_required'],
    ['Elicitation', 'input_required'], ['StopFailure', 'failed']])('%s maps only its documented signal scope', (name, event) => {
    const result = provider.parseEvent(fixture(name), manifest)!;
    expect(result.event).toBe(event);
    expect(result.sessionId).toBe('abc123');
    expect(result.agentId).toBe('claude-code');
    expect(result.evidence?.contract).toBe('claude-agent-sdk@0.3.306/hooks-v1');
    expect(result.evidence?.scope).toBe(name === 'StopFailure' ? 'turn' : 'request');
    expect(result.sourceEvent).toBe(name);
    expect(JSON.stringify(result)).not.toContain('transcript_path');
    expect(JSON.stringify(result)).not.toContain('tool_input');
    expect(JSON.stringify(result)).not.toContain('requested_schema');
    expect(JSON.stringify(result)).not.toContain('error_details');
  });
  test.each(['Stop', 'SessionEnd', 'TaskCompleted', 'PostToolUse'])('%s does not prove accepted task completion', name => {
    expect(provider.parseEvent(fixture(name), manifest)).toBeNull();
  });
  test.each([0, 1, 2])('legacy exitStatus %i is not a supported hook event', exitStatus => {
    expect(provider.parseEvent({ sessionId: 's', exitStatus, turns: 2 }, manifest)).toBeNull();
  });
  test.each([null, [], {}, { hook_event_name: 'PermissionRequest' },
    { session_id: 12, hook_event_name: 'StopFailure', error: 'x' },
    { session_id: 's', hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' },
    { session_id: 's', hook_event_name: 'Notification', notification_type: 'auth_success', message: 'success' },
    { session_id: 's', hook_event_name: 'Unknown', status: 'completed' }])('unknown/invalid payload never manufactures notice %#', input => {
    expect(provider.parseEvent(input, manifest)).toBeNull();
  });
  test('missing documented required event fields are rejected', () => {
    for (const [name, field] of [['PermissionRequest', 'tool_name'], ['PermissionRequest', 'tool_input'], ['Elicitation', 'message'], ['StopFailure', 'error']]) {
      const p = fixture(name); delete p[field];
      expect(provider.parseEvent(p, manifest)).toBeNull();
    }
  });
  test('different agent cannot use Claude contract by claiming same payload', () => {
    expect(provider.parseEvent(fixture('Notification'), { ...manifest, id: 'other' })).toBeNull();
  });
  test('untrusted payload identity cannot replace source application identity', () => {
    expect(provider.parseEvent({ ...fixture('Notification'), agentId: 'spoof' }, manifest)!.agentId).toBe('claude-code');
  });
  test.each([0, 130, 143, -1, NaN, Infinity, 1.5, 256])('process exit %s never proves completed/input required', exit => {
    expect(new WrapperProvider().parseEvent(exit, manifest)).toBeNull();
  });
  test('nonzero exit has process scope, never business outcome acceptance', () => {
    expect(new WrapperProvider().parseEvent(1, manifest)!.evidence?.scope).toBe('process');
  });
  test.each([{ status: 'success', event: 'tool_call' }, { status: 'completed', event: 'mcp_query' }, { status: 'error' }])('generic plugin status is not a task outcome %#', payload => {
    expect(new PluginProvider().parseEvent(payload, manifest)).toBeNull();
  });
  test('permission reliability cannot be promoted to completion reliability', () => {
    expect(getEffectiveReliability({ ...manifest, events: { permission_required: CompletionReliability.Verified } })).toBe(CompletionReliability.Manual);
  });
});

describe('persisted delivery provenance and v1 additive compatibility', () => {
  let dir: string; let file: string;
  const input = { type: 'completed' as const, priority: 'P2' as const, agent_id: 'agent', agent_name: 'Agent',
    message: 'same text', title: 'done', timestamp: 100, session_id: 's1', task_id: 't1', source_event_id: 'e1',
    source_event: 'manual_report', evidence: { contract: 'manual-cli/v1', mechanism: 'cli' as const, basis: 'explicit_report' as const, scope: 'task' as const } };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-contract-')); file = path.join(dir, 'state.json'); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  test('v1 existing records and their read state survive new evidence', () => {
    const old = { id: 'legacy', timestamp: 1, type: 'failed', priority: 'P1', agent_id: 'a', agent_name: 'A', title: 'old', message: 'old', read: true };
    fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: 1, unreadCount: 0, visible: true, events: [old] }));
    const state = recordEvent(file, input);
    expect(state.version).toBe(1);
    expect(state.events[1]).toEqual(old);
    expect(state.events[0].evidence).toEqual(input.evidence);
    expect(readState(file).events[0].session_id).toBe('s1');
  });
  test('same delivery retry preserves event ID, read state and timestamp across reads', () => {
    const first = recordEvent(file, input); markRead(file, first.events[0].id);
    const again = recordEvent(file, { ...input, timestamp: 500 });
    expect(again.events).toHaveLength(1); expect(again.events[0].read).toBe(true);
    expect(again.events[0].id).toBe(first.events[0].id); expect(again.events[0].timestamp).toBe(100);
    expect(again.unreadCount).toBe(0);
  });
  test('same text and delivery id in different session, task or agent is never merged', () => {
    recordEvent(file, input);
    recordEvent(file, { ...input, session_id: 's2' });
    recordEvent(file, { ...input, task_id: 't2' });
    const state = recordEvent(file, { ...input, agent_id: 'other' });
    expect(state.events).toHaveLength(4); expect(state.unreadCount).toBe(4);
  });
  test('no stable delivery id: identical text is not evidence of repeated delivery', () => {
    recordEvent(file, { ...input, source_event_id: undefined });
    expect(recordEvent(file, { ...input, source_event_id: undefined }).events).toHaveLength(2);
  });
  test('retention limit count stays consistent after 25 deliveries', () => {
    for (let i=0; i<25; i++) recordEvent(file, { ...input, source_event_id: 'e'+i });
    const s = readState(file); expect(s.events).toHaveLength(20); expect(s.unreadCount).toBe(20);
  });
  test('installer preserves unrelated settings/hooks; repeated installation is idempotent', () => {
    fs.mkdirSync(path.join(dir, '.claude'));
    const target = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(target, JSON.stringify({ env: { KEEP: 'yes' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other-safe-hook' }] }] } }));
    installClaudeHooks(dir, '/example path/dist/daemon-cli.js');
    const first = fs.readFileSync(target, 'utf8'); installClaudeHooks(dir, '/example path/dist/daemon-cli.js');
    expect(fs.readFileSync(target, 'utf8')).toBe(first);
    const parsed = JSON.parse(first); expect(parsed.env.KEEP).toBe('yes');
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe('other-safe-hook');
    expect(parsed.hooks.Notification[0].matcher).toBe('permission_prompt');
    expect(parsed.hooks.Elicitation[0].hooks[0].command).toBe('node "/example path/dist/daemon-cli.js" hook');
  });
  test('uninstall preserves a peer command in the same group', () => {
    fs.mkdirSync(path.join(dir, '.claude')); const target = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: [{ hooks: [
      { type: 'command', command: 'node /x/daemon-cli.js hook' }, { type: 'command', command: 'other-safe-hook' },
    ] }] }, env: { KEEP: 'yes' } }));
    removeClaudeHooks(target, '/x/daemon-cli.js'); const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(parsed.hooks.Stop[0].hooks).toEqual([{ type: 'command', command: 'other-safe-hook' }]);
    expect(parsed.env.KEEP).toBe('yes');
  });
  test('unrelated daemon command and intentionally empty group survive', () => {
    fs.mkdirSync(path.join(dir, '.claude')); const target = path.join(dir, '.claude', 'settings.json');
    const groups = [{ hooks: [{ type: 'command', command: 'node /unrelated/daemon-cli.js hook' }] }, { matcher: 'kept', hooks: [] }];
    fs.writeFileSync(target, JSON.stringify({ hooks: { Stop: groups } }));
    installClaudeHooks(dir, '/x/daemon-cli.js'); removeClaudeHooks(target, '/x/daemon-cli.js');
    expect(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.Stop).toEqual(groups);
  });
  test('malformed hook group is not overwritten', () => {
    fs.mkdirSync(path.join(dir, '.claude')); const target = path.join(dir, '.claude', 'settings.json');
    const original = JSON.stringify({ hooks: { Stop: [{ unexpected: true }] } });
    fs.writeFileSync(target, original); expect(() => installClaudeHooks(dir, '/x/daemon-cli.js')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });
  test('invalid settings are not overwritten', () => {
    fs.mkdirSync(path.join(dir, '.claude')); const target = path.join(dir, '.claude', 'settings.json');
    fs.writeFileSync(target, 'not json'); expect(() => installClaudeHooks(dir, '/x/daemon-cli.js')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('not json');
  });
  test('real hook command preserves source in state and logs, exposes no approval output', () => {
    const p = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'daemon-cli.js'), 'hook'], {
      env: { ...process.env, AGENT_ATTENTION_HOME: dir }, input: JSON.stringify(fixture('Notification')), encoding: 'utf8', timeout: 5000,
    });
    expect(p.status).toBe(0); expect(p.stdout).toBe('');
    const saved = readState(file).events[0]; expect(saved.source_event).toBe('Notification'); expect(saved.session_id).toBe('abc123');
    const log = fs.readFileSync(path.join(dir, 'logs', 'runtime.jsonl'), 'utf8');
    expect(log).toContain('structured_signal'); expect(log).not.toContain('transcript_path');
  });
});

describe('CLI dedup identity boundaries', () => {
  let dir: string; const original = process.env.AGENT_ATTENTION_HOME;
  beforeEach(() => { dir=fs.mkdtempSync(path.join(os.tmpdir(), 'aa-dedup-scope-')); process.env.AGENT_ATTENTION_HOME=dir; jest.resetModules(); });
  afterEach(() => { if (original === undefined) delete process.env.AGENT_ATTENTION_HOME; else process.env.AGENT_ATTENTION_HOME=original; fs.rmSync(dir,{recursive:true,force:true}); });
  test('same words in different tasks and sessions are kept', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    expect(sn('a','completed','same',{sessionId:'s',taskId:'t'})).toBe(true);
    expect(sn('a','completed','same',{sessionId:'s',taskId:'t'})).toBe(false);
    expect(sn('a','completed','same',{sessionId:'s2',taskId:'t'})).toBe(true);
    expect(sn('a','completed','same',{sessionId:'s',taskId:'t2'})).toBe(true);
    expect(sn('b','completed','same',{sessionId:'s',taskId:'t'})).toBe(true);
  });
});
