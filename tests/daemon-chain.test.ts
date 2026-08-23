import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { createDaemon } from "../src/daemon";

jest.mock("child_process", () => {
  const mockFn = jest.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: jest.fn(), end: jest.fn(), writable: false };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    proc.pid = 88000;
    return proc;
  });
  return { spawn: mockFn };
});

import { spawn } from "child_process";
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe("daemon full chain (M4)", () => {
  let tmpDir = "";
  let statePath = "";
  let trayStatePath = "";
  let trayPidPath = "";
  let cliPath = "";
  let uiExe = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attention-m4-"));
    statePath = path.join(tmpDir, "state.json");
    trayStatePath = path.join(tmpDir, "tray-state.json");
    trayPidPath = path.join(tmpDir, "tray.pid");
    cliPath = path.join(tmpDir, "daemon-cli.js");
    uiExe = path.join(tmpDir, "AgentAttention.UI.exe");
    fs.writeFileSync(uiExe, "");
    fs.writeFileSync(cliPath, "module.exports={};");
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 0, events: [],
    }));
    mockedSpawn.mockClear();
  });

  afterEach(async () => {
    mockedSpawn.mockClear();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = "";
  });

  async function startDaemon(opts?: Partial<import("../src/daemon").DaemonOptions>) {
    const daemon = createDaemon({
      statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",
      trayStatePath, trayPidPath, cliPath,
      uiExecutablePath: uiExe, debug: false,
      ...opts,
    });
    await new Promise(r => setTimeout(r, 600));
    return daemon;
  }

  it("spawns native UI and writes initial tray-state on startup", async () => {
    const daemon = await startDaemon();
    expect(mockedSpawn).toHaveBeenCalledWith(
      uiExe,
      expect.arrayContaining(["-StatePath", statePath, "-TrayStatePath", trayStatePath]),
      expect.any(Object),
    );
    expect(fs.existsSync(trayStatePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(trayStatePath, "utf8"));
    expect(state.unreadCount).toBe(0);
    await daemon.stop();
  });

  it("pushes state to tray-state.json on state.json change", async () => {
    const daemon = await startDaemon();
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 3, events: [
        { id: "chain-1", timestamp: Date.now(), type: "input_required", priority: "P0",
          agent_id: "codex", agent_name: "Codex", title: "Chain", message: "m4", read: false },
      ],
    }));
    await new Promise(r => setTimeout(r, 600));
    expect(fs.existsSync(trayStatePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(trayStatePath, "utf8"));
    expect(content.events.length).toBe(1);
    expect(content.events[0].id).toBe("chain-1");
    await daemon.stop();
  });

  it("clears tray-state.json and stops cleanly", async () => {
    const daemon = await startDaemon();
    expect(fs.existsSync(trayStatePath)).toBe(true);
    await daemon.stop();
    expect(fs.existsSync(trayStatePath)).toBe(false);
  });

  it("writes tray.pid and reads it back correctly", async () => {
    const daemon = await startDaemon();
    expect(fs.existsSync(trayPidPath)).toBe(true);
    const pid = parseInt(fs.readFileSync(trayPidPath, "utf8").trim(), 10);
    expect(pid).toBeGreaterThan(0);
    await daemon.stop();
  });

  it("spawn args contain correct CLI state paths", async () => {
    const daemon = await startDaemon();
    const callArgs = mockedSpawn.mock.calls[0];
    expect(callArgs[0]).toBe(uiExe);
    expect(callArgs[1]).toContain("-StatePath");
    expect(callArgs[1]).toContain(statePath);
    expect(callArgs[1]).toContain("-CliPath");
    expect(callArgs[1]).toContain(cliPath);
    expect(callArgs[1]).toContain("-TrayStatePath");
    expect(callArgs[1]).toContain(trayStatePath);
    expect(callArgs[1]).toContain("-TrayPidPath");
    expect(callArgs[1]).toContain(trayPidPath);
    await daemon.stop();
  });

  it("falls back to PowerShell when uiExecutablePath is undefined", async () => {
    const daemon = createDaemon({
      statePath, powerShellPath: "powershell", trayScriptPath: "TrayIcon.ps1",
      trayStatePath, trayPidPath, cliPath, debug: false,
    });
    await new Promise(r => setTimeout(r, 300));
    expect(mockedSpawn).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-File", "TrayIcon.ps1"]),
      expect.any(Object),
    );
    await daemon.stop();
  });
});
