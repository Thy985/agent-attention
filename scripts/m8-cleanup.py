#!/usr/bin/env python3
"""M8 cleanup: remove PowerShell UI references from source and tests."""
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
BASE = r'D:\Projects\Active\agent-attention'

def patch(path, old, new):
    fp = os.path.join(BASE, path)
    with open(fp, 'r', encoding='utf-8') as f:
        c = f.read()
    if old not in c:
        print(f'  SKIP (not found): {path} :: {old[:60]}...')
        return False
    c = c.replace(old, new)
    with open(fp, 'w', encoding='utf-8') as f:
        f.write(c)
    print(f'  OK: {path}')
    return True

# ── src/daemon.ts ──────────────────────────────────────────────────
print('=== daemon.ts ===')

# Remove powerShellPath and trayScriptPath from DaemonOptions interface
patch('src/daemon.ts',
    '  powerShellPath: string;\n  trayScriptPath: string;\n',
    '')

# Update comment
patch('src/daemon.ts',
    '  trayStatePath: string;   // polling file written by daemon, read by TrayIcon.ps1',
    '  trayStatePath: string;   // polling file written by daemon, read by C# tray')

patch('src/daemon.ts',
    '  uiExecutablePath?: string; // native UI host; when omitted, spawn TrayIcon.ps1',
    '  uiExecutablePath?: string; // native C# UI host')

patch('src/daemon.ts',
    '/** Write current state to the polling file that TrayIcon.ps1 reads. */',
    '/** Write current state to the polling file that the C# tray reads. */')

# Replace spawnTray if/else with just csharp branch
old_spawn = (
    '  const spawnTray = () => {\n'
    '    if (options.uiExecutablePath) {\n'
    "      log(`spawning UI host: ${options.uiExecutablePath}`);\n"
    "      const registryPath = path.join(path.dirname(options.statePath), 'agents.json');\n"
    '      const trayArgs = [\n'
    "          '-StatePath', options.statePath,\n"
    "          '-RegistryPath', registryPath,\n"
    "          '-CliPath', options.cliPath,\n"
    "          '-TrayStatePath', options.trayStatePath,\n"
    '        ];\n'
    '      if (options.trayPidPath) trayArgs.push("-TrayPidPath", options.trayPidPath);\n\n'
    '      trayProc = spawn(\n'
    '        options.uiExecutablePath,\n'
    '        trayArgs,\n'
    '        {\n'
    "          stdio: ['ignore', 'ignore', 'pipe'],\n"
    '          windowsHide: true,\n'
    '          detached: false,\n'
    '        },\n'
    '      );\n'
    '    } else {\n'
    "      log(`spawning tray: ${options.powerShellPath} ${options.trayScriptPath}`);\n"
    '      const trayArgs = [\n'
    "          '-NoProfile',\n"
    "          '-ExecutionPolicy', 'Bypass',\n"
    "          '-File', options.trayScriptPath,\n"
    "          '-StatePath', options.statePath,\n"
    "          '-CliPath', options.cliPath,\n"
    "          '-TrayStatePath', options.trayStatePath,\n"
    '        ];\n'
    '      if (options.trayPidPath) trayArgs.push("-TrayPidPath", options.trayPidPath);\n\n'
    '      trayProc = spawn(\n'
    '        options.powerShellPath,\n'
    '        trayArgs,\n'
    '        {\n'
    "          stdio: ['ignore', 'ignore', 'pipe'],\n"
    '          windowsHide: true,\n'
    '          detached: false,\n'
    '        },\n'
    '      );\n'
    '    }'
)

new_spawn = (
    '  const spawnTray = () => {\n'
    "    log(`spawning UI host: ${options.uiExecutablePath}`);\n"
    "    const registryPath = path.join(path.dirname(options.statePath), 'agents.json');\n"
    '    const trayArgs = [\n'
    "        '-StatePath', options.statePath,\n"
    "        '-RegistryPath', registryPath,\n"
    "        '-CliPath', options.cliPath,\n"
    "        '-TrayStatePath', options.trayStatePath,\n"
    '      ];\n'
    '    if (options.trayPidPath) trayArgs.push("-TrayPidPath", options.trayPidPath);\n\n'
    '    trayProc = spawn(\n'
    '      options.uiExecutablePath,\n'
    '      trayArgs,\n'
    '      {\n'
    "        stdio: ['ignore', 'ignore', 'pipe'],\n"
    '        windowsHide: true,\n'
    '        detached: false,\n'
    '      },\n'
    '    );'
)
patch('src/daemon.ts', old_spawn, new_spawn)

