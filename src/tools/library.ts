import { z } from "zod";
import { fetchTeamLibrary, type LibraryKind, type RestLibraryItem } from "../figma/rest";
import { PlumbError } from "../errors";
import { fail, ok, requireToken } from "./shared";
import { parseTeamOrProject } from "./files";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DESCRIPTION =
  "List what a Figma team has published to its library — components, " +
  "component sets or styles — across every file, with description, source " +
  "file, node id and page. Use it to find the canonical button or colour " +
  "style before building one. `query` filters by name or description. " +
  "Team id: `teamId`, a figma.com/files/team/<id> link, or the server's " +
  "PLUMB_TEAM_ID. REST path: needs FIGMA_TOKEN; one per-minute (Tier 3) " +
  "request per page.";

/** Compact rows: drop Figma's long-lived thumbnail URLs unless asked. */
export function libraryRows(items: RestLibraryItem[], opts: { query?: string; thumbnails?: boolean } = {}) {
  const q = opts.query?.trim().toLowerCase();
  return items
    .filter((i) => !q || i.name.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q))
    .map((i) => ({
      name: i.name,
      ...(i.style_type ? { type: i.style_type } : {}),
      ...(i.description ? { description: i.description } : {}),
      file: i.file_key,
      node: i.node_id,
      ...(i.containing_frame?.pageName ? { page: i.containing_frame.pageName } : {}),
      ...(i.containing_frame?.containingComponentSet?.name ? { set: i.containing_frame.containingComponentSet.name } : {}),
      ...(i.updated_at ? { updated: i.updated_at } : {}),
      key: i.key,
      ...(opts.thumbnails && i.thumbnail_url ? { thumbnail: i.thumbnail_url } : {}),
    }));
}

/** Registers the `plumb_library` MCP tool. */
export function registerPlumbLibrary(server: McpServer): void {
  server.registerTool(
    "plumb_library",
    {
      title: "Plumb · library",
      description: DESCRIPTION,
      inputSchema: {
        teamId: z.string().optional().describe("Team id. Default: PLUMB_TEAM_ID."),
        url: z.string().optional().describe("A figma.com/files/team/<id>/… link."),
        kind: z
          .enum(["components", "component_sets", "styles"])
          .optional()
          .describe("What to list. Default components."),
        query: z.string().optional().describe("Only items whose name or description contains this (case-insensitive)."),
        pageSize: z.number().int().min(1).max(1000).optional().describe("Items per page. Default 100."),
        after: z.number().int().optional().describe("The `after` cursor from the previous page."),
        thumbnails: z.boolean().optional().describe("Include thumbnail image URLs. Default false."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const teamId = args.teamId ?? parseTeamOrProject(args.url).teamId ?? process.env.PLUMB_TEAM_ID?.trim();
        if (!teamId) {
          throw new PlumbError(
            "No Figma team id given.",
            "Pass `teamId` or a figma.com/files/team/<id> link, or set PLUMB_TEAM_ID on the server.",
          );
        }
        const kind: LibraryKind = args.kind ?? "components";
        const page = await fetchTeamLibrary(teamId, kind, requireToken(true), {
          pageSize: args.pageSize,
          after: args.after,
        });
        const items = libraryRows(page.items, { query: args.query, thumbnails: args.thumbnails });
        return ok({
          source: "rest",
          teamId,
          kind,
          count: items.length,
          items,
          ...(page.after !== undefined && page.items.length > 0 ? { after: page.after } : {}),
          next:
            page.after !== undefined && page.items.length > 0
              ? "More published items: call again with `after`."
              : "Open an item's `node` in its `file` with plumb_node (the plugin must have that file open).",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
