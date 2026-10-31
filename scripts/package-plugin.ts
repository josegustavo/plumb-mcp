/**
 * Package the Figma plugin as one zip a designer can import:
 *
 *   npm run package:plugin                          # local servers only
 *   npm run package:plugin -- --remote https://host/plumb-bridge-x/
 *
 * With --remote (or PLUMB_PLUGIN_REMOTE_URL) the zip's ui.html is pre-filled
 * with that central-server URL and manifest.json allows its origin, so the
 * only thing left to type in the plugin is the pairing key. The key is never
 * baked in: the zip is safe to attach to a public release.
 *
 * Output: dist-plugin/plumb-figma-plugin-<version>[-<host>].zip
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "figma-plugin");
const outDir = join(root, "dist-plugin");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

const argIdx = process.argv.indexOf("--remote");
const remoteArg = argIdx > -1 ? process.argv[argIdx + 1] : process.env.PLUMB_PLUGIN_REMOTE_URL;
const remote = remoteArg?.trim() || "";

let origin = "";
if (remote) {
  const u = new URL(remote);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`--remote must be http(s): ${remote}`);
  origin = u.host;
}

const stage = join(outDir, "plumb-figma-plugin");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8"));
if (origin) {
  const extra = [`https://${origin}`, `wss://${origin}`];
  manifest.networkAccess.allowedDomains = [...new Set([...manifest.networkAccess.allowedDomains, ...extra])];
  manifest.networkAccess.reasoning +=
    ` This build also connects to a central Plumb server at ${origin}, which the user's organisation runs.`;
}
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const ui = readFileSync(join(src, "ui.html"), "utf8");
const marker = /var DEFAULT_REMOTE_URL = "[^"]*"; \/\/ @plumb-remote-default/;
if (!marker.test(ui)) throw new Error("ui.html lost its @plumb-remote-default marker");
writeFileSync(
  join(stage, "ui.html"),
  ui.replace(marker, () => `var DEFAULT_REMOTE_URL = ${JSON.stringify(remote)}; // @plumb-remote-default`),
);

copyFileSync(join(src, "code.js"), join(stage, "code.js"));
copyFileSync(join(src, "icon.png"), join(stage, "icon.png"));
writeFileSync(
  join(stage, "INSTALL.txt"),
  [
    `Plumb Figma plugin ${version}`,
    "",
    "1. Unzip this folder somewhere permanent (e.g. Documents/Plumb Plugin).",
    "   Figma loads the plugin from here every time it runs — don't delete it.",
    "2. Figma desktop → Plugins → Development → Import plugin from manifest…",
    "   and pick manifest.json in this folder. (Only the desktop app can import.)",
    "3. Run Plugins → Development → Plumb.",
    remote
      ? `4. Click "Server…": the URL (${remote}) is filled in. Type the pairing key\n   and this machine's name, Save, then Pair on the "Central server" row.`
      : '4. Click "Pair" on the row of the Plumb server you want. For a central\n   server, click "Server…" and enter its URL and pairing key first.',
    "5. Keep the plugin running (Minimize turns it into a small dot).",
    "",
    "Updating: replace this folder's files with the new zip's, then re-run the plugin.",
    "",
  ].join("\n"),
);

const zipName = `plumb-figma-plugin-${version}${origin ? `-${origin.replace(/[^a-z0-9.-]/gi, "_")}` : ""}.zip`;
rmSync(join(outDir, zipName), { force: true });
execFileSync("zip", ["-rq", zipName, "plumb-figma-plugin"], { cwd: outDir });
console.log(`✓ ${join("dist-plugin", zipName)}${remote ? `  (central server: ${remote})` : ""}`);
