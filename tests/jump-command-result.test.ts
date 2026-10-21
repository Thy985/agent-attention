import { cmdJump, dispatchCommand } from '../src/commands';
import { getAgent } from '../src/registry';
import { jumpToTarget } from '../src/jump';
jest.mock('../src/registry', () => ({ getAgent: jest.fn() }));
jest.mock('../src/jump', () => ({ jumpToTarget: jest.fn() }));
const agent = getAgent as jest.Mock;
const jump = jumpToTarget as jest.Mock;
beforeEach(() => { agent.mockReset(); jump.mockReset(); });
it('propagates focus denial to RPC command result and exit code', async () => {
  agent.mockReturnValue({ target: { type: 'terminal', pid: 123 } });
  jump.mockReturnValue({ ok: false, reason: 'foreground-denied-or-changed' });
  expect(cmdJump('test')).toMatchObject({ ok: false, code: 1, error: 'Jump failed: foreground-denied-or-changed' });
  expect(await dispatchCommand('jump', ['test'])).toMatchObject({ ok: false, code: 1 });
});
it('keeps verified success', () => {
  agent.mockReturnValue({ target: { type: 'terminal', pid: 123 } });
  jump.mockReturnValue({ ok: true, reason: 'focused' });
  expect(cmdJump('test')).toMatchObject({ ok: true, code: 0 });
});
it('does not attempt a jump for an unknown agent or missing target', () => {
  expect(cmdJump('missing').ok).toBe(false);
  agent.mockReturnValue({ target: null });
  expect(cmdJump('none').ok).toBe(false);
  expect(jump).not.toHaveBeenCalled();
});
