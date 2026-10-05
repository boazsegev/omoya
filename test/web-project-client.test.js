import { expect, test } from "bun:test";
import { session } from "../lib/app/web/public/app/orchestrators/session.js";

test("project packets update the client state and invalidate the header", () => {
  const invalidated = [];
  const ctx = { state: { projects: [], scope: "project", canManageProjects: false }, invalidate: (region) => invalidated.push(region) };
  const projects = [{ name: "docs", path: "/tmp/docs", url: "/docs/", current: true }];
  session.packets.projects(ctx, { projects, scope: "all", canManageProjects: true });
  expect(ctx.state.projects).toEqual(projects);
  expect(ctx.state.scope).toBe("all");
  expect(ctx.state.canManageProjects).toBe(true);
  // Sidebar rows name their project in the all-projects view.
  expect(invalidated).toEqual(["header", "sidebar", "panels"]);
  session.packets.projects(ctx, { projects, canManageProjects: false });
  expect(ctx.state.canManageProjects).toBe(false);
});
