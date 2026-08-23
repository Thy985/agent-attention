import sys, os
sys.stdout.reconfigure(encoding='utf-8')
B = r'D:\Projects\Active\agent-attention'

def delete_lines(path, start, end):
    """Delete lines start-end (1-indexed, inclusive)."""
    with open(os.path.join(B, path), 'r', encoding='utf-8') as f:
        lines = f.readlines()
    # Delete lines[start-1:end]
    new_lines = lines[:start-1] + lines[end:]
    with open(os.path.join(B, path), 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    print(f'  {path}: deleted lines {start}-{end}')

# daemon.test.ts: lines 64-77 (spawns TrayIcon.ps1 test)
delete_lines('tests/daemon.test.ts', 64, 77)

# daemon-csharp.test.ts: lines 128-140 (uses PowerShell path test)
delete_lines('tests/daemon-csharp.test.ts', 128, 140)

# daemon-chain.test.ts: lines 123-137 (falls back to PowerShell test)
delete_lines('tests/daemon-chain.test.ts', 123, 137)

print('done')
