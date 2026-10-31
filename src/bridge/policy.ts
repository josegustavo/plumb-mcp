import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pairing and exposure policy for a bridge that is reachable beyond loopback
 * (a central server behind a reverse proxy). Everything comes from env and
 * defaults to the local behaviour: no key, any file, Studio on.
 *
 *   PLUMB_PAIR_SECRET      the plugin must send this key to pair; also turns on
 *                          upload tokens and turns Studio off (PLUMB_STUDIO=1 to keep it)
 *   PLUMB_ALLOWED_FILES    comma-separated Figma file names a plugin may serve
 *   PLUMB_HEARTBEAT_MS     server ping interval (default 20000, 0 = off)
 *   PLUMB_MAX_UPLOAD_BYTES upload size cap (default 64 MB)
 */

export function pairSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PLUMB_PAIR_SECRET?.trim() || undefined;
}

/** True when no key is configured, or `given` equals it (constant-time). */
export function secretMatches(given: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const secret = pairSecret(env);
  if (!secret) return true;
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when no allow-list is configured, or `fileName` is on it (case-insensitive). */
export function fileAllowed(fileName: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const list = env.PLUMB_ALLOWED_FILES?.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list?.length) return true;
  return typeof fileName === "string" && list.includes(fileName.trim().toLowerCase());
}

/** Fresh per-pairing token the plugin appends to upload / asset URLs. */
export function newUploadToken(): string {
  return randomBytes(18).toString("base64url");
}

export function heartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PLUMB_HEARTBEAT_MS?.trim();
  const n = raw === undefined || raw === "" ? 20_000 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 20_000;
}

/** Studio exposes the live event stream, so a keyed (exposed) bridge keeps it off unless asked. */
export function studioAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PLUMB_STUDIO === "0") return false;
  return !pairSecret(env) || env.PLUMB_STUDIO === "1";
}

export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PLUMB_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 64 * 1024 * 1024;
}

/** A display label from the plugin: trimmed, single line, at most 60 chars. */
export function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 60);
  return s || null;
}
