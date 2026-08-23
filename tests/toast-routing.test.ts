import * as fs from "fs";
import * as path from "path";
import { resolveNativeUiPath } from "../src/ui-host";

describe("toast routing (M8: csharp-only)", () => {
  it("win32.ts uses resolveNativeUiPath and -OpenCenter", () => {
    const src = fs.readFileSync(path.join("src", "notification", "win32.ts"), "utf8");
    expect(src).toContain("resolveNativeUiPath()");
    expect(src).toContain("-OpenCenter");
    expect(src).toContain("-StatePath");
    expect(src).toContain("-RegistryPath");
    expect(src).toContain("-CliPath");
    expect(src).toContain("-TrayStatePath");
  });

  it("resolveNativeUiPath resolves to real executable", () => {
    const exe = resolveNativeUiPath();
    expect(exe).not.toBeNull();
    expect(exe).toMatch(/AgentAttention\.UI\.exe$/);
    expect(fs.existsSync(exe!)).toBe(true);
  });
});
