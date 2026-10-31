import { timingSafeEqual } from "node:crypto";
import { createWriteStream, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxUploadBytes, pairSecret, studioAllowed } from "./policy";
import { isPending, pendingCount } from "./requestQueue";
import { bridge } from "./store";
import { readInboundAsset, stageUpload, stagingStats } from "./uploads";
import { createLogger } from "../logger";
import { SERVER_VERSION } from "../meta";
import { serveStudio, studioAvailable } from "../studio/serve";

/**
 * The bridge's plain-HTTP routes, served on the same port as its WebSocket:
 * health and metrics, the plugin's byte channel (/upload, /asset), and Plumb
 * Studio. Split from server.ts, which keeps the WebSocket protocol.
 */

const log = createLogger("bridge");

/** HTTP request handler for the bridge's loopback server. Serves CORS preflight,
 *  the `/upload/:reqId.:ext` POST that the plugin UI uses to ship raw screenshot
 *  bytes, and the `/asset/:key.:ext` GET the plugin pulls inbound bytes from —
 *  no base64 anywhere in the hot path. */
/** Health/readiness snapshot served at `GET /healthz`. */
export interface HealthReport {
  ok: true;
  version: string;
  /** The port the bridge bound, or null when no port in the pool was free. */
  port: number | null;
  /** Whether a Figma plugin has completed the one-time pairing click. */
  paired: boolean;
  pluginVersion: string | null;
  /** Seconds since the process started. */
  uptimeSec: number;
  /** ms since the last message from the plugin, or null if none yet. */
  lastSeenMsAgo: number | null;
  /** In-flight plugin requests — a number that only grows means a wedged plugin. */
  pending: number;
  /** Bytes and temp files held between an HTTP upload and its WS reply. Also a
   *  number that should return to zero; one that doesn't is a leak. */
  staging: { uploads: number; assetRequests: number; inbound: number };
  /** Whether the built Studio SPA is present in this install. */
  studio: boolean;
  /** Machine label the paired plugin sent, if any. */
  machine: string | null;
  /** Figma file the paired plugin is serving, once its inventory arrived. */
  fileName: string | null;
  /** Whether pairing requires a key (PLUMB_PAIR_SECRET). */
  keyed: boolean;
}

/**
 * The health document, in Prometheus text exposition format.
 *
 * Deliberately hand-rolled rather than pulling in a metrics client: there are
 * six numbers, the format is a documented one-liner per sample, and a
 * dependency to emit it would be larger than the server's entire runtime tree.
 */
export function renderMetrics(): string {
  const h = healthReport();
  const lines = [
    "# HELP plumb_up Whether the bridge is serving.",
    "# TYPE plumb_up gauge",
    "plumb_up 1",
    "# HELP plumb_plugin_paired Whether a Figma plugin has completed pairing.",
    "# TYPE plumb_plugin_paired gauge",
    `plumb_plugin_paired ${h.paired ? 1 : 0}`,
    "# HELP plumb_uptime_seconds Seconds since the process started.",
    "# TYPE plumb_uptime_seconds counter",
    `plumb_uptime_seconds ${h.uptimeSec}`,
    "# HELP plumb_requests_in_flight Plugin requests awaiting a reply.",
    "# TYPE plumb_requests_in_flight gauge",
    `plumb_requests_in_flight ${h.pending}`,
    "# HELP plumb_staged_uploads Uploaded files awaiting their matching reply.",
    "# TYPE plumb_staged_uploads gauge",
    `plumb_staged_uploads ${h.staging.uploads}`,
    "# HELP plumb_staged_inbound Byte payloads staged for the plugin to pull.",
    "# TYPE plumb_staged_inbound gauge",
    `plumb_staged_inbound ${h.staging.inbound}`,
  ];
  return lines.join("\n") + "\n";
}

