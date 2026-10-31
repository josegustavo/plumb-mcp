import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAssets } from "./assets";

describe("writeAssets", () => {
  const saved = process.env.PLUMB_ASSETS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.PLUMB_ASSETS_DIR;
    else process.env.PLUMB_ASSETS_DIR = saved;
  });

  it("never overwrites an export from an earlier call with the same layer name", () => {
    const root = mkdtempSync(join(tmpdir(), "plumb-assets-test-"));
    process.env.PLUMB_ASSETS_DIR = root;
    const upload = (body: string) => {
      const p = join(mkdtempSync(join(tmpdir(), "plumb-upload-")), "tmp.svg");
      writeFileSync(p, body);
      return p;
    };

    const first = writeAssets("specific", [{ id: "1:1", name: "group", format: "SVG", path: upload("<svg>a</svg>") }]);
    const second = writeAssets("specific", [{ id: "2:2", name: "group", format: "SVG", path: upload("<svg>b</svg>") }]);

    expect(first.written[0]!.path).toBe(join(root, "specific", "group.svg"));
    expect(second.written[0]!.path).toBe(join(root, "specific", "group-2.svg"));
    expect(readFileSync(first.written[0]!.path, "utf8")).toBe("<svg>a</svg>");
  });
});
