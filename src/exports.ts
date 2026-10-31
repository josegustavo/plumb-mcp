import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PlumbError } from "./errors";
import { EXPORT_TTL_MS } from "./hosted";

/**
 * Hosted exports, addressed by content: every file plumb_assets / plumb_screenshot
 * writes on `plumb-mcp serve` also gets a `<sha256>.<ext>` name. Exporting the
 * same design again yields the same name — no duplicate on disk, and a client
 * (or a gateway) can tell from the hash alone that it already holds the file.
 *
 * Remote clients reach those files three ways, so each picks what it supports:
 *   - inline (SVG markup in the JSON; images as MCP image blocks when asked);
 *   - `resources/read plumb://exports/<file>` (the `resource_link` blocks);
 *   - `GET /files/<file>` on the MCP HTTP port, with the bearer token or the
 *     signed, expiring `download` URL.
 * Files live under PLUMB_ASSETS_DIR, so the hosted sweep removes them after
 * {@link EXPORT_TTL_MS} unused; a re-export touches the file and keeps it.
 */

export const EXPORT_FILE_RE = /^[a-f0-9]{64}\.(svg|png|jpg|gif|webp)$/;

export const MIME_BY_EXT: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface ExportRef {
  sha256: string;
  /** `<sha256>.<ext>` */
  file: string;
  mimeType: string;
  bytes: number;
  /** `plumb://exports/<file>` — readable with resources/read. */
  uri: string;
  /** `/files/<file>?exp=…&sig=…`, prefixed with PLUMB_PUBLIC_URL when set. */
  download: string;
  /** When `download` stops working (ISO). */
  expires: string;
}

export function exportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.PLUMB_ASSETS_DIR ?? join(process.cwd(), "plumb-assets"), "by-hash");
}

/** Plugin `format` → extension. Anything else is refused: the extension becomes a file name. */
const EXT_BY_FORMAT: Record<string, string> = { svg: "svg", png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp" };

/** Markup an exported SVG never needs and a hostile one would use once served from a web origin. */
const UNSAFE_SVG = /<script|<foreignObject|<!ENTITY|<!DOCTYPE|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:/i;

/** The bytes really are the format the plugin claimed. */
const LOOKS_LIKE: Record<string, (b: Buffer) => boolean> = {
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  webp: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  svg: (b) => {
    const text = b.toString("utf8");
    return /<svg[\s>]/i.test(text) && !UNSAFE_SVG.test(text);
  },
};

// ponytail: a per-process key — links die on restart (they live 24 h anyway) and no
// secret to configure; the gateway fetches with the bearer token, not these links.
const SIGNING_KEY = randomBytes(32);

function signature(file: string, exp: number): string {
  return createHmac("sha256", SIGNING_KEY).update(`${file}:${exp}`).digest("hex");
}

/** A signed, expiring path for one export file. */
export function signedDownload(file: string, now = Date.now(), env: NodeJS.ProcessEnv = process.env) {
  const exp = Math.floor((now + EXPORT_TTL_MS) / 1000);
  const base = (env.PLUMB_PUBLIC_URL?.trim() ?? "").replace(/\/+$/, "");
  return {
    download: `${base}/files/${file}?exp=${exp}&sig=${signature(file, exp)}`,
    expires: new Date(exp * 1000).toISOString(),
  };
}

/** True for an unexpired signature from {@link signedDownload}. */
export function signatureValid(
  file: string,
  exp: string | null,
  sig: string | null,
  now = Date.now(),
): boolean {
  const e = Number(exp);
  if (!sig || !Number.isInteger(e) || e * 1000 < now) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(signature(file, e));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Give a written export its content-addressed name (hard link, else copy); returns how to reach it. */
export function publishExport(path: string, format: string): ExportRef {
  const ext = EXT_BY_FORMAT[String(format).toLowerCase()];
  if (!ext) throw new PlumbError(`The plugin sent an unsupported export format (${String(format).slice(0, 20)}).`, "Export as SVG, PNG, JPG, GIF or WEBP.");
  const bytes = readFileSync(path);
  if (!LOOKS_LIKE[ext]!(bytes)) {
    throw new PlumbError(
      `The exported file is not a plain ${ext.toUpperCase()} (wrong content, or SVG markup with script or external content).`,
      "Export that layer again; if it persists, check the layer in Figma.",
    );
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const file = `${sha256}.${ext}`;
  const dir = exportsDir();
  const target = join(dir, file);
  mkdirSync(dir, { recursive: true });
  if (existsSync(target)) {
    const now = new Date();
    utimesSync(target, now, now); // seen again: restart its TTL
  } else {
    try {
      linkSync(path, target);
    } catch {
      copyFileSync(path, target);
    }
  }
  return {
    sha256,
    file,
    mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
    bytes: bytes.length,
    uri: `plumb://exports/${file}`,
    ...signedDownload(file),
  };
}

/** `resources/read plumb://exports/<file>`: SVG as text, bitmaps as a base64 blob. */
export function registerExportResource(server: McpServer): void {
  server.registerResource(
    "export",
    new ResourceTemplate("plumb://exports/{file}", { list: undefined }),
    {
      title: "Plumb export",
      description: "A file plumb_assets or plumb_screenshot exported, named by its SHA-256.",
    },
    async (uri, { file }) => {
      const name = String(file);
      const path = join(exportsDir(), name);
      if (!EXPORT_FILE_RE.test(name) || !existsSync(path)) {
        throw new Error(
          `Export ${name} expired or never existed. Call the tool again; the same design returns the same file.`,
        );
      }
      const ext = name.split(".")[1]!;
      const buf = readFileSync(path);
      const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";
      return {
        contents: [
          ext === "svg"
            ? { uri: uri.href, mimeType, text: buf.toString("utf8") }
            : { uri: uri.href, mimeType, blob: buf.toString("base64") },
        ],
      };
    },
  );
}

/** The MCP `resource_link` block for an export. */
export function resourceLink(ref: ExportRef, name: string) {
  return {
    type: "resource_link" as const,
    uri: ref.uri,
    name,
    mimeType: ref.mimeType,
    size: ref.bytes,
  };
}
