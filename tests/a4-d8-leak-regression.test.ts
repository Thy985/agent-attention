/**
 * Source wiring guards only. The former toy JS allocation/heapUsed test never
 * called TrayController or measured GDI handles; it sampled Jest/V8 GC timing.
 * Production OwnedResource lifetime and StateStore recovery are exercised by
 * tests/ui-contract-harness. Actual ContextMenuStrip disposal is covered by the
 * Windows UI harness, which must run on Windows; neither is a GDI leak measurement.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('Tray lifetime and build source wiring (not native leak measurement)', () => {
  const tray = fs.readFileSync(path.join(__dirname, '../src/center/csharp/AgentAttention.UI/TrayController.cs'), 'utf8');

  it('hands replacement menus to the production resource owner after installing them', () => {
    expect(tray).toContain('OwnedResource<WinForms.ContextMenuStrip>');
    expect(tray).toMatch(/_notifyIcon\.ContextMenuStrip\s*=\s*menu;\s*_menu\.Replace\(menu\);/);
  });

  it('detaches and disposes the owned final menu when the tray is disposed', () => {
    expect(tray).toMatch(/public void Dispose\(\)[\s\S]*?_notifyIcon\.ContextMenuStrip\s*=\s*null;\s*_menu\.Dispose\(\);/);
  });

  it('should confirm C# build artifacts include HighDpi props (A3 D7)', () => {
    const csproj = fs.readFileSync(
      path.join(__dirname, '../src/center/csharp/AgentAttention.UI/AgentAttention.UI.csproj'),
      'utf-8',
    );
    expect(csproj).toContain('<HighDpi>Enable</HighDpi>');
    expect(csproj).toContain('<HighDpiMode>PerMonitorV2</HighDpiMode>');
  });

  it('should confirm daemon start registers startup hook (A2 D5)', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/daemon-cli.ts'),
      'utf-8',
    );
    expect(src).toContain('registerStartupHook');
    expect(src).toContain('agent-attention.vbs');
    // Should be called at end of startDaemon
    expect(src).toMatch(/Daemon started[\s\S]*?registerStartupHook\(\)/);
  });
});
