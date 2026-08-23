import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getUiMode, resolveNativeUiPath } from '../src/ui-host';

describe('UI host mode', () => {
  const previousMode = process.env.AGENT_ATTENTION_UI;
  const previousOverride = process.env.AGENT_ATTENTION_UI_EXE;

  afterEach(() => {
    if (previousMode === undefined) delete process.env.AGENT_ATTENTION_UI;
    else process.env.AGENT_ATTENTION_UI = previousMode;
    if (previousOverride === undefined) delete process.env.AGENT_ATTENTION_UI_EXE;
    else process.env.AGENT_ATTENTION_UI_EXE = previousOverride;
  });

  it('defaults to the PowerShell host', () => {
    delete process.env.AGENT_ATTENTION_UI;
    expect(getUiMode()).toBe('ps');
  });

  it('selects the C# host explicitly', () => {
    process.env.AGENT_ATTENTION_UI = 'csharp';
    expect(getUiMode()).toBe('csharp');
  });

  it('resolves an explicit C# executable override', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-attention-ui-'));
    const executable = path.join(dir, 'AgentAttention.UI.exe');
    fs.writeFileSync(executable, '');
    process.env.AGENT_ATTENTION_UI_EXE = executable;

    expect(resolveNativeUiPath()).toBe(executable);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a missing explicit override', () => {
    process.env.AGENT_ATTENTION_UI_EXE = path.join(os.tmpdir(), 'missing-agent-attention-ui.exe');
    expect(resolveNativeUiPath()).toBeNull();
  });
});
