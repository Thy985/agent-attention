#!/usr/bin/env python3
"""M8: fix remaining issues."""
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
BASE = r'D:\Projects\Active\agent-attention'

def patch(path, old, new):
    fp = os.path.join(BASE, path)
    with open(fp, 'r', encoding='utf-8') as f:
        c = f.read()
    if old not in c:
        print(f'  SKIP: {path} :: {old[:60]}')
        return False
    c = c.replace(old, new)
    with open(fp, 'w', encoding='utf-8') as f:
        f.write(c)
    print(f'  OK: {path}')
    return True

print('=== Fix daemon.ts imports ===')
patch('src/daemon.ts',
    "import { getUiMode, resolveNativeUiPath } from './ui-host';",
    "import { resolveNativeUiPath } from './ui-host';")

print('=== Fix daemon-cli.ts ===')
# Replace getPsPids-based tray management with PID-file-based approach
with open(os.path.join(BASE, 'src/daemon-cli.ts'), 'r', encoding='utf-8') as f:
    c = f.read()

# Remove getPsPids function
start = c.index('function getPsPids(')
end = c.index('\n}\n\nconst STATE_DIR', start)
c = c[:start] + c[end+2:]

# Replace killOrphanTrayProcesses with simple PID-file check
old_orphan = '''function killOrphanTrayProcesses(): number {
  let killed = 0;
  try {
    // Get all TrayIcon.ps1 processes excluding our own
    const pids = getPsPids('TrayIcon.ps1');
    for (const trayPid of pids) {
      try {
        // Get parent PID via CIM
        const parent = runPs(
          'get-ciminstance win32_process | where-object { $_.processid -eq ' +
          trayPid + ' } | select-object -expandproperty parentprocessid',
        ).trim();
        const parentPid = parseInt(parent, 10);
        if (isNaN(parentPid) || parentPid === 0) continue; // init/system parent
        // Check if parent is an agent-attention daemon
        const parentCmd = runPs(
          'get-ciminstance win32_process | where-object { $_.processid -eq ' +
          parentPid + ' } | select-object -expandproperty commandline',
        ).trim();
        if (parentCmd.includes('daemon.js') && parentCmd.includes('agent-attention')) {
          if (isProcessRunning(parentPid)) continue; // parent alive — not orphan
        }
        // Parent is dead or not a daemon — this is an orphan
        try { process.kill(trayPid, 'SIGTERM'); killed++; } catch {}
      } catch {}
    }
  } catch {
    // fallback: just kill all matching pids
    for (const pid of getPsPids('TrayIcon.ps1')) {
      try { process.kill(pid, 'SIGTERM'); killed++; } catch {}
    }
  }
  if (killed > 0) console.log(`Killed ${killed} orphan tray process(es)`);
  return killed;
}

'''
new_orphan = '''function killOrphanTrayProcesses(): number {
  // C# UI manages its own lifecycle via single-instance lock.
  // The daemon writes tray.pid; we just clean up stale entries.
  let killed = 0;
  const pid = readTrayPid();
  if (pid && !isProcessRunning(pid)) {
    try { fs.unlinkSync(TRAY_PID_FILE); killed++; } catch {}
  }
  return killed;
}

'''
patch2 = c.replace(old_orphan, new_orphan)
if patch2 != c:
    c = patch2
    with open(os.path.join(BASE, 'src/daemon-cli.ts'), 'w', encoding='utf-8') as f:
        f.write(c)
    print('  OK: daemon-cli.ts killOrphanTrayProcesses')
else:
    print('  SKIP: killOrphanTrayProcesses not found')

# Replace getStatus tray check
old_status = '''  // Check if tray process exists via get-ciminstance (issue #14)
  let trayRunning = false;
  try {
    const pids = getPsPids('TrayIcon.ps1');
    trayRunning = pids.length > 0;
  } catch {
    trayRunning = false;
  }'''
new_status = '''  // Check if tray process exists via PID file
  const trayPid = readTrayPid();
  const trayRunning = trayPid !== null && isProcessRunning(trayPid);'''
c = c.replace(old_status, new_status)
if 'trayRunning' in c and c.count('getPsPids') == 0:
    with open(os.path.join(BASE, 'src/daemon-cli.ts'), 'w', encoding='utf-8') as f:
        f.write(c)
    print('  OK: daemon-cli.ts getStatus')

