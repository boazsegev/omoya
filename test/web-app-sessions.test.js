// test/web-app-sessions.test.js — saved-session grouping for the web sidebar.
import { expect, test } from "bun:test";
import { sessionGroups } from "../lib/app/web/public/app/logic/sessions.js";

const projects = [
  { name: "zeta", path: "/z", current: true },
  { name: "alpha", path: "/a" },
  { name: "mid", path: "/m" },
];
const recent = [
  { id: "z1", project: "/z", preview: "fix the build" },
  { id: "a1", project: "/a", preview: "write docs" },
  { id: "a2", project: "/a", agent: "builder", preview: "release" },
];

test("the all-projects view groups every project's sessions, projects sorted alphabetically", () => {
  const groups = sessionGroups({ recent, projects, scope: "all" });
  expect(groups.map((g) => [g.name, g.total, g.items.map((s) => s.id)])).toEqual([["alpha", 2, ["a1", "a2"]], ["mid", 0, []], ["zeta", 1, ["z1"]]]);
});

test("a project view shows only the current project", () => {
  expect(sessionGroups({ recent, projects, scope: "project" }).map((g) => [g.name, g.total])).toEqual([["zeta", 1]]);
});

test("a group view shows its member projects only", () => {
  const grouped = projects.map((p) => ({ ...p, groups: p.name === "mid" ? [] : ["g"] }));
  expect(sessionGroups({ recent, projects: grouped, scope: "group", group: "g" }).map((g) => g.name)).toEqual(["alpha", "zeta"]);
});

test("the filter narrows items but keeps each project's total", () => {
  const groups = sessionGroups({ recent, projects, scope: "all", query: " BUILD" });
  expect(groups.map((g) => [g.name, g.total, g.items.map((s) => s.id)])).toEqual([["alpha", 2, ["a2"]], ["mid", 0, []], ["zeta", 1, ["z1"]]]);
});
