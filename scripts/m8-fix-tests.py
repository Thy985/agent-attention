import sys, os, re
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

def read(p):
    with open(os.path.join(B, p), 'r', encoding='utf-8') as f:
        return f.read()
def write(p, c):
    with open(os.path.join(B, p), 'w', encoding='utf-8') as f:
        f.write(c)

# 1. daemon.test.ts — remove ps references
p = 'tests/daemon.test.ts'
c = read(p)
c = c.replace("    powerShellPath: 'powershell',\n    trayScriptPath: 'src/center/TrayIcon.ps1',\n", '')
c = c.replace("    powerShellPath: 'powershell',\n", '')
c = c.replace("    trayScriptPath: 'src/center/TrayIcon.ps1',", '')
# Remove the ps spawn test entirely
c = re.sub(r"  it\('spawns TrayIcon\.ps1 without stdin pipe'.*?await expect\(daemon\.stop\(\)\)\.resolves\.not\.toThrow\(\);\n  \}\n\n", '', c, flags=re.DOTALL)
write(p, c)
print('1. daemon.test.ts')

# 2. daemon-csharp.test.ts
p = 'tests/daemon-csharp.test.ts'
c = read(p)
c = c.replace("powerShellPath: 'powershell', trayScriptPath: 'src/center/TrayIcon.ps1',\n      ", '')
c = c.replace("powerShellPath: 'powershell', trayScriptPath: 'src/center/TrayIcon.ps1',", '')
# Fix uiExecutablePath: undefined → remove the test that passes undefined
c = re.sub(r"  it\('uses PowerShell path when uiExecutablePath is absent'.*?await daemon\.stop\(\);\n  \}\n", '', c, flags=re.DOTALL)
# Fix uiExecutablePath: uiExe ?? undefined → just uiExe (make it required)
c = c.replace('uiExecutablePath: uiExe ?? undefined,', 'uiExecutablePath: uiExe!,')
write(p, c)
print('2. daemon-csharp.test.ts')

# 3. daemon-chain.test.ts
p = 'tests/daemon-chain.test.ts'
c = read(p)
c = c.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', '')
c = c.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",', '')
c = re.sub(r'  it\("falls back to PowerShell.*?await daemon\.stop\(\);\n  \}\n', '', c, flags=re.DOTALL)
write(p, c)
print('3. daemon-chain.test.ts')

# 4. daemon-ipc-fastpath.test.ts
p = 'tests/daemon-ipc-fastpath.test.ts'
c = read(p)
c = c.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', '')
c = c.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",', '')
write(p, c)
print('4. daemon-ipc-fastpath.test.ts')

# 5. daemon-ipc-rpc.test.ts
p = 'tests/daemon-ipc-rpc.test.ts'
c = read(p)
c = c.replace('powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",\n      ', '')
write(p, c)
print('5. daemon-ipc-rpc.test.ts')

# 6. toast-routing.test.ts
p = 'tests/toast-routing.test.ts'
c = read(p)
# Remove ps mode test
c = re.sub(r'  it\("ps mode triggers powershell path in win32\.ts source".*?expect\(src\)\.toContain\("CenterWindow\.ps1"\);\n  \}\n\n', '', c, flags=re.DOTALL)
# Remove ps spawn args test
c = re.sub(r'  it\("win32\.ts spawn args include powershell flags for ps mode".*?expect\(src\)\.not\.toContain\(\'process\.execPath\'\);\n  \}\n', '', c, flags=re.DOTALL)
write(p, c)
print('6. toast-routing.test.ts')

# 7. toast-integration.test.ts
p = 'tests/toast-integration.test.ts'
c = read(p)
# Remove CenterWindow.ps1 test
c = re.sub(r"  it\('compiled JS does not hardcode dist/src/center/.*?expect\(src\)\.not\.toContain\(\"path\.join\(__dirname, '\.\.', 'src', 'center'\"\);\n  \}\n\n", '', c, flags=re.DOTALL)
# Remove AGENT_ATTENTION_UI env test
c = re.sub(r"  it\('csharp mode selects native host over PowerShell'.*?else process\.env\.AGENT_ATTENTION_UI = original;\n    \}\n  \}\n", '', c, flags=re.DOTALL)
# Fix the remaining test that checks getUiMode
c = c.replace("expect(src).toContain(\"getUiMode() === 'csharp'\");", "expect(src).toContain(\"resolveNativeUiPath()\");")
write(p, c)
print('7. toast-integration.test.ts')

# 8. win32-paths.test.ts
p = 'tests/win32-paths.test.ts'
c = read(p)
# Remove CenterWindow.ps1 tests
c = re.sub(r"  it\('source no longer hard-codes dist/src/center/ for CenterWindow\.ps1'.*?expect\(code\)\.not\.toContain\(\"path\.join\(__dirname, '\.\.'", '', c, flags=re.DOTALL)
c = re.sub(r"  it\('getCenterPath uses \.\./\.\./src/center/CenterWindow\.ps1.*?expect\(code\)\.toContain\(\"path\.join\(__dirname, '\.\.', '\.\.', 'src', 'center', 'CenterWindow\.ps1'\"\\);\n  \}\n\n", '', c, flags=re.DOTALL)
# Fix the C# mode test
c = c.replace("expect(code).toContain(\"getUiMode() === 'csharp'\");", "expect(code).toContain(\"resolveNativeUiPath()\");")
write(p, c)
print('8. win32-paths.test.ts')

# 9. cli-invariant.test.ts
p = 'tests/cli-invariant.test.ts'
c = read(p)
# Remove ps path assertion test
c = re.sub(r"  it\('should use spawn with explicit powershell in win32\.ts \(not process\.execPath\)\'.*?expect\(src\)\.not\.toContain\('exec\(`powershell'\);\n  \}\n\n", '', c, flags=re.DOTALL)
write(p, c)
print('9. cli-invariant.test.ts')

# 10. daemon-cli.ts — add resolveNativeUiPath import
p = 'src/daemon-cli.ts'
c = read(p)
old_imp = "import { clearUnread, markRead } from './state/AttentionState';"
new_imp = old_imp + "\nimport { resolveNativeUiPath } from './ui-host';"
c = c.replace(old_imp, new_imp)
write(p, c)
print('10. daemon-cli.ts import')

print('\nAll fixes applied')