# Remove killExistingDaemon tray-child killing
old_kill = '''  // Also kill their tray children
  for (const pid of pids) {
    try {
      // P2-1 fix: the old script had a space between the pipeline variable
      // and its .name property, which is a PowerShell parser error.
      // Use the correct $var.property form throughout.
      runPs(
        `get-ciminstance win32_process | where-object { ` +
        `$_.name -eq 'powershell.exe' -and $_.parentprocessid -eq ${pid} ` +
        `-and $_.commandline -like '*TrayIcon.ps1*' } | ` +
        `foreach-object { stop-process -id $_.processid -force }`,
      );
    } catch {}
  }'''
c = c.replace(old_kill, '')
if c.count('getPsPids') < 5:
    with open(os.path.join(BASE, 'src/daemon-cli.ts'), 'w', encoding='utf-8') as f:
        f.write(c)
    print('  OK: daemon-cli.ts killExistingDaemon')

# Replace doctor tray instance counting
old_doctor = '''  // Try PID file first (exact match, no CIM needed)
  const trayPid = readTrayPid();
  if (trayPid && isProcessRunning(trayPid)) trayInstances = 1;
  else {
    // Fall back to get-ciminstance pattern match
    try {
      const out = runPs(
        'get-ciminstance win32_process | where-object { $_.name -eq ' +
        \"'powershell.exe' -and $_.commandline -like '*TrayIcon.ps1*' } \" +
        '| select-object -expandproperty processid',
      );
      trayInstances = out.trim().split('\\n').filter(Boolean).length;
    } catch { trayInstances = 0; }
  }'''
new_doctor = '''  // Try PID file first (exact match)
  const trayPid = readTrayPid();
  if (trayPid && isProcessRunning(trayPid)) trayInstances = 1;'''
c = c.replace(old_doctor, new_doctor)
with open(os.path.join(BASE, 'src/daemon-cli.ts'), 'w', encoding='utf-8') as f:
    f.write(c)
print('  OK: daemon-cli.ts doctor')

# Replace doctor Tray script check
old_check = '''    {
      name: 'Tray script',
      ok: fs.existsSync(path.join(__dirname, '..', 'src', 'center', 'TrayIcon.ps1')),
      detail: 'src/center/TrayIcon.ps1 exists',
    },'''
new_check = '''    {
      name: 'UI executable',
      ok: resolveNativeUiPath() !== null,
      detail: resolveNativeUiPath() !== null ? 'AgentAttention.UI.exe found' : 'NOT FOUND — run npm run build:ui && npm run publish:ui',
    },'''
# Need to import resolveNativeUiPath in daemon-cli.ts
c = c.replace(old_check, new_check)
# Add import
c = c.replace(
    \"import { clearUnread, markRead } from './state/AttentionState';\",
    \"import { clearUnread, markRead } from './state/AttentionState';\\nimport { resolveNativeUiPath } from './ui-host';\"
)
with open(os.path.join(BASE, 'src/daemon-cli.ts'), 'w', encoding='utf-8') as f:
    f.write(c)
print('  OK: daemon-cli.ts doctor check')

