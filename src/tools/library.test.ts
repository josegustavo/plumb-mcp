import { describe, expect, it } from "vitest";
import { libraryRows } from "./library";
import { parseTeamOrProject } from "./files";
import type { RestLibraryItem } from "../figma/rest";

const items: RestLibraryItem[] = [
  {
    key: "k1",
    file_key: "F1",
    node_id: "1:2",
    name: "Button / Primary",
    description: "Main call to action",
    thumbnail_url: "https://s3/thumb.png",
    containing_frame: { pageName: "Components", containingComponentSet: { name: "Button" } },
  },
  { key: "k2", file_key: "F1", node_id: "3:4", name: "Brand/Blue", style_type: "FILL" },
];

describe("plumb_library / plumb_files helpers", () => {
  it("keeps rows compact, filters by name or description, drops thumbnails unless asked", () => {
    expect(libraryRows(items, { query: "call to" })).toEqual([
      {
        name: "Button / Primary",
        description: "Main call to action",
        file: "F1",
        node: "1:2",
        page: "Components",
        set: "Button",
        key: "k1",
      },
    ]);
    expect(libraryRows(items, { query: "BRAND" })[0]).toMatchObject({ name: "Brand/Blue", type: "FILL" });
    expect(libraryRows(items, { thumbnails: true })[0]!.thumbnail).toBe("https://s3/thumb.png");
  });

  it("reads team and project ids from browser links", () => {
    expect(parseTeamOrProject("https://www.figma.com/files/team/123456/recents")).toEqual({ teamId: "123456" });
    expect(parseTeamOrProject("https://www.figma.com/files/987/project/42/Marketing")).toEqual({ projectId: "42" });
    expect(parseTeamOrProject("https://www.figma.com/design/abc/File")).toEqual({});
    expect(parseTeamOrProject(undefined)).toEqual({});
  });
});
