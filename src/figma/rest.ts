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
  /** Pinned position: a canvas point (`x`/`y`), or a point inside a node
   *  (`node_id` + `node_offset`), optionally a dragged region with a pin corner. */
  client_meta?: {
    node_id?: string;
    node_offset?: { x: number; y: number };
    x?: number;
    y?: number;
    region_width?: number;
    region_height?: number;
    comment_pin_corner?: string;
  } | null;
}

/** One saved version from the file's version history. */
export interface RestVersion {
  id: string;
  created_at: string;
  label?: string | null;
  description?: string | null;
  user?: { handle?: string };
}

/**
 * Every comment on a file. The plugin API cannot read comments, so this is
 * REST-only. Comments sit in Figma's Tier 2 rate limit (per-minute), not the
 * Tier 1 per-month cap that file/node reads hit on Starter plans.
 */
export async function fetchComments(fileKey: string, token: string): Promise<RestComment[]> {
  const json = await tier2Get<{ comments?: RestComment[] }>(fileKey, "comments", token);
  return Array.isArray(json.comments) ? json.comments : [];
}

/** The most recent `pageSize` (max 50) entries of the file's version history. Tier 2. */
export async function fetchVersions(fileKey: string, token: string, pageSize: number): Promise<RestVersion[]> {
  const json = await tier2Get<{ versions?: RestVersion[] }>(
    fileKey,
    `versions?page_size=${Math.min(Math.max(pageSize, 1), 50)}`,
    token,
  );
  return Array.isArray(json.versions) ? json.versions : [];
}

/** A file's metadata (`GET /v1/files/:key/meta`, Tier 3) — no document tree. */
export interface RestFileMeta {
  name?: string;
  folder_name?: string;
  last_touched_at?: string;
  last_touched_by?: { handle?: string };
  creator?: { handle?: string };
  thumbnail_url?: string;
  editorType?: string;
  version?: string;
  url?: string;
}

export async function fetchFileMeta(fileKey: string, token: string): Promise<RestFileMeta> {
  const json = await tier2Get<{ file?: RestFileMeta }>(fileKey, "meta", token);
  return json.file ?? {};
}

/** A team's projects (`GET /v1/teams/:id/projects`, Tier 2). */
export async function fetchTeamProjects(
  teamId: string,
  token: string,
): Promise<{ name?: string; projects: Array<{ id: string; name: string }> }> {
  const json = await figmaGet<{ name?: string; projects?: Array<{ id: string | number; name: string }> }>(
    `teams/${encodeURIComponent(teamId)}/projects`,
    token,
    `team ${teamId}`,
  );
  return {
    name: json.name,
    projects: (json.projects ?? []).map((p) => ({ id: String(p.id), name: p.name })),
  };
}

/** A project's files (`GET /v1/projects/:id/files`, Tier 2). */
export async function fetchProjectFiles(
  projectId: string,
  token: string,
): Promise<{ name?: string; files: Array<{ key: string; name: string; last_modified?: string; thumbnail_url?: string }> }> {
  const json = await figmaGet<{
    name?: string;
    files?: Array<{ key: string; name: string; last_modified?: string; thumbnail_url?: string }>;
  }>(`projects/${encodeURIComponent(projectId)}/files`, token, `project ${projectId}`);
  return { name: json.name, files: json.files ?? [] };
}

/** One published library item (`GET /v1/teams/:id/{components,component_sets,styles}`, Tier 3). */
export interface RestLibraryItem {
  key: string;
  file_key: string;
  node_id: string;
  name: string;
  description?: string;
  style_type?: string;
  thumbnail_url?: string;
  updated_at?: string;
  containing_frame?: { name?: string; pageName?: string; containingComponentSet?: { name?: string } | null } | null;
}

export type LibraryKind = "components" | "component_sets" | "styles";

export async function fetchTeamLibrary(
  teamId: string,
  kind: LibraryKind,
  token: string,
  opts: { pageSize?: number; after?: number } = {},
): Promise<{ items: RestLibraryItem[]; after?: number }> {
  const qs = new URLSearchParams({ page_size: String(Math.min(Math.max(opts.pageSize ?? 100, 1), 1000)) });
  if (opts.after !== undefined) qs.set("after", String(opts.after));
  const json = await figmaGet<{ meta?: Record<string, unknown> & { cursor?: { after?: number } } }>(
    `teams/${encodeURIComponent(teamId)}/${kind}?${qs}`,
    token,
    `team ${teamId}`,
  );
  const items = json.meta?.[kind];
  return {
    items: Array.isArray(items) ? (items as RestLibraryItem[]) : [],
    ...(json.meta?.cursor?.after !== undefined ? { after: json.meta.cursor.after } : {}),
  };
}

/** GET `/v1/files/:key/<path>` for a Tier 2/3 endpoint. */
function tier2Get<T>(fileKey: string, path: string, token: string): Promise<T> {
  return figmaGet<T>(`files/${encodeURIComponent(fileKey)}/${path}`, token, `file "${fileKey}"`);
}

/** GET `/v1/<path>` for a per-minute (Tier 2/3) endpoint. A 429 surfaces Retry-After and is never retried. */
async function figmaGet<T>(path: string, token: string, what: string): Promise<T> {
  const url = `https://api.figma.com/v1/${path}`;

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
      `Figma rate-limited the ${path.split("?")[0]} request (HTTP 429)` +
        (Number.isFinite(wait) && wait > 0 ? `; Retry-After ${Math.ceil(wait)}s.` : "."),
      "Do not retry before Retry-After has passed — every retry counts against the same quota.",
    );
  }
  if (res.status === 404) {
    throw new PlumbError(
      `Figma ${what} was not found (HTTP 404).`,
      "Check the key or id — it is in the Figma URL (/design/<key>, /files/team/<id>, /files/project/<id>).",
    );
  }
  if (!res.ok) throw restError(res.status, what);
  return (await res.json()) as T;
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
