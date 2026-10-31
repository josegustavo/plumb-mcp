import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSTED_TOOLS } from "./hosted";
import { startHttpMcp } from "./http";

describe("plumb-mcp serve (MCP over HTTP)", () => {
  let http: Server;
  let url: URL;
  const savedTransport = process.env.PLUMB_TRANSPORT;
  const savedTools = process.env.PLUMB_TOOLS;

  beforeAll(async () => {
    process.env.PLUMB_TRANSPORT = "http";
    delete process.env.PLUMB_TOOLS;
    http = await startHttpMcp({ host: "127.0.0.1", port: 0, token: "tok-123" });
    const addr = http.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    url = new URL(`http://127.0.0.1:${addr.port}/mcp`);
  });

  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    if (savedTransport === undefined) delete process.env.PLUMB_TRANSPORT;
    else process.env.PLUMB_TRANSPORT = savedTransport;
    if (savedTools === undefined) delete process.env.PLUMB_TOOLS;
    else process.env.PLUMB_TOOLS = savedTools;
  });

  async function listTools(): Promise<string[]> {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: "Bearer tok-123" } } }),
    );
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name).sort();
  }

  it("refuses requests without the bearer token", async () => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
  });

  it("serves only the read-only hosted toolset by default", async () => {
    expect(await listTools()).toEqual([...HOSTED_TOOLS].sort());
  });

  it("honours an explicit PLUMB_TOOLS list", async () => {
    process.env.PLUMB_TOOLS = "plumb_status,plumb_node";
    try {
      expect(await listTools()).toEqual(["plumb_node", "plumb_status"]);
    } finally {
      delete process.env.PLUMB_TOOLS;
    }
  });

  it("answers health without auth", async () => {
    const res = await fetch(new URL("/health", url));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("will not bind beyond loopback without a token", async () => {
    await expect(startHttpMcp({ host: "0.0.0.0", port: 0 })).rejects.toThrow(/PLUMB_MCP_TOKEN/);
  });
});
