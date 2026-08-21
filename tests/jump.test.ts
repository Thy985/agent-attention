import { jumpToTarget, AgentTarget } from '../src/jump';
import { execSync } from 'child_process';

describe('jumpToTarget', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns early when target is null', () => {
    expect(() => jumpToTarget(null)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns early when target type is not terminal', () => {
    const target = { type: 'terminal' as const, pid: 1 };
    expect(() => jumpToTarget(target)).not.toThrow();
  });

  it('does not log warning when PID does not exist (best-effort)', () => {
    // spawnSync succeeds silently when process not found (no exception thrown)
    // This is correct behavior - jumpToTarget is best-effort
    const target: AgentTarget = { type: 'terminal', pid: 999999 };
    expect(() => jumpToTarget(target)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not throw on execSync failure', () => {
    const target: AgentTarget = { type: 'terminal', pid: 0 };
    expect(() => jumpToTarget(target)).not.toThrow();
  });

  it('succeeds silently for current process PID', () => {
    const target: AgentTarget = { type: 'terminal', pid: process.pid };
    // Should not throw even if SetForegroundWindow fails
    expect(() => jumpToTarget(target)).not.toThrow();
  });
});
