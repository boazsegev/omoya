// test/web-app-sessions.test.js — saved-session and running-agent grouping for the web sidebar.
import { expect, test } from "bun:test";
import { sessionGroups } from "../lib/app/web/public/app/logic/sessions.js";
import { agentGroups, sortedAgents } from "../lib/app/web/public/app/logic/agents.js";

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

test("agent display order sorts roots and children by name without mutating the packet", () => {
  const agents = [
    { id: "z", name: "Zulu", children: [{ id: "z2", name: "zebra" }, { id: "z1", name: "Alpha" }] },
    { id: "a", name: "Beta", children: [] },
  ];
  expect(sortedAgents(agents).map((a) => a.name)).toEqual(["Beta", "Zulu"]);
  expect(sortedAgents(agents)[1].children.map((a) => a.name)).toEqual(["Alpha", "zebra"]);
  expect(agents.map((a) => a.name)).toEqual(["Zulu", "Beta"]);
  agents[0].name = "Aardvark";
  expect(sortedAgents(agents).map((a) => a.name)).toEqual(["Aardvark", "Beta"]);
  expect(agents.map((a) => a.name)).toEqual(["Aardvark", "Beta"]);
  expect(agents[0].children.map((a) => a.name)).toEqual(["zebra", "Alpha"]);
});

test("running agents group under their project, children counted, aggregate state, projects sorted", () => {
  const agents = [
    { id: "z", project: "/z", state: "disconnected" },
    { id: "a", project: "/a", state: "idle", children: [{ id: "a.1", project: "/a", busy: true }] },
    { id: "a2", project: "/a", state: "idle" },
  ];
  const groups = agentGroups({ agents, projects });
  expect(groups.map((g) => [g.name, g.total, g.state, g.items.map((a) => a.id)])).toEqual([["alpha", 3, "working", ["a", "a2"]], ["zeta", 1, "disconnected", ["z"]]]);
});
