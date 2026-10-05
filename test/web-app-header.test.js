import { expect, test } from "bun:test";
import { headerPresentation, projectChoices, groupChoices, groupUrl, groupReachable } from "../lib/app/web/public/app/logic/header.js";
import { agentDisplayName } from "../lib/app/web/public/app/logic/agents.js";

const base = { isOnline: true, activity: "idle", throttledUntil: null, projects: [] };

test("header reports readiness before a throttle countdown is available", () => {
  expect(headerPresentation({ ...base, now: 1000 }).accessibleLabel).toBe("Connection: Ready");
});

test("header includes a pending throttle countdown in its accessible label", () => {
  const result = headerPresentation({ ...base, throttledUntil: 6000, now: 1000 });
  expect(result.accessibleLabel).toBe("Connection: Ready · continuing in 5s");
  expect(result.wait).toBe(" · continuing in 5s");
});

test("header identifies the active project without changing the other projects", () => {
  const projects = [
    { name: "Other", path: "/other", url: "/p/other", current: false },
    { name: "Here", path: "/here", url: "/p/here", current: true },
  ];
  expect(headerPresentation({ ...base, projects, now: 1000 }).project).toBe(projects[1]);
  expect(projectChoices(projects, false)).toEqual([
    { label: "Other", detail: "/other", current: false, url: "/p/other", path: "/other" },
    { label: "Here", detail: "/here", current: true, url: "/p/here", path: "/here" },
    { separator: true },
    { label: "All projects", detail: "Show every project's agents", url: "/", view: true },
  ]);
  expect(projectChoices(projects, false, "all").at(-1)).toEqual({ label: "Only Here", detail: "Hide other projects' agents", url: "/p/here", view: true });
  expect(projectChoices(projects.slice(1), false, "all")).toHaveLength(1);
  expect(projectChoices(projects, true).at(-1)).toEqual({ label: "Add project…", add: true });
});

test("group menu lists every known group, marks membership, and offers a new group", () => {
  const projects = [{ name: "iodine", groups: ["ruby", "c"] }, { name: "fio", groups: ["c"] }, { name: "paper" }];
  expect(groupChoices(projects[1], projects)).toEqual([
    { label: "c", group: "c", member: false, current: true },
    { label: "ruby", group: "ruby", member: true, current: false },
    { separator: true },
    { label: "New group…", create: true },
  ]);
  expect(groupChoices(projects[2], [projects[2]])).toEqual([{ label: "New group…", create: true }]);
});

test("agent names carry their project while several projects are visible", () => {
  const projects = [{ path: "path-iodine", name: "iodine" }, { path: "path-fio", name: "fio" }];
  const agent = { id: "a1", name: "main", project: "path-fio" };
  expect(agentDisplayName(agent, { scope: "all", projects })).toBe("fio/main");
  expect(agentDisplayName(agent, { scope: "project", projects })).toBe("main"); // one project's view
  expect(agentDisplayName(agent, { scope: "all", projects: [projects[1]] })).toBe("main"); // one project served
  expect(agentDisplayName({ id: "a2", project: "path-fio" }, { scope: "all", projects })).toBe("fio/a2");
});

test("project menu offers the all-projects view, each reachable group's view, and the current project; group members switch in place", () => {
  const projects = [
    { name: "here", path: "/here", url: "/here/", current: true, groups: ["c", "web"] },
    { name: "other", path: "/other", url: "/other/", groups: ["c"] },
    { name: "group:web", path: "/clash", url: "/group%3Aweb/" }, // its URL wins over the "web" group view
  ];
  const choices = projectChoices(projects, false, "group", "c");
  expect(choices.filter((c) => c.path).map((c) => [c.label, c.inView === true])).toEqual([["here", true], ["other", true], ["group:web", false]]);
  expect(choices.filter((c) => c.view).map((c) => [c.label, c.url])).toEqual([["All projects", "/"], ["Only here", "/here/"]]);
  expect(projectChoices(projects, false, "all").filter((c) => c.view).map((c) => c.url)).toEqual(["/group:c/", "/here/"]);
  expect(projectChoices(projects, false, "project").filter((c) => c.view).map((c) => c.url)).toEqual(["/", "/group:c/"]);
  expect(groupUrl("a b")).toBe("/group:a%20b/");
  expect(groupReachable("web", projects)).toBe(false);
});

test("agents carry their project label in a group view of several projects only", () => {
  const projects = [{ name: "a", path: "/a", groups: ["g"] }, { name: "b", path: "/b", groups: ["g"] }, { name: "c", path: "/c", groups: ["solo"] }];
  expect(agentDisplayName({ name: "x", project: "/a" }, { projects, scope: "group", group: "g" })).toBe("a/x");
  expect(agentDisplayName({ name: "x", project: "/c" }, { projects, scope: "group", group: "solo" })).toBe("x");
});
