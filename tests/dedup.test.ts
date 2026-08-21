import { shouldNotify } from '../src/dedup';

describe('shouldNotify', () => {
  beforeEach(() => {
    // Clear the in-memory set between tests by accessing internal state
    const dedupModule = require('../src/dedup');
    // Force re-import to reset module state isn't possible, so we use a workaround:
    // Just test the public API without time manipulation
  });

  it('returns true for a brand-new notification', () => {
    expect(shouldNotify('claude', 'completed', 'hello')).toBe(true);
  });

  it('returns false for a duplicate within TTL (same agent)', () => {
    shouldNotify('claude', 'failed', 'same message');
    expect(shouldNotify('claude', 'failed', 'same message')).toBe(false);
  });

  it('returns true for the same event+message but different agent', () => {
    shouldNotify('claude', 'completed', 'message A');
    expect(shouldNotify('codex', 'completed', 'message A')).toBe(true);
  });

  it('returns true for the same message but different event', () => {
    shouldNotify('claude', 'completed', 'task done');
    expect(shouldNotify('claude', 'failed', 'task done')).toBe(true);
  });

  it('returns true for different messages from same agent', () => {
    shouldNotify('claude', 'completed', 'message A');
    expect(shouldNotify('claude', 'completed', 'message B')).toBe(true);
  });

  // B4 regression: separator-collision test
  it('does not confuse agent:event:message containing colons (no cross-event suppression)', () => {
    // These two keys are semantically distinct but could collide with naive ':' splitting:
    //   "a:b:c" vs "a:b:c" — same string but parsed differently
    // With JSON.stringify-based keys this cannot happen.
    shouldNotify('a:b', 'c', 'd');          // key = ["a:b","c","d"]
    expect(shouldNotify('a', 'b:c', 'd')).toBe(true); // key = ["a","b:c","d"] — different
    expect(shouldNotify('a', 'b', 'c:d')).toBe(true); // key = ["a","b","c:d"] — different
  });
});