#!/usr/bin/env bun
/**
 * website/build.js — zero-dependency Bun builder for the Omoya static site.
 * Docs-gate-first: runs test/api-docs.test.js (which regenerates API.md and
 * API-schema.md from the live tree and fails on any documentation contract
 * problem) BEFORE the API document is consumed. Clean-first: wipes
 * website/build/, renders the home page, collects the API JSON document from
 * test/api-reference.js and renders one page per module plus
 * overview/architecture/contracts/tools/settings sections, emits the static
 * search index, and copies website/static/ assets verbatim. Fails on any
 * unexpected source error (no catch-and-continue).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collect, contractProblems } from "../test/api-reference.js";
import { ROOT, site } from "./site.js";
import { homePage } from "./lib/home.js";
import { apiPages } from "./lib/api.js";
import { searchIndex } from "./lib/search.js";
import { llmsFullTxt, llmsTxt, robotsTxt, sitemapXml } from "./lib/llms.js";

const BUILD = join(ROOT, "build");
const started = performance.now();

/**
 * Run the documentation gate before consuming the API: api-docs.test.js
 * regenerates API.md/API-schema.md from the live tree and asserts every
 * public export is documented and every contract source resolves. A failed
 * gate aborts the build.
 */
async function docsGate() {
  const proc = Bun.spawn(["bun", "test", "test/api-docs.test.js"], {
    cwd: join(ROOT, ".."),
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`documentation gate failed: bun test test/api-docs.test.js exited ${code}`);
}
await docsGate();

/** Write one page (path like "/api/agent/") as <build>/<path>/index.html. */
function writePage(path, html) {
  const dir = join(BUILD, ...path.split("/").filter(Boolean));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), html);
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
cpSync(join(ROOT, "static"), BUILD, { recursive: true });

const pages = [{ path: "/", html: homePage() }];
const searchEntries = [{
  title: site.title,
  url: "/",
  text: `${site.description} terminal interface TUI headless streaming JSONL om-agent om-io library embed om --serve browser chat sessions providers ollama openai anthropic copilot kimi tools skills prompts workers mcp jobs scheduling security sandbox safe mode project memory ai-settings ai-skills ai-prompts AGENTS.md install bun`,
}];

const data = await collect();
const problems = contractProblems(data);
if (problems.length > 0) {
  throw new Error(`documentation gate problem(s):\n  ${problems.slice(0, 10).join("\n  ")}${problems.length > 10 ? "\n  …" : ""}`);
}
for (const p of apiPages(data)) {
  pages.push(p);
  searchEntries.push(p.search);
}

/**
 * Link integrity gate: every root-relative /api/<slug>/#anchor link emitted
 * into a page and every search-index URL must resolve to an anchor that
 * EXISTS on its target page. A resolver that falls back to a parent anchor
 * (a symbol mention landing on its module) fails here instead of shipping
 * a broken UX.
 */
function linkProblems(pages, indexEntries) {
  const ids = new Map(pages.map((p) => [p.path,
    new Set([...p.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  const problems = [];
  const check = (from, url) => {
    const m = /^(\/api\/[a-z]+\/)#(.+)$/.exec(url);
    if (m && !ids.get(m[1])?.has(m[2])) problems.push(`${from}: ${url} has no anchor on its target page`);
  };
  for (const p of pages) {
    for (const m of p.html.matchAll(/ href="(\/api\/[a-z]+\/#[^"]+)"/g)) check(p.path, m[1]);
  }
  for (const e of indexEntries) check(`search "${e.t}"`, e.u);
  return problems;
}

const index = searchIndex(searchEntries, data, data.generated);
const brokenLinks = linkProblems(pages, index.entries);
if (brokenLinks.length > 0) {
  throw new Error(`broken API link(s):\n  ${brokenLinks.slice(0, 10).join("\n  ")}${brokenLinks.length > 10 ? "\n  …" : ""}`);
}
mkdirSync(join(BUILD, "assets", "search"), { recursive: true });
writeFileSync(join(BUILD, "assets", "search", "index.json"), JSON.stringify(index));

for (const p of pages) writePage(p.path, p.html);
writeFileSync(join(BUILD, "llms.txt"), llmsTxt(data));
writeFileSync(join(BUILD, "llms-full.txt"), llmsFullTxt());
writeFileSync(join(BUILD, "robots.txt"), robotsTxt());
writeFileSync(join(BUILD, "sitemap.xml"), sitemapXml(pages));

const elapsed = (performance.now() - started).toFixed(0);
console.log(`built website/build: ${pages.length} pages (${data.modules.length} API modules), ${index.entries.length} search entries, in ${elapsed}ms`);
for (const p of pages) console.log(`  ${p.path}`);
