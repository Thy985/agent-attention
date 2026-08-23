import sys, os
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

with open(os.path.join(B, 'src/daemon-cli.ts'), 'r', encoding='utf-8') as f:
    c = f.read()

# Add import
c = c.replace(
    "import { clearUnread, markRead } from './state/AttentionState';",
    "import { clearUnread, markRead } from './state/AttentionState';\nimport { resolveNativeUiPath } from './ui-host';"
)

# Replace Tray script check with UI executable check
c = c.replace(
    """    {\n      name: 'Tray script',\n      ok: fs.existsSync(path.join(__dirname, '..', 'src', 'center', 'TrayIcon.ps1')),\n      detail: 'src/center/TrayIcon.ps1 exists',\n    },""",
    """    {\n      name: 'UI executable',\n      ok: resolveNativeUiPath() !== null,\n      detail: resolveNativeUiPath() !== null ? 'AgentAttention.UI.exe found' : 'NOT FOUND — run npm run build:ui && npm run publish:ui',\n    },"""
)

with open(os.path.join(B, 'src/daemon-cli.ts'), 'w', encoding='utf-8') as f:
    f.write(c)
print('daemon-cli.ts fixed')
