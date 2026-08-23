import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('shouldNotify', () => {
  // P1-6 fix: dedup now persists to <home>/.agent-attention/dedup.json so a
  // follow-up agent-notify process sees recent keys. Tests isolate themselves
  // by pointing AGENT_ATTENTION_HOME at a per-test temp dir BEFORE requiring
  // the module (the path is resolved at module load), and by jest.resetModules
  // to clear the in-process cache. This also avoids racing with other test
  // files (registry/state) that use the real ~/.agent-attention directory.

  let tmpHome: string;
  const origHome = process.env.AGENT_ATTENTION_HOME;

  beforeEach(() => {
    jest.resetModules();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-dedup-'));
    process.env.AGENT_ATTENTION_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.AGENT_ATTENTION_HOME;
    else process.env.AGENT_ATTENTION_HOME = origHome;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  it('returns true for a brand-new notification', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    expect(sn('claude-' + Math.random(), 'completed', 'hello')).toBe(true);
  });

  it('returns false for a duplicate within TTL (same agent)', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    const unique = 'claude-' + Math.random() + '-' + Date.now();
    sn(unique, 'failed', 'same message');
    expect(sn(unique, 'failed', 'same message')).toBe(false);
  });

  it('returns true for the same event+message but different agent', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    const tag = 'agent-' + Math.random();
    sn('claude-' + tag, 'completed', 'message A');
    expect(sn('codex-' + tag, 'completed', 'message A')).toBe(true);
  });

  it('returns true for the same message but different event', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    const unique = 'claude-' + Math.random() + '-' + Date.now();
    sn(unique, 'completed', 'task done');
    expect(sn(unique, 'failed', 'task done')).toBe(true);
  });

  it('returns true for different messages from same agent', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    const unique = 'claude-' + Math.random() + '-' + Date.now();
    sn(unique, 'completed', 'message A');
    expect(sn(unique, 'completed', 'message B')).toBe(true);
  });

  // B4 regression: separator-collision test
  it('does not confuse agent:event:message containing colons (no cross-event suppression)', () => {
    const { shouldNotify: sn } = require('../src/dedup');
    // These two keys are semantically distinct but could collide with naive ':' splitting:
    //   "a:b:c" vs "a:b:c" — same string but parsed differently
    // With JSON.stringify-based keys this cannot happen.
    const tag = Math.random().toString();
    sn('a:b-' + tag, 'c', 'd');          // key = ["a:b","c","d"]
    expect(sn('a-' + tag, 'b:c', 'd')).toBe(true); // key = ["a","b:c","d"] — different
    expect(sn('a-' + tag, 'b', 'c:d')).toBe(true); // key = ["a","b","c:d"] — different
  });

  // P1-6 regression: dedup state survives process restarts. Each require()
  // returns a fresh module with an empty in-memory cache, but they share the
  // on-disk dedup.json. So a fresh "process" sees the previous suppressions.
  it('suppresses across simulated process restarts (persistent dedup)', () => {
    const tag = 'persist-' + Date.now() + '-' + Math.random();
    const agent = 'claude-' + tag;
    const event = 'completed';
    const msg = 'persistent-msg-' + tag;

    // First process — accept
    const m1 = require('../src/dedup');
    expect(m1.shouldNotify(agent, event, msg)).toBe(true);

    // Second process — fresh module, in-memory cache empty, but disk has it
    jest.resetModules();
    const m2 = require('../src/dedup');
    expect(m2.shouldNotify(agent, event, msg)).toBe(false);
  });

  it('writes dedup.json under AGENT_ATTENTION_HOME', () => {
    const tag = 'path-' + Date.now() + '-' + Math.random();
    const m = require('../src/dedup');
    m.shouldNotify('agent-' + tag, 'completed', 'msg-' + tag);
    const dedupPath = path.join(tmpHome, 'dedup.json');
    expect(fs.existsSync(dedupPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(dedupPath, 'utf-8'));
    expect(typeof raw).toBe('object');
    expect(Object.keys(raw).length).toBeGreaterThan(0);
  });
});
