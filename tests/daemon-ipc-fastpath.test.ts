import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { EventEmitter } from "events";
import { createDaemon } from "../src/daemon";
import { startPipeServer, stopPipeServer, emitNotification } from "../src/pipeline/ipc";

jest.mock("child_process", () => {
  const mockFn = jest.fn(() => {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: jest.fn(), end: jest.fn(), writable: false };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = jest.fn();
    proc.pid = 99000;
    return proc;
  });
  return { spawn: mockFn };
});

import { spawn } from "child_process";
const mockedSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe("ipc fast path (M6a)", () => {
  let tmpDir = "";
  let statePath = "";
  let trayStatePath = "";
  let cliPath = "";
  let uiExe = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attention-m6a-"));
    statePath = path.join(tmpDir, "state.json");
    trayStatePath = path.join(tmpDir, "tray-state.json");
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
    stopPipeServer();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = "";
  });

  function drainSubscribe(client: net.Socket): Promise<void> {
    return new Promise<void>((resolve) => {
      let consumed = 0;
      const handler = () => {
        consumed++;
        if (consumed >= 2) {
          client.removeListener("data", handler);
          resolve();
        }
      };
      client.on("data", handler);
      setTimeout(() => { client.removeListener("data", handler); resolve(); }, 2000);
    });
  }

  it("tray-state.json written on state change with IPC active", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));

    const daemon = createDaemon({
      statePath, trayStatePath, trayPidPath: path.join(tmpDir, "tray.pid"),
      cliPath, uiExecutablePath: uiExe, debug: false,
    });
    await new Promise(r => setTimeout(r, 500));

    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 2, events: [
        { id: "m6a-1", timestamp: Date.now(), type: "completed", priority: "P1",
          agent_id: "a", agent_name: "A", title: "T", message: "m6a", read: false },
      ],
    }));

    await new Promise(r => setTimeout(r, 600));

    expect(fs.existsSync(trayStatePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(trayStatePath, "utf8"));
    expect(data.events.length).toBe(1);
    expect(data.events[0].id).toBe("m6a-1");
    await daemon.stop();
  });

  it("emitNotification delivers state-changed within 50ms", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>(r => client.once("connect", r));
    client.write(JSON.stringify({ type: "subscribe" }) + "\n");
    await drainSubscribe(client);

    const t0 = Date.now();
    emitNotification(tmpDir, "state-changed", { file: "state", sha256: "fast" });

    const result = await new Promise<boolean>((resolve) => {
      let buf = "";
      const handler = (data: Buffer) => {
        buf += data.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          try {
            const msg = JSON.parse(line);
            if (msg.type === "state-changed") {
              client.removeListener("data", handler);
              resolve(true);
              return;
            }
          } catch {}
        }
      };
      client.on("data", handler);
      setTimeout(() => { client.removeListener("data", handler); resolve(false); }, 2000);
    });

    expect(result).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
    client.destroy();
    stopPipeServer();
  });

  it("stopPipeServer is safe to call after already stopped", () => {
    startPipeServer(tmpDir);
    stopPipeServer();
    expect(() => stopPipeServer()).not.toThrow();
  });

  it("state-changed notification delivers correct payload", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>(r => client.once("connect", r));
    client.write(JSON.stringify({ type: "subscribe" }) + "\n");
    await drainSubscribe(client);

    emitNotification(tmpDir, "state-changed", { file: "state", sha256: "xyz" });

    const result = await new Promise<any>((resolve) => {
      let buf = "";
      const handler = (data: Buffer) => {
        buf += data.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          try {
            const msg = JSON.parse(buf.slice(0, idx).trim());
            if (msg.type === "state-changed") {
              client.removeListener("data", handler);
              resolve(msg.payload);
              return;
            }
          } catch {}
        }
      };
      client.on("data", handler);
      setTimeout(() => { client.removeListener("data", handler); resolve(null); }, 2000);
    });

    expect(result).not.toBeNull();
    expect(result.sha256).toBe("xyz");
    expect(result.file).toBe("state");
    client.destroy();
    stopPipeServer();
  });

  it("IPC fast path: no stale tray-state.json after stop", async () => {
    const daemon = createDaemon({
      statePath, trayStatePath, trayPidPath: path.join(tmpDir, "tray.pid"),
      cliPath, uiExecutablePath: uiExe, debug: false,
    });
    await new Promise(r => setTimeout(r, 500));
    expect(fs.existsSync(trayStatePath)).toBe(true);
    await daemon.stop();
    expect(fs.existsSync(trayStatePath)).toBe(false);
  });
});
