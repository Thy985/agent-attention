import sys, os, re
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

def fix(path, fn):
    with open(os.path.join(B, path), 'r', encoding='utf-8') as f:
        c = f.read()
    c = fn(c)
    with open(os.path.join(B, path), 'w', encoding='utf-8') as f:
        f.write(c)
    print(f'  {path}')

# daemon.test.ts
fix('tests/daemon.test.ts', lambda c: (
    # Remove powerShellPath and trayScriptPath from makeOptions
    c.replace("powerShellPath: 'powershell',\n    trayScriptPath: 'src/center/TrayIcon.ps1',\n", '')
    .replace("powerShellPath: 'powershell',\n", '')
    .replace("trayScriptPath: 'src/center/TrayIcon.ps1',", '')
    # Remove the ps spawn test (lines 66-74)
    .replace("""  it('spawns TrayIcon.ps1 without stdin pipe', async () => {
    daemon = createDaemon(options as DaemonOptions);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedSpawn).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining(['-File', 'src/center/TrayIcon.ps1']),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );
  });

""", '')
))

# daemon-csharp.test.ts
fix('tests/daemon-csharp.test.ts', lambda c: (
    # Remove powerShellPath and trayScriptPath from options
    c.replace("powerShellPath: 'powershell', trayScriptPath: 'src/center/TrayIcon.ps1',\n      ", '')
    .replace("powerShellPath: 'powershell', trayScriptPath: 'src/center/TrayIcon.ps1',", '')
    # Remove the ps fallback test (lines 129-138)
    .replace("""  it('uses PowerShell path when uiExecutablePath is absent', async () => {
    const daemon = createDaemon({ ...options!, uiExecutablePath: undefined });
    await new Promise(r => setTimeout(r, 100));
    expect(mockedSpawn).toHaveBeenCalledWith(
      'powershell',
      expect.arrayContaining(['-File', 'src/center/TrayIcon.ps1']),
      expect.any(Object),
    );
    await daemon.stop();
  });
""", '')
    # Fix uiExecutablePath type
    .replace('uiExecutablePath: uiExe ?? undefined,', 'uiExecutablePath: uiExe!,')
))

# daemon-chain.test.ts
fix('tests/daemon-chain.test.ts', lambda c: (
    # Remove powerShellPath and trayScriptPath from startDaemon
    c.replace('statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', 'statePath, ')
    .replace('statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",', 'statePath, ')
    # Remove the ps fallback test (lines 124-136)
    .replace("""  it("falls back to PowerShell when uiExecutablePath is undefined", async () => {
    const daemon = createDaemon({
      statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",
      trayStatePath, trayPidPath, cliPath, debug: false,
    });
    await new Promise(r => setTimeout(r, 300));
    expect(mockedSpawn).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-File", "TrayIcon.ps1"]),
      expect.any(Object),
    );
    await daemon.stop();
  });
""", '')
))

print('done')
