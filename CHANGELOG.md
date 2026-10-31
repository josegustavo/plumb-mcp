# Changelog

All notable changes to `plumb-mcp` are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
correspond to npm/git tags.

For the full commit-level history, see `git log` or the
[GitHub tags](https://github.com/tathagat22/plumb-mcp/tags) — this file
starts detailed tracking from the production-hardening pass below and is
maintained per release going forward. Earlier versions (through v0.13.2)
are summarized only briefly.

## [Unreleased]

## [0.13.3-fork.2]

### Added

- **`plumb_comments`**: each thread now has its exact pin point (`pin`), relative to the pinned node or on the canvas, and the marked area (`region`) when the comment covers one.
- **`plumb_files`**: a team's projects, a project's files with last-modified dates, or one file's metadata (last editor and time, version). Uses Figma REST, Tier 2/3.
- **`plumb_library`**: a team's published components, component sets or styles across all its files, with a name/description filter and paging. Uses Figma REST, Tier 3.
- **Defaults**: `PLUMB_FILE_KEY` is the default file for `plumb_comments` and `plumb_versions`, and `PLUMB_TEAM_ID` the default team for `plumb_files` and `plumb_library`.
- `serve` includes `plumb_files` and `plumb_library` in its read-only toolset.

### Security

- Production dependencies now audit clean:
  - zod 3 → 4.6.7 (GHSA-mrhx-c7xc-m3w5, high). Two schema type casts and four `z.record` calls were updated; no behaviour change.
  - body-parser, qs, hono, fast-uri and ip-address were updated by `npm audit fix`.

## [0.13.3-fork.1] — fork [josegustavo/plumb-mcp](https://github.com/josegustavo/plumb-mcp)

Upstream 0.13.3 plus the changes below.

### Added

- **Named styles on nodes**: `fillStyle`, `strokeStyle`, `textStyle`, `effectStyle`, `gridStyle`.
- **Text details**:
  - `textAlign` and `textValign`, italics, `paraGap`, `maxLines`;
  - links (`href`) and list types (`list`).
- **Layout and hand-off**:
  - Figma Grid auto-layout (`flow: grid`, `gridCell`) and layout grids (`grids`);
  - `annotations`, `devStatus` and export settings (`export`);
  - component property definitions in `plumb_components`.
- **`plumb_variables`**: local variable collections and named styles with their values.
- **`plumb_node includeHidden`**: hidden layers, with `hiddenFills`.
- **`plumb_comments` and `plumb_versions`**: comment threads and version history over the Figma REST API. They need `FIGMA_TOKEN` and are rate-limited per minute (Tier 2).
- **`plumb-mcp serve`**: MCP over Streamable HTTP at `/mcp`, with a bearer token (`PLUMB_MCP_TOKEN`).
  - Serves a read-only toolset by default (`PLUMB_TOOLS` overrides).
  - Returns screenshots and bitmaps inline as MCP image blocks.
  - Deletes exports after 24 h.
  - Refuses REST file reads, so they can't bypass `PLUMB_ALLOWED_FILES` or spend the Tier 1 quota; comments and versions still work.
  - Refuses to start a bridge beyond loopback without `PLUMB_PAIR_SECRET`.
- **Keyed bridge**:
  - `PLUMB_PAIR_SECRET` pairing key, plus a per-pairing upload token for `/upload` and `/asset`;
  - `PLUMB_ALLOWED_FILES`, `PLUMB_HEARTBEAT_MS` ping and drop, `PLUMB_MAX_UPLOAD_BYTES`;
  - the machine label in status and health;
  - Studio off when keyed.
- **Plugin**: a **Server…** panel (URL, key, machine name) for a remote bridge.
  - `npm run package:plugin [-- --remote <url>]` builds an importable zip.
  - Each `v*` tag attaches the zip to its GitHub release.
- **Deploy kit**: `deploy/central/` (compose, env and Caddy examples) and `docs/central-server.md`.

### Fixed

- Exports no longer overwrite an earlier file with the same name.
- The bridge no longer trusts a file path or screenshot format sent back by the plugin. A plugin on another machine could otherwise make the server read or create files outside its folders.

### Changed

- `release.yml` (npm and MCP Registry publishing) and `docs.yml` (Pages) run only on the upstream repository.

## [0.13.3]

### Added

- **`plumb-mcp demo`** — the whole design→code→verify loop offline, in one
  command. Runs the real comparison engine over a bundled Plumb Design Spec
  with 13 planted mistakes and prints what it caught, with no Figma token, no
  plugin, no browser and no network. `--json` emits the results for scripting;
  `--pds` prints the design spec it runs against. The 13/13 recall, zero false
  positives, and 71.0 → 96.2 → 100.0 convergence are asserted in
  `src/demo/demo.test.ts`, so the demo fails CI if it stops being true.
- **`docker-compose.yml`** — `docker compose up demo` runs that walkthrough in
  an isolated container with `network_mode: none`; `up bridge` serves the
  bridge and Plumb Studio on a published port; `run --rm mcp` is the stdio MCP
  server. Plus a `.devcontainer` that installs both workspaces and runs the
  demo on attach.
- **`GET /healthz`** on the bridge — liveness plus whether a plugin is actually
  paired, in-flight request count, and uptime. Used as the Compose healthcheck.
- **Structured logging** (`src/logger.ts`) — levelled, zero-dependency, always
  to stderr so stdout stays reserved for MCP framing. `PLUMB_LOG_LEVEL` and
  `PLUMB_LOG_FORMAT=json` control it.
- **Configurable bridge ports** — `PLUMB_BRIDGE_PORT`, `PLUMB_BRIDGE_PORTS`,
  and `PLUMB_BRIDGE_HOST`. Needed for more than ten concurrent sessions on one
  machine, for containers that must publish a known port, and to stop the test
  suite depending on which ports happen to be free.
- **Kubernetes deployment** under `deploy/` — a Helm chart, plain manifests,
  and a Terraform module, all producing the same locked-down deployment:
  ClusterIP, a deny-all NetworkPolicy, non-root with a read-only root
  filesystem and no capabilities, and the `restricted` Pod Security Standard
  enforced on the namespace. The bridge has no authentication of its own, so
  nothing is exposed by default and `deploy/README.md` states plainly what each
  switch opens up — and what does not work in a cluster (the Figma plugin scans
  `127.0.0.1`, so it pairs through `kubectl port-forward`).
- **Continuous design verification** — an opt-in CronJob that renders a URL you
  already serve, diffs it against the Figma node it was built from, and fails
  the Job when they drift. `plumb-mcp verify` already exits non-zero on drift;
  this puts it on a schedule.
- **A `verifier` image target** carrying Chromium and the fonts it needs, for
  the workloads that must render a page. Declared before `runner` in the
  Dockerfile so a plain `docker build .` still produces the slim server image.
- **An IaC CI workflow** — `helm lint` on defaults and on an everything-enabled
  values file, `kubeconform -strict` against real Kubernetes schemas on two
  versions, assertions that the values schema still *rejects* bad input,
  `terraform fmt`/`validate`, both image targets building, Chromium proven to
  render under the chart's exact securityContext, and a regenerate-and-diff so
  the plain manifests can never drift from the chart.
- **Dependabot** across all four npm manifests plus the GitHub Actions, and an
  `npm audit --omit=dev --audit-level=high` gate in CI.
- **Coverage reporting with an enforced floor** (`npm run test:coverage`), and
  an enforced 600-code-line cap per file via ESLint `max-lines`.
- **`cssVar` next to `var`** — when a bound variable defines Web code syntax in
  Figma (`codeSyntax.WEB`, e.g. `var(--color-brand-primary)`), it now ships
  verbatim as `cssVar` on solid fills, `strokeCssVar`, and `radiusCssVar`, so
  agents can use the team's exact CSS token instead of guessing one from the
  variable name.
- **Stroke variables** — a stroke bound to a colour variable now carries
  `strokeVar` (and `strokeCssVar`). Before, the plugin resolved the name but
  the compact `stroke` ref dropped it.

### Fixed

- Fills, strokes and corner radii bound to **team-library variables** came
  back as bare hex with no `var` name — only variables defined in the open
  file were resolved. Binding ids missing from the local map are now resolved
  with `getVariableByIdAsync` and cached
  ([#27](https://github.com/tathagat22/plumb-mcp/issues/27)).
- `computeLineHeightRatio` treated a unit-less (`"1.5"`) or percentage
  (`"150%"`) line-height as pixels and divided by the font size, reporting a
  9.4× line-height for a 150% one. Both are now classified before conversion.
- `bridge.reset()` left `lastSeen` set after a plugin disconnected, so health
  and status reported a recent heartbeat for a dead session.
- Every high-severity advisory in the shipped dependency tree (all transitive
  through the MCP SDK) is resolved.

### Changed

- **Lower memory in Figma.** The plugin no longer calls
  `figma.loadAllPagesAsync()` on open, which pulled every page of the file
  into Figma's memory. It watches only the page you're on (`nodechange`,
  re-bound on page switch) and loads the rest only when a tool needs the whole
  file: `plumb_outline`, a screen looked up by name, `plumb_search`, or
  `plumb_components`. Unloaded pages arrive with `loaded: false`, and the
  server fills them in with one `get-inventory` request. Lookups by id never
  trigger it.
- The plugin panel backs off reconnect attempts to ports with no server, from
  1.5s to 10s, instead of opening a failing socket on every empty port every
  1.5s for as long as it stays open.
- **Bounded server memory.** The plugin node cache is an LRU of 24 subtrees
  (it was unbounded until the next file edit). Staged inbound asset bytes are
  now swept on expiry even if never re-read, and capped at 128 MB. The bundle
  is built without comments or whitespace (550 KB → 416 KB, and no longer held
  as two-byte source by V8). Headless Chrome skips extensions, sync, component
  updates and background networking.
- The server exits when its MCP client disconnects (stdin closes), after
  answering any in-flight requests. Before, the bridge's listening socket kept
  it running as an orphan for every closed editor session.
- The five files over 1000 lines are split by concern, behind unchanged public
  surfaces: `src/dsl/schema.ts` → a layered `schema/` barrel,
  `src/verify.ts` → `verify/`, `src/normalize/normalize.ts` → five focused
  modules, `figma-plugin/code.ts` → five, and `figma-plugin/emit.ts` →
  `emit/`. `src/assets/search.ts` follows. No file is over 600 code lines.
- `.env.example` documents all 20 environment variables the source reads;
  README gains a full environment-variable table.
- The container user's UID/GID are pinned to 65532 rather than left to Alpine's
  allocator, so a base-image bump cannot move them out from under a Kubernetes
  `runAsUser` or the `/data` ownership.
- Test files 20 → 35, tests 208 → 621, line coverage 30% → 41%.

### Earlier in this cycle

Production-hardening pass — crash/security fixes, resource-leak fixes, and
CI/lint infrastructure, none of which change the tool contract:

- Global `uncaughtException`/`unhandledRejection` guards so one bad tool
  call can't take down every concurrent session sharing the bridge process.
- Bridge WebSocket messages are now validated before use instead of trusted
  as well-formed; malformed messages are dropped and logged, not fatal.
- A shared URL allowlist blocks `plumb_import_web` and `plumb_brand` from
  navigating to `file:`/loopback/private-IP addresses.
- `plumb_screenshot`'s `out` path is confined to the cwd/screenshots root;
  `plumb_fig_outline`/`plumb_fig_node` require a `.fig` extension.
- Tree walks that previously recursed on untrusted input (Figma pre-walk,
  the HTML/web semantic-graph builder) are now iterative, and pasted
  DSL/PDS documents are bounds-checked before validation — pathological
  input degrades gracefully instead of risking a stack overflow.
- Timeouts added everywhere a network call previously had none: Figma REST,
  Google Fonts, the hand-rolled CDP client, and the Anthropic fit generator.
- `plumb-mcp init` now gitignores the config files it writes and warns if a
  real `FIGMA_TOKEN` would land in a file git already tracks.
- Bridge upload/asset-request bookkeeping now has a TTL and is swept
  immediately on plugin disconnect, instead of leaking indefinitely.
- The plugin's shared write queue times out a stuck operation so it can't
  strand another session's request past its own watchdog.
- SIGINT/SIGTERM now close any open headless-Chrome sessions before exit; a
  failed Chrome launch cleans up its process and temp profile dir.
- Real CI (typecheck, lint, test, build) now runs on every push/PR — the
  Vitest suite was previously never run in CI at all. Added a minimal
  ESLint config.

## [0.13.x] — prompt→design, Studio, security badges

Prompt→design write direction (`plumb_studio`/`plumb_brand`/`plumb_design`/
`plumb_review`), Plumb Studio (the live local cockpit), and the bespoke
marketing homepage shipped across v0.13.0–v0.13.2.

## [0.12.0] — self-healing fit loop

`plumb_fit`, the autonomous `plumb-mcp fit` CLI, and the browser playground.

## Earlier

v0.6.0 through v0.10.9 built out the core Figma → code read path: PDS
normalization, the plugin bridge, `plumb_verify`, design tokens, variables,
multi-agent session support, and progressive fidelity work (blend modes,
gradients, masks, motion). See git tags for exact scope per version.
