import sys, os, re
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

def fix(path):
    with open(os.path.join(B, path), 'r', encoding='utf-8') as f:
        c = f.read()
    return c

def save(path, c):
    with open(os.path.join(B, path), 'w', encoding='utf-8') as f:
        f.write(c)

# win32-paths.test.ts
c = fix('tests/win32-paths.test.ts')
# Remove getCenterPath test
pat1 = r"  it\('getCenterPath uses.*?CenterWindow\.ps1.*?\}\n\n"
c = re.sub(pat1, '', c, flags=re.DOTALL)
# Fix the C# mode check
c = c.replace("""expect(code).toContain("getUiMode() === 'csharp'");""", "expect(code).toContain('resolveNativeUiPath()');")
save('tests/win32-paths.test.ts', c)
print('win32-paths.test.ts')

# toast-integration.test.ts
c = fix('tests/toast-integration.test.ts')
# Remove CenterWindow.ps1 test
pat2 = r"  it\('compiled JS does not hardcode dist/src/center/.*?expect\(src\)\.not\.toContain.*?src', 'center'\);\n  \}\n\n"
c = re.sub(pat2, '', c, flags=re.DOTALL)
# Remove AGENT_ATTENTION_UI test
pat3 = r"  it\('csharp mode selects native host over PowerShell'.*?AGENT_ATTENTION_UI = original;\n    \}\n  \}\n"
c = re.sub(pat3, '', c, flags=re.DOTALL)
# Fix getUiMode check
c = c.replace("""expect(src).toContain("getUiMode() === 'csharp'");""", "expect(src).toContain('resolveNativeUiPath()');")
save('tests/toast-integration.test.ts', c)
print('toast-integration.test.ts')

# cli-invariant.test.ts
c = fix('tests/cli-invariant.test.ts')
# Remove ps in win32.ts test
pat4 = r"  it\('should use spawn with explicit powershell in win32\.ts.*?exec\(`powershell'\);\n  \}\n\n"
c = re.sub(pat4, '', c, flags=re.DOTALL)
save('tests/cli-invariant.test.ts', c)
print('cli-invariant.test.ts')

print('done')
