# Central server

Run Plumb once, next to your other services, and a whole team can use it
without installing Figma desktop, the plugin, or Plumb. One machine runs
Figma desktop with the plugin open and pairs with the server over HTTPS.
Everyone else talks to the server over MCP.

```
MCP clients / gateway ──HTTP /mcp (bearer)──►  plumb-mcp serve  ◄──WSS + HTTPS (key)── Figma desktop + plugin
                                                 (container)        via your reverse proxy
```

Design reads go through the plugin, so they use no Figma API quota and work on
every Figma plan. The server refuses REST file reads (`fileKey` / `url`
arguments). They would skip `PLUMB_ALLOWED_FILES` and spend the plan's small
monthly Tier 1 quota for every client.

Only four tools call the REST API, all for things the Plugin API can't read:
`plumb_comments`, `plumb_versions`, `plumb_files` (team projects, project files,
file metadata) and `plumb_library` (the team's published components and
styles). They need a personal access token (`FIGMA_TOKEN`, free, read-only
scopes are enough) and fall under Figma's per-minute Tier 2/3 limits, not the
monthly quota. Set `PLUMB_FILE_KEY` and `PLUMB_TEAM_ID` so requests don't need
to paste a link.

## What `plumb-mcp serve` changes

| | stdio (default) | `serve` |
|---|---|---|
| MCP transport | stdin/stdout, one client | Streamable HTTP at `/mcp`, many clients, stateless. `/health` needs no auth. |
| Auth | none (local process) | `Authorization: Bearer $PLUMB_MCP_TOKEN`, required beyond loopback |
| Tools | all | Read-only set: status, outline, node, query, search, describe, components, variables, tokens, screenshot, assets, comments, versions, files, library, audit, diff. `PLUMB_TOOLS=all` or a comma list overrides it. |
| Files | paths on this machine | named by SHA-256, linked, deleted after 24 h unused (see below) |

## Files: how exports reach a remote client

Every file `plumb_assets` or `plumb_screenshot` writes is also named by its
content, `<sha256>.<ext>`. Exporting the same design again gives the same name:
nothing is duplicated, and a client or gateway that already holds that hash
needs no new download. Each export row carries `sha256`, `mimeType`, `bytes`,
`uri`, `download` and `expires`, so the client picks how to get the bytes:

| Need | What to use |
|---|---|
| The model should **see** a screenshot or bitmap | Image blocks. `plumb_screenshot` sends one by default; `plumb_assets` sends them with `view: true`. Up to `PLUMB_INLINE_MAX_BYTES` (5 MB) per response. |
| SVG markup to put in code | `source` on the row. Inline by default, up to 100 KB; bigger SVGs are links only. |
| The **file** itself, from a client that supports MCP resources | The `resource_link` block: `resources/read plumb://exports/<file>` (SVG as text, bitmaps as a base64 blob). |
| The file, by plain HTTP (older clients, scripts, a gateway) | `GET /files/<file>` on the MCP port: send the bearer token, or use the row's signed `download` link, which needs no header and expires in 24 h. `PLUMB_PUBLIC_URL` turns it into an absolute URL. |

Bitmaps never travel as base64 unless asked for. A file deleted after 24 h
unused answers 404 with "call the tool again"; the same design comes back
under the same name.

## Bridge hardening

`serve` refuses to start when the bridge binds beyond loopback without
`PLUMB_PAIR_SECRET`.

| Variable | Effect |
|---|---|
| `PLUMB_PAIR_SECRET` | The plugin must send this key to pair. The check is constant-time, and a wrong key closes the socket. Each pairing also gets a token the plugin must send to `/upload` and `/asset`. Plumb Studio turns off (`PLUMB_STUDIO=1` keeps it on). |
| `PLUMB_ALLOWED_FILES` | Comma-separated Figma file names the plugin may serve. Any other file is refused at pairing or at its first inventory. |
| `PLUMB_HEARTBEAT_MS` | Server ping interval (default 20000; `0` = off). A plugin that answered pings and then stays silent for 3 intervals is dropped, which frees the pairing slot (a sleeping laptop, a dead proxy connection). |
| `PLUMB_MAX_UPLOAD_BYTES` | Upload cap (default 64 MB). |

