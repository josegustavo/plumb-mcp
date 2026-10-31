import { mkdirSync, mkdtempSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXPORT_TTL_MS, sweepExports } from "./hosted";
import { requireToken } from "./tools/shared";

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

  it("refuses REST file reads but keeps comments/versions", () => {
    process.env.PLUMB_TRANSPORT = "http";
    process.env.FIGMA_TOKEN = "figd_test";
    expect(() => requireToken()).toThrow(/plugin only/);
    expect(requireToken(true)).toBe("figd_test");
  });
});
