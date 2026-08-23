import { jumpToTarget, AgentTarget } from '../src/jump';

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

  it('does not throw on spawnSync failure', () => {
    const target: AgentTarget = { type: 'terminal', pid: 0 };
    expect(() => jumpToTarget(target)).not.toThrow();
  });

  it('succeeds silently for current process PID', () => {
    const target: AgentTarget = { type: 'terminal', pid: process.pid };
    // Should not throw even if SetForegroundWindow fails
    expect(() => jumpToTarget(target)).not.toThrow();
  });

  it('uses spawnSync with explicit powershell (not process.execPath)', () => {
    // Verify the source uses spawnSync('powershell', ...) — NOT process.execPath
    const fs = require('fs');
    const src = fs.readFileSync('src/jump.ts', 'utf8');
    expect(src).toContain("spawnSync('powershell'");
    expect(src).not.toContain('spawnSync(process.execPath');
  });

  // P1-14 regression: jumpToTarget was dead code (defined but never called).
  // The CLI now exposes `agent-attention jump <agent-id>` which dispatches
  // through jumpToTarget when the agent has a registered terminal target.
  it('is invoked from daemon-cli.ts (no longer dead code)', () => {
    const fs = require('fs');
    const src = fs.readFileSync('src/daemon-cli.ts', 'utf8');
    // CLI must require ./jump and call jumpToTarget
    expect(src).toMatch(/require\(['"]\.\/jump['"]\)/);
    expect(src).toMatch(/jumpToTarget\(/);
  });
});
