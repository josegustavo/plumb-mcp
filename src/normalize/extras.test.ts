import { describe, expect, it } from "vitest";
import type { FigmaFileResult, FigmaNode } from "../figma/types";
import type { PdsNode } from "../pds";
import { normalize } from "./normalize";

const box = (w: number, h: number) => ({ x: 0, y: 0, width: w, height: h });

function fixture(): FigmaFileResult {
  const link: FigmaNode = {
    id: "10",
    name: "Read more link",
    type: "TEXT",
    absoluteBoundingBox: box(200, 20),
    characters: "Read more",
    style: {
      fontSize: 16,
      fontWeight: 400,
      fontFamily: "Poppins",
      italic: true,
      textAlignVertical: "CENTER",
      hyperlink: { type: "URL", url: "https://example.com/more" },
    },
  };
  const bullets: FigmaNode = {
    id: "11",
    name: "Benefits list",
    type: "TEXT",
    absoluteBoundingBox: box(300, 60),
    characters: "Title\nOne\nTwo",
    lineTypes: ["NONE", "UNORDERED", "UNORDERED"],
    style: { fontSize: 14, paragraphSpacing: 8, textTruncation: "ENDING", maxLines: 3 },
  };
  const cell: FigmaNode = {
    id: "12",
    name: "Wide card",
    type: "FRAME",
    absoluteBoundingBox: box(400, 100),
    gridColumnAnchorIndex: 1,
    gridRowAnchorIndex: 0,
    gridColumnSpan: 2,
    gridRowSpan: 1,
  };
  const grid: FigmaNode = {
    id: "13",
    name: "Card grid",
    type: "FRAME",
    absoluteBoundingBox: box(600, 100),
    layoutMode: "GRID",
    gridColumnCount: 3,
    gridColumnSizes: [{ type: "FLEX", value: 1 }, { type: "FIXED", value: 200 }, { type: "HUG" }],
    gridRowCount: 1,
    gridColumnGap: 24,
    gridRowGap: 16,
    children: [cell],
  };
  const hiddenPromo: FigmaNode = {
    id: "14",
    name: "Hidden promo",
    type: "FRAME",
    visible: false,
    absoluteBoundingBox: box(100, 100),
  };
  return {
    fileName: "test",
    version: "1",
    document: {
      id: "1",
      name: "Page",
      type: "FRAME",
      absoluteBoundingBox: box(1366, 800),
      layoutMode: "VERTICAL",
      layoutGrids: [
        { pattern: "COLUMNS", count: 12, gutterSize: 24, offset: 140, alignment: "STRETCH", sectionSize: 66 },
        { pattern: "ROWS", visible: false, count: 4 },
      ],
      annotations: [{ label: "**Sticky** on scroll", properties: ["height"] }],
      devStatus: { type: "READY_FOR_DEV", description: "QA desktop" },
      exportSettings: [{ format: "PNG", constraint: { type: "SCALE", value: 2 } }, { format: "SVG" }],
      fills: [
        { type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } },
        { type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0, a: 1 } },
      ],
      children: [link, bullets, grid, hiddenPromo],
    },
  };
}

function byName(nodes: Record<string, PdsNode>, name: string): PdsNode {
  const n = Object.values(nodes).find((x) => x.name === name);
  if (!n) throw new Error(`no node named ${name}`);
  return n;
}

describe("normalize — hand-off and text extras", () => {
  const pds = normalize(fixture(), 6);
  const root = pds.nodes[pds.root]!;

  it("emits visible layout grids, annotations, dev status and export presets", () => {
    expect(root.grids).toEqual([{ pattern: "columns", count: 12, gutter: 24, margin: 140, align: "stretch" }]);
    expect(root.annotations).toEqual(["**Sticky** on scroll [height]"]);
    expect(root.devStatus).toBe("ready-for-dev");
    expect(root.devNote).toBe("QA desktop");
    expect(root.export).toEqual(["PNG@2x", "SVG"]);
  });

  it("emits link, italic token, vertical align, lists, paragraph gap and clamp", () => {
    const link = byName(pds.nodes, "Read more link");
    expect(link.href).toBe("https://example.com/more");
    expect(link.textValign).toBe("center");
    expect(pds.tokens.text[link.text as string]).toMatch(/^italic 400 16px/);
    const list = byName(pds.nodes, "Benefits list");
    expect(list.listLines).toEqual([null, "ul", "ul"]);
    expect(list.paraGap).toBe(8);
    expect(list.maxLines).toBe(3);
  });

  it("maps Grid auto-layout to CSS grid tracks and child cells", () => {
    const grid = byName(pds.nodes, "Card grid");
    const layout = (typeof grid.layout === "string" ? pds.tokens.layout?.[grid.layout] : grid.layout)!;
    expect(layout).toMatchObject({ flow: "grid", columns: "1fr 200px auto", rows: "1fr", gap: 24, gapCross: 16 });
    expect(byName(pds.nodes, "Wide card").gridCell).toEqual({ col: 2, row: 1, colSpan: 2 });
  });

  it("drops hidden layers and fills by default, keeps them flagged with includeHidden", () => {
    expect(Object.values(pds.nodes).some((n) => n.name === "Hidden promo")).toBe(false);
    expect(root.hiddenFills).toBeUndefined();
    const withHidden = normalize(fixture(), 6, { includeHidden: true });
    expect(byName(withHidden.nodes, "Hidden promo").hidden).toBe(true);
    expect(withHidden.nodes[withHidden.root]!.hiddenFills).toEqual([{ type: "color", color: "#000000" }]);
  });
});
