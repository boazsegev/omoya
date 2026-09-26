#!/usr/bin/env bun
/**
 * website/build.js — zero-dependency Bun builder for the Omoya static site.
 * Docs-gate-first: runs test/api-docs.test.js (which regenerates API.md and
 * API-schema.md from the live tree and fails on any documentation contract
 * problem) BEFORE the API document is consumed. Clean-first: wipes
 * website/build/, renders the home page, collects the API JSON document from
 * test/api-reference.js and renders one page per module plus
 * overview/architecture/contracts/tools/settings sections, emits the static
 * search index and the 404.html error page, and copies website/static/
 * assets verbatim. Fails on any unexpected source error
 * (no catch-and-continue).
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { collect, contractProblems } from "../test/api-reference.js";
import { ROOT, site } from "./site.js";
import { homePage } from "./lib/home.js";
import { notFoundPage } from "./lib/not-found.js";
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
 * Link integrity gate for every generated page link. Resolve relative URLs
 * exactly as a browser would, require each same-origin target page to exist,
 * and require fragments to name an ID on that target. This covers API cards,
 * architecture edges, sidebars, cross-references, and search-index URLs.
 */
function linkProblems(pages, indexEntries) {
  const ids = new Map(pages.map((p) => [p.path,
    new Set([...p.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
  const problems = [];
  const canonicalPath = (pathname) => pathname === "/" ? "/" : `${pathname.replace(/\/(?:index\.html)?$/, "")}/`;
  const check = (from, href) => {
    // Intra-API links are root-relative (`/api/env/#Env-safe`) and resolve
    // identically under directory and extensionless clean-URL deployment;
    // remaining relative links use only depth prefixes that behave the same
    // in both forms, so plain browser resolution against the page path is
    // the correct expectation for every link on the site.
    const url = new URL(href, `https://omoya.invalid${from}`);
    if (url.origin !== "https://omoya.invalid") return;
    const target = canonicalPath(url.pathname);
    if (!ids.has(target)) {
      problems.push(`${from}: ${href} resolves to missing page ${target}`);
      return;
    }
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment && !ids.get(target).has(fragment)) {
      problems.push(`${from}: ${href} has no #${fragment} on ${target}`);
    }
  };
  for (const p of pages) {
    for (const m of p.html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) check(p.path, m[1]);
  }
  for (const e of indexEntries) check("/", e.u);
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
writeFileSync(join(BUILD, "404.html"), notFoundPage());
writeFileSync(join(BUILD, "llms.txt"), llmsTxt(data));
writeFileSync(join(BUILD, "llms-full.txt"), llmsFullTxt());
writeFileSync(join(BUILD, "robots.txt"), robotsTxt());
writeFileSync(join(BUILD, "sitemap.xml"), sitemapXml(pages));

const elapsed = (performance.now() - started).toFixed(0);
console.log(`built website/build: ${pages.length} pages (${data.modules.length} API modules), ${index.entries.length} search entries, plus 404.html, in ${elapsed}ms`);
for (const p of pages) console.log(`  ${p.path}`);
console.log(`  /404.html (error page — not in sitemap or search index)`);
