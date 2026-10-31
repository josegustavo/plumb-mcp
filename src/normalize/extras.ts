import { cleanPx } from "../util/num";
import type { FigmaNode, FigmaTypeStyle } from "../figma/types";
import type { PdsNode } from "../pds";

/**
 * Hand-off and text details that don't change geometry: layout grids, grid
 * cells, Dev Mode annotations / status, export presets, links, lists,
 * paragraph spacing, line clamp. Each emits only when it carries signal.
 */

/** REST/plugin hyperlink → `href`: the URL, or `#node:<id>` for an in-file link. */
export function linkHref(h: FigmaTypeStyle["hyperlink"]): string | undefined {
  if (!h) return undefined;
  if (h.type === "URL" && h.url) return h.url;
  if (h.type === "NODE" && h.nodeID) return `#node:${h.nodeID}`;
  return undefined;
}

const LIST: Record<string, "ul" | "ol"> = { UNORDERED: "ul", ORDERED: "ol" };

const GRID_ALIGN: Record<string, "min" | "max" | "stretch" | "center"> = {
  MIN: "min",
  MAX: "max",
  STRETCH: "stretch",
  CENTER: "center",
};

function exportLabel(s: NonNullable<FigmaNode["exportSettings"]>[number]): string {
  const c = s.constraint;
  const size =
    !c || (c.type === "SCALE" && c.value === 1)
      ? ""
      : c.type === "SCALE"
        ? `@${c.value}x`
        : ` ${c.type === "WIDTH" ? "w" : "h"}${c.value}`;
  return `${s.format}${size}${s.suffix ? ` ${s.suffix}` : ""}`;
}

/** Grids, grid cell, annotations, dev status and export presets for any node. */
export function handoffProps(fn: FigmaNode, parent?: FigmaNode): Partial<PdsNode> {
  const out: Partial<PdsNode> = {};
  const grids = (fn.layoutGrids ?? [])
    .filter((g) => g.visible !== false)
    .map((g) => ({
      pattern: g.pattern.toLowerCase() as "columns" | "rows" | "grid",
      ...(g.count !== undefined && g.count > 0 ? { count: g.count } : {}),
      ...(g.gutterSize ? { gutter: cleanPx(g.gutterSize) } : {}),
      ...(g.offset ? { margin: cleanPx(g.offset) } : {}),
      ...(g.alignment ? { align: GRID_ALIGN[g.alignment] } : {}),
      ...(g.sectionSize && (g.pattern === "GRID" || g.alignment !== "STRETCH")
        ? { size: cleanPx(g.sectionSize) }
        : {}),
    }));
  if (grids.length) out.grids = grids;

  if (parent?.layoutMode === "GRID" && typeof fn.gridColumnAnchorIndex === "number") {
    out.gridCell = {
      col: fn.gridColumnAnchorIndex + 1,
      row: (fn.gridRowAnchorIndex ?? 0) + 1,
      ...(fn.gridColumnSpan && fn.gridColumnSpan > 1 ? { colSpan: fn.gridColumnSpan } : {}),
      ...(fn.gridRowSpan && fn.gridRowSpan > 1 ? { rowSpan: fn.gridRowSpan } : {}),
    };
  }

  const notes = (fn.annotations ?? [])
    .map((a) => {
      const props = a.properties?.length ? ` [${a.properties.join(", ")}]` : "";
      return `${a.label}${props}`.trim();
    })
    .filter(Boolean);
  if (notes.length) out.annotations = notes;

  if (fn.devStatus?.type === "READY_FOR_DEV") out.devStatus = "ready-for-dev";
  else if (fn.devStatus?.type === "COMPLETED") out.devStatus = "completed";
  if (out.devStatus && fn.devStatus?.description) out.devNote = fn.devStatus.description;

  if (fn.exportSettings?.length) out.export = fn.exportSettings.map(exportLabel);
  return out;
}

/** Link, list, paragraph and clamp details for a TEXT node. */
export function textExtras(fn: FigmaNode): Partial<PdsNode> {
  const out: Partial<PdsNode> = {};
  const s = fn.style;
  const href = linkHref(s?.hyperlink);
  if (href) out.href = href;

  const lines = (fn.lineTypes ?? []).map((t) => LIST[t] ?? null);
  if (lines.some((l) => l !== null)) {
    const first = lines[0];
    if (first && lines.every((l) => l === first)) out.list = first;
    else out.listLines = lines;
  }

  if (s?.paragraphSpacing) out.paraGap = cleanPx(s.paragraphSpacing);
  if (s?.paragraphIndent) out.paraIndent = cleanPx(s.paragraphIndent);
  if (s?.maxLines && s.textTruncation === "ENDING") out.maxLines = s.maxLines;
  if (s?.textAlignVertical === "CENTER") out.textValign = "center";
  else if (s?.textAlignVertical === "BOTTOM") out.textValign = "bottom";
  return out;
}
