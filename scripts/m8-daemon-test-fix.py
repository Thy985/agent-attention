import sys, os
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

# Fix daemon.test.ts makeOptions and options
with open(os.path.join(B, 'tests/daemon.test.ts'), 'r', encoding='utf-8') as f:
    c = f.read()

c = c.replace(
    "  const makeOptions = (dir: string): DaemonOptions => ({\n    statePath:     path.join(dir, 'state.json'),\n        trayStatePath: path.join(dir, 'tray-state.json'),\n    trayPidPath:   path.join(dir, 'tray.pid'),\n    cliPath:       path.join(dir, 'daemon-cli.js'),\n    debug:         false,\n  });",
    "  const makeOptions = (dir: string): DaemonOptions => ({\n    statePath:        path.join(dir, 'state.json'),\n    trayStatePath:    path.join(dir, 'tray-state.json'),\n    trayPidPath:      path.join(dir, 'tray.pid'),\n    cliPath:          path.join(dir, 'daemon-cli.js'),\n    uiExecutablePath: path.join(dir, 'AgentAttention.UI.exe'),\n    debug:            false,\n  });"
)

c = c.replace(
    "  const options: Partial<DaemonOptions> = {\n    statePath: '',\n        debug: false,\n  };",
    "  const options: Partial<DaemonOptions> = {\n    statePath: '',\n    debug: false,\n  };"
)

with open(os.path.join(B, 'tests/daemon.test.ts'), 'w', encoding='utf-8') as f:
    f.write(c)
print('daemon.test.ts fixed')

print('done')
