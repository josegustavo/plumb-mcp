/**
 * Hosted mode: `plumb-mcp serve` runs Plumb as a shared HTTP MCP server (one
 * Figma machine, many remote clients). Remote clients can't read this
 * machine's disk, so tools inline their images; and the default toolset is
 * Figma reads only — no canvas writes, no local-file or arbitrary-URL tools.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function isHosted(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUMB_TRANSPORT === "http";
}

/** The tools a hosted server registers unless PLUMB_TOOLS says otherwise. */
export const HOSTED_TOOLS = [
  "plumb_status",
  "plumb_outline",
  "plumb_node",
  "plumb_query",
  "plumb_search",
  "plumb_describe",
  "plumb_components",
  "plumb_variables",
  "plumb_tokens",
  "plumb_screenshot",
  "plumb_assets",
  "plumb_comments",
  "plumb_versions",
  "plumb_audit",
  "plumb_diff",
] as const;

/**
 * Which tools to register: `PLUMB_TOOLS=all` or a comma list wins; otherwise
 * hosted mode gets {@link HOSTED_TOOLS} and stdio gets everything (null).
 */
export function toolAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = env.PLUMB_TOOLS?.trim();
  if (raw === "all") return null;
  if (raw) return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return isHosted(env) ? new Set<string>(HOSTED_TOOLS) : null;
}

let registered: readonly string[] = [];

/** Recorded by createServer(): the tool names that passed the allow-list. */
export function setRegisteredTools(names: readonly string[]): void {
  registered = names;
}

export function registeredTools(): readonly string[] {
  return registered;
}

/** How long a hosted server keeps exported files. Remote clients get the bytes
 *  inline and can't reach this disk, so without a sweep they only pile up. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;

/** Delete files older than {@link EXPORT_TTL_MS} under each dir; returns how many. */
export function sweepExports(dirs: readonly string[], now = Date.now()): number {
  let removed = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir, { recursive: true, encoding: "utf8" });
    } catch {
      continue; // nothing exported yet
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (st.isFile() && now - st.mtimeMs > EXPORT_TTL_MS) {
          unlinkSync(path);
          removed++;
        }
      } catch {
        // gone already — a concurrent export renamed or removed it
      }
    }
  }
  return removed;
}

/** Largest image a hosted tool inlines as an MCP image block (PLUMB_INLINE_MAX_BYTES, default 5 MB). */
export function inlineMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PLUMB_INLINE_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024;
}