# Remove trayScriptPath in CLI entry point
patch('src/daemon.ts',
    "  const trayScriptPath = path.join(__dirname, '..', 'src', 'center', 'TrayIcon.ps1');\n",
    '')

# Fix error message
patch('src/daemon.ts',
    "'AGENT_ATTENTION_UI=csharp but AgentAttention.UI.exe was not found. '\n        + 'Build it or set AGENT_ATTENTION_UI_EXE.',",
    "'AgentAttention.UI.exe not found. Build it or set AGENT_ATTENTION_UI_EXE.'")

# Fix createDaemon call
patch('src/daemon.ts',
    '  const daemon = createDaemon({\n    statePath,\n    powerShellPath: \'powershell\',\n    trayScriptPath,\n    trayStatePath,',
    '  const daemon = createDaemon({\n    statePath,\n    trayStatePath,')

# Update log line
patch('src/daemon.ts',
    "  daemonLog(`tray polling file: ${trayStatePath}`, debug);",
    "  daemonLog(`tray polling file: ${trayStatePath}`, debug)  // C# tray reads this")

print('=== win32.ts ===')
# src/notification/win32.ts
patch('src/notification/win32.ts',
    "/** Resolve the CenterWindow.ps1 path. */\n"
    "function getCenterPath(): string {\n"
    "  const envPath = process.env.AGENT_ATTENTION_CENTER;\n"
    "  if (envPath) return envPath;\n"
    "  // After build, dist/notification/win32.js lives at dist/notification/win32.js.\n"
    "  // CenterWindow.ps1 is shipped under src/center/ via package.json \"files\".\n"
    "  // So from dist/notification/ we need to go up two levels to reach src/center/.\n"
    "  const local = path.join(__dirname, '..', '..', 'src', 'center', 'CenterWindow.ps1');\n"
    "  if (require('fs').existsSync(local)) return local;\n"
    "  return local;\n"
    "}\n\n",
    '')

patch('src/notification/win32.ts',
    '  const centerPath = getCenterPath();\n',
    '')

old_notif_spawn = (
    "          try {\n"
    "            const { spawn } = require('child_process');\n"
    "            if (getUiMode() === 'csharp') {\n"
    "              const uiExecutable = resolveNativeUiPath();\n"
    "              if (!uiExecutable) throw new Error('AgentAttention.UI.exe not found');\n"
    "              spawn(uiExecutable, [\n"
    "                '-StatePath', path.join(stateDir, 'state.json'),\n"
    "                '-RegistryPath', path.join(stateDir, 'agents.json'),\n"
    "                '-CliPath', cliPath,\n"
    "                '-TrayStatePath', path.join(stateDir, 'tray-state.json'),\n"
    "                '-OpenCenter',\n"
    "              ], { windowsHide: true });\n"
    "            } else {\n"
    "              spawn('powershell', [\n"
    "                '-NoProfile', '-ExecutionPolicy', 'Bypass',\n"
    "                '-File', centerPath,\n"
    "                '-StatePath', path.join(stateDir, 'state.json'),\n"
    "                '-RegistryPath', path.join(stateDir, 'agents.json'),\n"
    "              ], { windowsHide: true });\n"
    "            }\n"
    "          } catch (err) {"
)

new_notif_spawn = (
    "          try {\n"
    "            const { spawn } = require('child_process');\n"
    "            const uiExecutable = resolveNativeUiPath();\n"
    "            if (!uiExecutable) throw new Error('AgentAttention.UI.exe not found');\n"
    "            spawn(uiExecutable, [\n"
    "              '-StatePath', path.join(stateDir, 'state.json'),\n"
    "              '-RegistryPath', path.join(stateDir, 'agents.json'),\n"
    "              '-CliPath', cliPath,\n"
    "              '-TrayStatePath', path.join(stateDir, 'tray-state.json'),\n"
    "              '-OpenCenter',\n"
    "            ], { windowsHide: true });\n"
    "          } catch (err) {"
)
patch('src/notification/win32.ts', old_notif_spawn, new_notif_spawn)

patch('src/notification/win32.ts',
    "import { getUiMode, resolveNativeUiPath } from '../ui-host';",
    "import { resolveNativeUiPath } from '../ui-host';")

print('=== package.json ===')
patch('package.json',
    '    "src/center/*.ps1",\n',
    '')

print('=== DONE ===')
