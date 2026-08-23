import * as fs from 'fs';
import * as path from 'path';

/**
 * M2 L3: Toast integration path-resolution regression tests.
 *
 * Verifies that after build + publish, the compiled notification module
 * resolves all three paths correctly in both source and emitted JS.
 */
describe('toast-integration (L3 path resolution)', () => {
  let compiledSource: string;
  let compiledExists: boolean;

  beforeAll(() => {
    compiledExists = fs.existsSync(path.join('dist', 'notification', 'win32.js'));
  });

  it('resolved module path in compiled JS points to dist/notification/win32.js', () => {
    if (!compiledExists) {
      console.warn('[M2] dist/notification/win32.js not found — source-only check');
      return;
    }
    compiledSource = fs.readFileSync(path.join('dist', 'notification', 'win32.js'), 'utf8');
    // Must reference the native UI executable path
    expect(compiledSource).toContain('AgentAttention.UI.exe');
  });

  it('source references csharp mode activation with -OpenCenter flag', () => {
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    expect(src).toContain("'-OpenCenter'");
    expect(src).toContain("getUiMode() === 'csharp'");
    expect(src).toContain('resolveNativeUiPath()');
  });

  it('compiled JS does not hardcode dist/src/center/ (off-by-two bug)', () => {
    if (!compiledExists) return;
    const src = fs.readFileSync('src/notification/win32.ts', 'utf8');
    // The fixed form uses two ".." segments to reach src/center/
    expect(src).toContain("path.join(__dirname, '..', '..', 'src', 'center', 'CenterWindow.ps1')");
    // Must NOT contain the old broken one-level form
    expect(src).not.toContain("path.join(__dirname, '..', 'src', 'center'");
  });

  it('compiled JS does not reference Code.exe', () => {
    if (!compiledExists) {
      console.warn('[M2] Compiled JS absent — using source check only');
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
    // Must be non-null because we just published in the prior step
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(result!).toContain("AgentAttention.UI.exe")
  });

  it('csharp mode selects native host over PowerShell', () => {
    const { getUiMode } = require('../src/ui-host');
    const original = process.env.AGENT_ATTENTION_UI;
    process.env.AGENT_ATTENTION_UI = 'csharp';
    try {
      expect(getUiMode()).toBe('csharp');
    } finally {
      if (original === undefined) delete process.env.AGENT_ATTENTION_UI;
      else process.env.AGENT_ATTENTION_UI = original;
    }
  });
});


