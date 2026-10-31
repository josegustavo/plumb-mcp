import { z } from "zod";
import { fetchFileMeta, fetchProjectFiles, fetchTeamProjects } from "../figma/rest";
import { parseFigmaUrl } from "../figma/url";
import { PlumbError } from "../errors";
import { isHosted } from "../hosted";
import { checkRestScope, fail, ok, pinnedIds, requireToken } from "./shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const DESCRIPTION =
  "Find Figma files without opening them: a team's projects (`teamId`, or the " +
  "server's PLUMB_TEAM_ID), a project's files with last-modified dates " +
  "(`projectId`), or one file's metadata — name, last editor and time, " +
  "version (`fileKey` / file `url`). Team and project ids are in the browser " +
  "URL (figma.com/files/team/<id>/…, …/project/<id>/…). REST path: needs " +
  "FIGMA_TOKEN; one per-minute (Tier 2/3) request per call, not the monthly " +
  "file-read quota.";

/** Team or project id from a figma.com/files/… link. */
export function parseTeamOrProject(url: string | undefined): { teamId?: string; projectId?: string } {
  const m = url ? /\/(team|project)\/(\d+)/.exec(url) : null;
  if (!m) return {};
  return m[1] === "team" ? { teamId: m[2] } : { projectId: m[2] };
}

/** Registers the `plumb_files` MCP tool. */
export function registerPlumbFiles(server: McpServer): void {
  server.registerTool(
    "plumb_files",
    {
      title: "Plumb · files",
      description: DESCRIPTION,
      inputSchema: {
        url: z.string().optional().describe("A team, project or file link from the Figma browser URL."),
        teamId: z.string().optional().describe("List this team's projects. Default: PLUMB_TEAM_ID."),
        projectId: z.string().optional().describe("List this project's files."),
        fileKey: z.string().optional().describe("Return this file's metadata."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const fromUrl = parseTeamOrProject(args.url);
        const fileKey = args.fileKey ?? (args.url ? parseFigmaUrl(args.url)?.fileKey : undefined);
        const projectId = args.projectId ?? fromUrl.projectId;
        const teamId = args.teamId ?? fromUrl.teamId ?? (fileKey || projectId ? undefined : pinnedIds("team")[0]);
        const token = requireToken(true);

        if (fileKey) {
          const m = await fetchFileMeta(checkRestScope("file", fileKey), token);
          return ok({
            source: "rest",
            fileKey,
            name: m.name,
            ...(m.folder_name ? { project: m.folder_name } : {}),
            lastEdited: m.last_touched_at,
            lastEditedBy: m.last_touched_by?.handle,
            ...(m.creator?.handle ? { creator: m.creator.handle } : {}),
            ...(m.editorType ? { editor: m.editorType } : {}),
            ...(m.version ? { version: m.version } : {}),
          });
        }
        if (projectId) {
          checkRestScope("project", projectId);
          const teams = pinnedIds("team");
          if (isHosted() && teams.length) {
            // A pinned server reads only its teams' projects (one extra Tier 2 call).
            const owned = await Promise.all(teams.map((t) => fetchTeamProjects(t, token)));
            if (!owned.some((t) => t.projects.some((p) => p.id === projectId))) {
              throw new PlumbError(
                "That project is not in this server's Figma team.",
                "Call figma_files with no arguments to list the team's projects.",
              );
            }
          }
          const p = await fetchProjectFiles(projectId, token);
          const files = [...p.files]
            .sort((a, b) => (b.last_modified ?? "").localeCompare(a.last_modified ?? ""))
            .map((f) => ({ key: f.key, name: f.name, ...(f.last_modified ? { modified: f.last_modified } : {}) }));
          return ok({ source: "rest", projectId, project: p.name, count: files.length, files });
        }
        if (teamId) {
          const t = await fetchTeamProjects(checkRestScope("team", teamId), token);
          return ok({
            source: "rest",
            teamId,
            team: t.name,
            count: t.projects.length,
            projects: t.projects,
            next: "Call plumb_files with a projectId to list its files.",
          });
        }
        throw new PlumbError(
          "No team, project or file given.",
          "Pass a Figma link, `teamId`, `projectId` or `fileKey` — or set PLUMB_TEAM_ID on the server.",
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
