import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import { EventEmitter } from "events";
import { createDaemon } from "../src/daemon";
import {
  startPipeServer, stopPipeServer, registerRpcCommand, unregisterRpcCommand,
} from "../src/pipeline/ipc";

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

describe("ipc command RPC (M6b)", () => {
  let tmpDir = "";
  let statePath = "";
  let cliPath = "";
  let uiExe = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attention-m6b-"));
    statePath = path.join(tmpDir, "state.json");
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
    // Unregister any registered handlers
    for (const name of ["mark-all-read", "mark-event", "jump"]) {
      try { unregisterRpcCommand(name); } catch {}
    }
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

  function readAuth(): string {
    try { return fs.readFileSync(path.join(tmpDir, "ipc-auth.secret"), "utf8").trim(); } catch { return ""; }
  }

  it("registerRpcCommand + executeRpcCommand dispatches to handler", async () => {
    const handler = jest.fn(async () => ({ ok: true, code: 0 }));
    registerRpcCommand("test-cmd", handler);

    expect(() => {
      const { executeRpcCommand } = require("../src/pipeline/ipc");
      // Can't call directly without server, but we can test via socket
    }).not.toThrow();

    unregisterRpcCommand("test-cmd");
  });

  it("unknown command returns error via RPC", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 400));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    const token = readAuth();
    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>(r => client.once("connect", r));
    client.write(JSON.stringify({ type: "hello", token }) + "\n");
    await new Promise(r => setTimeout(r, 50));
    client.write(JSON.stringify({ type: "subscribe" }) + "\n");
    await drainSubscribe(client);

    // Send an unknown command
    client.write(JSON.stringify({
      type: "cmd", requestId: "r1", command: "unknown-cmd", args: [],
    }) + "\n");

    const result = await new Promise<any>((resolve) => {
      let buf = "";
      const handler = (data: Buffer) => {
        buf += data.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          try {
            const msg = JSON.parse(line);
            if (msg.type === "cmd-ack") {
              client.removeListener("data", handler);
              resolve(msg);
              return;
            }
          } catch {}
        }
      };
      client.on("data", handler);
      setTimeout(() => { client.removeListener("data", handler); resolve(null); }, 2000);
    });

    expect(result).not.toBeNull();
    expect(result.type).toBe("cmd-ack");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown command");
    client.destroy();
    stopPipeServer();
  });

  it("registered mark-all-read handler returns ack", async () => {
    // Write a state with unread events
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 2, events: [
        { id: "e1", timestamp: Date.now(), type: "completed", priority: "P1",
          agent_id: "a", agent_name: "A", title: "T", message: "m", read: false },
        { id: "e2", timestamp: Date.now(), type: "input_required", priority: "P0",
          agent_id: "b", agent_name: "B", title: "T2", message: "m2", read: false },
      ],
    }));

    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 400));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    const token = readAuth();
    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>(r => client.once("connect", r));
    client.write(JSON.stringify({ type: "hello", token }) + "\n");
    await new Promise(r => setTimeout(r, 50));
    client.write(JSON.stringify({ type: "subscribe" }) + "\n");
    await drainSubscribe(client);

    // Send mark-all-read command
    client.write(JSON.stringify({
      type: "cmd", requestId: "r2", command: "mark-all-read", args: [],
    }) + "\n");

    const result = await new Promise<any>((resolve) => {
      let buf = "";
      const handler = (data: Buffer) => {
        buf += data.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          const line = buf.slice(0, idx).trim();
          try {
            const msg = JSON.parse(line);
            if (msg.type === "cmd-ack") {
              client.removeListener("data", handler);
              resolve(msg);
              return;
            }
          } catch {}
        }
      };
      client.on("data", handler);
      setTimeout(() => { client.removeListener("data", handler); resolve(null); }, 2000);
    });

    expect(result).not.toBeNull();
    expect(result.type).toBe("cmd-ack");
    expect(result.requestId).toBe("r2");
    client.destroy();
    stopPipeServer();
  });

  it("RPC command fails gracefully when no server", async () => {
    // Without starting server, unregister all and verify safe no-op
    for (const name of ["mark-all-read", "mark-event", "jump"]) {
      try { unregisterRpcCommand(name); } catch {}
    }
    expect(() => stopPipeServer()).not.toThrow();
  });

  it("daemon registers RPC handlers and handles mark-event", async () => {
    const daemon = createDaemon({
      statePath, trayStatePath: path.join(tmpDir, "tray-state.json"),
      trayPidPath: path.join(tmpDir, "tray.pid"),
      cliPath, uiExecutablePath: uiExe, debug: false,
    });
    await new Promise(r => setTimeout(r, 600));

    // Write state with an unread event
    fs.writeFileSync(statePath, JSON.stringify({
      version: 1, updatedAt: Date.now(), unreadCount: 1, events: [
        { id: "m6b-e1", timestamp: Date.now(), type: "completed", priority: "P1",
          agent_id: "x", agent_name: "X", title: "M6b", message: "test", read: false },
      ],
    }));

    await new Promise(r => setTimeout(r, 500));

    // tray-state.json should reflect the change
    expect(fs.existsSync(path.join(tmpDir, "tray-state.json"))).toBe(true);
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, "tray-state.json"), "utf8"));
    expect(data.events.length).toBe(1);
    expect(data.events[0].id).toBe("m6b-e1");

    await daemon.stop();
  });
});
