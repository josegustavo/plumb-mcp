import { PlumbError } from "../errors";
import type { FigmaFileResult, FigmaNode } from "./types";

/** A stalled connection to api.figma.com (flaky network, captive portal,
 *  Figma incident) must not hang a tool call forever — cap it. */
const REST_TIMEOUT_MS = 15_000;

function describeFetchError(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return `timed out after ${REST_TIMEOUT_MS / 1000}s`;
  }
  return e instanceof Error ? e.message : String(e);
}

export interface RestRequest {
  fileKey: string;
  nodeId: string;
  depth: number;
  token: string;
}

interface RestNodesResponse {
  name?: string;
  version?: string | number;
  nodes?: Record<string, { document?: FigmaNode } | undefined>;
}

/**
 * Milestone 0 ingest: fetch a single node subtree via the Figma REST API.
 * Plan §3/§11: REST is the secondary path — fine for the M0 proof against one
 * known file, but rate-limited on free workspaces; the plugin path (M1) is
 * primary.
 */
export async function fetchNodeViaRest(req: RestRequest): Promise<FigmaFileResult> {
  const { fileKey, nodeId, depth, token } = req;
  const url =
    `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}` +
    `/nodes?ids=${encodeURIComponent(nodeId)}&depth=${depth}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PlumbError(
      `Could not reach api.figma.com: ${describeFetchError(e)}`,
      "Check your internet connection, then retry.",
    );
  }

  if (!res.ok) throw restError(res.status, fileKey);

  const json = (await res.json()) as RestNodesResponse;
  const entry = json.nodes?.[nodeId];
  if (!entry?.document) {
    throw new PlumbError(
      `Figma returned no node "${nodeId}" for file "${fileKey}".`,
      "Check the node id — copy the part after 'node-id=' in the Figma URL and " +
        "replace '-' with ':'. Confirm it belongs to this file.",
    );
  }

  return {
    document: entry.document,
    fileName: json.name ?? "",
    version: String(json.version ?? ""),
  };
}

interface RestFileResponse {
  name?: string;
  version?: string | number;
  document?: FigmaNode;
}

/**
 * Fetch a file's shallow structure (pages → top-level frames) for plumb_outline.
 * Depth 2 keeps it cheap: canvases and their frames, nothing deeper.
 */
export async function fetchFileOutline(
  fileKey: string,
  token: string,
  depth = 2,
): Promise<FigmaFileResult> {
  const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?depth=${depth}`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PlumbError(
      `Could not reach api.figma.com: ${describeFetchError(e)}`,
      "Check your internet connection, then retry.",
    );
  }

  if (!res.ok) throw restError(res.status, fileKey);

  const json = (await res.json()) as RestFileResponse;
  if (!json.document) {
    throw new PlumbError(
      `Figma returned no document for file "${fileKey}".`,
      "Check the file key — the string after /design/ or /file/ in the Figma URL.",
    );
  }

  return {
    document: json.document,
    fileName: json.name ?? "",
    version: String(json.version ?? ""),
  };
}

/** One comment as the REST API returns it (`GET /v1/files/:key/comments`). */
export interface RestComment {
  id: string;
  parent_id?: string;
  order_id?: string | null;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  user?: { handle?: string };
  /** Pinned position — `node_id` when the comment sits on a frame/layer. */
  client_meta?: { node_id?: string; node_offset?: { x: number; y: number }; x?: number; y?: number } | null;
}

/**
 * Every comment on a file. The plugin API cannot read comments, so this is
 * REST-only. Comments sit in Figma's Tier 2 rate limit (per-minute), not the
 * Tier 1 per-month cap that file/node reads hit on Starter plans.
 */
export async function fetchComments(fileKey: string, token: string): Promise<RestComment[]> {
  const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/comments`;

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      headers: { "X-Figma-Token": token },
      signal: AbortSignal.timeout(REST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PlumbError(
      `Could not reach api.figma.com: ${describeFetchError(e)}`,
      "Check your internet connection, then retry.",
    );
  }

  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    throw new PlumbError(
      "Figma rate-limited the comments request (HTTP 429)" +
        (Number.isFinite(wait) && wait > 0 ? `; Retry-After ${Math.ceil(wait)}s.` : "."),
      "Do not retry before Retry-After has passed — every retry counts against the same quota.",
    );
  }
  if (!res.ok) throw restError(res.status, fileKey);

  const json = (await res.json()) as { comments?: RestComment[] };
  return Array.isArray(json.comments) ? json.comments : [];
}

function restError(status: number, fileKey: string): PlumbError {
  switch (status) {
    case 401:
    case 403:
      return new PlumbError(
        `Figma rejected the request (HTTP ${status}).`,
        "Set a valid token in the FIGMA_TOKEN env var. Create a read-only token " +
          "at figma.com → Settings → Security → personal access tokens.",
      );
    case 404:
      return new PlumbError(
        `Figma file "${fileKey}" was not found (HTTP 404).`,
        "Check the file key — it is the string after '/design/' or '/file/' in the Figma URL.",
      );
    case 429:
      return new PlumbError(
        "Figma rate-limited the request (HTTP 429).",
        "Wait, then retry. REST limits are very low on free/Starter workspaces — " +
          "this is exactly why Plumb's primary path is the plugin, not REST.",
      );
    default:
      return new PlumbError(
        `Figma REST request failed (HTTP ${status}).`,
        "Retry; if it persists, check status.figma.com.",
      );
  }
}
