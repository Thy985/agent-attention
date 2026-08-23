import sys, os
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

with open(os.path.join(B, 'tests/daemon-chain.test.ts'), 'r', encoding='utf-8') as f:
    c = f.read()

c = c.replace('statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', 'statePath, ')
c = c.replace('statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",', 'statePath, ')

with open(os.path.join(B, 'tests/daemon-chain.test.ts'), 'w', encoding='utf-8') as f:
    f.write(c)
print('fixed')
