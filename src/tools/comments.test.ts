import { describe, expect, it } from "vitest";
import { threadComments } from "./comments";
import type { RestComment } from "../figma/rest";

const raw: RestComment[] = [
  { id: "1", order_id: "1", message: "Old root", created_at: "2026-10-01T10:00:00Z", user: { handle: "Ana" }, client_meta: { node_id: "1:2" } },
  { id: "2", parent_id: "1", message: "Second reply", created_at: "2026-10-03T10:00:00Z", user: { handle: "Jose" } },
  { id: "3", parent_id: "1", message: "First reply", created_at: "2026-10-02T10:00:00Z", user: { handle: "Ana" } },
  { id: "4", order_id: "2", message: "New root", created_at: "2026-10-05T10:00:00Z", user: { handle: "Jose" }, client_meta: { x: 10, y: 20 } },
  { id: "5", order_id: "3", message: "Done", created_at: "2026-10-04T10:00:00Z", resolved_at: "2026-10-06T10:00:00Z", client_meta: { node_id: "1:2" } },
];

describe("threadComments", () => {
  it("groups replies oldest-first under roots, newest root first, hides resolved", () => {
    const threads = threadComments(raw);
    expect(threads.map((t) => t.id)).toEqual(["4", "1"]);
    expect(threads[1]!.replies.map((r) => r.message)).toEqual(["First reply", "Second reply"]);
    expect(threads[1]!.node).toBe("1:2");
    expect(threads[0]!.node).toBeUndefined();
  });

  it("includes resolved threads and filters by node id on request", () => {
    const threads = threadComments(raw, { includeResolved: true, nodeIds: ["1:2"] });
    expect(threads.map((t) => t.id)).toEqual(["5", "1"]);
    expect(threads[0]!.resolved).toBe("2026-10-06T10:00:00Z");
    expect(threads[0]!.author).toBe("unknown");
  });
});
