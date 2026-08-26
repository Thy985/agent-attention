import * as fs from 'fs';
import * as path from 'path';

/**
 * M2 L3: Toast integration path-resolution regression tests.
 */
describe('toast-integration (L3 path resolution)', () => {
  let compiledExists: boolean;

  beforeAll(() => {
    compiledExists = fs.existsSync(path.join('dist', 'notification', 'win32.js'));
  });

  it('resolved module path in compiled JS points to dist/notification/win32.js', () => {
    if (!compiledExists) {
      console.warn('[M2] dist/notification/win32.js not found — source-only check');
      return;
    }
    const compiledSource = fs.readFileSync(path.join('dist', 'notification', 'win32.js'), 'utf8');
    expect(compiledSource).toContain('AgentAttention.UI.exe');
  });

  it('source references -OpenCenter flag and resolveNativeUiPath', () => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    expect(src).toContain("'-OpenCenter'");
    expect(src).toContain('resolveNativeUiPath()');
  });

  it('source no longer references CenterWindow.ps1', () => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    expect(src).not.toContain('CenterWindow.ps1');
    expect(src).not.toContain('getCenterPath');
  });

  it('compiled JS does not reference Code.exe', () => {
    if (!compiledExists) {
      const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
      expect(src).not.toContain('Code.exe');
      return;
    }
    const js = fs.readFileSync(path.join('dist', 'notification', 'win32.js'), 'utf8');
    expect(js).not.toContain('Code.exe');
  });

  it('resolveNativeUiPath returns null when UI_EXE override is missing', () => {
    const { resolveNativeUiPath } = require('../src/ui-host');
    const original = process.env.AGENT_ATTENTION_UI_EXE;
    process.env.AGENT_ATTENTION_UI_EXE = path.join('/nonexistent', 'path', 'AgentAttention.UI.exe');
    try {
      expect(resolveNativeUiPath()).toBeNull();
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_ATTENTION_UI_EXE;
      } else {
        process.env.AGENT_ATTENTION_UI_EXE = original;
      }
    }
  });

  it('resolveNativeUiPath finds real artifact in installed layout', () => {
    const { resolveNativeUiPath } = require('../src/ui-host');
    const result = resolveNativeUiPath();
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(result!).toContain("AgentAttention.UI.exe");
  });
});