print('=== Update tests ===')
# tests/daemon.test.ts
with open(os.path.join(BASE, 'tests/daemon.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
tc = tc.replace(\"powerShellPath: 'powershell',\\n    trayScriptPath: 'src/center/TrayIcon.ps1',\\n\", '')
tc = tc.replace(\"powerShellPath: 'powershell',\\n\", '')
tc = tc.replace(\"trayScriptPath: 'src/center/TrayIcon.ps1',\", '')
# Remove the ps spawn test
import re
tc = re.sub(r'  it\(\'spawns TrayIcon\.ps1 without stdin pipe\'.*?await expect\(daemon\.stop\(\)\)\.resolves\.not\.toThrow\(\);\n  \}\n\n', '', tc, flags=re.DOTALL)
with open(os.path.join(BASE, 'tests/daemon.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/daemon.test.ts')

# tests/daemon-csharp.test.ts
with open(os.path.join(BASE, 'tests/daemon-csharp.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
tc = tc.replace(\"powerShellPath: 'powershell', trayScriptPath: 'src/center/TrayIcon.ps1',\", '')
# Remove the ps fallback test
tc = re.sub(r'  it\(\'uses PowerShell path when uiExecutablePath is absent\'.*?await daemon\.stop\(\);\n  \}\n', '', tc, flags=re.DOTALL)
with open(os.path.join(BASE, 'tests/daemon-csharp.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/daemon-csharp.test.ts')

# tests/daemon-chain.test.ts
with open(os.path.join(BASE, 'tests/daemon-chain.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
tc = tc.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', '')
tc = tc.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",', '')
# Remove the ps fallback test
tc = re.sub(r'  it\("falls back to PowerShell.*?await daemon\.stop\(\);\n  \}\n', '', tc, flags=re.DOTALL)
with open(os.path.join(BASE, 'tests/daemon-chain.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/daemon-chain.test.ts')

# tests/daemon-ipc-fastpath.test.ts
with open(os.path.join(BASE, 'tests/daemon-ipc-fastpath.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
tc = tc.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', '')
tc = tc.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",', '')
with open(os.path.join(BASE, 'tests/daemon-ipc-fastpath.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/daemon-ipc-fastpath.test.ts')

# tests/daemon-ipc-rpc.test.ts
with open(os.path.join(BASE, 'tests/daemon-ipc-rpc.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
tc = tc.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', '')
with open(os.path.join(BASE, 'tests/daemon-ipc-rpc.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/daemon-ipc-rpc.test.ts')

# tests/toast-routing.test.ts
with open(os.path.join(BASE, 'tests/toast-routing.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
# Remove ps mode tests
tc = re.sub(r'  it\("ps mode triggers powershell path in win32\.ts source".*?expect\(src\)\.toContain\("CenterWindow\.ps1"\);\n  \}\n\n', '', tc, flags=re.DOTALL)
tc = re.sub(r'  it\("win32\.ts spawn args include powershell flags for ps mode".*?expect\(src\)\.not\.toContain\(\'process\.execPath\'\);\n  \}\n', '', tc, flags=re.DOTALL)
with open(os.path.join(BASE, 'tests/toast-routing.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/toast-routing.test.ts')

# tests/toast-integration.test.ts
with open(os.path.join(BASE, 'tests/toast-integration.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
# Remove CenterWindow.ps1 path test
tc = re.sub(r'  it\(\'compiled JS does not hardcode dist/src/center/.*?expect\(src\)\.not\.toContain\("path\.join\(__dirname, \'\.\.\', \'src\', \'center\'");\n  \}\n\n', '', tc, flags=re.DOTALL)
# Remove AGENT_ATTENTION_UI env test
tc = re.sub(r'  it\(\'csharp mode selects native host over PowerShell\'.*?else process\.env\.AGENT_ATTENTION_UI = original;\n    \}\n  \}\n', '', tc, flags=re.DOTALL)
with open(os.path.join(BASE, 'tests/toast-integration.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/toast-integration.test.ts')

# tests/win32-paths.test.ts
with open(os.path.join(BASE, 'tests/win32-paths.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
# Remove CenterWindow.ps1 path tests
tc = re.sub(r'  it\(\'source no longer hard-codes dist/src/center/ for CenterWindow\.ps1\'.*?expect\(code\)\.not\.toContain\("path\.join\(__dirname, \'\\.\\.', '', tc, flags=re.DOTALL)
tc = re.sub(r'  it\(\'getCenterPath uses \.\./\.\./src/center/CenterWindow\.ps1.*?expect\(code\)\.toContain\("path\.join\(__dirname, \'\\.\\.\/\'\\.\\.\/\'src\', \'center\', \'CenterWindow\.ps1\'\)"\);\n  \}\n\n', '', tc, flags=re.DOTALL)
# Update the C# mode test
tc = tc.replace(
    "expect(code).toContain(\"getUiMode() === 'csharp'\");",
    "expect(code).toContain(\"resolveNativeUiPath()\");"
)
with open(os.path.join(BASE, 'tests/win32-paths.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/win32-paths.test.ts')

# tests/cli-invariant.test.ts - remove ps-specific assertions
with open(os.path.join(BASE, 'tests/cli-invariant.test.ts'), 'r', encoding='utf-8') as f:
    tc = f.read()
# Remove the ps path assertions
tc = re.sub(r'  it\(\'should use spawn with explicit powershell in win32\.ts \(not process\.execPath\)\'.*?expect\(src\)\.not\.toContain\(\'exec\(`powershell\'\);\n  \}\n\n', '', tc, flags=re.DOTALL)
with open(os.path.join(BASE, 'tests/cli-invariant.test.ts'), 'w', encoding='utf-8') as f:
    f.write(tc)
print('  OK: tests/cli-invariant.test.ts')

print('\\n=== ALL DONE ===')
