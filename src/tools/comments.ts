import { z } from "zod";
import { fetchComments, type RestComment } from "../figma/rest";
import { resolveFigmaTarget } from "../figma/url";
import { PlumbError } from "../errors";
import { fail, ok, requireToken } from "./shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DESCRIPTION =
  "Read the comments left on a Figma file, grouped into threads (root comment " +
  "+ replies), newest first. Each thread carries the node id it is pinned to, " +
  "so you can open it with plumb_node. Open threads only unless " +
  "`includeResolved`. REST path: needs FIGMA_TOKEN and a file key or URL — the " +
  "plugin API cannot read comments. One call per file; it costs one Tier 2 " +
  "(per-minute) REST request, not the per-month file-read quota.";

export interface CommentThread {
  id: string;
  /** Figma's visible thread number (#12 in the comments panel). */
  n?: string;
  node?: string;
  author: string;
  at: string;
  resolved?: string;
  message: string;
  replies: Array<{ author: string; at: string; message: string }>;
}

/** Group flat REST comments into threads, filter, newest first. */
export function threadComments(
  comments: RestComment[],
  opts: { includeResolved?: boolean; nodeIds?: string[] } = {},
): CommentThread[] {
  const replies = new Map<string, RestComment[]>();
  for (const c of comments) {
    if (!c.parent_id) continue;
    const list = replies.get(c.parent_id) ?? [];
    list.push(c);
    replies.set(c.parent_id, list);
  }
  const nodeFilter = opts.nodeIds?.length ? new Set(opts.nodeIds) : undefined;
  return comments
    .filter((c) => !c.parent_id)
    .filter((c) => opts.includeResolved || !c.resolved_at)
    .filter((c) => !nodeFilter || nodeFilter.has(c.client_meta?.node_id ?? ""))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((c) => ({
      id: c.id,
      ...(c.order_id ? { n: c.order_id } : {}),
      ...(c.client_meta?.node_id ? { node: c.client_meta.node_id } : {}),
      author: c.user?.handle ?? "unknown",
      at: c.created_at,
      ...(c.resolved_at ? { resolved: c.resolved_at } : {}),
      message: c.message,
      replies: (replies.get(c.id) ?? [])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((r) => ({ author: r.user?.handle ?? "unknown", at: r.created_at, message: r.message })),
    }));
}

/** Registers the `plumb_comments` MCP tool. */
export function registerPlumbComments(server: McpServer): void {
  server.registerTool(
    "plumb_comments",
    {
      title: "Plumb · comments",
      description: DESCRIPTION,
      inputSchema: {
        url: z.string().optional().describe("Figma file URL — the file key is extracted from it."),
        fileKey: z.string().optional().describe("Figma file key (the string after /design/ in the URL)."),
        nodeIds: z
          .array(z.string())
          .optional()
          .describe("Only threads pinned to these node ids (e.g. the frame a peer asked about)."),
        includeResolved: z.boolean().optional().describe("Also return resolved threads. Default false."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { fileKey } = resolveFigmaTarget({ url: args.url, fileKey: args.fileKey });
        if (!fileKey) {
          throw new PlumbError(
            "No Figma file key given.",
            "Pass `url` (any link to the file) or `fileKey`.",
          );
        }
        const raw = await fetchComments(fileKey, requireToken(true));
        const threads = threadComments(raw, { includeResolved: args.includeResolved, nodeIds: args.nodeIds });
        return ok({
          source: "rest",
          fileKey,
          totalComments: raw.length,
          threadCount: threads.length,
          threads,
          next:
            threads.length === 0
              ? "No matching comment threads."
              : "Open a thread's `node` with plumb_node to see what it refers to.",
        });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
