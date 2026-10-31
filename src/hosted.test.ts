import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXPORT_TTL_MS, HOSTED_TOOLS, sweepExports, toolAllowlist } from "./hosted";
import { checkRestScope, requireToken, restFileKey } from "./tools/shared";

describe("hosted mode", () => {
  const saved = { transport: process.env.PLUMB_TRANSPORT, token: process.env.FIGMA_TOKEN };
  afterEach(() => {
    if (saved.transport === undefined) delete process.env.PLUMB_TRANSPORT;
    else process.env.PLUMB_TRANSPORT = saved.transport;
    if (saved.token === undefined) delete process.env.FIGMA_TOKEN;
    else process.env.FIGMA_TOKEN = saved.token;
  });

  it("sweeps exports older than the TTL and keeps fresh ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "plumb-sweep-"));
    mkdirSync(join(dir, "specific"));
    const old = join(dir, "specific", "old.png");
    const fresh = join(dir, "fresh.png");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const past = (Date.now() - EXPORT_TTL_MS - 60_000) / 1000;
    utimesSync(old, past, past);

    expect(sweepExports([dir, join(dir, "missing")])).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("never offers unsafe tools on a hosted server unless told twice", () => {
    const hosted = { PLUMB_TRANSPORT: "http" } as NodeJS.ProcessEnv;
    expect(toolAllowlist({ ...hosted, PLUMB_TOOLS: "all" })).toEqual(new Set(HOSTED_TOOLS));
    expect(toolAllowlist({ ...hosted, PLUMB_TOOLS: "plumb_node,plumb_import_web" })).toEqual(new Set(["plumb_node"]));
    expect(toolAllowlist({ ...hosted, PLUMB_TOOLS: "all", PLUMB_UNSAFE_TOOLS: "1" })).toBeNull();
    expect(toolAllowlist({ PLUMB_TOOLS: "plumb_import_web" } as NodeJS.ProcessEnv)).toEqual(new Set(["plumb_import_web"]));
  });

  it("keeps REST reads inside the pinned file and team", () => {
    process.env.PLUMB_TRANSPORT = "http";
    process.env.PLUMB_FILE_KEY = "AbC123";
    try {
      expect(restFileKey({})).toBe("AbC123");
      expect(() => restFileKey({ fileKey: "Other99" })).toThrow(/configured Figma file/);
      expect(() => checkRestScope("project", "../meta")).toThrow(/Invalid Figma project id/);
    } finally {
      delete process.env.PLUMB_FILE_KEY;
    }
  });

  it("refuses REST file reads but keeps comments/versions", () => {
    process.env.PLUMB_TRANSPORT = "http";
    process.env.FIGMA_TOKEN = "figd_test";
    expect(() => requireToken()).toThrow(/plugin only/);
    expect(requireToken(true)).toBe("figd_test");
  });
});
