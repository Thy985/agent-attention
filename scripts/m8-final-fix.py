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

# daemon.test.ts — remove ps spawn test
fix('tests/daemon.test.ts', lambda c: re.sub(
    r"  it\('spawns TrayIcon\.ps1 without stdin pipe'.*?await expect\(daemon\.stop\(\)\)\.resolves\.not\.toThrow\(\);\n  \}\n\n",
    '', c, flags=re.DOTALL
))

# daemon-csharp.test.ts — remove ps fallback test
fix('tests/daemon-csharp.test.ts', lambda c: re.sub(
    r"  it\('uses PowerShell path when uiExecutablePath is absent'.*?await daemon\.stop\(\);\n  \}\n",
    '', c, flags=re.DOTALL
))

# daemon-chain.test.ts — remove ps fallback test
fix('tests/daemon-chain.test.ts', lambda c: re.sub(
    r'  it\("falls back to PowerShell.*?await daemon\.stop\(\);\n  \}\n',
    '', c, flags=re.DOTALL
))

print('done')
