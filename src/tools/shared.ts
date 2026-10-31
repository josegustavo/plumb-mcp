import { PlumbError, toErrorPayload } from "../errors";
import { isHosted } from "../hosted";
import { resolveFigmaTarget } from "../figma/url";
import { assertStructureBounds } from "../util/bounds";
import type { PdsDocument } from "../pds";

/** Standard success envelope for an MCP tool — the payload as JSON text. */
export function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/** Standard failure envelope — instruction-shaped `{error, nextAction}` (plan §6.6). */
export function fail(e: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(toErrorPayload(e)) }],
    isError: true,
  };
}

/**
 * The Figma token from env, or a PlumbError telling the agent how to set one.
 *
 * A hosted server (`plumb-mcp serve`) reads designs through the plugin only:
 * REST file reads would skip PLUMB_ALLOWED_FILES and spend the Figma plan's
 * small monthly Tier 1 quota on every remote client's behalf. Only the
 * per-minute (Tier 2/3) tools — comments, versions, files, library — pass
 * `hostedOk`.
 */
export function requireToken(hostedOk = false): string {
  if (isHosted() && !hostedOk) {
    throw new PlumbError(
      "This server reads Figma through the plugin only; fileKey/url (REST) reads are off.",
      "Pass a node id or screen name instead, with the Plumb plugin paired.",
    );
  }
  const token = process.env.FIGMA_TOKEN ?? process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    throw new PlumbError(
      "No Figma token configured.",
      "Set FIGMA_TOKEN in the MCP server's env block. Create a read-only token " +
        "at figma.com → Settings → Security → personal access tokens.",
    );
  }
  return token;
}

/**
 * The file a per-minute REST tool (comments, versions, file metadata) reads:
 * `url` or `fileKey`, else PLUMB_FILE_KEY — so a central server that works on
 * one file needs no link in every request.
 */
export function restFileKey(args: { url?: string; fileKey?: string }): string {
  const fileKey = resolveFigmaTarget(args).fileKey ?? (process.env.PLUMB_FILE_KEY?.trim() || undefined);
  if (!fileKey) {
    throw new PlumbError(
      "No Figma file key given.",
      "Pass `url` (any link to the file) or `fileKey`, or set PLUMB_FILE_KEY on the server.",
    );
  }
  return fileKey;
}

/** Minimal shape check for a raw JSON object the caller claims is a
 *  PdsDocument (from a prior plumb_node/outline/query call) — used by
 *  tools that accept a PDS snapshot directly (plumb_diff, plumb_audit)
 *  rather than resolving a Figma target themselves. */
export function asPdsDocument(value: unknown, label: string): PdsDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Record<string, unknown>).root !== "string" ||
    typeof (value as Record<string, unknown>).nodes !== "object"
  ) {
    throw new PlumbError(
      `\`${label}\` doesn't look like a PdsDocument (missing \`root\`/\`nodes\`).`,
      "Pass the raw JSON object returned by a prior plumb_node / plumb_outline / plumb_query call, unmodified.",
    );
  }
  try {
    assertStructureBounds(value);
  } catch (e) {
    throw new PlumbError(
      `\`${label}\` is too large/deeply nested to process: ${e instanceof Error ? e.message : String(e)}.`,
      "Pass a smaller PDS snapshot — e.g. from plumb_query with a narrower select, not a full-file dump.",
    );
  }
  return value as PdsDocument;
}
