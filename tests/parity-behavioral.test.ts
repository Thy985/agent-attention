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
    proc.pid = 77000;
    return proc;
  });
  return { spawn: mockFn };
});

import { spawn } from "child_process";
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe("behavioral parity ps1 vs csharp (M4)", () => {
  let tmpDirPs = "";
  let tmpDirCs = "";
  let cliPathPs = "";
  let cliPathCs = "";

  beforeEach(() => {
    tmpDirPs = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attention-ps-"));
    tmpDirCs = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attention-cs-"));
    cliPathPs = path.join(tmpDirPs, "daemon-cli.js");
    cliPathCs = path.join(tmpDirCs, "daemon-cli.js");
    fs.writeFileSync(cliPathPs, "module.exports={};");
    fs.writeFileSync(cliPathCs, "module.exports={};");
    // Pre-create identical state.json in both
    const init = JSON.stringify({ version: 1, updatedAt: Date.now(), unreadCount: 0, events: [] });
    fs.writeFileSync(path.join(tmpDirPs, "state.json"), init);
    fs.writeFileSync(path.join(tmpDirCs, "state.json"), init);
    mockedSpawn.mockClear();
  });

  afterEach(async () => {
    mockedSpawn.mockClear();
    for (const d of [tmpDirPs, tmpDirCs]) {
      if (d) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
      }
    }
    tmpDirPs = "";
    tmpDirCs = "";
  });

  it("ps1 path spawns powershell and writes tray-state with schema", async () => {
    const daemon = createDaemon({
      statePath: path.join(tmpDirPs, "state.json"),
      powerShellPath: "powershell",
      trayScriptPath: "TrayIcon.ps1",
      trayStatePath: path.join(tmpDirPs, "tray-state.json"),
      trayPidPath: path.join(tmpDirPs, "tray.pid"),
      cliPath: cliPathPs,
      debug: false,
    });
    await new Promise(r => setTimeout(r, 500));
    expect(mockedSpawn).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-File", "TrayIcon.ps1"]),
      expect.any(Object),
    );
    expect(fs.existsSync(path.join(tmpDirPs, "tray-state.json"))).toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDirPs, "tray-state.json"), "utf8"));
    expect(data).toHaveProperty("unreadCount");
    expect(data).toHaveProperty("events");
    expect(Array.isArray(data.events)).toBe(true);
    await daemon.stop();
  });

  it("csharp path spawns native UI and writes tray-state with schema", async () => {
    const uiExe = path.join(tmpDirCs, "AgentAttention.UI.exe");
    fs.writeFileSync(uiExe, "");
    const daemon = createDaemon({
      statePath: path.join(tmpDirCs, "state.json"),
      powerShellPath: "powershell",
      trayScriptPath: "TrayIcon.ps1",
      trayStatePath: path.join(tmpDirCs, "tray-state.json"),
      trayPidPath: path.join(tmpDirCs, "tray.pid"),
      cliPath: cliPathCs,
      uiExecutablePath: uiExe,
      debug: false,
    });
    await new Promise(r => setTimeout(r, 500));
    expect(mockedSpawn).toHaveBeenCalledWith(
      uiExe,
      expect.arrayContaining(["-StatePath", path.join(tmpDirCs, "state.json")]),
      expect.any(Object),
    );
    expect(fs.existsSync(path.join(tmpDirCs, "tray-state.json"))).toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDirCs, "tray-state.json"), "utf8"));
    expect(data).toHaveProperty("unreadCount");
    expect(data).toHaveProperty("events");
    expect(Array.isArray(data.events)).toBe(true);
    await daemon.stop();
  });

  it("both paths produce identical tray-state content for same input", async () => {
    const update = JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 1, events: [
        { id: "same-id", timestamp: Date.now(), type: "input_required", priority: "P0",
          agent_id: "x", agent_name: "X", title: "Same", message: "hello", read: false },
      ],
    });
    fs.writeFileSync(path.join(tmpDirPs, "state.json"), update);
    fs.writeFileSync(path.join(tmpDirCs, "state.json"), update);

    const psDaemon = createDaemon({
      statePath: path.join(tmpDirPs, "state.json"),
      powerShellPath: "powershell",
      trayScriptPath: "TrayIcon.ps1",
      trayStatePath: path.join(tmpDirPs, "tray-state.json"),
      trayPidPath: path.join(tmpDirPs, "tray.pid"),
      cliPath: cliPathPs,
      debug: false,
    });
    const csDaemon = createDaemon({
      statePath: path.join(tmpDirCs, "state.json"),
      powerShellPath: "powershell",
      trayScriptPath: "TrayIcon.ps1",
      trayStatePath: path.join(tmpDirCs, "tray-state.json"),
      trayPidPath: path.join(tmpDirCs, "tray.pid"),
      cliPath: cliPathCs,
      uiExecutablePath: path.join(tmpDirCs, "AgentAttention.UI.exe"),
      debug: false,
    });
    await new Promise(r => setTimeout(r, 700));

    const psData = JSON.parse(fs.readFileSync(path.join(tmpDirPs, "tray-state.json"), "utf8"));
    const csData = JSON.parse(fs.readFileSync(path.join(tmpDirCs, "tray-state.json"), "utf8"));

    expect(psData.events.length).toBe(csData.events.length);
    expect(psData.events[0].id).toBe(csData.events[0].id);
    expect(psData.unreadCount).toBe(csData.unreadCount);

    await psDaemon.stop();
    await csDaemon.stop();
  });

  it("both paths clear pid file on stop", async () => {
    const psDaemon = createDaemon({
      statePath: path.join(tmpDirPs, "state.json"),
      powerShellPath: "powershell",
      trayScriptPath: "TrayIcon.ps1",
      trayStatePath: path.join(tmpDirPs, "tray-state.json"),
      trayPidPath: path.join(tmpDirPs, "tray.pid"),
      cliPath: cliPathPs,
      debug: false,
    });
    const csDaemon = createDaemon({
      statePath: path.join(tmpDirCs, "state.json"),
      powerShellPath: "powershell",
      trayScriptPath: "TrayIcon.ps1",
      trayStatePath: path.join(tmpDirCs, "tray-state.json"),
      trayPidPath: path.join(tmpDirCs, "tray.pid"),
      cliPath: cliPathCs,
      uiExecutablePath: path.join(tmpDirCs, "AgentAttention.UI.exe"),
      debug: false,
    });
    await new Promise(r => setTimeout(r, 500));

    await psDaemon.stop();
    await csDaemon.stop();

    expect(fs.existsSync(path.join(tmpDirPs, "tray.pid"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDirCs, "tray.pid"))).toBe(false);
  });
});
