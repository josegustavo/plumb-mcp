import { readFileSync } from "node:fs";
import { z } from "zod";
import { publishExport, resourceLink } from "../exports";
import { formatScreenMatches, resolveScreen, screenName } from "../bridge/inventory";
import { requestAssets } from "../bridge/server";
import { bridge } from "../bridge/store";
import { assetFileName, writeAssets, type WrittenAsset } from "../assets";
import { inlineMaxBytes, isHosted } from "../hosted";
import { PlumbError } from "../errors";
import { fail, ok } from "./shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DESCRIPTION =
  "Export Figma assets — icons as SVG, images as PNG — through the paired " +
  "plugin. Three modes:\n" +
  "  • Default — `id` or `name` of a screen → recursive export of every " +
  "asset in it, written to a local folder.\n" +
  "  • List — same + `list: true` → just the manifest (id, name, format, " +
  "parentId) of available assets; no files written. Cheap; use first to see " +
  "what's there.\n" +
  "  • Surgical — `ids: [...]` → export exactly those node ids (one file " +
  "each, no recursion). Preferred once you know what you need.";

const IMAGE_MIME: Record<string, string> = {
  PNG: "image/png",
  JPG: "image/jpeg",
  GIF: "image/gif",
  WEBP: "image/webp",
};

type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | ReturnType<typeof resourceLink>;

/**
 * The tool result for written assets.
 * - `images`: bitmaps without a `source` ride as MCP image blocks after the
 *   JSON, in row order, until {@link inlineMaxBytes}; those rows get `image: true`.
 * - `hosted`: rows drop this machine's paths and name their content-addressed
 *   export instead (sha256, `uri` for resources/read, signed `download`), each
 *   with a `resource_link` block.
 */
function respond(
  payload: Record<string, unknown> & { dir: string },
  written: WrittenAsset[],
  opts: { hosted: boolean; images: boolean },
) {
  let budget = inlineMaxBytes();
  const blocks: Block[] = [];
  const assets = written.map((w) => {
    const ref = opts.hosted ? publishExport(w.path, w.format) : null;
    const row: Record<string, unknown> = {
      id: w.id,
      name: w.name,
      format: w.format,
      ...(ref
        ? { sha256: ref.sha256, mimeType: ref.mimeType, uri: ref.uri, download: ref.download, expires: ref.expires }
        : { path: w.path }),
      bytes: w.bytes,
      parentId: w.parentId,
      ...(w.source !== undefined ? { source: w.source } : {}),
    };
    const mimeType = IMAGE_MIME[w.format];
    if (opts.images && w.source === undefined && mimeType && w.bytes <= budget) {
      blocks.push({ type: "image", data: readFileSync(w.path).toString("base64"), mimeType });
      budget -= w.bytes;
      row.image = true;
    }
    if (ref) blocks.push(resourceLink(ref, assetFileName(w.name, w.format)));
    return row;
  });
  const { dir, ...rest } = payload;
  const text = JSON.stringify({ ...rest, ...(opts.hosted ? {} : { dir }), count: written.length, assets });
  return { content: [{ type: "text" as const, text }, ...blocks] };
}

const HOSTED_NEXT =
  "SVG rows carry `source` markup to drop into code. Every row also has `uri` " +
  "(resources/read) and `download` (HTTP, expires): the same design always " +
  "returns the same sha256, so a file you already hold needs no new download. " +
  "Pass `view: true` to look at bitmaps.";

