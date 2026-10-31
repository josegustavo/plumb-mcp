import { z } from "zod";
import { fetchVersions } from "../figma/rest";
import { resolveFigmaTarget } from "../figma/url";
import { PlumbError } from "../errors";
import { fail, ok, requireToken } from "./shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DESCRIPTION =
  "List the Figma file's version history, newest first: who saved, when, and " +
  "the label / description of named versions. Use it to see what changed " +
  "since a review date or which named milestone is current. REST path: needs " +
  "FIGMA_TOKEN and a file key or URL. One Tier 2 (per-minute) request per call.";

/** Registers the `plumb_versions` MCP tool. */
export function registerPlumbVersions(server: McpServer): void {
  server.registerTool(
    "plumb_versions",
    {
      title: "Plumb · versions",
      description: DESCRIPTION,
      inputSchema: {
        url: z.string().optional().describe("Figma file URL — the file key is extracted from it."),
        fileKey: z.string().optional().describe("Figma file key (the string after /design/ in the URL)."),
        limit: z.number().int().min(1).max(50).optional().describe("How many recent versions. Default 20, max 50."),
        namedOnly: z
          .boolean()
          .optional()
          .describe("Only versions a person saved with a label (skips autosaves)."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { fileKey } = resolveFigmaTarget({ url: args.url, fileKey: args.fileKey });
        if (!fileKey) {
          throw new PlumbError("No Figma file key given.", "Pass `url` (any link to the file) or `fileKey`.");
        }
        const raw = await fetchVersions(fileKey, requireToken(true), args.limit ?? 20);
        const versions = raw
          .filter((v) => !args.namedOnly || !!v.label)
          .map((v) => ({
            id: v.id,
            at: v.created_at,
            by: v.user?.handle ?? "unknown",
            ...(v.label ? { label: v.label } : {}),
            ...(v.description ? { description: v.description } : {}),
          }));
        return ok({ source: "rest", fileKey, count: versions.length, versions });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
