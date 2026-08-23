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
fix('tests/daemon.test.ts', lambda c: c
    .replace(
        "    statePath:     path.join(dir, 'state.json'),\n    trayStatePath: path.join(dir, 'tray-state.json'),\n    trayPidPath:   path.join(dir, 'tray.pid'),\n    cliPath:       path.join(dir, 'daemon-cli.js'),\n    debug:         false,",
        "    statePath:        path.join(dir, 'state.json'),\n    trayStatePath:    path.join(dir, 'tray-state.json'),\n    trayPidPath:      path.join(dir, 'tray.pid'),\n    cliPath:          path.join(dir, 'daemon-cli.js'),\n    uiExecutablePath: path.join(dir, 'AgentAttention.UI.exe'),\n    debug:            false,"
    )
    .replace(
        "    statePath: '',\n    debug: false,",
        "    statePath: '',\n    uiExecutablePath: '',\n    debug: false,"
    )
)

# daemon-csharp.test.ts
fix('tests/daemon-csharp.test.ts', lambda c: re.sub(
    r"  it\('uses PowerShell path when uiExecutablePath is absent'.*?await daemon\.stop\(\);\n  \}\n",
    '', c, flags=re.DOTALL
))

# daemon-chain.test.ts
fix('tests/daemon-chain.test.ts', lambda c: (
    re.sub(r'  it\("falls back to PowerShell.*?await daemon\.stop\(\);\n  \}\n', '', c, flags=re.DOTALL)
    .replace('statePath, trayStatePath, trayPidPath, cliPath, debug: false,', 'statePath, trayStatePath, trayPidPath, cliPath, uiExecutablePath: uiExe, debug: false,')
))

print('all fixed')