export function healthReport(): HealthReport {
  return {
    ok: true,
    version: SERVER_VERSION,
    port: bridge.port,
    paired: bridge.paired,
    pluginVersion: bridge.pluginVersion,
    uptimeSec: Math.round(process.uptime()),
    lastSeenMsAgo: bridge.lastSeen ? Date.now() - bridge.lastSeen : null,
    pending: pendingCount(),
    staging: stagingStats(),
    studio: studioAvailable() && studioAllowed(),
    machine: bridge.machine,
    fileName: bridge.inventory?.fileName ?? null,
    keyed: !!pairSecret(),
  };
}

/** On a keyed bridge, /upload and /asset need the current pairing's `?k=` token. */
function uploadAuthorized(url: URL): boolean {
  if (!pairSecret()) return true;
  const k = url.searchParams.get("k");
  if (!bridge.uploadToken || typeof k !== "string") return false;
  const a = Buffer.from(k);
  const b = Buffer.from(bridge.uploadToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://bridge");
  } catch {
    res.writeHead(400); // e.g. `//`: answer instead of leaving the socket open
    res.end();
    return;
  }
  if (req.method === "GET") {
    // Liveness + readiness in one document. `ok` answers "is this process
    // alive"; `paired` answers "can the plugin path actually serve a request
    // right now" — a container orchestrator wants the first, a human
    // debugging "why did plumb_node time out" wants the second.
    // `/healthz` is the Kubernetes convention; `/health` is what most other
    // probes and uptime checkers reach for. Same document either way — an
    // operator should not have to guess which spelling this server picked.
    if (req.url === "/healthz" || req.url === "/health") {
      const body = JSON.stringify(healthReport());
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    // Prometheus text exposition. The counters that actually indicate trouble
    // are the two that should return to zero and don't when something is
    // wedged: in-flight plugin requests, and staged bytes waiting for a reply.
    if (req.url === "/metrics") {
      const body = renderMetrics();
      res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      res.end(body);
      return;
    }
    // Inbound asset pull: the plugin UI eager-hydrates plan.assets from here.
    const am =/^\/asset\/([A-Za-z0-9_-]+)\.([a-z0-9]+)$/.exec(url.pathname);
    if (am) {
      if (!uploadAuthorized(url)) {
        res.writeHead(401);
        res.end();
        return;
      }
      const staged = readInboundAsset(am[1]!);
      if (!staged) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": staged.contentType,
        "Content-Length": staged.bytes.length,
      });
      res.end(staged.bytes);
      return;
    }
    // Anything else → the Plumb Studio SPA (unless policy keeps it off).
    if (!studioAllowed()) {
      res.writeHead(404);
      res.end();
      return;
    }
    serveStudio(req, res);
    return;
  }
  const m = /^\/upload\/([A-Za-z0-9_-]+)\.([a-z0-9]+)$/.exec(url.pathname);
  if (!m || req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!uploadAuthorized(url)) {
    res.writeHead(401);
    res.end();
    return;
  }
  const limit = maxUploadBytes();
  if (Number(req.headers["content-length"] ?? 0) > limit) {
    res.writeHead(413);
    res.end();
    return;
  }
  const reqId = m[1]!;
  const ext = m[2]!;
  // Only bytes for a request in flight (`r7`, or `r7-2` = asset 2 of r7): a token
  // holder can't stage files nobody asked for.
  if (!isPending(reqId.replace(/-\d+$/, ""))) {
    res.writeHead(409);
    res.end();
    return;
  }
  const path = join(tmpdir(), `plumb-${reqId}.${ext}`);
  const out = createWriteStream(path);
  // A client that hangs up mid-body: close the file and remove it (else fd + temp file leak).
  req.on("close", () => {
    if (!req.complete) {
      out.destroy();
      rmSync(path, { force: true });
    }
  });
  // Content-Length can be absent (chunked) — enforce the cap on the stream too.
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > limit) {
      req.unpipe(out);
      out.destroy();
      rmSync(path, { force: true });
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });
  req.pipe(out);
  out.on("finish", () => {
    stageUpload(reqId, path);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  out.on("error", (err) => {
    log.error("upload write failed", { reqId, path, err });
    res.writeHead(500);
    res.end();
  });
}

