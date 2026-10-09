/**
 * ai-tools/ai-website-check.js — static behavioral checks for the website
 * build: search index anchors, cross-links between documented API points,
 * and the search navigation's scroll-to-anchor behavior. Run after
 * `bun run build:site`. Exits 1 on failure.
 * Usage: bun ai-tools/ai-website-check.js
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, "website", "build");

const results = [];
const check = (name, ok, detail = "") => { results.push(Boolean(ok)); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`); };
const read = (path) => readFileSync(join(BUILD, path), "utf8");

// --- build sanity
check("build exists", existsSync(join(BUILD, "index.html")), "website/build missing — run bun run build:site");
const agent = read("api/agent/index.html");
const env = read("api/env/index.html");
const gtui = read("api/gtui/index.html");
const settings = read("api/settings/index.html");
const app = read("assets/app.js");
const index = JSON.parse(read("assets/search/index.json"));
const style = read("assets/style.css");
const llms = read("llms.txt");
const llmsFull = read("llms-full.txt");
const robots = read("robots.txt");
const sitemap = read("sitemap.xml");

// --- LLM/crawler discovery artifacts
check("llms.txt identifies the site and complete corpus", llms.startsWith("# Omoya\n") && llms.includes("https://omoya.ai/llms-full.txt"), "missing title or full-documentation URL");
check("llms-full.txt includes generated API documentation", llmsFull.startsWith("# Omoya documentation\n") && llmsFull.includes("# API (") && llmsFull.includes("## Agent"), "full corpus is incomplete");
check("robots.txt exposes the canonical sitemap", robots.includes("Sitemap: https://omoya.ai/sitemap.xml"), "no canonical sitemap directive");
check("sitemap lists home and API pages", sitemap.includes("<loc>https://omoya.ai/</loc>") && sitemap.includes("<loc>https://omoya.ai/api/agent/</loc>"), "expected canonical pages missing");
check("pages advertise LLM and sitemap discovery", agent.includes('href="https://omoya.ai/llms.txt"') && agent.includes('href="https://omoya.ai/sitemap.xml"'), "page metadata missing");

// --- 404 error page: a flat file at the build root, root-relative so it
// renders correctly at any unmatched URL, and invisible to crawlers/search
const notFound = read("404.html");
check("404.html uses the shared shell with root-relative assets and links",
  notFound.includes('href="/assets/style.css"') && notFound.includes('src="/assets/app.js"')
    && notFound.includes('<a href="/"') && notFound.includes('<a href="/api/"') && !notFound.includes('href="../'),
  "404 page has relative links/assets that break at deep missing URLs");
check("404.html is excluded from indexing, sitemap, and search",
  notFound.includes('content="noindex"') && !sitemap.includes("404.html")
    && !index.entries.some((e) => e.u.includes("404")),
  "404 page leaks into sitemap/search or lacks noindex");
check("404.html carries the status motif and recovery links",
  /hero not-found[\s\S]*?class="code"[^>]*>404</.test(notFound) && /<h1>/.test(notFound),
  "404 page missing the 404 motif or a heading");

// --- every search entry hash resolves to an id on its page
const pageCache = new Map();
const pageHtml = (url) => {
  const path = url.split("#")[0];
  if (!pageCache.has(path)) pageCache.set(path, read(join(path, "index.html")));
  return pageCache.get(path);
};
let badAnchors = 0;
for (const entry of index.entries) {
  const hash = entry.u.split("#")[1];
  if (!hash) continue;
  const html = pageHtml(entry.u);
  if (!html.includes(`id="${hash}"`)) { badAnchors++; if (badAnchors <= 3) console.log(`   missing #${hash} on ${entry.u}`); }
}
check("search index anchors all resolve", badAnchors === 0, `${badAnchors} dangling hashes`);

// --- hash navigation: the app must scroll to the anchor after search clicks
check("app.js scrolls to hash targets", /scrollIntoView/.test(app), "no scrollIntoView in app.js");
check("app.js handles initial hash", /location\.hash/.test(app), "no location.hash handling");

// --- public application surfaces and concise schema presentation
check("GTUI has a public API page", gtui.includes("<h1>GTUI</h1>"), "GTUI was not collected as a public module");
check("settings use expandable schema sections", /<section class="symbol" id="tui">[\s\S]*?<details><summary>Schema<\/summary>/.test(settings), "tui setting is not tools-style expandable documentation");
check("settings do not inline expanded themes", !/<td><code>tui<\/code><\/td>/.test(settings) && !/<h3><code>themes<\/code><\/h3>/.test(settings), "nested defaults were expanded into settings rows");

// --- cross-links: a doc mentioning a known API point links to it.
// Cross-references are root-relative (`/api/env/#Env-safe`): pages deploy
// as extensionless clean URLs where relative sibling links would escape
// the /api/ tree, so these patterns pin the absolute form.
const contracts = read("api/contracts/index.html");
// Agent now uses the shared Env instance and passes safe mode explicitly
// when listing/calling tools; do not expect a removed Env.safeEnv getter.
check("Agent documents shared Env and safe tool calls", agent.includes("so one Env serves any number of Agents")
  && agent.includes("env.tools(safe)") && env.includes('id="Env-tools"'),
  "shared Env or safe tool selection missing");
check("Agent page has onEvent member anchor", agent.includes('id="Agent-onEvent"'), "no #Agent-onEvent anchor");
// Agent.EVENT.XXX mentions resolve to the documented EVENT field (same-page
// mentions use a bare fragment; cross-page ones the full /api/ path).
check("Agent.EVENT.XXX prefix-links to the EVENT field", /href="(?:\/api\/agent\/)?#Agent-EVENT"/.test(agent), "Agent.EVENT.REQUEST_START not linked");
// Env.EVENT is the current event namespace; ensure its public anchor exists.
check("Env.EVENT has a public anchor", env.includes('id="Env-EVENT"'), "Env.EVENT anchor missing");
// the contracts page cross-links known API points too (it pairs Env.onEvent
// with Agent's identity members)
check("contracts page cross-links API points", /href="\/api\/(env|agent)\/#/.test(contracts), "no cross-module links on contracts page");
// bare same-page member mentions link locally with a bare fragment
check("same-page member mention links locally", /href="#Agent-usage"/.test(agent) && /href="#Agent-folder"/.test(agent), "no local member links");
// JS builtins never link
check("builtins never link", !/href="[^"]*#(stringify|random|now)"/.test(agent + env), "builtin linked");

// --- API home: module cards are whole-card links with the /api/ prefix
const overview = read("api/index.html");
const cardHrefs = [...overview.matchAll(/<a class="card" href="([^"]+)"/g)].map((m) => m[1]);
check("API home cards are whole links with /api/ prefix", cardHrefs.length >= 10
  && cardHrefs.every((h) => /^\/api\/[a-z][a-z0-9_.-]*\/$/.test(h)), `unexpected card links: ${cardHrefs.slice(0, 5).join(", ")}`);
check("no extensionless-relative API links escape the /api/ tree",
  !/href="\.\/(architecture|contracts|tools|settings|markdown|context|env|io|agent|cli|jobs|tui|gtui|index)\//.test(overview),
  "overview still uses ./<section>/ links");

// --- API scroll model: ONE page scroll. The documentation never gets its
// own scroller (nested scrollers hid the sticky header after hash jumps);
// the header stays sticky everywhere; the sidebar is sticky below it and
// scrolls internally, bounded to the viewport; hash targets clear the header
const withSidebar = style.match(/\.with-sidebar \{[^}]*\}/s)?.[0] ?? "";
const sidebarMain = style.match(/\.with-sidebar main \{[^}]*\}/s)?.[0] ?? "";
check("API documentation scrolls with the page (no nested scroller)",
  withSidebar && !/height:|overflow/.test(withSidebar) && !/overflow-y: auto|height: 100%/.test(sidebarMain),
  ".with-sidebar or its main column regained a viewport height or own scrolling");
check("header stays sticky on API pages",
  /\.site-header \{[^}]*position: sticky/s.test(style) && !/body:has\(\.with-sidebar\) \.site-header/.test(style),
  "site header is not sticky, or is un-stuck on sidebar pages");
check("sidebar is sticky below the header and scrolls independently",
  /\.with-sidebar > \.api-nav \{[^}]*position: sticky[^}]*top: calc\(var\(--header-h\)[^}]*max-height: calc\(100vh - var\(--header-h\)[^}]*overflow-y: auto/s.test(style),
  ".api-nav lost its sticky position, viewport bound, or overflow scrolling");
check("hash targets clear the sticky header",
  /\[id\] \{ scroll-margin-top: calc\(var\(--header-h\)/.test(style) && /--header-h/.test(app),
  "no header-aware scroll-margin or app.js does not publish --header-h");

// --- sidebar: the current module page lists its symbols as a sub-navigation
check("Agent sidebar lists module sections", /class="current"/.test(agent)
  && /<ul class="api-sections">/.test(agent) && agent.includes('href="#Agent"')
  && agent.includes('href="#Agent-onEvent"'), "no sidebar sub-navigation on agent page");
const sidebarHashes = [...agent.matchAll(/<ul class="api-sections">[\s\S]*?href="#([^"]+)"/g)].map((m) => m[1]);
check("sidebar sub-navigation anchors exist on the page",
  sidebarHashes.length > 0 && sidebarHashes.every((hash) => agent.includes(`id="${hash}"`)),
  "sidebar hash link without a matching id");

if (results.some((ok) => !ok)) { console.log("FAIL: website self-test"); process.exit(1); }
console.log(`PASS: website self-test (${results.length} checks)`);
