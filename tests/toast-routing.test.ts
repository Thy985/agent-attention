import * as fs from "fs";
import * as path from "path";
import { getUiMode, resolveNativeUiPath } from "../src/ui-host";

describe("toast routing (M4)", () => {
  const previousMode = process.env.AGENT_ATTENTION_UI;
  const previousExe = process.env.AGENT_ATTENTION_UI_EXE;

  afterEach(() => {
    if (previousMode === undefined) delete process.env.AGENT_ATTENTION_UI;
    else process.env.AGENT_ATTENTION_UI = previousMode;
    if (previousExe === undefined) delete process.env.AGENT_ATTENTION_UI_EXE;
    else process.env.AGENT_ATTENTION_UI_EXE = previousExe;
  });

  it("csharp mode triggers native UI path in win32.ts source", () => {
    const src = fs.readFileSync(path.join("src", "notification", "win32.ts"), "utf8");
    expect(src).toContain("getUiMode() === 'csharp'");
    expect(src).toContain("resolveNativeUiPath()");
    expect(src).toContain("-OpenCenter");
  });

  it("ps mode triggers powershell path in win32.ts source", () => {
    const src = fs.readFileSync(path.join("src", "notification", "win32.ts"), "utf8");
    expect(src).toContain("powershell");
    expect(src).toContain("CenterWindow.ps1");
  });

  it("csharp mode resolves to native exe when available", () => {
    process.env.AGENT_ATTENTION_UI = "csharp";
    expect(getUiMode()).toBe("csharp");
    const exe = resolveNativeUiPath();
    expect(exe).not.toBeNull();
    expect(exe).toMatch(/AgentAttention\.UI\.exe$/);
    expect(fs.existsSync(exe!)).toBe(true);
  });

  it("AGENT_ATTENTION_UI=ps selects PowerShell host", () => {
    process.env.AGENT_ATTENTION_UI = "ps";
    expect(getUiMode()).toBe("ps");
  });

  it("default mode is csharp (M7) when env not set", () => {
    delete process.env.AGENT_ATTENTION_UI;
    expect(getUiMode()).toBe("csharp");
  });

  it("win32.ts spawn args include -StatePath and -RegistryPath for csharp", () => {
    const src = fs.readFileSync(path.join("src", "notification", "win32.ts"), "utf8");
    expect(src).toContain("-StatePath");
    expect(src).toContain("-RegistryPath");
    expect(src).toContain("-CliPath");
    expect(src).toContain("-TrayStatePath");
  });

  it("win32.ts spawn args include powershell flags for ps mode", () => {
    const src = fs.readFileSync(path.join("src", "notification", "win32.ts"), "utf8");
    expect(src).toContain("-NoProfile");
    expect(src).toContain("-ExecutionPolicy");
    expect(src).toContain("-File");
  });
});
