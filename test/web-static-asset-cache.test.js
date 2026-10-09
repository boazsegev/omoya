import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { startWebHost, staticAssets, viewRoute } from "../lib/app/web/host.js";

function registry() {
  const workspace = { stop() {}, themeCss: () => "theme{}" };
  const entry = { path: "/project", workspace, env: { agents: () => [] }, owned: false };
  let listCalls = 0;
  return {
    entries: [entry],
    list() { listCalls++; return [{ path: entry.path, url: "/project/" }]; },
    url: (path) => path === entry.path ? "/project/" : undefined,
    members: (group) => group === "team" ? [entry] : [],
    get listCalls() { return listCalls; },
  };
}

test("startup reads static assets once and scoped routes serve the same snapshot", async () => {
  const target = registry();
  const host = startWebHost(target, { port: 0 });
  try {
    const expected = readFileSync(new URL("../lib/app/web/public/app.js", import.meta.url), "utf8");
    for (const route of ["/", "/project/", "/group:team/"]) {
      const response = await fetch(new URL(route, host.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("<html");
    }
    for (const route of ["/app.js", "/project/app.js", "/group:team/app.js", "/group%3Ateam/app.js"]) {
      const response = await fetch(new URL(route, host.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain("default-src");
      expect(await response.text()).toBe(expected);
    }
    for (const route of ["/style.css", "/project/style.css", "/group:team/style.css"]) {
      const response = await fetch(new URL(route, host.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/css");
      await response.text();
    }
    expect((await fetch(new URL("/group:missing/app.js", host.url))).status).toBe(404);
    expect((await fetch(new URL("/styles.css", host.url))).status).toBe(404);
    expect((await fetch(new URL("/project/missing.js", host.url))).status).toBe(404);
    expect((await fetch(new URL("/project/app.js", host.url), { method: "POST" })).status).toBe(404);
    expect((await fetch(new URL("/project/../app.js", host.url))).status).toBe(200);
  } finally { await host.stop(); }
});

test("static snapshot reads each allowed file once and reuses its bodies", () => {
  const reads = new Map();
  const assets = staticAssets((path) => {
    reads.set(path, (reads.get(path) ?? 0) + 1);
    return readFileSync(path, "utf8");
  });
  expect(assets.get("/app.js")).toContain("import");
  const firstBody = assets.get("/app.js");
  expect(assets.get("/app.js")).toBe(firstBody);
  expect(assets.has("/styles.css")).toBe(false);
  expect([...reads.values()].every((count) => count === 1)).toBe(true);
  expect(reads.size).toBeGreaterThan(0);
});

test("project routes use live URLs and do not derive the full project listing", () => {
  const target = registry();
  expect(viewRoute(target, "/project/app.js").workspace).toBe(target.entries[0].workspace);
  expect(target.listCalls).toBe(0);
  target.url = () => "/renamed/";
  expect(viewRoute(target, "/renamed/app.js").workspace).toBe(target.entries[0].workspace);
  expect(viewRoute(target, "/project/app.js").workspace).toBeNull();
  expect(target.listCalls).toBe(0);
});

test("longest live project route wins over groups and shorter prefixes", () => {
  const target = registry();
  const nested = { path: "/nested", workspace: { nested: true } };
  target.entries.push(nested);
  target.url = (path) => path === nested.path ? "/project/nested/" : "/project/";
  expect(viewRoute(target, "/project/nested/app.js").workspace).toBe(nested.workspace);
  expect(viewRoute(target, "/project/app.js").workspace).toBe(target.entries[0].workspace);
  expect(target.listCalls).toBe(0);
});

// Static edits during a running host are deliberately not hot-reloaded: restart to refresh the startup snapshot.