Only one plugin can be paired at a time. A second one is refused with the first
one's machine name, e.g. `Another Plumb plugin is already paired (Office PC).`
`plumb_status` and `/healthz` show which machine and file are connected.

What keeps strangers out, in order:

1. Your reverse proxy exposes the bridge on one path, to one network only.
2. The pairing key.
3. The per-pairing upload token.

`/mcp` should stay on the internal network, behind the bearer token. The
server never trusts file paths or formats the plugin sends back, so a rogue
plugin can't read or write files on the server.

## Deploy

1. **Image.** Use the prebuilt `ghcr.io/josegustavo/plumb-mcp:<tag>`
   (linux/amd64 and arm64), or push a `v*` tag to your own fork:
   `.github/workflows/docker.yml` publishes `ghcr.io/<owner>/plumb-mcp`.
   Public GHCR packages are free.
2. **Container.** Copy `deploy/central/.env.example` to `.env`, fill in the
   secrets, then run `docker compose up -d` with
   `deploy/central/docker-compose.yml`. No host ports are published.
3. **Reverse proxy.** Expose only the bridge, on one path, only to the Figma
   machine's network. See `deploy/central/Caddyfile.example`. Keep `/mcp`
   internal.
4. **Plugin.** Download `plumb-figma-plugin-<version>.zip` from the
   [releases](https://github.com/josegustavo/plumb-mcp/releases). Or build
   one with your URL already filled in (keep that zip private: it names your
   bridge path):

   ```bash
   npm run package:plugin -- --remote https://example.com/plumb-bridge-7f3k9q/
   ```

   On the Figma machine:
   1. Unzip somewhere permanent.
   2. In Figma, choose *Plugins → Development → Import plugin from manifest…*
      and run the plugin.
   3. Click **Server…**, enter the URL (if not pre-filled), the pairing key
      and a machine name, then **Save** → **Pair**.
   4. Minimize the plugin and leave it running.

   The key is stored in Figma's plugin storage on that machine and is never in
   the zip.
5. **Clients.** Point MCP clients (or your MCP gateway) at
   `http://plumb:8080/mcp` with the bearer token.

**Updating:** set the new tag in `PLUMB_IMAGE`, then run
`docker compose pull && docker compose up -d`. When the plugin's version
changes, re-import the new zip.

## Logs

The server logs to stderr: one JSON object per line with `PLUMB_LOG_FORMAT=json`.
At the default `info` level it writes:

- startup;
- each pairing (plugin version, machine, peer address);
- each rejection (wrong key, file not allowed, slot taken);
- disconnects and heartbeat drops;
- errors.

It writes no line per MCP request or tool call, and never logs tokens, keys or
tool arguments. `PLUMB_LOG_LEVEL=debug` adds a line per connection and per
asset reply. The compose file rotates Docker's log (3 × 10 MB). Per-call usage
and audit logs belong in the MCP gateway in front of `/mcp`.

Your reverse proxy writes its own access log only if you turn one on (in Caddy,
a `log` directive in the site block). That log would hold the bridge path and
the upload token in `/upload?k=…` URLs. The token is valid only while that
plugin stays paired, and only for staging bytes. Caddy redacts
`Authorization` and cookie headers by default.

## Limits

- One Figma file at a time: whatever is open where the plugin runs.
- Figma must stay open with the plugin running. Figma has no background or
  auto-start for plugins, so if it restarts, someone re-runs the plugin.
- Everything the server reads, it reads as the Figma account on that machine.
- Figma loads development plugins only in Figma desktop, from a manifest
  folder. The web app can't run them unless the plugin is published to the
  Figma Community or to an organisation.
