import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_TTL_MS } from "./hosted";
import { exportsDir, publishExport, signatureValid, signedDownload } from "./exports";
import { startHttpMcp } from "./http";

describe("hosted exports", () => {
  const saved = { ...process.env };
  let http: Server;
  let base: string;
  let svgPath: string;

  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "plumb-exports-"));
    process.env.PLUMB_ASSETS_DIR = root;
    process.env.PLUMB_MCP_TOKEN = "tok-123";
    process.env.PLUMB_TRANSPORT = "http";
    svgPath = join(root, "icon.svg");
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    http = await startHttpMcp({ host: "127.0.0.1", port: 0, token: "tok-123" });
    const addr = http.address();
    if (typeof addr !== "object" || !addr) throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()));
    process.env = saved;
  });

  it("names a file by its content, once, however often it is exported", () => {
    const a = publishExport(svgPath, "SVG");
    const copy = join(process.env.PLUMB_ASSETS_DIR!, "icon-2.svg");
    writeFileSync(copy, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const b = publishExport(copy, "SVG");
    expect(b.file).toBe(a.file);
    expect(a.file).toMatch(/^[a-f0-9]{64}\.svg$/);
    expect(readdirSync(exportsDir())).toEqual([a.file]);
    expect(a.uri).toBe(`plumb://exports/${a.file}`);
  });

  it("signs downloads that expire and can't be altered", () => {
    const now = Date.now();
    const url = new URL(signedDownload("f.png", now).download, "http://x");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    expect(signatureValid("f.png", exp, sig, now)).toBe(true);
    expect(signatureValid("g.png", exp, sig, now)).toBe(false);
    expect(signatureValid("f.png", exp, `${sig!.slice(0, -1)}0`, now)).toBe(sig!.endsWith("0"));
    expect(signatureValid("f.png", exp, sig, now + EXPORT_TTL_MS + 60_000)).toBe(false);
  });

  it("serves /files with the bearer or a signed link, nothing else", async () => {
    const ref = publishExport(svgPath, "SVG");
    expect((await fetch(`${base}/files/${ref.file}`)).status).toBe(401);
    const signed = await fetch(`${base}${ref.download}`);
    expect(signed.status).toBe(200);
    expect(signed.headers.get("content-type")).toBe("image/svg+xml");
    expect(await signed.text()).toContain("<svg");
    const bearer = await fetch(`${base}/files/${ref.file}`, { headers: { Authorization: "Bearer tok-123" } });
    expect(bearer.status).toBe(200);
    const gone = await fetch(`${base}/files/${"0".repeat(64)}.png`, { headers: { Authorization: "Bearer tok-123" } });
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { nextAction: string }).nextAction).toMatch(/same file/);
    expect((await fetch(`${base}/files/..%2F..%2Fetc%2Fpasswd`, { headers: { Authorization: "Bearer tok-123" } })).status).toBe(404);
    expect((await fetch(`${base}//`)).status).toBe(400);
  });

  it("reads an export with resources/read", async () => {
    const ref = publishExport(svgPath, "SVG");
    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer tok-123" } },
      }),
    );
    const res = await client.readResource({ uri: ref.uri });
    await client.close();
    expect(res.contents[0]).toMatchObject({ mimeType: "image/svg+xml" });
    expect((res.contents[0] as { text: string }).text).toContain("<svg");
  });
});
