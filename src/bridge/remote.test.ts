import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bridge } from "./store";
import { healthReport, requestAssets, requestScreenshot, startBridge, stopBridge } from "./server";

/**
 * Central-server mode: a bridge reachable beyond loopback is keyed with
 * PLUMB_PAIR_SECRET, can pin the Figma files it serves, hands out an upload
 * token, drops silent sockets, and keeps Studio off.
 */

const ENV_KEYS = ["PLUMB_BRIDGE_PORTS", "PLUMB_PAIR_SECRET", "PLUMB_ALLOWED_FILES", "PLUMB_HEARTBEAT_MS"] as const;
const saved: Record<string, string | undefined> = {};

function open(port: number): Promise<{ ws: WebSocket; next: () => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue: any[] = [];
    const waiters: Array<(m: any) => void> = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      const w = waiters.shift();
      if (w) w(msg);
      else queue.push(msg);
    });
    const next = () =>
      new Promise<any>((r) => {
        const m = queue.shift();
        if (m !== undefined) r(m);
        else waiters.push(r);
      });
    ws.once("error", reject);
    ws.once("open", () => resolve({ ws, next }));
  });
}

async function nextOfType(next: () => Promise<any>, t: string): Promise<any> {
  for (;;) {
    const m = await next();
    if (m.t === t || (t === "pair-result" && (m.t === "paired" || m.t === "pair-rejected"))) return m;
  }
}

const closed = (ws: WebSocket) => new Promise<void>((r) => (ws.readyState === ws.CLOSED ? r() : ws.once("close", () => r())));

/** The client sees the close before the server's close handler resets the slot. */
async function unpaired(): Promise<boolean> {
  for (let i = 0; i < 50 && bridge.paired; i++) await new Promise((r) => setTimeout(r, 20));
  return !bridge.paired;
}

describe("keyed bridge (PLUMB_PAIR_SECRET)", () => {
  let port: number;

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.PLUMB_BRIDGE_PORTS = "0";
    process.env.PLUMB_PAIR_SECRET = "s3cret-key";
    process.env.PLUMB_ALLOWED_FILES = "Website Design";
    process.env.PLUMB_HEARTBEAT_MS = "60";
    await startBridge();
    if (!bridge.port) throw new Error("bridge failed to bind");
    port = bridge.port;
  });

  afterAll(async () => {
    await stopBridge();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  let sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets) ws.terminate();
    await Promise.all(sockets.map(closed));
    sockets = [];
    await new Promise((r) => setTimeout(r, 20));
  });

  async function client() {
    const c = await open(port);
    sockets.push(c.ws);
    expect((await c.next()).t).toBe("plumb-hello");
    return c;
  }

  it("rejects a wrong key and closes the socket", async () => {
    const { ws, next } = await client();
    ws.send(JSON.stringify({ t: "pair", pluginVersion: "test", secret: "nope" }));
    const reply = await nextOfType(next, "pair-result");
    expect(reply).toEqual({ t: "pair-rejected", reason: "Wrong pairing key." });
    await closed(ws);
    expect(bridge.paired).toBe(false);
  });

  it("rejects a file that is not on the allow-list", async () => {
    const { ws, next } = await client();
    ws.send(JSON.stringify({ t: "pair", pluginVersion: "test", secret: "s3cret-key", fileName: "Other file" }));
    const reply = await nextOfType(next, "pair-result");
    expect(reply.t).toBe("pair-rejected");
    expect(reply.reason).toContain("Other file");
  });

  it("pairs with the right key, labels the machine, and gates uploads with the token", async () => {
    const { ws, next } = await client();
    ws.send(
      JSON.stringify({ t: "pair", pluginVersion: "test", secret: "s3cret-key", machine: "Office PC", fileName: "Website Design" }),
    );
    const reply = await nextOfType(next, "pair-result");
    expect(reply.t).toBe("paired");
    expect(typeof reply.uploadToken).toBe("string");
    expect(healthReport()).toMatchObject({ paired: true, machine: "Office PC", keyed: true });

    const base = `http://127.0.0.1:${port}/upload/r9999.png`;
    expect((await fetch(base, { method: "POST", body: "x" })).status).toBe(401);
    expect((await fetch(`${base}?k=wrong`, { method: "POST", body: "x" })).status).toBe(401);
    // Right token, but no request r9999 in flight: nothing to stage.
    expect((await fetch(`${base}?k=${reply.uploadToken}`, { method: "POST", body: "x" })).status).toBe(409);
    const shot = requestScreenshot("1:2");
    const sreq = await nextOfType(next, "get-screenshot");
    const up = await fetch(`http://127.0.0.1:${port}/upload/${sreq.reqId}.png?k=${reply.uploadToken}`, { method: "POST", body: "x" });
    expect(up.status).toBe(200);
    ws.send(JSON.stringify({ t: "screenshot", reqId: sreq.reqId, format: "PNG", nodeName: "n", error: null }));
    expect((await shot).path).toBeTruthy();

    // A second plugin can't take the slot while this one is paired.
    const other = await client();
    other.ws.send(JSON.stringify({ t: "pair", pluginVersion: "test", secret: "s3cret-key" }));
    const second = await nextOfType(other.next, "pair-result");
    expect(second.t).toBe("pair-rejected");
    expect(second.reason).toContain("Office PC");
  });

  it("drops an inventory for a file that is not allowed", async () => {
    const { ws, next } = await client();
    ws.send(JSON.stringify({ t: "pair", pluginVersion: "test", secret: "s3cret-key" }));
    expect((await nextOfType(next, "pair-result")).t).toBe("paired");
    ws.send(JSON.stringify({ t: "inventory", fileName: "Someone else's file", pages: [] }));
    expect((await nextOfType(next, "pair-rejected")).reason).toContain("Someone else's file");
    await closed(ws);
    expect(await unpaired()).toBe(true);
  });

  it("never trusts a file path or format the plugin sends back", async () => {
    const { ws, next } = await client();
    ws.send(JSON.stringify({ t: "pair", pluginVersion: "test", secret: "s3cret-key" }));
    expect((await nextOfType(next, "pair-result")).t).toBe("paired");

    const assets = requestAssets({ nodeId: "1:2" });
    const areq = await nextOfType(next, "get-assets");
    ws.send(
      JSON.stringify({ t: "assets", reqId: areq.reqId, assets: [{ id: "1:3", name: "x", format: "png/../../../cwd/PWNED", path: "/etc/passwd" }], error: null }),
    );
    const got = (await assets).assets[0]!;
    expect(got.path).toBeNull();
    expect(got.format).toBe("PNG");

    const shot = requestScreenshot("1:2");
    const sreq = await nextOfType(next, "get-screenshot");
    ws.send(JSON.stringify({ t: "screenshot", reqId: sreq.reqId, format: "x/../../../evil", nodeName: "n", error: null }));
    expect((await shot).format).toBe("PNG");
  });

  it("drops a paired socket that stops answering pings, but never one that never answered", async () => {
    // Answers the first ping, then goes silent → terminated after ~3 intervals.
    const quiet = await client();
    quiet.ws.send(JSON.stringify({ t: "pair", pluginVersion: "test", secret: "s3cret-key" }));
    expect((await nextOfType(quiet.next, "pair-result")).t).toBe("paired");
    await nextOfType(quiet.next, "ping");
    quiet.ws.send(JSON.stringify({ t: "pong" }));
    await closed(quiet.ws);

    // Never answers (an old plugin without pong) → still connected after many intervals.
    const old = await client();
    await new Promise((r) => setTimeout(r, 400));
    expect(old.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps Studio off on a keyed bridge", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
  });
});
