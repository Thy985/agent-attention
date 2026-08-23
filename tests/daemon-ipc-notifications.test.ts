import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as net from "net";
import {
  getUserToken, getPipePath, startPipeServer, stopPipeServer,
  emitNotification, watchRegistryForNotifications,
} from "../src/pipeline/ipc";

describe("ipc notifications (M5)", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-attention-m5-"));
  });

  afterEach(() => {
    stopPipeServer();
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
    tmpDir = "";
  });

  /**
   * Connect, subscribe, consume daemon-status + state responses, return socket.
   */
  function connectAndDrain(port: number): Promise<net.Socket | null> {
    return new Promise((resolve) => {
      const client = net.createConnection(port, "127.0.0.1");
      client.on("error", () => resolve(null));
      let consumed = 0;
      const totalExpected = 2; // daemon-status + state
      const handler = (data: Buffer) => {
        consumed += data.toString().split("\n").filter(Boolean).length;
        if (consumed >= totalExpected) {
          client.removeListener("data", handler);
          resolve(client);
        }
      };
      client.on("data", handler);
      client.once("connect", () => {
        client.write(JSON.stringify({ type: "subscribe" }) + "\n");
      });
      setTimeout(() => {
        client.removeListener("data", handler);
        client.destroy();
        resolve(null);
      }, 3000);
    });
  }

  /** Read the next line from a socket (buffers partial reads). */
  function readLine(socket: net.Socket): Promise<string | null> {
    return new Promise((resolve) => {
      let buf = "";
      const handler = (data: Buffer) => {
        buf += data.toString();
        const idx = buf.indexOf("\n");
        if (idx !== -1) {
          socket.removeListener("data", handler);
          resolve(buf.slice(0, idx));
        }
      };
      socket.on("data", handler);
      setTimeout(() => {
        socket.removeListener("data", handler);
        resolve(null);
      }, 2000);
    });
  }

  it("emitNotification broadcasts state-changed to the subscribed client", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    expect(fs.existsSync(portFile)).toBe(true);
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);
    expect(port).toBeGreaterThan(0);

    const client = await connectAndDrain(port);
    expect(client).not.toBeNull();

    const t0 = Date.now();
    emitNotification(tmpDir, "state-changed", { file: "state", sha256: "abc123" });
    const elapsed = Date.now() - t0;

    const line = await readLine(client!);
    expect(line).not.toBeNull();
    const msg = JSON.parse(line!);
    expect(msg.type).toBe("state-changed");
    expect(msg.payload.sha256).toBe("abc123");
    expect(elapsed).toBeLessThan(50); // M5 L3: notification ≤50ms
    client!.destroy();
  });

  it("emitNotification broadcasts registry-changed to the subscribed client", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    const client = await connectAndDrain(port);
    expect(client).not.toBeNull();

    emitNotification(tmpDir, "registry-changed", { file: "agents", sha256: "def456" });

    const line = await readLine(client!);
    expect(line).not.toBeNull();
    const msg = JSON.parse(line!);
    expect(msg.type).toBe("registry-changed");
    expect(msg.payload.sha256).toBe("def456");
    client!.destroy();
  });

  it("subscribe response includes daemon-status:alive then state", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    const client = net.createConnection(port, "127.0.0.1");
    await new Promise<void>(r => client.once("connect", r));
    client.write(JSON.stringify({ type: "subscribe" }) + "\n");

    // Collect all lines until we have both daemon-status and state
    const messages: any[] = [];
    await new Promise<void>(resolve => {
      let buf = "";
      const handler = (data: Buffer) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try { messages.push(JSON.parse(line)); } catch {}
        }
        if (messages.length >= 2) {
          client.removeListener("data", handler);
          resolve();
        }
      };
      client.on("data", handler);
      setTimeout(() => {
        client.removeListener("data", handler);
        resolve();
      }, 2000);
    });

    // First should be daemon-status:alive
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].type).toBe("daemon-status");
    expect(messages[0].payload.status).toBe("alive");
    expect(typeof messages[0].payload.pid).toBe("number");
    // Second should be state
    expect(messages[1].type).toBe("state");

    client.destroy();
  });

  it("emitNotification is safe when no server started", () => {
    expect(() => emitNotification(tmpDir, "state-changed", {})).not.toThrow();
    expect(() => emitNotification(tmpDir, "registry-changed", {})).not.toThrow();
    expect(() => emitNotification(tmpDir, "daemon-status", {})).not.toThrow();
  });

  it("watchRegistryForNotifications detects agents.json change", async () => {
    startPipeServer(tmpDir);
    await new Promise(r => setTimeout(r, 300));
    const portFile = path.join(tmpDir, "ipc-port.txt");
    const port = parseInt(fs.readFileSync(portFile, "utf8").trim(), 10);

    fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({ version: 1, agents: [] }));
    watchRegistryForNotifications(tmpDir);

    const client = await connectAndDrain(port);
    expect(client).not.toBeNull();

    // Change agents.json — watcher polls every 1s
    fs.writeFileSync(path.join(tmpDir, "agents.json"), JSON.stringify({ version: 2, agents: [{ agent_id: "x" }] }));

    const line = await readLine(client!);
    expect(line).not.toBeNull();
    const msg = JSON.parse(line!);
    expect(msg.type).toBe("registry-changed");
    expect(msg.payload.file).toBe("agents");
    client!.destroy();
  });

  it("getUserToken and getPipePath still work correctly", () => {
    const token = getUserToken();
    expect(token).toBeTruthy();
    expect(token).not.toContain("\\");
    const pipePath = getPipePath();
    expect(pipePath).toMatch(/^\\\\\.\\pipe\\agent-attention-/);
  });
});
