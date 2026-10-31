import { timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { EXPORT_FILE_RE, exportsDir, MIME_BY_EXT, signatureValid } from "./exports";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { healthReport } from "./bridge/server";
import { createLogger } from "./logger";
import { createServer } from "./server";

/**
 * `plumb-mcp serve`: the MCP server over Streamable HTTP at `/mcp`, for a
 * central deployment where remote clients (or a gateway that proxies them)
 * talk to one Plumb next to one paired Figma plugin.
 *
 * Stateless: every POST gets its own McpServer + transport. Tools are cheap to
 * register and all real state (the bridge, the pairing, the node cache) is
 * module-level, so requests share it without sessions.
 *
 *   PLUMB_HTTP_HOST   bind address (default 127.0.0.1)
 *   PLUMB_HTTP_PORT   port (default 8080)
 *   PLUMB_MCP_TOKEN   required bearer token; mandatory beyond loopback
 *   PLUMB_PUBLIC_URL  optional origin prefixed to signed `download` links
 *
 * GET /files/<sha256>.<ext> serves hosted exports (see ./exports).
 */

const log = createLogger("http");

export interface HttpOptions {
  host: string;
  port: number;
  token?: string;
}

export const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const port = Number(env.PLUMB_HTTP_PORT);
  return {
    host: env.PLUMB_HTTP_HOST?.trim() || "127.0.0.1",
    port: Number.isInteger(port) && port >= 0 ? port : 8080,
    token: env.PLUMB_MCP_TOKEN?.trim() || undefined,
  };
}

function bearerMatches(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * GET /files/<sha256>.<ext>: one hosted export. Allowed with the bearer token
 * (a gateway), or with the signed, expiring URL a tool returned (a client that
 * can't set headers). A missing file means it expired: the caller re-runs the
 * tool, and the same design comes back under the same name.
 */
function serveExport(req: IncomingMessage, res: ServerResponse, url: URL, file: string, token?: string): void {
  if (!EXPORT_FILE_RE.test(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const allowed =
    !token ||
    bearerMatches(req, token) ||
    signatureValid(file, url.searchParams.get("exp"), url.searchParams.get("sig"));
  if (!allowed) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" });
    res.end();
    return;
  }
  const path = join(exportsDir(), file);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    const body = JSON.stringify({
      error: "This export expired or never existed on this server.",
      nextAction: "Call the tool again; the same design returns the same file name.",
    });
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME_BY_EXT[file.split(".")[1]!] ?? "application/octet-stream",
    "Content-Length": size,
    "Cache-Control": "private, max-age=86400, immutable",
    ETag: `"${file.split(".")[0]}"`,
    // Inert if opened in a browser: an SVG can't run anything from here.
    "Content-Disposition": `attachment; filename="${file}"`,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
  });
  // pipeline: a file swept between stat and open ends the response instead of hanging it.
  pipeline(createReadStream(path), res, () => undefined);
}

/** Starts the HTTP MCP endpoint. Resolves with the listening server (its real port via `address()`). */
export async function startHttpMcp(opts: HttpOptions): Promise<Server> {
  if (!opts.token && !LOOPBACK.has(opts.host)) {
    throw new Error(`PLUMB_MCP_TOKEN is required when PLUMB_HTTP_HOST (${opts.host}) is not loopback.`);
  }
  const http = createHttpServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://plumb");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const path = url.pathname;
    const fileMatch = /^\/files\/([^/]+)$/.exec(path);
    if (req.method === "GET" && fileMatch) {
      serveExport(req, res, url, fileMatch[1]!, opts.token);
      return;
    }
    if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
      const body = JSON.stringify(healthReport());
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (opts.token && !bearerMatches(req, opts.token)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" });
      res.end();
      return;
    }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((e: unknown) => {
        log.error("request failed", { err: e instanceof Error ? e : new Error(String(e)) });
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  const addr = http.address();
  log.info("MCP over HTTP", {
    url: `http://${opts.host}:${typeof addr === "object" && addr ? addr.port : opts.port}/mcp`,
    auth: opts.token ? "bearer" : "none (loopback only)",
  });
  return http;
}