/** Registers the `plumb_assets` MCP tool (plan §8). */
export function registerPlumbAssets(server: McpServer): void {
  server.registerTool(
    "plumb_assets",
    {
      title: "Plumb · assets",
      description: DESCRIPTION,
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe("Screen/node id to scope the export to."),
        name: z
          .string()
          .optional()
          .describe("Screen name — resolved against the file."),
        ids: z
          .array(z.string())
          .optional()
          .describe(
            "Surgical — export exactly these node ids (one each, no recursion).",
          ),
        list: z
          .boolean()
          .optional()
          .describe(
            "Manifest only — return id/name/format/parentId per candidate; no file writes.",
          ),
        raw: z
          .boolean()
          .optional()
          .describe(
            "For nodes with IMAGE fills, export the original uploaded bytes (JPG/PNG/GIF/WEBP) via getImageByHash, instead of a 2× rasterised PNG render. Other nodes (icons, vectors) export the same as default.",
          ),
        inline: z
          .boolean()
          .optional()
          .describe(
            "Return asset bytes inline on each row: SVGs as raw markup, " +
              "bitmaps under 64KB as a data: URI, larger bitmaps as MCP image " +
              "blocks after the JSON (rows marked `image: true`). Files are " +
              "still written; this is additive. On a hosted (`plumb-mcp serve`) " +
              "server: default true, and it inlines SVG markup only (up to 100KB) — " +
              "bitmaps come as links; use `view` to see them.",
          ),
        view: z
          .boolean()
          .optional()
          .describe(
            "Hosted server: also return bitmaps as MCP image blocks so you can look at " +
              "them (costs image tokens). Default false — rows link to the files instead.",
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        if (!bridge.paired) {
          throw new PlumbError(
            "No Figma plugin is paired.",
            "plumb_assets uses the plugin path — run the Plumb plugin in Figma and click 'Pair with Plumb'.",
          );
        }

        const list = args.list === true;
        const raw = args.raw === true;
        const hosted = isHosted();
        const inline = args.inline ?? hosted;
        const images = hosted ? args.view === true : inline;

        // --- Surgical mode — specific ids ----------------------------------
        if (args.ids && args.ids.length > 0) {
          const { assets, error } = await requestAssets({ ids: args.ids, list, raw });
          if (error) {
            throw new PlumbError(
              `The plugin could not export the requested ids: ${error}`,
              "Retry; if it persists, the ids may be invalid or deleted.",
            );
          }
          if (list) {
            return ok({
              source: "plugin",
              mode: "list",
              count: assets.length,
              manifest: assets.map((a) => ({
                id: a.id,
                name: a.name,
                format: a.format,
                parentId: a.parentId,
              })),
              next:
                assets.length === 0
                  ? "None of the supplied ids resolved to exportable nodes."
                  : "Pick what you need, then call plumb_assets with `ids: [...]` and no `list`.",
            });
          }
          const folder = args.name || (args.id ? screenName(args.id) : "") || "specific";
          const { dir, written } = writeAssets(folder, assets, { inline, svgOnly: hosted });
          return respond({
            source: "plugin",
            mode: "specific",
            dir,
            next:
              written.length === 0
                ? "None of the supplied ids resolved to exportable nodes."
                : hosted
                  ? HOSTED_NEXT
                  : inline
                    ? "Each row has either `source` (SVG markup or data: URI) or just `path`. Drop SVG `source` straight into JSX."
                    : "Use these file paths when building.",
          }, written, { hosted, images });
        }

        // --- Screen-scoped modes (default or list) -------------------------
        if (!args.id && !args.name) {
          throw new PlumbError(
            "Provide a screen `id` or `name` — or `ids: [...]` for surgical export.",
            "Call plumb_outline to list screen names and ids.",
          );
        }

        const resolved = await resolveScreen(args.id, args.name);
        if ("ambiguous" in resolved) {
          return ok({
            ambiguous: true,
            matches: formatScreenMatches(resolved.ambiguous),
            next:
              "Several screens share that name. Each row shows `page` and " +
              "`box` (w×h) — pick the one you want and re-call plumb_assets with its `id`.",
          });
        }

        const { assets, error } = await requestAssets({ nodeId: resolved.id, list, raw });
        if (error) {
          throw new PlumbError(
            `The plugin could not export assets: ${error}`,
            "Retry; if it persists, the screen may have been deleted or renamed.",
          );
        }

        const sname = screenName(resolved.id) || resolved.id;

        if (list) {
          return ok({
            source: "plugin",
            mode: "list",
            screen: sname,
            count: assets.length,
            manifest: assets.map((a) => ({
              id: a.id,
              name: a.name,
              format: a.format,
              parentId: a.parentId,
            })),
            next:
              assets.length === 0
                ? "No exportable assets in this screen."
                : "Pick the ones you actually need, then call plumb_assets with `ids: [...]` (no `list`).",
          });
        }

        const { dir, written } = writeAssets(sname, assets, { inline, svgOnly: hosted });
        return respond({
          source: "plugin",
          dir,
          next:
            written.length === 0
              ? "No exportable assets (icons / images) were found in this screen."
              : hosted
                ? HOSTED_NEXT
                : inline
                  ? "Each row has either `source` (SVG markup or data: URI) or just `path`. Drop SVG `source` straight into JSX."
                  : "Use these file paths when building. Tip: pass `list: true` first to peek without downloading; then `ids: [...]` to pull just what you need.",
        }, written, { hosted, images });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
